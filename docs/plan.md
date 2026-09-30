# Hub 기획안 v0.3

> 혼자 여러 프로젝트와 여러 역할을 맡는 사람을 위한 개인용 도구: **작업 관리 + AI 공유 기억 + 견적·정산 관리**
> 작성일: 2026-09-30 · 1단계(노션 대체 + AI 연결) 구현 완료

## 0. 확정·변경 사항 (v0.2 → v0.3)

| 항목 | 내용 |
|---|---|
| 1단계 범위 | **AI 연결 먼저**로 확정하고 구현 완료. 견적·정산은 2단계 |
| 세금계산서 | **모든 거래가 세금계산서 발행 건**. 청구 방식(3.3%, 현금영수증 등) 구분 없이 계산서 흐름 하나로 단순화 |
| ChatGPT | **Pro** 사용. 개인 요금제에서 쓰기 도구가 되는지는 자료마다 다르고, 2026년 9월 말 커스텀 MCP의 쓰기 호출이 막힌다는 보고도 있음 → 읽기(브리핑)는 MCP로, 쓰기는 MCP를 시도하되 `[Hub 메모]` 붙여넣기로 보완 |
| 기술 스택 | Next.js + Supabase → **Node.js 내장 기능 + SQLite 파일 하나** (외부 패키지 0개). 1인용이라 서버 하나와 파일 하나가 운영이 가장 단순하고, 백업은 파일 복사로 끝남. 개발 환경에서 외부 패키지를 설치할 수 없었던 점도 반영 |
| 요약·정리 | Hub에는 LLM API를 붙이지 않음. 요약과 분류는 연결된 AI가 MCP로 하고, Hub는 규칙대로 브리핑을 조립 → API 키와 비용이 들지 않음 |
| 노션 이관 | Hub가 노션 API로 페이지를 가져오고, 정리는 연결된 AI가 `fetch` → `propose_*`로 제안 |
| Muse 예비안 | 노션 미러링 대신 **브리핑 복사 + `[Hub 메모]` 붙여넣기**로 변경 (노션 의존 제거) |

## 1. 해결하려는 문제

1. **작업이 흩어짐**: 프로젝트가 여러 개이고, 역할(개발·기획·디자인·마케팅)도 여러 개임
2. **AI마다, 새 창마다 맥락을 다시 설명해야 함**: 노션 한 페이지 방식은 페이지가 계속 커지고, AI끼리 덮어쓰고, 오래된 정보가 남고, 프로젝트가 서로 섞임
3. **돈 흐름을 놓침**: 견적 발송, 계산서 발행, 입금 여부가 한눈에 보이지 않음

## 2. 설계 원칙

1. **원본은 Hub 하나**: 나와 모든 AI가 같은 데이터를 본다
2. **AI는 제안하고, 반영은 내가 한다**: 결정·할 일·카드 변경은 인박스에서 승인. 세션 요약과 마지막 위치는 바로 저장
3. **필요한 만큼만 넘긴다**: 프로젝트별, 분량별(S/M/L) 브리핑
4. **숫자는 코드가 계산한다**: 금액·부가세·분할 금액은 AI가 아니라 코드로 계산 (2단계)
5. **입력은 말하듯이**: `브랜드X 로고 시안 금요일까지 #디자인 !`
6. **MCP는 편의 수단, 복사는 보험**: 어떤 AI 연결이 막혀도 브리핑 복사와 붙여넣기로 대신할 수 있다

## 3. 모듈

### 3.1 작업 관리 — 1단계 ✅

- **오늘 보드**: 모든 진행 중 프로젝트의 지난 마감 / 오늘 / 진행 중 / 이번 주 / 마감 없음. 역할 필터
- **빠른 입력**: 프로젝트 이름(또는 `@이름`), `#역할`, 날짜 표현(오늘·내일·금요일·다음 주 월요일·10/3·3일 후·월말), `!`(긴급)을 인식
- **마지막 위치**: 프로젝트마다 "어디까지 했는지" 한 줄. AI의 `log_session`도 갱신하고, 모든 브리핑에 들어감
- 주간 리뷰는 3단계

### 3.2 AI 공유 기억 — 1단계 ✅

| 레이어 | 내용 |
|---|---|
| Profile | 이름, 소개, 작업 선호. 모든 브리핑 맨 위에 들어감 |
| Project Card | 한 줄 소개, 목표, 타깃, 현재 단계, 제약, 작업 범위, 링크, 상태 |
| Decision Log | 결정·이유·출처. 뒤집힌 결정은 대체 관계로 남기고 브리핑에서 뺌 |
| Task | 역할, 우선순위, 상태, 마감, 출처 |
| Session Log | AI 대화 요약과 출처 |

**브리핑**: S(짧게) / M(기본: 결정 10개, 할 일 10개, 최근 세션 2개) / L(전체). 카드가 30일 넘게 안 바뀌었으면 ⚠️ 표시. 복사용 브리핑에는 대화를 마칠 때 `[Hub 메모]`로 정리해 달라는 안내가 붙는다.

