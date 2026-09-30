# Hub

혼자 여러 프로젝트(개발·기획·디자인·마케팅·문서)를 하는 사람을 위한 개인 작업 허브예요. 할 일·결정·레퍼런스를 한곳에 모아 두면 **Claude·ChatGPT·Grok·Muse가 MCP로 같은 맥락을 읽고 기록**해요. 새 창을 열 때마다 다시 설명하지 않아도 돼요.

- **처음이면 [사용 가이드](docs/GUIDE.md)부터 보세요** — 메뉴 지도, 첫 설정, 하루 사용 흐름
- 기획 문서: [docs/plan.md](docs/plan.md)
- 런타임: Node.js 22.18 이상 (24 LTS 권장). **외부 패키지 없음**, 빌드 없음. DB는 내장 SQLite 파일 하나

## 할 수 있는 것

| 메뉴 | 기능 |
|---|---|
| 오늘 | 모든 프로젝트의 지난 마감·오늘·진행 중·7일 안·대기·나중·마감 없음. 빠른 추가(`브랜드X 로고 시안 금요일까지 #디자인 !`), 여러 줄 추가, 미루기·대기·반복·편집, 인박스 미리보기, 브리핑 복사, 🌙 하루 마감 |
| 대시보드 | **현황**: 분야별 현황, 다가오는 마감, 프로젝트별 진행도(%), 프로젝트×분야 표 · **월간 달력**: 노션 캘린더처럼 한 달 보기, 분야 필터, 분야별·프로젝트별 진행도 |
| 프로젝트 | 카드(목표·타깃·단계·제약·범위), 진행도, 결정 로그, 할 일, 세션 기록, 마지막 위치, 레퍼런스, S/M/L 브리핑 |
| 레퍼런스 | 링크를 넣으면 제목·설명·썸네일을 읽고 카테고리(디자인·개발·마케팅·기획·문서·PPT…)를 추천. 태그·프로젝트 연결, 검색, 여러 개 한 번에 추가 |
| AI 실행 | 할 일을 적으면 **Jev(또는 규칙)가 어떤 AI·모델로 할지 추천** → 확인하면 앱에서 열기(프롬프트 채움) 또는 API로 바로 실행 → 결과의 `[Hub 메모]` 자동 반영 |
| 인박스 | AI 제안 승인·수정·거절, 프로젝트별 모두 승인, AI가 바로 반영한 변경 기록과 **되돌리기** |
| 붙여넣기 | MCP를 못 쓰는 AI의 `[Hub 메모]`를 붙여 넣어 반영 (형식이 조금 달라도 읽어요) |
| 하루 마감 | 오늘 한 일 요약 → 못 끝낸 일 넘기기 → 오늘 저장한 것·**내 컴퓨터 파일 정리**(남길 것만 체크 → Grok Bot 요청문·휴지통 명령) → 한 줄 회고 |
| 설정 | 프로필, AI 연결 안내와 지침 문구, AI 실행(추천표·앱 주소), 자동화, 캘린더 구독(ICS), 개인 토큰, 연결된 앱, MCP 호출 기록, 백업, 노션 가져오기 |

그 밖에: 전체 검색(`/`), 단축키, 앱으로 설치(PWA), 매일 자동 백업 7개 보관, 쓰는 동안 로그인 자동 연장.

## 로컬 실행

```bash
cp .env.example .env      # HUB_PASSWORD를 채우세요
npm start                 # http://localhost:3000
npm test                  # 단위·통합 테스트 (node:test)
```

`npm run dev`는 파일이 바뀌면 다시 시작해요. 타입 검사는 `npm install` 후 `npm run typecheck`로 해요 (typescript, @types/node 개발 의존성). 실행에는 설치가 필요 없어요.

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
| `HUB_PUBLIC_URL` | 배포 시 ✅ | 외부 주소 (예: `https://hub.example.com`). OAuth 메타데이터·캘린더 주소에 쓰여요 |
| `HUB_DATA_DIR` | | 데이터 폴더 (기본 `./data`, Docker는 `/data`). 매일 백업은 `backups/`에 |
| `HUB_SECRET` | | 세션 서명 키. 비우면 자동 생성해서 DB에 저장 |
| `HUB_TZ` | | 날짜 기준 시간대 (기본 `Asia/Seoul`) |
| `NOTION_TOKEN` | | 노션 가져오기 기본 토큰 |
| `PORT` / `HOST` | | 기본 `3000` / `0.0.0.0` |
| `TYPESAFE_API_KEY` | | Jev로 AI 추천 (없으면 규칙으로 추천). `TYPESAFE_MODEL` 기본 `jev-latest` |
| `OPENAI_API_KEY` | | AI 실행을 ChatGPT API로 (`OPENAI_BASE_URL` 선택) |
| `ANTHROPIC_API_KEY` | | AI 실행을 Claude API로 (`ANTHROPIC_BASE_URL` 선택) |
| `XAI_API_KEY` | | AI 실행을 Grok API로 (`XAI_BASE_URL` 선택) |
| `META_API_KEY` + `META_API_BASE_URL` | | AI 실행을 Muse(Meta, OpenAI 호환 chat) API로 |

