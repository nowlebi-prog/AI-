# Hub 기획안 v0.4

> 혼자 여러 프로젝트와 여러 역할을 맡는 사람을 위한 개인용 도구: **작업 관리 + AI 공유 기억 + AI 실행 + 견적·정산 관리**
> 작성일: 2026-09-30 · 1단계(노션 대체 + AI 연결)와 1.2단계(실사용 편의·연계) 구현 완료 · 사용법은 [GUIDE.md](GUIDE.md)

## 0. 확정·변경 사항 (v0.3 → v0.4)

| 항목 | 내용 |
|---|---|
| AI 실행 (신규) | 할 일을 적으면 **어떤 AI·모델로 할지 추천**하고, 확인하면 그 AI로 실행. 판단은 **Jev(TypeSafe의 판단 전용 모델)**, 키가 없거나 실패하면 규칙으로. 실행은 ① 구독 중인 앱을 프롬프트가 채워진 채로 열기(키 불필요) ② 서버에 API 키가 있으면 Hub가 바로 실행하고 결과의 `[Hub 메모]`를 자동 반영 |
| 요약·정리 원칙 | Hub 핵심 기능에는 여전히 LLM을 붙이지 않음(요약·분류는 연결된 AI가 MCP로). **AI 실행만** 선택적으로 API 키를 씀 |
| 레퍼런스 (신규) | 링크를 넣으면 제목·설명·썸네일을 읽고 카테고리(디자인·개발·마케팅·기획·문서·PPT…) 추천. 태그·메모·프로젝트 연결, 검색. AI도 저장·검색 가능 |
| 대시보드 (신규) | **현황**(분야별·프로젝트별·14일 마감) + **월간 달력**(노션 캘린더식 한 달 보기, 분야 필터, 진행도 %) |
| 하루 마감 (신규) | 오늘 요약 → 못 끝낸 일 넘기기 → 오늘 저장한 것·**내 컴퓨터 파일 정리**(남길 것만 체크 → Grok Bot 요청문과 휴지통 명령 생성) → 한 줄 회고 |
| 분야 | 개발·기획·디자인·마케팅에 **문서·PPT**를 추가 (운영·기타 포함 7개). 프로젝트에도 주 분야를 둠 |
| 반영 정책 | AI 제안은 인박스 승인이 기본. 내가 AI에게 **직접 시킨 변경**은 바로 반영(끌 수 있음). 바로 반영된 모든 변경은 **변경 기록**에 남고 되돌릴 수 있음. 같은 할 일·결정은 중복 제안을 막음 |
| 편의 기능 | 할 일 편집·미루기·대기·반복, 여러 줄 추가, 입력 미리보기, 전체 검색, 캘린더 구독(ICS), 앱 설치(PWA), 단축키, 매일 자동 백업, 로그인 자동 연장, 하루 시작 시각 |

## 1. 해결하려는 문제

1. **작업이 흩어짐**: 프로젝트가 여러 개이고, 역할(개발·기획·디자인·마케팅·문서)도 여러 개임
2. **AI마다, 새 창마다 맥락을 다시 설명해야 함**: 노션 한 페이지 방식은 페이지가 계속 커지고, AI끼리 덮어쓰고, 오래된 정보가 남고, 프로젝트가 서로 섞임
3. **어떤 일을 어떤 AI에 맡길지 매번 고민함**: AI·모델마다 잘하는 일이 다름
4. **본 것·받은 것이 쌓임**: 좋은 사이트는 어디 뒀는지 잊고, 다운로드 폴더는 계속 쌓임
5. **돈 흐름을 놓침**: 견적 발송, 계산서 발행, 입금 여부가 한눈에 보이지 않음 (2단계)

## 2. 설계 원칙

1. **원본은 Hub 하나**: 나와 모든 AI가 같은 데이터를 본다
2. **AI는 제안하고, 반영은 내가 한다**: 직접 시킨 것만 바로 반영하고, 그것도 되돌릴 수 있다
3. **필요한 만큼만 넘긴다**: 프로젝트별, 분량별(S/M/L) 브리핑
4. **숫자는 코드가 계산한다**: 진행도·금액·부가세는 AI가 아니라 코드로
5. **입력은 말하듯이**: `브랜드X 로고 시안 금요일까지 #디자인 !`
6. **MCP는 편의 수단, 복사는 보험**: 어떤 AI 연결이 막혀도 브리핑 복사와 붙여넣기로 대신할 수 있다
7. **지우는 건 사람이**: 파일은 Hub가 지우지 않는다. 요청문·명령만 만들고, 명령도 휴지통으로만 옮긴다

