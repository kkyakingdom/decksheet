const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN = "https://discord.com/api/v10/oauth2/token";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const SESSION_MAX_SECONDS = 6 * 60 * 60;
const STATE_MAX_SECONDS = 10 * 60;

let googleTokenCache = { token: null, expiresAt: 0 };

export default {
  async fetch(request, env) {
    try {
      assertEnvironment(env);
      const url = new URL(request.url);

      if (request.method === "OPTIONS") return handleOptions(request, env);

      let response;
      switch (url.pathname) {
        case "/api/health":
          response = json({ ok: true, configured: true });
          break;
        case "/api/auth/login":
          response = await handleLogin(request, env);
          break;
        case "/api/auth/callback":
          response = await handleCallback(request, env);
          break;
        case "/api/me":
          response = await handleMe(request, env);
          break;
        case "/api/sheets":
          response = await handleSheets(request, env);
          break;
        case "/api/sheet":
          response = await handleSheet(request, env);
          break;
        default:
          response = json({ error: "not_found" }, 404);
      }
      return addCors(response, request, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "서버에서 요청을 처리하지 못했습니다.";
      if (status >= 500) console.error(error);
      return addCors(json({ error: status === 500 ? "server_error" : "request_error", message }, status), request, env);
    }
  },
};

function assertEnvironment(env) {
  const names = [
    "DISCORD_CLIENT_ID",
    "DISCORD_CLIENT_SECRET",
    "DISCORD_GUILD_ID",
    "DISCORD_ROLE_ID",
    "GOOGLE_SHEET_ID",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "SESSION_SECRET",
    "APP_URL",
  ];
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new HttpError(500, `환경변수/Secret 누락: ${missing.join(", ")}`);
  let app;
  try { app = new URL(env.APP_URL); } catch { throw new HttpError(500, "APP_URL이 올바른 URL이 아닙니다."); }
  if (app.protocol !== "https:" && app.hostname !== "localhost") throw new HttpError(500, "APP_URL은 HTTPS 주소여야 합니다.");
}

function handleOptions(request, env) {
  ensureAllowedOrigin(request, env);
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  });
  return addCors(new Response(null, { status: 204, headers }), request, env);
}

