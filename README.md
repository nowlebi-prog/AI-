# Hub

혼자 여러 프로젝트를 하는 사람을 위한 개인 작업 허브예요. 프로젝트·결정·할 일을 한곳에 모아 두면, **Claude·ChatGPT·Grok·Muse가 MCP로 같은 맥락을 읽고 변경을 제안**해요. 새 창을 열 때마다 설명할 필요가 없어요.

- 기획 문서: [docs/plan.md](docs/plan.md)
- 런타임: Node.js 22.18 이상 (24 LTS 권장). **외부 패키지 없음**. DB는 내장 SQLite 파일 하나.

## 1단계에서 되는 것

| 기능 | 설명 |
|---|---|
| 오늘 보드 | 모든 프로젝트의 지난 마감·오늘·진행 중·이번 주 할 일. 역할 필터 |
| 빠른 추가 | `브랜드X 로고 시안 3개 금요일까지 #디자인 !` → 프로젝트·역할·마감·긴급 자동 인식 |
| 프로젝트 | 카드(목표·타깃·단계·제약·범위), 결정 로그(대체 이력), 할 일, 세션 기록, 마지막 위치 |
| 브리핑 | S/M/L 세 가지 크기. MCP로 전달하거나 복사해서 붙여 넣기 |
| 원격 MCP 서버 | `/mcp` (Streamable HTTP). 도구 9개. OAuth 2.1 또는 개인 토큰 |
| 인박스 | AI 제안을 승인·수정·거절. 종류별 자동 승인 규칙 |
| 붙여넣기 | MCP를 못 쓰는 AI의 `[Hub 메모]`를 붙여 넣으면 반영 |
| 가져오기 | 노션 페이지(API)나 텍스트를 가져오면, 연결된 AI가 읽고 정리해서 제안 |
| 설정 | 프로필, AI 연결 안내, 개인 토큰, 연결된 앱, MCP 호출 기록, 백업 |

## 로컬 실행

```bash
cp .env.example .env      # HUB_PASSWORD를 채우세요
npm start                 # http://localhost:3000
npm test                  # 단위·통합 테스트 (node:test)
```

`npm run dev`는 파일이 바뀌면 다시 시작해요. 타입 검사는 `npm install` 후 `npm run typecheck`로 해요 (typescript, @types/node 개발 의존성).

## 배포 (AI 연결에 필요)

AI 서비스는 **각자의 클라우드에서** Hub에 접속해요. 그래서 인터넷에서 열리는 **HTTPS 주소**가 필요하고, localhost로는 연결되지 않아요. 데이터가 SQLite 파일이라 **디스크가 유지되는 곳**에 올려야 해요. 서버리스(Vercel 등)는 맞지 않아요.

```bash
docker build -t hub .
docker run -d --name hub -p 3000:3000 -v hub-data:/data \
  -e HUB_PASSWORD='길고-추측하기-어려운-비밀번호' \
  -e HUB_PUBLIC_URL='https://hub.example.com' \
  hub
```

올릴 곳 예시: 작은 VPS + Caddy(자동 HTTPS), Fly.io·Railway·Render(볼륨 연결), 집 PC + Cloudflare Tunnel.

| 환경변수 | 필수 | 설명 |
|---|---|---|
| `HUB_PASSWORD` | ✅ | 로그인 비밀번호 |
| `HUB_PUBLIC_URL` | 배포 시 ✅ | 외부 주소 (예: `https://hub.example.com`). OAuth 메타데이터에 쓰여요 |
| `HUB_DATA_DIR` | | 데이터 폴더 (기본 `./data`, Docker는 `/data`) |
| `HUB_SECRET` | | 세션 서명 키. 비우면 자동 생성해서 DB에 저장 |
| `HUB_TZ` | | 날짜 기준 시간대 (기본 `Asia/Seoul`) |
| `NOTION_TOKEN` | | 노션 가져오기 기본 토큰 |
| `PORT` / `HOST` | | 기본 `3000` / `0.0.0.0` |

백업은 설정 → **백업 다운로드**를 쓰거나, `hub.db` 파일을 복사하면 돼요.

## AI 연결

MCP 주소: `https://(내 주소)/mcp`. 주소 끝에 `/`를 붙이지 마세요.

| AI | 방법 |
|---|---|
| Claude (데스크톱·웹) | 설정 → 커넥터 → 커스텀 커넥터 추가 → MCP 주소 → Hub 로그인 후 허용 |
| ChatGPT (Pro) | 웹에서 설정 → Apps & Connectors → Advanced settings → Developer mode → 커넥터 추가(OAuth) → 허용. 데스크톱 앱에는 자동 동기화 |
| Grok | grok.com 커넥터 → New Connector → Custom → MCP 주소 → OAuth 허용 |
| Grok Bot | Settings → Plugins → 커스텀 MCP → 주소 + 헤더 `Authorization: Bearer (개인 토큰)` |
| Meta Muse | MCP 메뉴가 없어요. 개인 토큰을 만든 뒤 Muse에게 "이 주소와 헤더로 MCP 연결 스킬을 만들어 줘"라고 요청 |

그다음 각 AI의 커스텀 지침에 설정 화면의 **AI 지침 문구**를 한 번 넣어 두세요. 쓰기(제안)가 막힌 AI는 브리핑을 MCP로 받고, 대화 끝에 받은 `[Hub 메모]`를 **붙여넣기**로 반영하면 돼요.

### MCP 도구

| 도구 | 권한 | 하는 일 |
|---|---|---|
| `list_projects` | 읽기 | 프로젝트 목록 |
| `get_brief` | 읽기 | 프로젝트 브리핑(S/M/L). 프로젝트를 비우면 전체 요약 |
| `list_tasks` | 읽기 | 할 일 조회 (프로젝트·상태·역할·마감 조건) |
| `search` / `fetch` | 읽기 | 전체 검색 / 항목 전체 보기 (`project:1`, `D12`, `T5`, `import:2`…) |
| `propose_decision` | 제안 | 결정 제안 (이전 결정 대체 가능) |
| `propose_task` | 제안 | 새 할 일 또는 기존 할 일 변경·완료 제안 |
| `propose_project` | 제안 | 새 프로젝트 또는 카드 수정 제안 |
| `log_session` | 제안 | 대화 요약·마지막 위치 저장(바로 반영) + 결정·할 일 제안 |

번호 규칙: P=프로젝트, D=결정, T=할 일, L=세션 기록, I=가져온 문서.

## 구조

```
src/
  server.ts, app.ts        진입점, 라우팅
  db.ts                    SQLite 연결·마이그레이션
  auth/                    세션·CSRF, 개인 토큰, OAuth 2.1 인가 서버
  mcp/                     Streamable HTTP 서버, 도구 정의, 입력 검증
  domain/                  프로젝트·할 일·결정·제안·브리핑·검색·메모 파서·가져오기
  web/                     서버 렌더링 화면 (자동 이스케이프 템플릿)
public/                    CSS, 작은 JS (복사·탭·확인창)
test/                      node:test 단위·통합 테스트
```

## 보안

- 비밀번호 로그인, HttpOnly·SameSite=Lax 세션 쿠키, 모든 폼에 CSRF 토큰, CSP·프레임 차단 헤더
- 토큰·인가 코드는 해시로만 저장. OAuth는 PKCE(S256) 필수이고, 리프레시 토큰은 쓸 때마다 새로 발급(회전)해요
- AI 도구는 **제안만** 할 수 있어요. 실제 반영은 인박스 승인(또는 직접 켠 자동 승인 규칙)으로만 돼요