## 3. 메뉴와 연결 (정보 구조)

| 메뉴 | 기능 | 이어지는 곳 |
|---|---|---|
| 오늘 `/` | 지난 마감·오늘·진행 중·7일 안·대기·나중·마감 없음, 빠른 추가, 인박스 미리보기, 브리핑 복사, 🌙 하루 마감 | 할 일 ⋯ → AI 실행 · 하루 마감 |
| 대시보드 `/dashboard` · `/calendar` | 현황(분야 카드, 14일 마감, 분야별 프로젝트 진행도, 프로젝트×분야) · 월간 달력(분야 필터, 이번 달·프로젝트 진행도) | 분야 카드 → 오늘(분야 필터) · 항목 → 프로젝트 · 날짜 ＋ → 빠른 추가 |
| 프로젝트 | 카드, 진행도, 할 일, 결정, 레퍼런스, 세션 기록, 마지막 위치, 브리핑 | AI 실행(프로젝트 지정) · 레퍼런스(프로젝트 필터) |
| 레퍼런스 | 링크 저장·분류·검색·태그 | 프로젝트 · 검색 · 브리핑(L) · MCP |
| AI 실행 | 추천(Jev/규칙) → 앱에서 열기 / API 실행 → 결과 반영 | 인박스 · 붙여넣기 |
| 인박스 | 제안 승인·수정·거절, 프로젝트별 모두 승인, 변경 기록·되돌리기 | — |
| 붙여넣기 | `[Hub 메모]` 반영 (형식이 달라도 읽음) | 인박스 |
| 하루 마감 `/wrapup` | 요약·넘기기·파일 정리·회고 | Grok Bot 요청문 · 휴지통 명령 |
| 검색 | 프로젝트·결정·할 일·레퍼런스·AI 기록·가져온 문서 | 각 항목 |
| 설정 | 프로필, AI 연결, AI 실행(추천표·앱 주소), 자동화, 캘린더, 토큰, 연결된 앱, 호출 기록, 데이터(백업·노션 가져오기) | — |

## 4. 모듈

### 4.1 작업 관리 ✅

- **빠른 입력**: 프로젝트 이름(또는 `@이름`), `#분야`, 날짜 표현(오늘·내일·금요일·다음 주 월요일·10/3·3일 후·월말), 반복(매주 월·매월 10일·평일마다), `!`(긴급). 입력하는 동안 미리보기
- **할 일**: 편집, 미루기(오늘·내일·다음 주·마감 없음), 대기(무엇을 기다리는지), 반복(완료하면 다음 차례 생성), 여러 줄 한 번에 추가
- **마지막 위치**: 프로젝트마다 "어디까지 했는지" 한 줄. AI의 `log_session`도 갱신하고, 모든 브리핑에 들어감
- **하루 시작 시각**: 새벽 작업을 전날로 치는 기준 (기본 자정)

### 4.2 AI 공유 기억 ✅

| 레이어 | 내용 |
|---|---|
| Profile | 이름, 소개, 작업 선호. 모든 브리핑 맨 위 |
| Project Card | 한 줄 소개, 목표, 타깃, 현재 단계, 제약, 작업 범위, 링크, 상태, 주 분야 |
| Decision Log | 결정·이유·출처. 뒤집힌 결정은 대체 관계로 남기고 브리핑에서 뺌 |
| Task | 분야, 우선순위, 상태, 마감, 반복, 대기, 출처 |
| Session Log | AI 대화 요약과 출처, 하루 마감 회고 |
| Reference | 링크, 제목·설명·썸네일, 카테고리, 태그, 메모, 프로젝트 |

**원격 MCP 도구 14개** — 읽기: `list_projects`, `get_brief`, `list_tasks`, `recent_activity`, `search`, `fetch`, `find_references`, `get_file_cleanup` / 쓰기: `save_reference`, `submit_files` / 제안: `propose_decision`, `propose_task`, `propose_project`(결정·할 일 포함 가능), `log_session`. `direct=true`는 사용자가 직접 시킨 경우에만 바로 반영.

### 4.3 AI 실행 ✅

