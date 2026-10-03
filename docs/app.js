const API_BASE = String(window.APP_CONFIG?.API_BASE || "").replace(/\/$/, "");
const TOKEN_KEY = "nslg_sheet_session";

const els = {
  login: document.getElementById("loginView"),
  forbidden: document.getElementById("forbiddenView"),
  viewer: document.getElementById("viewerView"),
  authError: document.getElementById("authError"),
  title: document.getElementById("sheetTitle"),
  status: document.getElementById("sheetStatus"),
  tabs: document.getElementById("tabs"),
  loading: document.getElementById("loading"),
  error: document.getElementById("sheetError"),
  viewport: document.getElementById("sheetViewport"),
  canvas: document.getElementById("sheetCanvas"),
  userName: document.getElementById("userName"),
  userAvatar: document.getElementById("userAvatar"),
  loginButton: document.getElementById("loginButton"),
  reloginButton: document.getElementById("reloginButton"),
  logoutButton: document.getElementById("logoutButton"),
};

const state = {
  sheets: [],
  activeSheetId: null,
  sheetCache: new Map(),
};

init();

async function init() {
  if (!API_BASE || API_BASE.includes("YOUR-WORKER")) {
    showOnly(els.login);
    els.authError.textContent = "docs/config.js의 API_BASE에 Cloudflare Worker 주소를 입력해 주세요.";
    els.authError.hidden = false;
    return;
  }

  const loginUrl = `${API_BASE}/api/auth/login`;
  els.loginButton.href = loginUrl;
  els.reloginButton.href = loginUrl;
  els.logoutButton.addEventListener("click", logoutLocal);

  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const tokenFromCallback = hash.get("session");
  if (tokenFromCallback) {
    sessionStorage.setItem(TOKEN_KEY, tokenFromCallback);
    history.replaceState({}, "", location.pathname + location.search);
  }

  const params = new URLSearchParams(location.search);
  const authError = params.get("auth_error");
  if (authError) {
    history.replaceState({}, "", location.pathname);
    if (authError === "no_role") {
      showOnly(els.forbidden);
      return;
    }
    els.authError.textContent = authErrorMessage(authError);
    els.authError.hidden = false;
  }

  if (!sessionStorage.getItem(TOKEN_KEY)) {
    showOnly(els.login);
    return;
  }

  try {
    const me = await api("/api/me");
    showViewerUser(me.user);
    await loadWorkbook();
  } catch (error) {
    if (error.status === 403) showOnly(els.forbidden);
    else showOnly(els.login);
  }
}

async function loadWorkbook() {
  showOnly(els.viewer);
  setLoading(true);
  try {
    const data = await api("/api/sheets");
    els.title.textContent = data.title || "자료실";
    showViewerUser(data.user);
    state.sheets = data.sheets || [];
    renderTabs();
    if (!state.sheets.length) {
      showSheetError("표시 가능한 시트 탭이 없습니다.");
      return;
    }
    await selectSheet(state.sheets[0].sheetId);
  } catch (error) {
    if (error.status === 401) {
      sessionStorage.removeItem(TOKEN_KEY);
      showOnly(els.login);
      return;
    }
    if (error.status === 403) {
      showOnly(els.forbidden);
      return;
    }
    showSheetError(error.message || "Google Sheet를 불러오지 못했습니다.");
  } finally {
    setLoading(false);
  }
}

function logoutLocal() {
  sessionStorage.removeItem(TOKEN_KEY);
  state.sheetCache.clear();
  state.activeSheetId = null;
  location.reload();
}

function showViewerUser(user) {
  if (!user) return;
  els.userName.textContent = user.name || "Discord 사용자";
  if (user.avatar) {
    els.userAvatar.src = user.avatar;
    els.userAvatar.hidden = false;
  } else {
    els.userAvatar.hidden = true;
  }
}

function renderTabs() {
  els.tabs.replaceChildren();
  for (const sheet of state.sheets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab-button";
    button.textContent = sheet.title;
    button.dataset.sheetId = String(sheet.sheetId);
    button.addEventListener("click", () => selectSheet(sheet.sheetId));
    els.tabs.appendChild(button);
  }
}

