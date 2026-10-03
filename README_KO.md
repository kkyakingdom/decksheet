# GitHub Pages + Discord 역할 인증 + Google Sheet Viewer

이 버전은 **GitHub에 그대로 업로드해서 사용할 수 있게** 구성했습니다.

- 화면(프론트엔드): GitHub Pages
- 로그인/권한 확인/Google Sheet 읽기: Cloudflare Worker
- Google Sheet 원본: 비공개(Restricted) 유지
- Discord 조건: 지정 서버 가입 + 지정 Role 보유

## 이미 입력된 값

- Discord Client ID: `1554840609670438945`
- Discord Guild ID: `1493410906456064112`
- Discord Role ID: `1553600098661957643`
- Google Sheet ID: `1x1AflXH28V5E-WjJh6XwItMfzAfyCf-dsYZSNn23e1A`

Client Secret과 Google 서비스 계정 JSON은 저장소 파일에 들어 있지 않습니다.

> **Discord Client Secret은 코드에 넣지 않습니다.** GitHub `Repository secrets`의 `DISCORD_CLIENT_SECRET`에만 저장하도록 이미 연결되어 있습니다. 자세한 내용은 `GitHub_Secret_등록방법.txt`를 보세요.

---

## 가장 쉬운 설치 순서

### 1. GitHub 새 저장소 만들기

예: `mou-sheet-viewer`

이 ZIP 안의 **내용 전체**를 저장소 최상위에 업로드합니다. 폴더를 한 번 더 감싸서 올리지 마세요.

업로드 후 저장소 루트에 아래가 보여야 합니다.

```text
.github/
docs/
worker/
README_KO.md
```

### 2. GitHub Pages 켜기

GitHub 저장소에서:

`Settings → Pages → Build and deployment → Source → GitHub Actions`

저장하면 포함된 `Deploy GitHub Pages` Action이 `docs/` 폴더를 사이트로 배포합니다.

사이트 주소 예:

`https://YOUR-ID.github.io/mou-sheet-viewer/`

이 주소를 복사합니다.

### 3. Google 서비스 계정 준비

Google Cloud에서 Google Sheets API를 활성화하고 Service Account를 만든 뒤 JSON Key를 다운로드합니다.

JSON 안의 `client_email`을 복사하여 보호할 Google Sheet에 **뷰어**로 공유합니다.

Google Sheet의 일반 액세스는 `제한됨(Restricted)`으로 유지하세요.

### 4. GitHub Actions Secrets 등록

저장소에서:

`Settings → Secrets and variables → Actions → Secrets → New repository secret`

다음 6개를 등록합니다.

| 이름 | 값 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `CLOUDFLARE_API_TOKEN` | Workers 배포 권한이 있는 Cloudflare API Token |
| `DISCORD_CLIENT_SECRET` | Discord Developer Portal의 Client Secret |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 서비스 계정 JSON 파일 내용 전체 (`{`부터 `}`까지) |
| `SESSION_SECRET` | 긴 랜덤 문자열 (32자 이상 권장) |
| `APP_URL` | 2단계에서 만든 GitHub Pages 전체 주소 |

**Secret 값은 코드 파일에 직접 쓰지 마세요.**

### 5. Worker 배포

GitHub 저장소에서:

`Actions → Deploy Cloudflare Worker API → Run workflow`

완료되면 Cloudflare Dashboard의 Worker `nslg-discord-sheet-api`에서 workers.dev 주소를 확인합니다.

예:

`https://nslg-discord-sheet-api.YOUR-SUBDOMAIN.workers.dev`

### 6. GitHub Pages에 Worker 주소 연결

GitHub 저장소의 `docs/config.js` 파일을 열어 이 한 줄만 수정합니다.

```js
API_BASE: "https://YOUR-WORKER.workers.dev"
```

예:

```js
API_BASE: "https://nslg-discord-sheet-api.abc123.workers.dev"
```

Commit하면 GitHub Pages가 자동 재배포됩니다.

### 7. Discord Redirect URI 등록

Discord Developer Portal → 해당 Application → OAuth2에서 Redirect URI에 다음을 추가합니다.

```text
https://nslg-discord-sheet-api.YOUR-SUBDOMAIN.workers.dev/api/auth/callback
```

주의: **GitHub Pages 주소가 아니라 Worker 주소 + `/api/auth/callback`** 입니다.

### 8. 최종 테스트

GitHub Pages 주소를 엽니다.

1. `Discord로 로그인`
2. 지정 서버 가입 여부 확인
3. Role ID `1553600098661957643` 보유 여부 확인
4. 통과하면 Sheet Viewer 표시
5. 역할이 없으면 접근 거부

---

## 왜 GitHub Pages만 100% 단독으로 쓰지 않나요?

GitHub Pages는 정적 HTML/JS 호스팅이므로 Discord Client Secret과 Google 서비스 계정 Private Key를 안전하게 숨겨 실행할 서버 코드가 없습니다. 이를 브라우저 JavaScript에 넣으면 방문자가 키를 확인할 수 있습니다.

그래서 **GitHub는 화면과 코드 저장/자동 배포에 사용하고, 비밀키가 필요한 API 부분만 Cloudflare Worker에서 실행**합니다.

## 보안 구조

```text
GitHub Pages
    │ Discord 로그인 요청
    ▼
Cloudflare Worker
    │
    ├─ Discord OAuth2
    ├─ Guild 확인
    ├─ Role 확인
    └─ 비공개 Google Sheet 읽기
            │
            ▼
     허용된 사용자에게만 데이터 반환
```

OAuth 로그인 후 Worker가 암호화된 단기 세션 토큰을 GitHub Pages의 URL fragment(`#session=...`)로 전달하고, 페이지는 이를 즉시 `sessionStorage`에 저장한 뒤 URL에서 제거합니다. API 요청마다 Worker가 Discord Role을 다시 확인합니다.

## 중요한 제한

인증된 사용자가 화면에서 본 자료를 스크린샷/복사하는 것까지 기술적으로 막을 수는 없습니다. 이 시스템의 목적은 **원본 Google Sheet와 비밀키를 공개하지 않고, Discord 서버/Role을 통과한 사용자에게만 열람 경로를 제공하는 것**입니다.