- **판단**: Jev에 요청문을 보내 종류(choice 8개 + 해당 없음), 웹 검색 필요(noul), 난이도(score 3단계)를 한 번에 묻는다. 확률이 두 번째로 높은 종류의 추천 AI도 대안으로 보여 준다. 키가 없거나 실패하면 키워드 규칙으로
- **추천표 기본값** (설정에서 변경): 개발·기획·분석 → Claude `claude-opus-5-5` · 글·이미지 → ChatGPT `gpt-6-sol` · 간단한 질문 → ChatGPT `gpt-6-luna` · 최신 정보 → Grok `grok-4.7` · 대신 처리 → Muse `muse-spark-1.3`
- **앱에서 열기**: ChatGPT·Claude·Grok은 새 대화 주소에 프롬프트를 채우고, Muse나 긴 프롬프트는 복사 후 홈을 연다. Hub MCP가 연결된 AI에는 브리핑 대신 짧은 요청만 보낸다
- **API 실행**: OpenAI Responses, Anthropic Messages, OpenAI 호환 chat 형식. 브리핑을 붙여 보내고, 결과의 `[Hub 메모]`로 세션 기록·제안을 만든다
- 이미지 생성과 대신 처리(브라우저 작업)는 앱에서만

### 4.4 레퍼런스 ✅

링크의 og 태그로 제목·설명·썸네일을 채우고(내부 주소는 접속하지 않음), 사이트·제목으로 카테고리를 추천한다. 같은 링크는 합친다. AI가 `save_reference`로 저장한 것도 변경 기록에서 되돌릴 수 있다.

### 4.5 대시보드·월간 달력 ✅

- 현황: 분야별 열린 일·지난 마감·7일 안·진행 중·대기·7일 완료, 14일 마감 그래프, 분야별 프로젝트(다음 할 일·마지막 위치·진행도), 프로젝트×분야 표
- 월간 달력: 월 이동, 분야·프로젝트 필터, 반복 할 일의 다음 차례 표시, 이번 달 진행도(이달 마감 중 완료)·프로젝트 진행도(반복 제외 할 일 중 완료)

### 4.6 하루 마감 ✅

- 설정한 시각(기본 18시)이 지나면 오늘 화면에 안내. 마감하면 그날은 다시 뜨지 않음
- 파일 정리: Hub는 로컬 파일을 볼 수 없으므로 ① Mac·Windows 목록 명령(읽기 전용, 클립보드로 복사) 결과를 붙여 넣거나 ② 파일에 접근하는 AI가 `submit_files`로 보낸다 → 남길 것만 체크 → **Grok Bot 요청문**(확인 후 휴지통으로만) + Grok Bot이 Hub에 연결된 경우의 짧은 요청 + 직접 실행용 휴지통 명령(macOS 15+ 내장 `trash`, 이전 버전은 `~/.Trash`, Windows는 휴지통 API)
- Grok Bot은 xAI 클라우드에서 동작해서 내 PC 파일에 닿지 못할 수 있음 → 휴지통 명령으로 보완

### 4.7 견적·정산 — 2단계 (설계, 변경 없음)

**흐름**: 문의 → 견적 작성 → **견적 발송** → 협의(수정 견적) → **수주**/실주 → 진행 → 납품 → **세금계산서 발행** → **입금 완료**

- 모든 거래가 세금계산서 발행 건. 결제 조건(선금/잔금 등)에 따라 청구 건을 나누고, 청구 건마다 계산서·입금 상태를 추적
- 현황 보드: 거래처 · 건명 · 금액 · 견적 · 수주 · 계산서 · 입금 · 다음 할 일
- 알림(기본값): 발송 후 5일 무응답 → 팔로업 / 유효기간 D-3 / 계산서 발급 기한 D-day (기본: 공급한 달의 다음 달 10일) / 입금 예정일 경과
- AI 견적 작성: `B사 상세페이지 리뉴얼 — 기획 50, 디자인 120, 퍼블리싱 80 / 부가세 별도 / 선금 50 잔금 50` → AI가 구조화하고 코드가 계산 → 표 편집 → 직인 포함 PDF
- 수주하면 프로젝트 카드와 할 일 초안을 만들고, 견적 범위를 카드의 작업 범위로
- 세금계산서: 처음에는 홈택스에서 직접 발행하고 Hub에서 체크(+ 입력용 정보 복사). 나중에 발행 대행 API(팝빌 등) 검토
- 금액·사업자번호·연락처는 기본적으로 AI 브리핑에서 뺀다. MCP 도구 `draft_quote`, `money_status`는 별도 권한

## 5. AI 연결 (2026년 9월 조사 기준)

네 AI 모두 **AI 회사의 클라우드에서** MCP 서버에 접속한다 → Hub는 **공개 HTTPS 주소와 인증**이 필요하다 (localhost 불가).