async function selectSheet(sheetId) {
  if (state.activeSheetId === sheetId && state.sheetCache.has(sheetId)) return;
  state.activeSheetId = sheetId;
  updateActiveTab();
  hideSheetError();
  setLoading(true);
  els.viewport.hidden = true;

  try {
    let sheet = state.sheetCache.get(sheetId);
    if (!sheet) {
      sheet = await api(`/api/sheet?sheetId=${encodeURIComponent(sheetId)}`);
      state.sheetCache.set(sheetId, sheet);
    }
    renderSheet(sheet);
    els.status.textContent = `${sheet.title} · Discord 권한 확인됨`;
    els.viewport.hidden = false;
  } catch (error) {
    if (error.status === 401) {
      showOnly(els.login);
      return;
    }
    if (error.status === 403) {
      showOnly(els.forbidden);
      return;
    }
    showSheetError(error.message || "시트 탭을 불러오지 못했습니다.");
  } finally {
    setLoading(false);
  }
}

function updateActiveTab() {
  for (const button of els.tabs.querySelectorAll(".tab-button")) {
    const active = Number(button.dataset.sheetId) === state.activeSheetId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  }
  const active = els.tabs.querySelector(".tab-button.active");
  active?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
}

function renderSheet(sheet) {
  els.canvas.replaceChildren();
  const table = document.createElement("table");
  table.className = "sheet-table";

  const metrics = calculateMetrics(sheet);
  const colgroup = document.createElement("colgroup");
  for (let c = 0; c < metrics.colCount; c += 1) {
    const col = document.createElement("col");
    col.style.width = `${metrics.colWidths[c]}px`;
    if (sheet.colMeta?.[c]?.hidden) col.style.visibility = "collapse";
    colgroup.appendChild(col);
  }
  table.appendChild(colgroup);

  const mergeMap = buildMergeMap(sheet.merges || []);
  const tbody = document.createElement("tbody");

  for (let r = 0; r < metrics.rowCount; r += 1) {
    const tr = document.createElement("tr");
    const rowMeta = sheet.rowMeta?.[r];
    tr.style.height = `${metrics.rowHeights[r]}px`;
    if (rowMeta?.hidden) tr.hidden = true;

    for (let c = 0; c < metrics.colCount; c += 1) {
      const merge = mergeMap.get(`${r}:${c}`);
      if (merge?.skip) continue;

      const td = document.createElement("td");
      td.dataset.row = String(r);
      td.dataset.col = String(c);
      if (merge?.master) {
        td.rowSpan = Math.max(1, merge.er - merge.sr);
        td.colSpan = Math.max(1, merge.ec - merge.sc);
      }
      const cell = sheet.rows?.[r]?.cells?.[c] || emptyCell();
      applyCellStyle(td, cell.style || {});
      renderCellContent(td, cell);
      applyFrozenPosition(td, r, c, sheet.grid || {}, metrics);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  els.canvas.appendChild(table);
}

function calculateMetrics(sheet) {
  let rowCount = sheet.rows?.length || 0;
  let colCount = 0;
  for (const row of sheet.rows || []) colCount = Math.max(colCount, row.cells?.length || 0);
  for (const merge of sheet.merges || []) {
    rowCount = Math.max(rowCount, merge.er || 0);
    colCount = Math.max(colCount, merge.ec || 0);
  }
  rowCount = Math.max(rowCount, Math.min(sheet.rowMeta?.length || 0, 2000), 1);
  colCount = Math.max(colCount, Math.min(sheet.colMeta?.length || 0, 200), 1);

  const rowHeights = Array.from({ length: rowCount }, (_, i) => sheet.rowMeta?.[i]?.size || 24);
  const colWidths = Array.from({ length: colCount }, (_, i) => sheet.colMeta?.[i]?.size || 100);
  const rowTops = prefixSums(rowHeights);
  const colLefts = prefixSums(colWidths);
  return { rowCount, colCount, rowHeights, colWidths, rowTops, colLefts };
}

function prefixSums(values) {
  const result = new Array(values.length).fill(0);
  let total = 0;
  for (let i = 0; i < values.length; i += 1) {
    result[i] = total;
    total += values[i];
  }
  return result;
}

function buildMergeMap(merges) {
  const map = new Map();
  for (const merge of merges) {
    map.set(`${merge.sr}:${merge.sc}`, { master: true, ...merge });
    for (let r = merge.sr; r < merge.er; r += 1) {
      for (let c = merge.sc; c < merge.ec; c += 1) {
        if (r === merge.sr && c === merge.sc) continue;
        map.set(`${r}:${c}`, { skip: true, ...merge });
      }
    }
  }
  return map;
}

function renderCellContent(td, cell) {
  if (cell.image) {
    const img = document.createElement("img");
    img.src = cell.image;
    img.alt = cell.value || "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.className = "cell-image";
    td.appendChild(img);
    return;
  }

  const value = String(cell.value ?? "");
  let content = td;
  if (cell.link) {
    const link = document.createElement("a");
    link.href = cell.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "cell-link";
    td.appendChild(link);
    content = link;
  }

  if (Array.isArray(cell.runs) && cell.runs.length > 0 && value) {
    const sorted = [...cell.runs].sort((a, b) => a.start - b.start);
    if (sorted[0].start > 0) content.appendChild(document.createTextNode(value.slice(0, sorted[0].start)));
    for (let i = 0; i < sorted.length; i += 1) {
      const start = sorted[i].start;
      const end = i + 1 < sorted.length ? sorted[i + 1].start : value.length;
      const span = document.createElement("span");
      span.textContent = value.slice(start, end);
      applyTextStyle(span, sorted[i].style || {});
      content.appendChild(span);
    }
  } else {
    content.textContent = value;
  }
}

function applyCellStyle(td, style) {
  if (style.bg) td.style.background = style.bg;
  if (style.h) td.style.textAlign = alignment(style.h);
  if (style.v) td.style.verticalAlign = verticalAlignment(style.v);
  td.style.whiteSpace = style.wrap === "WRAP" ? "pre-wrap" : style.wrap === "CLIP" ? "pre" : "pre-wrap";
  td.style.overflowWrap = style.wrap === "WRAP" ? "anywhere" : "normal";
  applyTextStyle(td, style.text || {});

  for (const side of ["top", "right", "bottom", "left"]) {
    const border = style.borders?.[side];
    if (!border) continue;
    td.style[`border${capitalize(side)}`] = borderCss(border);
  }
}

function applyTextStyle(el, text) {
  if (text.color) el.style.color = text.color;
  if (text.bold) el.style.fontWeight = "700";
  if (text.italic) el.style.fontStyle = "italic";
  if (text.size) el.style.fontSize = `${text.size}pt`;
  if (text.family) el.style.fontFamily = `"${String(text.family).replace(/"/g, "")}", sans-serif`;
  const decorations = [];
  if (text.underline) decorations.push("underline");
  if (text.strike) decorations.push("line-through");
  if (decorations.length) el.style.textDecoration = decorations.join(" ");
}

function applyFrozenPosition(td, row, col, grid, metrics) {
  const frozenRows = grid.frozenRows || 0;
  const frozenCols = grid.frozenCols || 0;
  const rowFrozen = row < frozenRows;
  const colFrozen = col < frozenCols;
  if (!rowFrozen && !colFrozen) return;
  td.style.position = "sticky";
  if (rowFrozen) td.style.top = `${metrics.rowTops[row]}px`;
  if (colFrozen) td.style.left = `${metrics.colLefts[col]}px`;
  td.style.zIndex = rowFrozen && colFrozen ? "5" : rowFrozen ? "4" : "3";
  if (!td.style.background) td.style.background = "var(--sheet-bg)";
}

function borderCss(border) {
  const map = {
    DOTTED: ["1px", "dotted"],
    DASHED: ["1px", "dashed"],
    SOLID: ["1px", "solid"],
    SOLID_MEDIUM: ["2px", "solid"],
    SOLID_THICK: ["3px", "solid"],
    DOUBLE: ["3px", "double"],
  };
  const [width, style] = map[border.style] || ["1px", "solid"];
  return `${width} ${style} ${border.color || "#d0d7de"}`;
}

function alignment(value) {
  return value === "CENTER" ? "center" : value === "RIGHT" ? "right" : "left";
}

function verticalAlignment(value) {
  return value === "MIDDLE" ? "middle" : value === "BOTTOM" ? "bottom" : "top";
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function emptyCell() {
  return { value: "", link: null, image: null, runs: [], style: {} };
}

function setLoading(on) {
  els.loading.hidden = !on;
}

function showSheetError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
  els.viewport.hidden = true;
}

function hideSheetError() {
  els.error.hidden = true;
  els.error.textContent = "";
}

function showOnly(element) {
  els.login.hidden = element !== els.login;
  els.forbidden.hidden = element !== els.forbidden;
  els.viewer.hidden = element !== els.viewer;
}

function authErrorMessage(code) {
  const messages = {
    invalid_state: "로그인 검증값이 일치하지 않습니다. 다시 로그인해 주세요.",
    token_exchange: "Discord 로그인 토큰을 받지 못했습니다. 다시 시도해 주세요.",
    token_missing: "Discord 로그인 정보가 올바르지 않습니다.",
    access_denied: "Discord 로그인이 취소되었습니다.",
  };
  return messages[code] || "Discord 로그인 중 오류가 발생했습니다. 다시 시도해 주세요.";
}

async function api(path) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers,
    cache: "no-store",
    mode: "cors",
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem(TOKEN_KEY);
    const error = new Error(payload.message || `요청 실패 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