**원격 MCP 도구 9개**

| 도구 | 권한 | 반영 |
|---|---|---|
| `list_projects`, `get_brief`, `list_tasks`, `search`, `fetch` | 읽기 | — |
| `propose_decision`, `propose_task`, `propose_project` | 제안 | 인박스 승인 (자동 승인 규칙 가능) |
| `log_session` | 제안 | 요약·마지막 위치는 바로 저장, 결정·할 일·완료 처리는 인박스 |

`search`와 `fetch`는 ChatGPT 커넥터가 기대하는 형태(결과 id·title·url / 문서 id·title·text·url)를 따른다.

### 3.3 견적·정산 — 2단계 (설계)

**흐름**: 문의 → 견적 작성 → **견적 발송** → 협의(수정 견적) → **수주**/실주 → 진행 → 납품 → **세금계산서 발행** → **입금 완료**

- 결제 조건(선금/잔금 등)에 따라 청구 건을 자동으로 나누고, 청구 건마다 계산서·입금 상태를 따로 추적
- 현황 보드: 거래처 · 건명 · 금액 · 견적 · 수주 · 계산서 · 입금 · 다음 할 일
- 알림(기본값): 발송 후 5일 무응답 → 팔로업 / 유효기간 D-3 / 계산서 발급 기한 D-day (기본: 공급한 달의 다음 달 10일) / 입금 예정일 경과
- AI 견적 작성: `B사 상세페이지 리뉴얼 — 기획 50, 디자인 120, 퍼블리싱 80 / 부가세 별도 / 선금 50 잔금 50` → AI가 구조화하고 코드가 계산 → 표 편집 → 직인 포함 PDF
- 수주하면 프로젝트 카드와 할 일 초안을 만들고, 견적 범위를 카드의 **작업 범위**로 넣는다
- 세금계산서: 처음에는 홈택스에서 직접 발행하고 Hub에서 체크(+ 홈택스 입력용 정보 복사). 나중에 발행 대행 API(팝빌 등) 검토
- 금액·사업자번호·연락처는 기본적으로 AI 브리핑에서 뺀다
- MCP 도구 추가 예정: `draft_quote`, `money_status`(별도 권한)

## 4. AI 연결 (2026년 9월 조사 기준)

네 AI 모두 **AI 회사의 클라우드에서** MCP 서버에 접속한다 → Hub는 **공개 HTTPS 주소와 인증**이 필요하다 (localhost 불가).

| AI | 연결 방식 | 비고 |
|---|---|---|
| Claude (데스크톱·웹) | 커스텀 커넥터로 원격 MCP 추가 → OAuth | 공식 SDK 클라이언트로 OAuth 전체 흐름 검증 완료 |
| ChatGPT (Pro) | 웹에서 Developer mode → 커넥터 추가(OAuth). 데스크톱 앱에는 계정으로 동기화 | 쓰기 도구 제한·차단 가능성 → 붙여넣기로 보완 |
| Grok | grok.com 커넥터 → Custom → OAuth | |
| Grok Bot | Settings → Plugins → 커스텀 MCP + `Authorization: Bearer` 개인 토큰 | |
| Meta Muse | MCP 메뉴 없음. 주소와 토큰을 주면 Muse가 연결 스킬을 만드는 방식 | 안 되면 브리핑 복사 + 붙여넣기 |

인증은 **OAuth 2.1(동적 클라이언트 등록, PKCE S256, 리프레시 토큰 회전)**과 **개인 토큰**을 둘 다 지원하고, 권한은 읽기/제안으로 나눈다.

## 5. 화면

- 1단계 ✅: 오늘 · 프로젝트(목록/상세) · 인박스 · 붙여넣기 · 가져오기 · 설정(프로필, AI 연결 안내와 지침 문구, 개인 토큰, 연결된 앱, 자동 승인, MCP 호출 기록, 백업) · 로그인 · OAuth 동의
- 2단계: 견적·정산 보드, 견적 작성, 거래처·단가표, 사업자 정보·직인

## 6. 데이터 모델

1단계 구현 (SQLite):

```
profile, settings
projects       이름, 상태, 카드 필드, 마지막 위치(내용·시각·출처)
tasks          project_id, 제목, 역할, 상태, 우선순위, 마감, 메모, 출처, 완료 시각
decisions      project_id, 내용, 이유, 출처, superseded_by
session_logs   project_id, 출처, 요약
proposals      종류, project_id, 내용(JSON), 출처, 상태, 결과 id
imports        출처(notion/text), 제목, 내용
api_tokens, oauth_clients, oauth_codes, oauth_tokens   (전부 해시 저장)
mcp_calls      호출 기록 (최근 2000건 유지)
```

2단계 추가 예정:

```
clients      상호, 사업자번호, 대표자, 담당자, 연락처, 계산서 수신 메일, 주소, 업태/종목
price_items  품목, 단위, 기본 단가, 역할
quotes       번호, client_id, project_id, 버전, 상태, 견적일, 유효기간, 부가세 방식, 결제 조건, 합계
quote_items  quote_id, 품목, 규격, 수량, 단가, 금액
billings     quote_id, 구분(선금/잔금/전액), 공급가액, 세액, 청구 예정일,
             계산서 발행일·승인번호, 입금 예정일·입금일
```

## 7. 기술 스택

| 영역 | 선택 |
|---|---|
| 런타임 | Node.js 22.18+ (24 LTS 권장). TypeScript를 빌드 없이 Node가 직접 실행 |
| DB | `node:sqlite` 파일 하나 (WAL 모드). 백업 = 파일 복사 또는 설정의 백업 다운로드 |
| 웹 | `node:http` + 서버 렌더링 HTML(자동 이스케이프 템플릿) + 작은 JS |
| MCP | Streamable HTTP, 상태 없음(JSON 응답), 프로토콜 2024-11-05 ~ 2025-11-25 지원 |
| 배포 | Docker 이미지 + 영구 볼륨. VPS + Caddy / Fly.io·Railway·Render / 집 PC + Cloudflare Tunnel |
| 테스트 | `node:test` 단위·통합 테스트 33개 + 공식 MCP SDK 클라이언트로 PAT·OAuth 접속 검증 |

## 8. 로드맵

| 단계 | 상태 | 범위 |
|---|---|---|
| 1. 노션 대체 + AI 연결 | ✅ 구현 | 위 3.1·3.2, OAuth·개인 토큰, 인박스, 붙여넣기, 노션 가져오기, 백업 |
| 1.5 실사용 연결 | 다음 | 배포 → 네 AI 실제 연결 테스트 → 기존 노션 페이지 이관 → 지침 문구 다듬기 |
| 2. 견적·정산 | 예정 | 3.3 전체 |
| 3. 편의·자동화 | 예정 | 데스크톱 퀵바(전역 단축키 입력·캡처), 주간 리뷰, 계산서 API 발행이나 홈택스 조회 검토, 견적 메일 발송 |

## 9. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| 승인할 게 많아서 귀찮아짐 | 요약·마지막 위치는 바로 저장, 모두 승인, 종류별 자동 승인 |
| AI 서비스 정책·기능 변경으로 연결이 끊김 | 원본은 Hub. 브리핑 복사 + `[Hub 메모]` 붙여넣기로 항상 대신 가능. MCP 호출 기록으로 원인 확인 |
| 거래처·금액 정보 유출 | MCP 인증 필수, 토큰 해시 저장, 권한 분리, 돈 관련 도구는 별도 권한(2단계) |
| 서버·디스크 장애 | SQLite 파일 백업 (정기 백업 자동화는 배포 위치 정한 뒤) |
| 세무 규칙을 잘못 적용함 | 기한 등은 기본값 + 설정 변경. 실제 적용은 세무사에게 확인 |

## 10. 결정이 필요한 것

1. **배포 위치와 주소** (1.5단계): VPS·Fly.io 같은 클라우드, 또는 집 PC + Cloudflare Tunnel 중 어디로 할지. 도메인이 있는지
2. (2단계) 견적 금액은 부가세 별도가 기본인지, 선금·잔금 분할이 흔한지, 지금 쓰는 견적서 양식(엑셀·한글·PDF)
3. (3단계) 주로 쓰는 OS: Mac / Windows

## 참고 자료

- Meta Muse 연결: [parallel.ai](https://parallel.ai/articles/meta-muse-custom-integrations), [sprites.ai](https://www.sprites.ai/muse/mcp)
- ChatGPT: [OpenAI Developer mode](https://developers.openai.com/api/docs/guides/developer-mode/), [Apps SDK: Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt/), [OpenAI 도움말(요금제별 지원)](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta), [Boomi(Plus·Pro 읽기 전용 언급)](https://help.boomi.com/docs/Atomsphere/Connect/MCPSetup/Connect_chatgpt_setup), [OpenAI 커뮤니티(쓰기 호출 차단 보고)](https://community.openai.com/t/chatgpt-safety-layer-blocks-valid-mcp-tool-calls/1400691), [데스크톱 동기화](https://docs.ternary.app/docs/ternary-mcp-for-chatgpt)
- Grok: [xAI Grok Connectors](https://docs.x.ai/grok/connectors), [Custom MCP Tunneling](https://docs.x.ai/grok/connectors/custom-mcp-tunneling), [Grok Bot 헤더 인증 예시](https://awaken.tax/docs/consumer/grok-mcp)
- 팝빌 SDK: [linkhub-sdk/node-popbill](https://github.com/linkhub-sdk/node-popbill)

*조사 내용은 라이선스 준수를 위해 요약하고 다시 정리했습니다.*