AI 키는 전부 선택이에요. 키가 없어도 구독 중인 앱으로 여는 방식은 그대로 돼요. API 사용료는 각 회사에 별도로 내요.

## AI 연결

MCP 주소: `https://(내 주소)/mcp` (끝에 `/`를 붙이지 마세요). 연결 방법은 AI마다 달라서 [사용 가이드](docs/GUIDE.md#3-ai-연결)와 설정 → **AI 연결**에 정리해 뒀어요. 연결한 뒤 설정의 **AI 지침 문구**를 각 AI의 커스텀 지침에 한 번 넣어 두면 돼요.

### MCP 도구 (14개)

| 도구 | 권한 | 하는 일 |
|---|---|---|
| `list_projects` | 읽기 | 프로젝트 목록 |
| `get_brief` | 읽기 | 프로젝트 브리핑(S/M/L). 프로젝트를 비우면 전체 요약 |
| `list_tasks` | 읽기 | 할 일 조회 (프로젝트·상태·분야·마감 조건) |
| `recent_activity` | 읽기 | 최근 N일의 완료·새 결정·새 할 일·AI 세션 모아 보기 (주간 리뷰, 다른 AI 작업 이어받기) |
| `search` / `fetch` | 읽기 | 전체 검색 / 항목 전체 보기 (`project:1`, `D12`, `T5`, `R3`…) |
| `find_references` | 읽기 | 저장한 레퍼런스 찾기 (단어·카테고리·태그·프로젝트) |
| `get_file_cleanup` | 읽기 | 하루 마감에서 고른 '지울 파일' 목록 받기 |
| `save_reference` | 쓰기 | 링크 저장 (바로 저장, 되돌리기 가능) |
| `submit_files` | 쓰기 | 오늘 생긴 파일 목록을 하루 마감 화면으로 보내기 |
| `propose_decision` | 제안 | 결정 제안 (이전 결정 대체 가능) |
| `propose_task` | 제안 | 새 할 일 또는 기존 할 일 변경·완료 제안 |
| `propose_project` | 제안 | 새 프로젝트(결정·할 일 포함) 또는 카드 수정 제안 |
| `log_session` | 제안 | 대화 요약·마지막 위치 저장(바로 반영) + 결정·할 일 제안 |

제안은 인박스에서 승인해야 반영돼요. 사용자가 "추가해 줘"처럼 **직접 시킨 변경**은 `direct=true`로 바로 반영되고(설정에서 끌 수 있음), 모두 변경 기록에서 되돌릴 수 있어요. 번호 규칙: P=프로젝트, D=결정, T=할 일, L=세션 기록, R=레퍼런스, I=가져온 문서.

## 구조

```
src/
  server.ts, app.ts        진입점, 라우팅, 자동 백업
  db.ts                    SQLite 연결·마이그레이션
  auth/                    세션·CSRF, 개인 토큰, OAuth 2.1 인가 서버
  mcp/                     Streamable HTTP 서버, 도구 정의, 입력 검증
  domain/                  할 일·반복·결정·제안·변경 기록·브리핑·검색·메모 파서
                           레퍼런스·대시보드·월간 달력·AI 추천(Jev)·AI 실행·하루 마감
  integrations/            AI API 호출(OpenAI·Anthropic·chat 호환), 링크 미리보기
  web/                     서버 렌더링 화면 (자동 이스케이프 템플릿)
public/                    CSS, 작은 JS (화면 유지 전송·복사·탭·단축키)
test/                      node:test 단위·통합 테스트
docs/                      사용 가이드, 기획 문서
```

## 개발

- 테스트: `npm test` (68개: 단위·도메인·웹·MCP·AI 실행). 외부 API는 흉내 서버로 시험해요
- GitHub Actions: `.github/workflows/ci.yml`이 Node 22·24에서 테스트를 돌려요
- 스키마는 `src/db.ts`의 마이그레이션으로 올라가요. 예전 DB 파일도 시작할 때 자동으로 바뀌어요

## 보안

- 비밀번호 로그인(시도 횟수 제한), HttpOnly·SameSite=Lax 세션 쿠키, 모든 폼에 CSRF 토큰, CSP·프레임 차단 헤더
- 토큰·인가 코드는 해시로만 저장. OAuth는 PKCE(S256) 필수이고, 리프레시 토큰은 쓸 때마다 새로 발급(회전)해요
- AI 도구는 제안이 기본이에요. 바로 반영된 변경도 모두 기록되고 되돌릴 수 있어요
- 링크 미리보기는 내부 주소(사설 IP·localhost)에 접속하지 않아요
- 캘린더 구독 주소는 추측할 수 없는 비밀 주소이고, 언제든 바꾸거나 끌 수 있어요
- 파일 정리는 Hub가 직접 지우지 않아요. 요청문·명령만 만들고, 명령도 영구 삭제가 아니라 휴지통으로 옮겨요