async function handleLogin(request, env) {
  requireGet(request);
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/auth/callback`;
  const now = Math.floor(Date.now() / 1000);
  const state = await sealToken({ v: 1, type: "oauth_state", nonce: randomToken(24), exp: now + STATE_MAX_SECONDS }, env.SESSION_SECRET);
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "identify guilds.members.read",
    state,
  });
  return redirect(`${DISCORD_AUTHORIZE}?${params.toString()}`);
}

async function handleCallback(request, env) {
  requireGet(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const redirectUri = `${url.origin}/api/auth/callback`;

  if (oauthError) return redirectApp(env, `discord_${oauthError}`);
  if (!code || !stateToken) return redirectApp(env, "invalid_state");

  const state = await unsealToken(stateToken, env.SESSION_SECRET);
  const now = Math.floor(Date.now() / 1000);
  if (!state || state.type !== "oauth_state" || state.exp <= now) return redirectApp(env, "invalid_state");

  const body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const tokenResponse = await fetch(DISCORD_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenResponse.ok) {
    console.error("Discord token exchange failed", tokenResponse.status, (await tokenResponse.text()).slice(0, 500));
    return redirectApp(env, "token_exchange");
  }

  const token = await tokenResponse.json();
  if (!token.access_token) return redirectApp(env, "token_missing");

  let user, member;
  try {
    [user, member] = await Promise.all([
      discordGet("/users/@me", token.access_token),
      discordGet(`/users/@me/guilds/${encodeURIComponent(env.DISCORD_GUILD_ID)}/member`, token.access_token),
    ]);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return redirectApp(env, "no_role");
    throw error;
  }

  if (!Array.isArray(member.roles) || !member.roles.includes(env.DISCORD_ROLE_ID)) return redirectApp(env, "no_role");

  const discordExpires = Number(token.expires_in) > 0 ? Number(token.expires_in) : SESSION_MAX_SECONDS;
  const maxAge = Math.min(SESSION_MAX_SECONDS, discordExpires);
  const session = {
    v: 1,
    type: "session",
    uid: String(user.id),
    username: user.global_name || user.username || "Discord 사용자",
    avatar: discordAvatarUrl(user),
    accessToken: token.access_token,
    exp: now + maxAge,
  };
  const sealed = await sealToken(session, env.SESSION_SECRET);
  return redirectApp(env, null, sealed);
}

async function handleMe(request, env) {
  requireGet(request);
  const auth = await requireAuthorized(request, env);
  return json({ authenticated: true, user: { id: auth.session.uid, name: auth.session.username, avatar: auth.session.avatar } });
}

async function handleSheets(request, env) {
  requireGet(request);
  const auth = await requireAuthorized(request, env);
  const googleToken = await getGoogleAccessToken(env);
  const meta = await fetchSpreadsheetMeta(env.GOOGLE_SHEET_ID, googleToken);
  return json({
    title: meta.title,
    locale: meta.locale,
    timeZone: meta.timeZone,
    user: { id: auth.session.uid, name: auth.session.username, avatar: auth.session.avatar },
    sheets: meta.sheets,
  });
}

async function handleSheet(request, env) {
  requireGet(request);
  await requireAuthorized(request, env);
  const url = new URL(request.url);
  const requestedSheetId = Number(url.searchParams.get("sheetId"));
  if (!Number.isInteger(requestedSheetId)) throw new HttpError(400, "올바른 sheetId가 필요합니다.");

  const googleToken = await getGoogleAccessToken(env);
  const meta = await fetchSpreadsheetMeta(env.GOOGLE_SHEET_ID, googleToken);
  const target = meta.sheets.find((sheet) => sheet.sheetId === requestedSheetId);
  if (!target) throw new HttpError(404, "표시할 수 없는 시트입니다.");
  return json(await fetchSheetGrid(env.GOOGLE_SHEET_ID, target.title, requestedSheetId, googleToken));
}

async function requireAuthorized(request, env) {
  ensureAllowedOrigin(request, env);
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, "Discord 로그인이 필요합니다.");
  const session = await unsealToken(match[1], env.SESSION_SECRET);
  if (!session || session.v !== 1 || session.type !== "session" || !session.accessToken || !session.uid || session.exp <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, "로그인 세션이 만료되었습니다.");
  }

  let member;
  try {
    member = await discordGet(`/users/@me/guilds/${encodeURIComponent(env.DISCORD_GUILD_ID)}/member`, session.accessToken);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403 || error.status === 404)) {
      throw new HttpError(error.status === 401 ? 401 : 403, "Discord 서버 또는 역할 권한을 확인할 수 없습니다.");
    }
    throw error;
  }
  if (!Array.isArray(member.roles) || !member.roles.includes(env.DISCORD_ROLE_ID)) throw new HttpError(403, "이 자료를 볼 수 있는 Discord 역할이 없습니다.");
  return { session, member };
}

async function discordGet(path, accessToken) {
  const response = await fetch(`${DISCORD_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const status = response.status;
    const text = await response.text();
    console.warn("Discord API error", status, path, text.slice(0, 300));
    throw new HttpError(status === 404 ? 404 : status === 401 ? 401 : 403, "Discord 권한 확인에 실패했습니다.");
  }
  return response.json();
}