| AI | 연결 방식 | 비고 |
|---|---|---|
| Claude (데스크톱·웹) | 커스텀 커넥터 → OAuth | 공식 SDK 클라이언트로 OAuth 전체 흐름 검증 |
| ChatGPT (Pro) | 웹에서 Developer mode → 커넥터(OAuth). 데스크톱 앱에 동기화 | 쓰기 도구 제한·차단 가능성 → 붙여넣기로 보완 |
| Grok | grok.com 커넥터 → Custom → OAuth | |
| Grok Bot | Plugins → 커스텀 MCP + `Authorization: Bearer` 개인 토큰 | 하루 마감 파일 정리 요청 대상 |
| Meta Muse | MCP 메뉴 없음. 주소와 토큰을 주면 Muse가 연결 스킬을 만드는 방식 | 안 되면 브리핑 복사 + 붙여넣기 |

인증은 **OAuth 2.1(동적 클라이언트 등록, PKCE S256, 리프레시 토큰 회전)**과 **개인 토큰**을 둘 다 지원하고, 권한은 읽기/쓰기로 나눈다.

## 6. 데이터 모델 (SQLite)

```
profile, settings
projects       이름, 상태, 주 분야(kind), 카드 필드, 마지막 위치(내용·시각·출처)
tasks          project_id, 제목, 분야, 상태, 우선순위, 마감, 메모, 출처, 완료 시각,
               대기(waiting), 반복(repeat), 다음 차례(next_task_id)
decisions      project_id, 내용, 이유, 출처, superseded_by
session_logs   project_id, 출처, 요약
proposals      종류, project_id, 내용(JSON), 출처, 상태, 결과 id
activity       바로 반영된 변경(직접·자동 승인·세션·레퍼런스)과 되돌리기용 이전 상태
refs           링크, 정규화 키, 제목·설명·썸네일·사이트, 카테고리, 태그, 메모, project_id, 출처
runs           AI 실행: 요청, 추천(JSON), 선택한 AI·모델, 상태, 응답, 반영 결과
day_files      하루 마감 파일 목록: 날짜, 경로, 출처, 남김/삭제
imports        출처(notion/text), 제목, 내용
api_tokens, oauth_clients, oauth_codes, oauth_tokens   (전부 해시 저장)
mcp_calls      호출 기록 (최근 2000건 유지)
```

2단계 추가 예정: `clients`, `price_items`, `quotes`, `quote_items`, `billings` (v0.3과 같음)

## 7. 기술 스택

| 영역 | 선택 |
|---|---|
| 런타임 | Node.js 22.18+ (24 LTS 권장). TypeScript를 빌드 없이 Node가 직접 실행. 외부 패키지 0개 |
| DB | `node:sqlite` 파일 하나 (WAL). 매일 자동 백업 7개 + 백업 다운로드 |
| 웹 | `node:http` + 서버 렌더링 HTML(자동 이스케이프) + 작은 JS(화면 유지 전송, 인라인 스크립트 없음, CSP) |
| MCP | Streamable HTTP, 상태 없음(JSON 응답), 프로토콜 2024-11-05 ~ 2025-11-25 |
| AI 실행 | TypeSafe System One(`/v1/systemone`), OpenAI Responses, Anthropic Messages, OpenAI 호환 chat |
| 배포 | Docker 이미지 + 영구 볼륨. VPS + Caddy / Fly.io·Railway·Render / 집 PC + Cloudflare Tunnel |
| 테스트 | `node:test` 68개(외부 API는 흉내 서버) + GitHub Actions(Node 22·24) |

## 8. 로드맵

| 단계 | 상태 | 범위 |
|---|---|---|
| 1. 노션 대체 + AI 연결 | ✅ | 작업 관리, AI 공유 기억, OAuth·개인 토큰, 인박스, 붙여넣기, 노션 가져오기, 백업 |
| 1.2 실사용 편의·연계 | ✅ | AI 실행(Jev), 레퍼런스, 대시보드·월간 달력·진행도, 하루 마감·파일 정리, 편의 기능, 사용 가이드 |
| 1.5 실사용 연결 | 다음 | GitHub에 올리기 → 배포 → 네 AI 실제 연결 테스트 → 기존 노션 페이지 이관 → 지침 문구·추천표 다듬기 → Jev 실제 호출 확인 |
| 2. 견적·정산 | 예정 | 4.7 전체 |
| 3. 편의·자동화 | 예정 | 데스크톱 퀵바(전역 단축키 입력·캡처), 주간 리뷰 화면, 파일 정리용 작은 로컬 도우미(목록 자동 전송), 계산서 API 발행이나 홈택스 조회 검토, 견적 메일 발송 |