function discordAvatarUrl(user) {
  if (!user?.id || !user?.avatar) return null;
  const ext = String(user.avatar).startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
}
async function fetchSpreadsheetMeta(spreadsheetId, accessToken) {
  const fields = [
    "properties(title,locale,timeZone)",
    "sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)))",
  ].join(",");
  const url = `${GOOGLE_SHEETS}/${encodeURIComponent(spreadsheetId)}?includeGridData=false&fields=${encodeURIComponent(fields)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const text = await response.text();
    console.error("Google Sheets meta error", response.status, text.slice(0, 500));
    throw new HttpError(response.status === 403 || response.status === 404 ? 502 : 500, "Google Sheet를 읽지 못했습니다. 서비스 계정 공유 권한을 확인하세요.");
  }
  const data = await response.json();
  const sheets = (data.sheets || [])
    .map((entry) => entry.properties)
    .filter((p) => p && p.hidden !== true)
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((p) => ({
      sheetId: p.sheetId,
      title: p.title,
      rowCount: p.gridProperties?.rowCount || 0,
      columnCount: p.gridProperties?.columnCount || 0,
      frozenRowCount: p.gridProperties?.frozenRowCount || 0,
      frozenColumnCount: p.gridProperties?.frozenColumnCount || 0,
    }));
  return {
    title: data.properties?.title || "Google Sheet",
    locale: data.properties?.locale || null,
    timeZone: data.properties?.timeZone || null,
    sheets,
  };
}

async function fetchSheetGrid(spreadsheetId, sheetTitle, expectedSheetId, accessToken) {
  const safeTitle = `'${String(sheetTitle).replace(/'/g, "''")}'`;
  const fields =
    "sheets(" +
    "properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))," +
    "merges," +
    "data(" +
    "startRow,startColumn," +
    "rowData(values(" +
    "formattedValue,hyperlink,userEnteredValue(formulaValue)," +
    "effectiveFormat(" +
    "backgroundColor,backgroundColorStyle," +
    "textFormat(foregroundColor,foregroundColorStyle,bold,italic,strikethrough,underline,fontSize,fontFamily)," +
    "horizontalAlignment,verticalAlignment,wrapStrategy," +
    "borders(top(style,color,colorStyle),bottom(style,color,colorStyle),left(style,color,colorStyle),right(style,color,colorStyle))" +
    ")," +
    "textFormatRuns(startIndex,format(foregroundColor,foregroundColorStyle,bold,italic,strikethrough,underline,fontSize,fontFamily))" +
    "))," +
    "rowMetadata(pixelSize,hiddenByUser,hiddenByFilter)," +
    "columnMetadata(pixelSize,hiddenByUser,hiddenByFilter)" +
    ")" +
    ")";
  const params = new URLSearchParams({
    includeGridData: "true",
    ranges: safeTitle,
    fields,
  });
  const url = `${GOOGLE_SHEETS}/${encodeURIComponent(spreadsheetId)}?${params.toString()}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const text = await response.text();
    console.error("Google Sheets grid error", response.status, text.slice(0, 500));
    throw new HttpError(502, "시트 데이터를 불러오지 못했습니다.");
  }
  const payload = await response.json();
  const sheet = payload.sheets?.[0];
  if (!sheet || sheet.properties?.sheetId !== expectedSheetId) throw new HttpError(404, "시트 데이터를 찾지 못했습니다.");
  return normalizeSheet(sheet);
}

function normalizeSheet(sheet) {
  const props = sheet.properties || {};
  const grid = props.gridProperties || {};
  const block = sheet.data?.[0] || {};
  const rows = (block.rowData || []).map((row) => ({
    cells: (row.values || []).map(normalizeCell),
  }));
  const rowMeta = (block.rowMetadata || []).map((m) => ({
    size: m.pixelSize || null,
    hidden: Boolean(m.hiddenByUser || m.hiddenByFilter),
  }));
  const colMeta = (block.columnMetadata || []).map((m) => ({
    size: m.pixelSize || null,
    hidden: Boolean(m.hiddenByUser || m.hiddenByFilter),
  }));
  const merges = (sheet.merges || []).map((m) => ({
    sr: m.startRowIndex || 0,
    er: m.endRowIndex || 0,
    sc: m.startColumnIndex || 0,
    ec: m.endColumnIndex || 0,
  }));

  return {
    sheetId: props.sheetId,
    title: props.title,
    grid: {
      rows: grid.rowCount || 0,
      cols: grid.columnCount || 0,
      frozenRows: grid.frozenRowCount || 0,
      frozenCols: grid.frozenColumnCount || 0,
    },
    merges,
    rowMeta,
    colMeta,
    rows,
  };
}

function normalizeCell(cell = {}) {
  const formula = cell.userEnteredValue?.formulaValue || "";
  return {
    value: cell.formattedValue ?? "",
    link: sanitizeHttpUrl(cell.hyperlink),
    image: extractImageUrl(formula),
    style: normalizeFormat(cell.effectiveFormat || {}),
    runs: Array.isArray(cell.textFormatRuns)
      ? cell.textFormatRuns.map((run) => ({ start: run.startIndex || 0, style: normalizeTextFormat(run.format || {}) }))
      : [],
  };
}

function extractImageUrl(formula) {
  if (!formula || !/^=IMAGE\s*\(/i.test(formula)) return null;
  const match = formula.match(/^=IMAGE\s*\(\s*"((?:[^"]|"")+)"/i);
  if (!match) return null;
  return sanitizeHttpUrl(match[1].replace(/""/g, '"'));
}

function sanitizeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeFormat(format) {
  return {
    bg: colorToCss(format.backgroundColorStyle?.rgbColor || format.backgroundColor),
    text: normalizeTextFormat(format.textFormat || {}),
    h: format.horizontalAlignment || null,
    v: format.verticalAlignment || null,
    wrap: format.wrapStrategy || null,
    borders: normalizeBorders(format.borders || {}),
  };
}

function normalizeTextFormat(format) {
  return {
    color: colorToCss(format.foregroundColorStyle?.rgbColor || format.foregroundColor),
    bold: Boolean(format.bold),
    italic: Boolean(format.italic),
    strike: Boolean(format.strikethrough),
    underline: Boolean(format.underline),
    size: Number.isFinite(format.fontSize) ? format.fontSize : null,
    family: format.fontFamily || null,
  };
}

function normalizeBorders(borders) {
  const result = {};
  for (const side of ["top", "right", "bottom", "left"]) {
    const border = borders[side];
    if (!border?.style) continue;
    result[side] = {
      style: border.style,
      color: colorToCss(border.colorStyle?.rgbColor || border.color) || "#d0d7de",
    };
  }
  return result;
}

function colorToCss(color) {
  if (!color || typeof color !== "object") return null;
  const r = Math.round((color.red ?? 0) * 255);
  const g = Math.round((color.green ?? 0) * 255);
  const b = Math.round((color.blue ?? 0) * 255);
  const a = color.alpha == null ? 1 : Math.max(0, Math.min(1, color.alpha));
  if (a < 1) return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
  return `rgb(${r}, ${g}, ${b})`;
}

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (googleTokenCache.token && googleTokenCache.expiresAt - 60 > now) return googleTokenCache.token;

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new HttpError(500, "GOOGLE_SERVICE_ACCOUNT_JSON이 올바른 JSON이 아닙니다.");
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new HttpError(500, "서비스 계정 JSON에 client_email/private_key가 없습니다.");
  }

  const jwt = await createGoogleJwt(serviceAccount, now);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });
  const response = await fetch(serviceAccount.token_uri || GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    console.error("Google OAuth error", response.status, text.slice(0, 500));
    throw new HttpError(500, "Google 서비스 계정 인증에 실패했습니다.");
  }
  const token = await response.json();
  googleTokenCache = {
    token: token.access_token,
    expiresAt: now + (Number(token.expires_in) || 3600),
  };
  return googleTokenCache.token;
}

async function createGoogleJwt(serviceAccount, now) {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: serviceAccount.token_uri || GOOGLE_TOKEN,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64UrlString(JSON.stringify(header))}.${base64UrlString(JSON.stringify(payload))}`;
  const keyBytes = pemToBytes(serviceAccount.private_key);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function pemToBytes(pem) {
  const cleaned = String(pem)
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(cleaned);
}


async function sealToken(payload, secret) {
  const key = await tokenKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  return bytesToBase64Url(combined);
}

async function unsealToken(token, secret) {
  try {
    const bytes = base64UrlToBytes(token);
    if (bytes.length < 29) return null;
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);
    const key = await tokenKey(secret);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

async function tokenKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function randomToken(byteLength) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function base64UrlString(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return base64ToBytes(base64);
}

function ensureAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  const allowed = new URL(env.APP_URL).origin;
  if (origin !== allowed) throw new HttpError(403, "허용되지 않은 웹사이트 요청입니다.");
}

function addCors(response, request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !env?.APP_URL) return response;
  let allowed;
  try { allowed = new URL(env.APP_URL).origin; } catch { return response; }
  if (origin !== allowed) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowed);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function redirect(location) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  return new Response(null, { status: 302, headers });
}

function redirectApp(env, error = null, session = null) {
  const target = new URL(env.APP_URL);
  if (error) target.searchParams.set("auth_error", error);
  if (session) target.hash = `session=${encodeURIComponent(session)}`;
  return redirect(target.toString());
}

function requireGet(request) {
  if (request.method !== "GET") throw new HttpError(405, "GET 요청만 허용됩니다.");
}

function json(value, status = 200) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store, max-age=0",
    "Pragma": "no-cache",
  });
  return new Response(JSON.stringify(value), { status, headers });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