## 9. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| 승인할 게 많아서 귀찮아짐 | 직접 시킨 변경은 바로 반영, 요약·마지막 위치도 바로 저장, 프로젝트별 모두 승인, 종류별 자동 승인 |
| AI가 잘못 반영함 | 바로 반영된 모든 변경을 기록하고 되돌리기 제공. 중복 제안 차단 |
| AI 서비스 정책·기능 변경으로 연결이 끊김 | 원본은 Hub. 브리핑 복사 + `[Hub 메모]` 붙여넣기로 항상 대신 가능. MCP 호출 기록으로 원인 확인 |
| 모델이 금방 바뀜 | 추천표·모델 이름·앱 주소를 설정에서 바꿀 수 있음 |
| Jev·AI API 비용·장애 | 키는 선택. 없거나 실패하면 규칙 추천과 앱에서 열기로 동작. Jev 호출은 4초 제한 |
| 파일을 잘못 지움 | Hub는 지우지 않음. 남길 것만 체크하는 방식, 실행 전 확인 요청, 휴지통으로만 이동 |
| 거래처·금액 정보 유출 | MCP 인증 필수, 토큰 해시 저장, 권한 분리, 돈 관련 도구는 별도 권한(2단계) |
| 서버·디스크 장애 | 매일 자동 백업 7개. 배포처의 볼륨 스냅샷도 같이 쓰기를 권장 |
| 세무 규칙을 잘못 적용함 | 기한 등은 기본값 + 설정 변경. 실제 적용은 세무사에게 확인 |

## 10. 결정이 필요한 것

1. **배포 위치와 주소** (1.5단계): VPS·Fly.io 같은 클라우드, 또는 집 PC + Cloudflare Tunnel 중 어디로 할지. 도메인이 있는지
2. **주로 쓰는 OS** (Mac / Windows): 하루 마감 파일 목록·휴지통 명령의 기본 탭과 3단계 데스크톱 퀵바에 반영
3. **AI 실행을 API로도 쓸지**: 쓴다면 어떤 회사 키를 넣을지 (구독 앱으로 여는 것만으로 충분하면 키 없이)
4. (2단계) 견적 금액은 부가세 별도가 기본인지, 선금·잔금 분할이 흔한지, 지금 쓰는 견적서 양식(엑셀·한글·PDF)

## 참고 자료

- Jev (TypeSafe): [소개 글](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [요청·응답 예시(실제 API 호출 결과)](https://github.com/aarora79/jev-samples), [호환 서버의 API 형식 정리](https://github.com/razorback16/openjev)
- 모델: [GPT-6 Sol·Luna](https://openai.com/index/introducing-gpt-6-sol-and-luna/), [GPT-6 Sol 모델 문서](https://developers.openai.com/api/docs/models/gpt-6-sol), [Claude Opus 5.5 문서](https://platform.claude.com/docs/en/models/opus-5-5/overview), [Grok 4.7 (xAI 릴리스 노트)](https://docs.x.ai/developers/release-notes), [Muse Spark 1.3 (Meta 모델 문서)](https://ai.developer.meta.com/docs/models/)
- macOS 내장 `trash` 명령: [sindresorhus/macos-trash](https://github.com/sindresorhus/macos-trash)
- Meta Muse 연결: [parallel.ai](https://parallel.ai/articles/meta-muse-custom-integrations), [sprites.ai](https://www.sprites.ai/muse/mcp)
- ChatGPT: [OpenAI Developer mode](https://developers.openai.com/api/docs/guides/developer-mode/), [Apps SDK: Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt/), [OpenAI 도움말(요금제별 지원)](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta), [OpenAI 커뮤니티(쓰기 호출 차단 보고)](https://community.openai.com/t/chatgpt-safety-layer-blocks-valid-mcp-tool-calls/1400691)
- Grok: [xAI Grok Connectors](https://docs.x.ai/grok/connectors), [Custom MCP Tunneling](https://docs.x.ai/grok/connectors/custom-mcp-tunneling), [Grok Bot 헤더 인증 예시](https://awaken.tax/docs/consumer/grok-mcp)
- 팝빌 SDK: [linkhub-sdk/node-popbill](https://github.com/linkhub-sdk/node-popbill)

*조사 내용은 라이선스 준수를 위해 요약하고 다시 정리했습니다.*
