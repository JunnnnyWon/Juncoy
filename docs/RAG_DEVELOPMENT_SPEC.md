# 23시 정시퇴근 프로젝트 지식·이미지 생성 지원 개발 명세서

버전: 1.0 · 작성일: 2026-10-06 (Asia/Seoul) · 상태: 개발 설계안

관련 문서: [개발 플랜](RAG_DEVELOPMENT_PLAN.md), [현재 코드 구조](architecture.md), [기존 API](api.md), [조사 보고서](../graphify-out/RAG_READINESS_2026-10-06.md).

이 문서는 개발 요구사항과 기본 설계를 정한다. 아래의 신규 서비스·API·테이블·지연 목표는 아직 구현하거나 운영 검증한 결과가 아니다. 노션·GitHub·디스코드 내용은 계속 바뀌므로 조사 시점의 게임 설정을 시스템 프롬프트에 고정하지 않는다.

## 1. 목적과 완료 기준

팀원이 프로젝트 질문이나 이미지 요청을 입력하면, 시스템이 Notion, GitHub, Discord 텍스트 대화와 스레드, Juncoy 회의 전사를 수집·검색·대조하여 최신 근거로 답한다. 답변과 이미지 프롬프트에는 확인한 출처·버전·시각을 연결한다. 변경된 결정, 제안, 미정 사항, 구현 상태를 구분한다.

핵심 사용자 요구:

> 자료는 실시간으로 바뀐다. 노션·GitHub·디스코드와 회의록을 종합해 판단해야 하며, 디스코드를 반드시 읽어야 한다.

완료로 인정하는 조건:

1. 네 출처가 모두 실제 인증된 원본으로 연결되어 초기 수집과 변경 반영 시험을 통과한다. Discord는 선택 기능이 아니다.
2. 질문마다 Discord 최신 대화 확인을 수행하며, 다른 출처의 관련 근거도 함께 탐색한다.
3. 삭제·권한 회수·정정·브랜치 변경이 검색과 답변에 반영된다.
4. 답변의 사실 주장은 열 수 있는 근거와 연결되고, 불확실성·충돌·미수집 범위를 표시한다.
5. 이미지 요청이 현재 프로젝트 맥락과 승인된 레퍼런스를 반영한 프롬프트로 변환된다. 실제 이미지 생성의 완료 조건은 별도 이미지 공급자 연결과 생성 검증을 포함한다.
6. 기존 회의 음성 수집·요약 서비스의 동작과 접근 정책이 유지된다.

모델 가중치에 프로젝트 자료를 학습시키는 작업은 초기 범위에 없다. 최신 지식을 검색해 Solar Pro 4 입력으로 제공하는 구조다. Graphify 코드 그래프는 개발 보조 자료이며 운영 RAG 인덱스를 대신하지 않는다.

## 2. 확인된 환경과 미확정 설정

### 2.1 현재 확인된 사실

| 항목 | 확인 내용 | 설계 영향 |
|---|---|---|
| Juncoy | TypeScript 모노레포, Node 24, Fastify, React/Vite, PostgreSQL 17, Kysely | 기존 인증과 UI를 활용하고 지식 처리는 분리 |
| LLM | 운영 UPSTAGE_MODEL=solar-pro4-260806, 해당 모델 요약 저장 확인 | 답변·근거 판단·프롬프트 작성에 Solar Pro 4 사용 |
| Notion | notion-second로 팀 자료 검색·fetch·5개 DB 행 조회 성공 | 운영 수집기의 별도 인증 필요 |
| GitHub | JunnnnyWon/Team_23 비공개 저장소 읽기 성공 | GitHub App 설치 토큰으로 서버 수집 권장 |
| Discord | Bot REST로 본문·수정 시각·답글·첨부 목록 읽기 HTTP 200 | 과거 수집 및 Gateway 이벤트 처리 구현 필요 |
| Discord 스레드 | 활성 3개; 아트·일정·최종 컨셉아트의 공개 보관 스레드 조회 성공, 표본 결과 0개 | 활성/보관/접근 가능한 비공개 스레드 탐색 포함 |
| 회의 | 팀 공유 완료 회의 12개, 확정 발언 15,935개, 전사 272,478자 (앞선 조사 시점) | workspace 공유 범위와 canonical 발언만 초기 사용 |
| 현재 요약 | 주제 중심 출력에서 decisions/action_items 등 배열을 비움 | 빈 배열을 결정 없음으로 해석하지 않음 |
| 게임 구현 | main 외 SideView, Stairs 브랜치에도 작업 존재 | 브랜치별 commit 기준 인덱스 필요 |

자료 수는 스냅샷이다. 파일 수나 채널 이름을 하드코딩한 완료 판정에 쓰지 않는다. 2026-10-06 재확인에서 Notion RAG 작업은 진행 중/10%, 기간 10/5~10/11로 기입되어 있었다. 이것은 프로젝트 관리 기입값이며 개발 구현률을 검증한 값이 아니다.

### 2.2 개발 기본 결정

- 답변 LLM: Upstage Solar Pro 4. 모델 ID는 환경 설정으로 관리하고 실행 결과의 observed_model도 기록한다.
- 원본 수집: 공식 API/Gateway/Webhook. 사용자의 Codex MCP 세션이나 브라우저 로그인 상태에 운영 수집을 의존하지 않는다.
- 지식 저장소: 기존 회의 DB와 분리된 PostgreSQL 17 + pgvector. 로컬 개발·스테이징·운영 볼륨을 분리한다.
- 작업 큐: 지식 DB의 별도 durable queue. 기존 Juncoy jobs를 지식 작업자가 claim하지 않는다.
- 검색: 구조화 속성 조회 + 키워드/코드 식별자 검색 + 임베딩 검색 + 필요한 후보 재정렬.
- 배포: knowledge-api, knowledge-worker, Discord 채팅 수집 프로세스, knowledge-postgres. 기존 음성 봇의 수정은 작고 단계적으로 적용한다.
- 인터페이스: 기존 웹의 프로젝트 질문·이미지 지원 화면. 지식 검색/문답 API를 먼저 구현한다. Discord 명령 진입점은 이후 확장할 수 있다.
- 초기 원본 범위: 팀이 승인한 Notion 루트, Team_23의 지정 브랜치, 지정 Discord 길드·채널과 하위 스레드, Juncoy 팀 공유 회의.

### 2.3 배포 전에 값이 필요한 설정

| 설정 | 기본안 | 확정/검증 시점 |
|---|---|---|
| Notion 운영 인증 | 프로젝트 루트에 연결한 읽기 전용 connection, 필요한 댓글 읽기 capability | 착수일. OAuth MCP 토큰 복사로 대체하지 않음 |
| GitHub 운영 인증 | 지정 저장소의 GitHub App, 필요한 read 권한과 이벤트 | 착수일 |
| 공유 정책 | 프로젝트 전체 공유로 승인된 원본 + 원본별 제한 ACL | 착수일. integration 읽기 권한만으로 팀 전원 공개하지 않음 |
| 임베딩 | Upstage Text Embedding API를 우선 검증, query/document 모델 쌍 | 모델 ID·차원·길이 제한·한국어/코드 recall을 실제 응답으로 확인 |
| 이미지 생성 | 공급자 독립 어댑터; 실제 공급자 아직 미선택 | 이미지 생성 구현 전. 비용·참조 이미지 지원·운영 인증 확인 |
| 아트 프로필 | 사람 승인 + 버전 관리. 최신 문서/채팅을 승인 후보로 제시 | 이미지 프리셋 공개 전 |
| 브랜치 정책 | main, SideView, Stairs를 분리 수집 | 매일 실제 ref와 팀 작업 정책 재확인 |

임베딩 차원이나 모델 ID, 이미지 가격을 추측해 명세의 고정 상수로 사용하지 않는다. 미확정 공급자 때문에 수집·문답 구현을 미루지 않되, 실제 이미지 생성이 없는 상태를 이미지 생성 완료로 보고하지 않는다.

## 3. 필수 요구사항

| ID | 요구사항 | 우선순위 |
|---|---|---|
| R01 | Notion·GitHub·Discord·Juncoy 네 출처 초기/증분 수집 | P0 |
| R02 | 모든 프로젝트 문답에서 Discord 최신 원문 확인 및 반영 | P0 |
| R03 | 수정·삭제·이동·권한 회수·복원 처리와 재처리 멱등성 | P0 |
| R04 | Webhook/Gateway 수신 + 정기 원본 대조 + 질문 시 확인 | P0 |
| R05 | 노션 속성·본문·관계·첨부, Discord 스레드·답글·이미지 문맥 수집 | P0 |
| R06 | GitHub 브랜치/commit별 현재 코드와 변경 이력 구분 | P0 |
| R07 | Juncoy canonical 전사·정정·대체·삭제·workspace 공유 반영 | P0 |
| R08 | 청크/원본/추출/임베딩 버전과 일관된 인덱스 공개 | P0 |
| R09 | 한국어와 코드 식별자 hybrid 검색, 날짜/담당/상태는 구조화 조회 | P0 |
| R10 | 주제·시점·확정성·작성 맥락을 대조한 출처 간 충돌 판단 | P0 |
| R11 | 주장별 원문 citation, 확인 시각, 출처별 검색·동기화 범위 표시 | P0 |
| R12 | 출처 실패·내용 제한·미수집·불명확한 충돌 시 부분 답변 | P0 |
| R13 | 사용자의 원본/프로젝트 접근 권한과 원본 내 지시 분리 | P0 |
| R14 | 질문 중 변경·삭제 시 다시 검증, 캐시와 파생 데이터 무효화 | P0 |
| R15 | Solar Pro 4 호출 분리, 사용량·모델·프롬프트 버전 기록 | P0 |
| R16 | 이미지 프롬프트에 최신 근거와 승인 스타일/참조 버전 반영 | P0 |
| R17 | 실제 이미지 공급자 어댑터·미리보기·재생성·비용 한도 | P1 |
| R18 | 동기화 지연·누락·실패 큐·백필 커버리지 운영 화면 | P0 |
| R19 | 회의/STT 보호, 독립 배포·큐·DB·제한된 리소스 | P0 |
| R20 | 동적 변경과 원본 실패를 포함한 인수 시험 및 회귀 평가 | P0 |

P0는 팀 문답 파일럿의 출시 조건이다. P1 실제 생성은 이미지 생성 제품 출시 조건이며, 프롬프트 지원만 제공할 때는 기능 이름과 UI에 그 범위를 표시한다.

## 4. 전체 데이터 흐름

~~~text
Notion Webhook/API ─┐
GitHub Webhook/API ─┼─> 변경 수신/내구 큐 -> 최신 원문 조회 -> 버전/ACL/삭제 상태
Discord Gateway/REST┤                                      |
Juncoy 전사 DB ────┘                                      v
                              첨부 추출 -> 청크/속성/관계 -> 검색 인덱스

질문 -> 사용자 권한 -> 네 출처 탐색 계획 -> Discord 최신 대화 필수 확인
     -> 관련 원본/브랜치/속성 최신 확인 -> 키워드+벡터+관계 검색
     -> 변경/충돌 판단 -> Solar Pro 4 답변 -> 공개 직전 버전/ACL 재검증
     -> 답변 + 근거 + 확인 시각 + 미수집/지연 상태

이미지 요청 -> 위 근거 검색 -> 스타일/장면 제약 + 승인 참조
            -> 프롬프트 검토 -> 이미지 공급자 -> 결과/버전/출처 기록
~~~

공급자 event는 원문 변경 알림이다. 이벤트 본문, 검색 요약, LLM 추출을 최신 원본 자체로 취급하지 않는다. 모든 출처를 매 질문마다 전체 다운로드하는 대신, 지속 인덱스와 해당 질문에 필요한 최신 원문 확인을 결합한다. 이때 Discord 확인은 항상 수행한다.

## 5. 수집 범위와 초기 원본 목록

### 5.1 Notion

| 원본 | 식별자 |
|---|---|
| workspace | a43ec741-b304-815c-8a7b-000311218f3d |
| 메인 페이지 | 3d1ec741-b304-8013-8cca-f758388c8f04 |
| 주차 보고서 | 3deec741-b304-80ac-8a66-d28368c7a06f |
| 회의록 data source | 3d1ec741-b304-80c5-91d1-000bbb283fb9 |
| 작업 현황 data source | 3d1ec741-b304-8086-ba3f-000bf2f7d110 |
| 아트 리소스 data source | 3d1ec741-b304-80df-98c0-000bb64140c1 |
| 기획서 data source | 3d1ec741-b304-8071-bd91-000bf5d7828a |
| 일정 data source | 3d4ec741-b304-80e5-8b38-000b4d9db22b |

이 목록은 초기 seed이며 새 page/database/data source 탐색을 허용된 루트 아래에서 계속 수행한다. 전체 개인 워크스페이스를 자동 확장하지 않는다.

### 5.2 Discord

길드: 1545264536158740590. 최신 목록은 길드 API로 확인한다.

| 초기 채널 | ID |
|---|---|
| 일반 | 1545264537987452990 |
| 기획채팅 | 1547913857928790136 |
| 플밍채팅 | 1547913888044159047 |
| 아트채팅 | 1547913914530926742 |
| 레퍼런스 | 1547916116595187752 |
| 공지 | 1547916764862619678 |
| 일정 | 1555346918492737546 |
| 최종 컨셉아트 | 1555389126289793194 |

위 채널의 활성·공개 보관·봇이 읽을 수 있는 비공개 스레드를 대상에 포함한다. 특히 아트의 페이크 스크린샷 스레드(1555344243680092221)가 이미지 중심 자료다. 봇 게시 채널은 회의 요약 중복을 피하도록 기본 제외하고, 회의 원문은 Juncoy에서 받는다. 다른 채널과 DM은 자동 포함하지 않는다. 신규 채널은 allowlist 또는 승인한 카테고리 정책에 따라 발견·표시·수집한다.

### 5.3 GitHub / Juncoy

- 저장소: JunnnnyWon/Team_23. main, SideView, Stairs를 독립 ref로 관리한다. 새 브랜치는 발견하되 승인된 브랜치 규칙에 따라 인덱싱한다.
- 코드·Config·문서·PR/issue/discussion과 댓글을 권한 범위에서 수집한다. PR과 discussion은 구현·승인 맥락이며 코드 상태 자체는 commit 파일로 확인한다.
- Juncoy: workspace_guild_id=1545264536158740590에 공유된 비삭제 회의. 원래 guild_id와 공유 workspace를 구분한다.
- 회의 중 확정된 final 발언도 수집할 수 있다. 초안 partial은 검색 근거에서 제외한다. 종료 후 완료된 회의와 현재 진행 중인 회의를 답변에서 구분한다.

## 6. 출처별 변경 반영 명세

### 6.1 Notion 수집기

1. 인증된 공식 API로 루트와 data source를 탐색한다. API 버전을 설정으로 고정하고 schema 변경 시 재조회한다.
2. data source의 모든 행을 has_more/next_cursor 종료까지 가져온다. UI view 필터만으로 전체 수집을 판정하지 않는다.
3. page 속성과 block children을 재귀·페이지네이션으로 읽는다. has_children이 있는 블록의 하위 내용도 조회한다. 파일 속성, body file/image, relation, 댓글을 지원한다.
4. page/data_source 생성·내용·속성·스키마·이동·삭제·복원 및 필요한 comment 이벤트를 수신한다. Webhook payload에서 최신 문서를 다시 읽는다.
5. raw body의 X-Notion-Signature를 verification_token 기반 HMAC-SHA256으로 검증한다. 이벤트 id를 dedupe하고 내구 저장 후 신속히 응답한다.
6. 같은 entity의 알림을 짧게 합쳐 처리하되, 파일 교체·권한·삭제 invalidation은 기다리지 않는다. timestamp 역전은 수신 순서로 현재 버전을 덮어쓰는 이유가 될 수 없다.
7. 증분 대조 2분, 루트/행/블록 커버리지 대조 15분, 전체 접근 범위 스캔 하루 1회가 기본이다. parent/page last_edited_time 하나만으로 중첩 블록 변화가 없다고 보증하지 않는다.
8. 403/404는 접근 불가일 수 있다. 조회한 문서를 먼저 검색 불가 처리하고, 이유를 ACCESS_LOST_OR_MISSING으로 구분한다. 명시적 page.deleted와 다르게 단정한다.
9. rate limit은 connection 단위 공유 limiter로 처리한다. Retry-After/429와 재시도 가능한 529/5xx는 제한된 backoff+jitter로 재시도한다.
10. MCP truncated/unknown block 또는 공식 API unsupported 블록은 coverage gap으로 기록한다. 첨부만 있는 빈 페이지도 내용 없는 문서가 아니다.

Notion Webhook은 실제 변경 후 대개 1분 내, 일부는 5분 내 전달될 수 있고, 집계/역순 알림이 있다. 플랫폼 지연을 0으로 약속하지 않는다. 질문 시 관련 원문을 다시 가져오는 경로가 필요하다.

### 6.2 GitHub 수집기

1. GitHub App 설치 토큰을 갱신하고 저장소·contents·pull requests·issues·필요 discussion read 권한만 사용한다.
2. push, create/delete ref, pull_request 및 review/comment, issues/issue_comment, 필요한 discussion/comment, repository/installation 권한 변경을 수신한다.
3. X-Hub-Signature-256 검증, X-GitHub-Delivery dedupe, 저장 성공 후 2초 안에 응답하도록 목표를 둔다. provider 10초 제한 전에 처리한다.
4. webhook은 파일/메타데이터 재조회 신호다. ref HEAD를 읽고 그 SHA의 tree와 blob을 가져온다. 경로만 바뀐 rename, delete, force-push, 브랜치 삭제, revert를 모두 처리한다.
5. 파일 내용 cache key는 repo+blob SHA, 유효 ref membership은 repo+branch+HEAD commit이다. 동일 blob 재사용과 브랜치별 현재 여부를 분리한다.
6. ref HEAD는 60초마다 대조한다. 이벤트 실패/누락 시 GitHub가 자동 redelivery하지 않는다고 가정하고 HEAD/PR/issue 상태를 정기 대조한다. 운영 토큰에 delivery 조회 권한이 있으면 실패 이벤트를 재전송할 수 있으나 HEAD 대조는 유지한다.
7. trees truncated=true는 하위 tree 재귀 조회로 보완한다. Content API 1,000개 directory 제한, 파일 크기 제한을 고려하고 download URL은 영구 ID로 쓰지 않는다.
8. LFS 포인터만 받은 .uasset/.umap/.fbx는 내부 내용을 읽었다고 표시하지 않는다. 바이너리 프리뷰/메타데이터 수집 범위는 별도 명시한다.

기본 질문은 main 현재 코드와 지정 개발 브랜치 차이를 함께 설명한다. commit 메시지의 “완료”를 현재 빌드 성공으로 승격하지 않는다. 실행 검증에는 별도의 실행 로그/결과가 필요하다.

### 6.3 Discord 수집기 — 필수

#### 초기 과거 수집

- 채널 전체 목록과 bot effective VIEW_CHANNEL/READ_MESSAGE_HISTORY를 확인한다. 메시지 API가 200 빈 배열이어도 권한과 과거 커버리지를 확인하기 전에는 “대화 없음”으로 결론 내리지 않는다.
- 채널 메시지를 limit=100, before cursor로 newest→oldest 페이지네이션한다. before/after/around는 한 요청에 하나만 사용한다. cursor는 JS number가 아닌 snowflake 문자열/BigInt다.
- 시작 시점 high-watermark를 고정하고 그 이후 실시간 이벤트와 백필을 겹쳐 처리한다. message ID + content hash/version으로 중복을 제거한다.
- parent 채널의 활성 스레드, 공개 보관 스레드, joined private archived 목록을 수집한다. 필요한 추가 권한 없이 숨겨진 비공개 스레드를 우회하지 않는다. has_more 종료까지 각 endpoint의 timestamp/snowflake cursor를 사용한다.
- 답글 원문과 thread starter를 함께 저장한다. 삭제된 reference는 missing_reference로 남긴다. 시간 구간/스레드/답글로 묶어 발화 맥락을 만든다.

#### 실시간 수집

- Intents: Guilds, GuildMessages, MessageContent. 메시지 내용 privileged intent 설정을 별도 배포 검증한다. GuildMembers는 사용자/ACL 최신화에 정말 필요하고 승인된 경우 추가한다.
- 이벤트: MESSAGE_CREATE/UPDATE/DELETE/DELETE_BULK, THREAD_CREATE/UPDATE/DELETE/LIST_SYNC, CHANNEL_CREATE/UPDATE/DELETE, 관련 role/permission 변경, guild access loss.
- uncached/partial update는 필드가 없다는 이유로 이전 content를 빈 값으로 바꾸지 않고 REST로 최신 메시지를 hydrate한다. content hash와 edited_timestamp를 모두 보존한다.
- attachment-only 메시지도 독립 문서다. attachment 제거는 기존 파생 텍스트/태그/참조를 무효화한다. reaction이나 핀만으로 결정 승인을 추론하지 않는다.
- Gateway heartbeat/resume/session 상태와 마지막 내구 처리 sequence를 관리한다. 같은 session에서 받은 sequence를 다른 session으로 직접 비교하지 않는다. Resume 실패는 REST 보완 수집과 gap 상태를 발생시킨다.
- 영구 gap은 조용히 성공 처리하지 않는다. Discord는 봇이 끊긴 동안 삭제·편집된 모든 메시지의 완전한 역사 API를 제공하는 것으로 가정할 수 없다. 최근 구간 대조 + 질의 근거 재조회 + archive 대조로 보완하고 남은 범위를 알린다.
- limiter는 token+route bucket+major resource/global 단위로 공유한다. 음성 봇과 같은 token이면 전체 요청량을 조정하고 HTTP rate limit 헤더와 retry_after를 따른다.

#### 매 질문의 Discord 확인

1. fresh=current가 기본이며 UI에서 이를 숨겨 끌 수 없다.
2. 허용 채널들의 최신 메시지 head와 활성 스레드 목록을 확인한다. 초기 소규모 범위(8개 채널+하위 활성 스레드)는 매 질문 최근 본문을 실제 가져와 확인한다. 단순 health ping은 읽기 성공이 아니다.
3. 질문과 관련한 채널/스레드의 신규 메시지를 cursor까지 수집하고, 검색에서 선택된 과거 메시지 및 답글 원문은 ID로 다시 읽는다. 반실사/최종 아트 같은 오래된 관련 대화도 근거 후보에서 확인한다.
4. edited/deleted message, 신규 스레드, pending event가 있으면 해당 문서를 최신화하거나 이번 요청의 ephemeral evidence로 사용한다. ephemeral에도 ACL·문서 ID·hash·시각·citation을 붙인다.
5. 빈 본문이 attachment-only인지 intent 제한인지 구분한다. content intent 제한이나 인증 실패는 READ_FAILED/CONTENT_RESTRICTED다.
6. Discord에 관련 증거가 없으면 “최신 대화는 확인했지만 관련 근거 없음”으로 기록한다. 읽지 못했다면 “확인 실패”다. 둘을 같은 no-result로 처리하지 않는다.

일반 질문이 “사다리 코드 어디야?”여도 프로그래밍 Discord의 최신 구현/문제 보고를 확인한다. 이미지 요청은 아트·레퍼런스·최종 컨셉아트·관련 스레드와 최신 회의 변경을 필수 고려한다.

### 6.4 Juncoy 회의 수집기

- 별도 read-only DB role로 필요한 테이블만 읽는다. 기존 worker jobs나 capture lease를 건드리지 않는다.
- 초기 전사 원본: transcript_segments canonical/is_final, segment_versions, segment_replacements, meeting metadata, workspace_meetings, markers, gaps, deletion_tombstones. VERIFIED 원장과 요약은 보조로 연결한다.
- event_seq는 회의별이므로 meeting_id+event_seq cursor다. NOTIFY는 wake-up이며 원문 이벤트는 DB에서 읽는다.
- 첫 버전은 5초마다 회의/전사 버전과 삭제를 대조한다. 기존 이벤트 로그 보관 floor에 밀린 cursor는 해당 회의를 full resnapshot한다.
- 정정은 표시 text와 raw_text를 함께 보존하고, 활성 근거는 최신 canonical/replacement로 이동한다. 이전 문장을 current 답변에 쓰지 않는다.
- read-only polling에서 모든 생성/삭제/공유 범위 변화를 대조한다. 필요시 후속 개발에서 기존 트랜잭션에 지식 outbox 이벤트를 추가할 수 있으나 음성 캡처를 차단하는 호출을 넣지 않는다.
- stale RECORDING 행과 실제 capture 활성 여부를 분리한다. 수집 활성 상태를 확인하지 못하면 진행 중 정보의 최신성을 표시한다.
- summaryOnly나 Solar topic 합성의 빈 decisions/action_items를 기준으로 사실 부재를 추론하지 않는다. RAG용 사실 추출은 전사/원장으로 별도 생성한다.

## 7. “실시간”의 의미와 지연 목표

모든 목표는 정상 인증·provider 가용·작은 텍스트 변경 기준의 초기 SLO이며 부하 시험으로 확정한다. 0초 동기화/모든 시점의 완전 스냅샷을 보장하지 않는다.

| 출처/작업 | 수신 후 검색 가능 p95 목표 | 원본 변경→검색 목표/한계 | 누락 대조 |
|---|---|---|---|
| Discord 텍스트 | 15초 이내 | 정상 Gateway에서 30초 목표 | head 30초, 최근 24시간 5분, 활성/보관 스레드 5/15분 |
| Juncoy final 전사/정정 | 10초 이내 | DB polling 포함 15초 목표 | 5초, 회의 종료/버전 증가 시 전체 버전 확인 |
| GitHub 코드/속성 | 60초 이내 | 작은 변경 120초 목표; 큰 push 별도 상태 | ref 60초, 메타데이터 5분, 전체 scope 하루 1회 |
| Notion 텍스트/속성 | 60초 이내 | 통상 2분 목표, provider 전달 최대 5분+처리 지연 가능 | 증분 2분, 구조 15분, 전체 하루 1회 |
| 첨부 PDF/이미지 | 5분 이내 | 크기/OCR/공급자 처리에 따라 별도 표시 | 파일 ID/hash 변경 즉시 큐, pending 표시 |
| 삭제/접근 상실 | 수신 후 즉시 검색 차단, p95 5초 | 공급자에서 아직 감지 못한 권한 변화는 별도 한계 | 현재 답변 근거 실시간 확인 및 ACL 재검증 |

측정 시각은 source_occurred_at, received_at, fetched_at, indexed_at, served_at를 구분한다. Notion timestamp와 서버 received_at 차이는 플랫폼+시계 오차가 포함됨을 명시한다.

질문은 최대 12초의 live 확인 budget(설정 가능)을 둔다. 기본 답변 p95 20초가 목표이며 첫 로딩 UI는 1초 이내 제공한다. provider 장애/대규모 변경으로 budget을 넘으면 degraded 응답을 제공하거나 최신 확인 재시도 선택지를 보여준다. current 모드에서 조용히 과거 캐시로 성공 처리하지 않는다. 출처별 last_success만으로 전체 scope가 최신이라고 표시하지 않는다.

## 8. 이벤트·버전·삭제 일관성

### 8.1 처리 단계

~~~text
RECEIVED -> FETCH_PENDING -> FETCHED -> EXTRACTING -> INDEXING -> READY
                       -> RETRYABLE / ACCESS_LOST / COVERAGE_GAP / DEAD_LETTER
DELETE/REVOKE ---------> UNAVAILABLE -> 파생 데이터 차단/제거
~~~

- provider delivery/event ID 또는 내부 event key에 UNIQUE를 적용한다. fetch·extract·index 작업은 document/version/config hash로 멱등 처리한다.
- 같은 document를 처리하는 worker에는 lease+generation fencing을 사용한다. 오래된 worker 결과가 더 최신 current_version을 덮어쓸 수 없다.
- 변경을 알게 되는 즉시 dirty=true로 표시한다. 최신화를 마치지 못한 이전 버전은 CURRENT 근거에서 제외한다. 역사 답변에서만 허용하거나 명시적 이전 버전으로 표시한다.
- 원문 조회 때 수정 시각/HEAD/content hash를 재확인한다. 작업 시작/끝 사이에 바뀌었으면 새 revision 작업을 만들고 이전 결과를 current로 publish하지 않는다.
- 청크/embedding의 active chunk_set 전환은 한 트랜잭션이다. 콘텐츠가 바뀌었는데 이전 embedding을 같은 버전으로 재사용하지 않는다.
- source_scope별 served generation/watermark를 기록한다. 분산 플랫폼 사이 전역 트랜잭션이 없으므로 “모든 자료가 정확히 같은 순간”이라는 표현을 쓰지 않는다.
- source delete/revoke는 authoritative tombstone을 만든다. 늦게 도착한 create/update가 원문 확인 없이 복원할 수 없다. 복원은 원본의 명시적 존재/접근 가능 상태와 새 fetch version으로만 가능하다.

### 8.2 과거 기록과 개인정보/권한

일반 편집 이력은 authorized history 답변에 쓸 수 있다. 원문 삭제·권한 회수는 다른 경우다. 삭제/비공개가 된 본문·첨부·청크·embedding·주장·캐시·이미지 참조를 일반 조회에서 즉시 차단하고 비동기 제거한다. saved answer는 관련 내용 또는 카드 전체를 “원본 삭제/접근 변경”으로 가리고 다시 표시하기 전에 재검증한다. audit에는 ID/hash/시각/처리 이유만 남길 수 있으며, 원문 텍스트 보존은 별도 승인 정책이 있을 때만 허용한다.

다운로드한 이미지/3D 파일의 삭제와 백업 복원에도 source tombstone을 재적용한다. 앱이 이미 외부에 보낸 답변까지 회수할 수 있다고 보장하지 않는다.

## 9. 문서·첨부·청크 모델

### 9.1 문서 식별자

| 종류 | 영구 key | 버전 |
|---|---|---|
| Notion page | notion:<workspace>:<page_id> | content hash + source 수정 시각 |
| Notion attachment | notion-file:<page/block>:<file_id> | binary SHA256 + extractor version |
| Discord message | discord:<guild>:<channel/thread>:<message_id> | content hash + edited_timestamp |
| Discord attachment | discord-file:<message_id>:<attachment_id> | binary SHA256 |
| GitHub file | github:<repo_id>:<ref>:<path> | HEAD commit + blob SHA |
| Juncoy transcript | meeting:<workspace>:<meeting_id> | transcript_version + segment revisions |

DB JSON은 UUID/snowflake/URL을 문자열로 보존한다. GitHub branch source와 공통 blob을 분리해 중복 저장을 줄인다. 다운로드 signed URL, 파일명, 내용만 같은 PDF를 동일 source로 자동 합치지 않는다.

### 9.2 추출

- Notion 속성은 typed JSON으로 저장한다. 완료/진행률/활용여부/적용여부 원문을 바꾸지 않는다. schema 버전과 label 변경도 기록한다.
- PDF는 텍스트 레이어 우선, 스캔이면 OCR. 표의 확정/미정 열·행·페이지와 도식의 캡션을 보존한다. 문서 전체 텍스트만 이어 붙여 표 관계를 잃지 않는다.
- 이미지에는 file hash, OCR, 모델 관찰 설명, 부모 메시지/페이지, 공간/자산 태그를 연결한다. 관찰 설명은 MODEL_OBSERVATION이며 사람이 승인한 디자인 설정으로 자동 승격하지 않는다.
- P0 이미지 최소 지원은 원본/썸네일/주변 설명과 검색 가능한 태그·직접 참조다. 자동 vision 추출은 지원 모델과 비용을 검증한 후 추가하며 text-only Solar가 픽셀을 이해한다고 가정하지 않는다.
- PPTX/DOCX는 본문·슬라이드/페이지·표·발표자 노트/관계 추출을 후속 지원한다. 처리 전에는 METADATA_ONLY로 표시한다.
- 영상은 첨부 메타데이터·설명부터 수집하고 선택적 프레임/전사 파이프라인을 후속 추가한다. 미분석 영상을 시연 검증 근거로 사용하지 않는다.
- Unreal/FBX/OBJ/ZIP은 메타데이터·미리보기 우선. 원본 의미 분석은 별도 에디터 export 작업으로 범위를 명시한다. ZIP은 허용 파일형·압축 해제 크기·경로 제한을 둔다.

기본 파일 한도: PDF 50MB/200쪽, 이미지 20MB, 영상은 P0 내용 추출 제외. 초과하면 실패 숨김 없이 OVERSIZE/manual import 후보로 표시한다. parser 실행은 외부 네트워크 없는 제한 worker로 격리한다.

### 9.3 청크

- 일반 문서: 제목/heading/표/페이지를 기준으로 500~900 token, overlap 80~120 token에서 시작하고 실제 tokenizer로 조절한다.
- Discord: 답글/스레드/주제, 10분 대화 창을 기본으로 300~800 token. author·timestamp·message ID별 span을 유지한다. 고립된 “네/좋아요”는 결정 근거가 아니다.
- 회의: 화자/시각/주제 60~120초 창, segment ID+revision+start/end ms와 원문 span을 보존한다.
- 코드: AST 함수/타입+인접 주석, 큰 함수는 줄 구간으로 나눈다. repo/path/branch/commit/line와 symbol을 기록한다.
- 관련 청크가 다른 출처를 가리키면 관계 탐색으로 보완한다. Notion task→기획서/리소스, Discord reply→대상, GitHub PR→commit, 회의→사람 정리 회의록을 연결한다.
- 동일 회의 중복은 meeting_mapping의 date/참석/제목/근거로 후보를 만들고 명확하지 않으면 합치지 않는다. 같은 전사를 복사한 문서 두 개를 독립된 두 개의 확인 증거로 세지 않는다.

## 10. 저장 구조와 구현 위치

아래는 신규 테이블 설계 이름이며 실제 DDL은 구현 단계에서 작성한다. 프로젝트 source/ACL filter는 검색 query 단계부터 적용한다.

| 테이블 | 주요 책임 |
|---|---|
| knowledge_projects / project_memberships | 프로젝트·팀·원본 공유 정책 |
| knowledge_sources / source_scopes | 공급자 인증 reference, 루트/채널/ref allowlist, 권한 상태 |
| source_events | 검증된 event/delivery ID, 처리 상태, 내구 수신 |
| knowledge_jobs | fetch/extract/index/refresh/delete, lease·generation·retry |
| connector_cursors / sync_checks | 채널/스레드/회별/ref별 cursor, 커버리지·마지막 대조 |
| documents | stable key, scope, ACL, current_version, dirty/deleted/access 상태 |
| document_versions | source/fetch/valid 시각, source revision, hash, normalized 내용 |
| attachments | 안정 ID/hash/storage key, 권한, 추출 상태 |
| chunk_sets / chunks | 추출 버전, 문서 citation/span, active 청크 집합 |
| embedding_profiles / chunk_embeddings | query/document model pair, 차원, chunk hash, vector |
| source_relations / meeting_mappings | 기존 명시적 relation/reply/PR 및 중복 원본 매핑 |
| claims / claim_evidence / claim_relations | 출처 근거를 가진 주장, 상태·대체/충돌 후보 |
| answer_runs / answer_evidence | 질문·source coverage·사용 버전·결과·모델/usage |
| style_profiles / image_jobs / image_results | 승인 스타일 버전, 근거 묶음, 생성 설정·결과 |
| deletion_tombstones / knowledge_audit | 삭제/권한 반영과 내용 없는 처리 감사 |

정합성 제약: unique project+source stable key, unique document+content hash+extractor version, unique event ID, current_version foreign key, vector profile 차원 일치, source ACL 변경 시 epoch 증가. claim의 evidence는 존재하고 현재 권한이 있는 원문 span을 가리켜야 한다.

pgvector embedding 차원은 provider를 확인한 뒤 migration에 반영한다. 초기 소규모 코퍼스에서는 정확한 cosine 검색으로 시작할 수 있으며, HNSW 인덱스는 실제 차원/형식 제한과 recall을 검증한 후 만든다. 모델 변경은 새 embedding profile로 재색인하고 구/신 모델 vector를 섞어 검색하지 않는다. 한국어 단어 형태와 코드 이름은 simple tsvector만으로 충분하다고 가정하지 않고 pg_trgm·정확 식별자 매칭 및 실제 평가를 결합한다.

권장 파일 배치:

~~~text
apps/knowledge-api/src/       질의·웹훅·상태·권한 API
apps/knowledge-worker/src/    수집·대조·파일 추출·인덱싱
apps/discord-context/src/     메시지 Gateway 수집 (음성 캡처 책임 없음)
packages/knowledge/src/       source adapters, normalize, chunk, retrieve, resolve
packages/knowledge-db/        별도 Kysely store와 migration
packages/contracts/src/knowledge.ts  새 DTO/Zod 계약
packages/providers/src/knowledge-solar.ts  문답/근거 판단용 adapter
packages/providers/src/embeddings.ts       임베딩 adapter
packages/providers/src/images.ts           이미지 adapter interface
apps/web/src/knowledge/       질문·근거·동기화·프롬프트·생성 결과 UI
tests/knowledge/              fake provider/통합/인수 fixture
infra/compose.knowledge.yml   새 서비스·볼륨·리소스 제한
~~~

기존 meeting summary 함수에 일반 Q&A를 억지로 넣지 않는다. 기존 root config는 real 모드에서 STT/음성용 credential을 요구하므로, 새 지식 서비스는 전용 config로 필요한 credential만 검증한다. 현재 summaryOnly 공개 동작은 이번 지식 기능 때문에 바꾸지 않는다.

## 11. 검색과 질문 시 최신 확인

### 11.1 요청 흐름

1. Discord OAuth session과 현재 프로젝트 membership을 확인한다. 제한된 source는 사용자 effective ACL filter에 포함한다.
2. 질문을 current/history/task/code/art 유형으로 분류하고 명시한 날짜·branch·asset를 유지한다. 한국어 질문을 검색용 키워드/동의어로 확장하되 인물·수치·상태를 지어내지 않는다.
3. source registry의 네 종류를 모두 탐색 계획에 넣는다. 각 출처별 relevant/no_match/failure/partial을 기록한다. 권한 없는 출처의 존재·제목을 사용자에게 누출하지 않는다.
4. Discord §6.3의 live read를 수행한다. GitHub ref HEAD, Notion 관련 page/속성, Juncoy 관련 회의 version도 다시 확인한다. 일정/담당/진행률 질문은 해당 Notion rows를 직접 조회한다.
5. source별 키워드/벡터 후보 각 최대 30개를 검색하고 ACL/current version/시점 filter 적용 후 dedupe/RRF한다. 상위 40개 내 후보를 재정렬하고 약 12~20개 evidence chunk를 선택한다. 숫자는 설정값이다.
6. cross-source relation과 discord reply 주변 원문으로 필요한 문맥을 확장한다. 적은 근거라도 모든 관련 필수 출처를 검토하며, quota 때문에 Discord를 무조건 제외하지 않는다.
7. 최신 fetch와 active index가 다르면 재색인을 기다리거나 ACL 검증된 ephemeral 원문 evidence를 사용한다. live 원문은 embedding 없이 키워드/질문 직접 평가로 보완 가능하다.
8. 근거와 충돌 후보를 Solar Pro 4에 전달한다. 원본 내 명령은 데이터로 격리한다. 모델은 주어진 evidence ID만 반환한다.
9. 인용 ID 존재, quote/span, 버전, 숫자/담당/확정 표현을 검증한다. 검증 실패는 제한된 재시도 또는 uncertain 답변으로 낮춘다.
10. 공개 직전 source epoch/current revision/ACL을 재확인한다. 변경되었으면 최대 1회 재작성하고, 계속 바뀌면 “확인 중 변경됨”으로 부분 답변한다. current 요청의 stale 출처를 숨기지 않는다.

history 질문에서도 Discord 현재 읽기를 수행해 관련 결정이 바뀌었는지 확인한다. 본문은 요청한 시점의 결정을 답하고, 현재와 다른 점을 따로 표시한다. 당시 보지 못한 source 버전을 나중에 역산해 완전한 역사로 만들지 않는다.

### 11.2 날짜/상태와 시점

source_occurred_at(발언/회의/commit 시각), source_modified_at(편집), observed_at(실제 확인), valid_from/to(사실 적용 구간), captured_at(시스템 기록)을 분리한다. source 편집 시각이 최신이라는 이유만으로 과거 회의 날짜를 덮어쓰지 않는다. “오늘/내일”은 원문 발화 시각과 Asia/Seoul 기준으로 해석하고 불명확하면 원문을 보존한다.

## 12. 출처 간 판단 규칙

단일 전역 순위(Notion>Discord>GitHub 또는 최신 메시지 승리)를 쓰지 않는다. 질문이 묻는 사실의 종류, 명시적 승인, 적용 대상, 결정 시각, 코드/실행 증거를 함께 평가한다.

| 질문 대상 | 기본 사실 원본 | 함께 대조할 것 |
|---|---|---|
| 현재 게임 기획·아트 결정 | 승인된 기준 문서 + 명시적 후속 결정 | 최신 Discord/회의가 수정·보류했는지 |
| 작업 상태·담당·기한 | Notion 구조화 속성 | Discord 보고·회의 변경·코드 증거와 불일치 여부 |
| 현재 구현 내용 | 해당 branch의 최신 commit 파일 | Discord 구현 보고, PR, 실행 증거 |
| 실제 게임에서 동작/배포됨 | 명시적 빌드/실행/배포 검증 | 코드 존재·commit 메시지와 구분 |
| 회의에서 무슨 말을 했는지 | 시각/화자/정정이 있는 전사 | 사람 회의록, 용어 정정, 발언 이후 번복 |
| 이미지 스타일/장면 | 승인 style_profile와 원문 근거 | 최신 아트 대화·회의·참조 이미지 변경 |

claim 상태: DISCUSSION, PROPOSAL, CONFIRMED, OPEN, SUPERSEDED, REJECTED, UNKNOWN. 모델 추출 confidence는 승인 권한이 아니다. 원본의 “맞나요?”, “같다”, “후에 결정”을 CONFIRMED로 올리지 않는다. owner_map의 의사결정 역할은 명시적 프로젝트 설정이며 직함을 모델이 추정하지 않는다.

변경 후보가 명확히 같은 대상/적용 범위의 이전 결정을 대체하면 supersedes 관계를 만들고 원문을 연결한다. 승인 권한이나 대상이 불명확한 새 Discord 메시지는 이전 문서를 몰래 교체하지 않고 “새 의견/확인 필요”로 제시한다. 충돌이 해결되지 않으면 양쪽 근거와 필요한 확인을 답한다.

인수 예시:

- 옛 그래픽 문서에 소녀/주인공 다른 데포르메 강도가 있어도 후속 회의·대화의 통일 결정 여부를 대조한다.
- “추격신 삭제”는 3층 이후와 중간 손가락 추격신을 분리해 답한다.
- Notion 완료, 90% 기입, Discord 완료 보고, 코드 branch 적용, PIE 검증은 다른 축이다.
- Stairs의 revert 뒤에도 과거 통합 commit 내용으로 현재 캐릭터 적용을 답하지 않는다.
- 100cm/150cm/3m 규격이 혼재하면 확인 없이 하나로 결정하지 않는다.

## 13. API와 응답 계약

### 13.1 공개 API (신규)

| 메서드/경로 | 기능 |
|---|---|
| GET /api/knowledge/projects/:id/status | 사용자에게 공개 가능한 source별 동기화/커버리지 |
| POST /api/knowledge/projects/:id/questions | 문답 생성, current/history, 질문 run ID |
| GET /api/knowledge/answers/:id | 저장된 답변과 근거, 현재 ACL/삭제 재검증 |
| GET /api/knowledge/answers/:id/events | 상태와 최종 답변 SSE |
| GET /api/knowledge/evidence/:id | 원문 excerpt와 출처 이동, 현재 ACL 필수 |
| POST /api/knowledge/projects/:id/image-prompts | 근거·스타일·참조를 가진 생성 프롬프트 |
| POST /api/knowledge/projects/:id/images | 검토한 prompt ID와 설정으로 실제 생성 |
| GET /api/knowledge/images/:id | 생성 상태/결과/사용 버전 |
| POST /api/knowledge/admin/sources/:id/resync | 권한 있는 운영자의 재동기화 |
| POST /api/knowledge/webhooks/notion | 서명 검증된 Notion event 수신 |
| POST /api/knowledge/webhooks/github | 서명 검증된 GitHub event 수신 |

기존 Origin 검사와 cookie 보호를 유지한다. provider webhook은 별도 router/raw-body 서명 정책으로 처리하고 사용자 Origin/CSRF 검사에 막히지 않게 한다. 브라우저 mutation과 provider event 인증을 혼동하지 않는다. source resync 외 원본 쓰기 기능은 초기 API에 없다.

요청 필드: question(최대 4,000자), temporal_mode=current|history, as_of(역사 모드일 때 ISO 시각), branch(사용자 명시), conversation_id(optional). fresh/current에서 Discord 확인을 생략하는 사용자 옵션을 제공하지 않는다. 이전 대화 history는 검색 힌트이며 원본 근거가 아니다.

응답의 필수 필드:

~~~json
{
  "answer_id": "uuid",
  "status": "PARTIAL",
  "answer": "근거로 작성한 한국어 본문",
  "checked_at": "ISO8601",
  "temporal_mode": "current",
  "claims": [{"text": "근거로 확인한 주장", "state": "CONFIRMED", "evidence_ids": ["evidence-id"]}],
  "evidence": [{"id": "evidence-id", "source": "discord", "document_id": "stable-id", "revision": "hash", "url": "original-url", "quote": "직접 근거", "observed_at": "ISO8601"}],
  "source_coverage": [
    {"source": "discord", "read_status": "LIVE_READ", "search_status": "MATCH", "scope_complete": true, "last_reconciled_at": "ISO8601", "gaps": []},
    {"source": "notion", "read_status": "PARTIAL", "search_status": "MATCH", "scope_complete": false, "last_reconciled_at": "ISO8601", "gaps": ["관련 첨부 추출 대기"]},
    {"source": "github", "read_status": "LIVE_READ", "search_status": "NO_MATCH", "scope_complete": true, "last_reconciled_at": "ISO8601", "gaps": []},
    {"source": "meeting", "read_status": "LIVE_READ", "search_status": "MATCH", "scope_complete": true, "last_reconciled_at": "ISO8601", "gaps": []}
  ],
  "conflicts": [],
  "warnings": [],
  "model": "solar-pro4-260806",
  "corpus_generation": "opaque-generation",
  "usage": {"input_tokens": 0, "output_tokens": 0}
}
~~~

위 JSON은 Notion 관련 첨부가 대기 중인 부분 답변 예시다. status enum은 COMPLETE/PARTIAL/NEEDS_CLARIFICATION/FAILED, read_status는 LIVE_READ/PARTIAL/FAILED/NOT_APPLICABLE, search_status는 MATCH/NO_MATCH/NOT_SEARCHED로 정의한다. NOT_APPLICABLE은 프로젝트에 등록되지 않은 자료 유형에만 사용하며 이 프로젝트의 필수 네 출처를 생략하는 용도가 아니다. source_coverage는 네 출처에 대해 정확히 하나씩 반환하되 제한된 scope 세부는 authorized scopes 목록으로 구성한다. scope_complete=true는 요청에 필요한 조회·pagination·최신 확인을 끝냈다는 뜻이고 전체 과거 백필은 backfill_complete/covered_interval로 별도 표시한다. COMPLETE는 필수 출처 탐색·Discord live read·관련 원문 확인·ACL·인용 검증을 통과한 요청을 뜻하며 전수 인덱싱을 뜻하지 않는다. initial backfill 미완료처럼 결론에 영향을 주는 gap은 PARTIAL이다.

실패 코드: SOURCE_AUTH_REQUIRED, SOURCE_ACCESS_LOST, DISCORD_CONTENT_RESTRICTED, SOURCE_RATE_LIMITED, LIVE_REFRESH_TIMEOUT, SOURCE_COVERAGE_GAP, INDEX_NOT_READY, EVIDENCE_CHANGED, ACL_REVOKED, MODEL_INVALID_RESPONSE, IMAGE_PROVIDER_NOT_CONFIGURED. HTTP 재시도 여부와 answer warning을 분리한다.

SSE 상태: checking_sources, reading_discord, refreshing_evidence, searching, resolving_conflicts, generating, revalidating, complete/partial/failed. 검증되지 않은 모델 draft를 최종 사실처럼 바로 stream하지 않는다. 상태를 먼저 보여주고 검증한 최종 본문을 공개한다.

### 13.2 citation

- Notion: page URL + PDF/page/block 위치 설명, 실제 파일 버전 hash.
- Discord: https://discord.com/channels/<guild>/<channel-or-thread>/<message>, 작성/편집 시각과 답글 맥락.
- GitHub: blob/<commit SHA>/<path>#Lx-Ly. 움직이는 branch URL만으로 근거를 고정하지 않는다.
- Juncoy: 기존 meeting/segment 링크, transcript_version/revision/start_ms.
- 이미지: 원본 asset ID/hash + 부모 문서 citation. 다운로드 URL은 응답에 계속 저장하지 않는다.

## 14. 접근·권한·보호

- 웹 로그인은 기존 Discord OAuth를 활용한다. 브라우저는 같은 origin의 기존 API knowledge proxy를 호출한다. 기존 API는 Auth.session/Auth.check를 수행하고 내부 knowledge-api로 전달한다. 지식 DB가 기존 oauth_sessions를 복제해 관리하지 않는다.
- 내부 요청은 서비스 전용 서명(body hash, user/project ID, audience, expiry 최대 30초, request nonce)을 검증하고 내부망에만 노출한다. 무서명 user header를 신뢰하지 않는다. knowledge-api는 프로젝트/source ACL도 적용한다. 기존 API는 질문 단계와 결과 반환 전 membership을 재확인한다. proxy 구현은 §10의 기존 API 변경 범위에 포함된다.
- project reader = 현재 길드 구성원 AND 프로젝트 접근 정책. 탈퇴 시 기존 30초 안의 차단 목표를 유지한다.
- 통합 인증이 읽을 수 있는 자료와 팀원에게 재공개 가능한 자료는 다르다. project_shared 원본은 소유자가 공유를 승인한 source scope만 사용한다. restricted 원본은 해당 사용자의 원본 접근/역할 조건을 적용한다.
- Discord restricted 채널/비공개 스레드는 user effective role/member overwrite와 접근을 검증한다. 봇이 관리자여도 사용자에게 자동 공개하지 않는다.
- 현재 Notion/GitHub의 per-user 권한을 API로 신뢰할 수 있게 검증하지 못하면 승인된 shared subset으로만 제공하거나 해당 scope를 차단한다.
- source ACL 검사는 검색 전, evidence 확장 전, 결과 직전에 적용한다. cache key는 사용자/ACL epoch+source revisions를 포함한다.
- 외부 자료의 “이 지시를 따라라/시스템 프롬프트 공개”는 인용 데이터다. retrieval worker와 답변 LLM에 원본 삭제·메시지 전송·GitHub merge 권한을 주지 않는다.
- OAuth/API key/서명 토큰/signed URL을 문서·LLM 입력·사용자 UI·로그에 남기지 않는다.
- 첨부 fetch는 허용 원본 URL과 리다이렉트 검증, private/local network 차단, MIME/크기/timeout 검사로 제한한다.
- 로그에는 request/source ID, 단계, duration, reason code 중심으로 기록한다. 질문/본문 보관은 프로젝트 retention 정책을 따르고 삭제 요청을 파생 데이터에 전파한다.

## 15. 이미지 생성 지원

### 15.1 사용자 흐름

1. 팀원은 장면/공간/목적과 원하는 변경을 입력한다. 기본 모드는 최종 게임 화면을 가늠하는 key visual/fake screenshot이며 캐릭터 sheet는 별도 모드다.
2. 문답과 같은 최신 source 확인을 수행한다. Discord 아트/레퍼런스/관련 스레드는 필수다.
3. 현재 승인된 style_profile를 기준으로 필요한 장면 제약과 reference candidates를 조회한다. 새로운 아트 결정이 있으면 후보 갱신으로 알린다.
4. Solar Pro 4가 장면 내용, 카메라, 조명, 재질, 캐릭터/공간 관계, 유지 조건, 변경 조건, 금지 요소를 구조화한다. 과거 미정 항목을 임의 확정하지 않는다.
5. UI에서 프롬프트·선택 참조·최신 변경 경고를 보여주고 생성 버튼으로 provider를 호출한다.
6. 결과와 prompt/negative prompt, provider/model/config, 지원할 때 seed, ref hash, style version, evidence versions, 생성 시각/비용을 저장한다.

### 15.2 승인과 생성 중 변경

- style_profile 버전은 사람 승인을 거친다. Discord의 반응 수나 LLM 판단으로 자동 승인하지 않는다.
- 새 source revision이 스타일과 충돌하면 STALE_CANDIDATE로 표시한다. 미확정 세부는 팀원이 임시 선택한 값으로 명확히 표시할 수 있다.
- 생성 버튼 시 prompt 근거·ACL·style epoch를 재확인한다. 변경된 중요 제약은 프롬프트 갱신을 요청한다.
- 생성 중 변경은 결과에 SOURCE_CHANGED_DURING_GENERATION을 기록한다. 기존 결과를 최신 기준 결과라고 자동 재분류하지 않고 새 기준 재생성 옵션을 제공한다.
- 승인된 참조 이미지를 provider로 전달할 수 있는 권한과 데이터 전송 정책을 설정한다. 원본 접근 상실 시 참조와 결과 공개 여부를 다시 평가한다.
- 일관성 평가는 동일 style+동일 장면 입력 5회에서 카메라·재질·크기 관계·금지 요소를 아트 담당자가 체크하는 방식으로 시작한다. RAG만으로 픽셀 스타일이 자동 고정된다고 약속하지 않는다.

## 16. 운영·배포·관측

- knowledge-postgres는 새 volume, pgvector 포함 image를 검증해 사용한다. 기존 meeting postgres image를 이번 기능 때문에 즉시 교체하지 않는다.
- meeting DB 접근은 새 read-only role이며 connection pool 초기 2개, 짧은 query/timeout·cursor 배치로 운영 부하를 제한한다.
- knowledge-worker에는 텍스트/첨부 큐별 concurrency와 CPU/memory 제한을 둔다. 회의 STT/요약 budget과 지식 LLM/embedding/image budget을 분리한다.
- same bot token의 별도 chat-only Gateway 연결은 voice state/명령을 처리하지 않는다. Discord 세션 제한과 resume 동작을 스테이징에서 검증한다. 적합하지 않으면 기존 Gateway에 경량 내구 event outbox만 추가하는 경로로 전환한다. 두 수집자가 동시에 canonical event를 만드는 구조는 피한다.
- 새 수집기의 REST 사용량이 기존 음성/OAuth 요청을 굶기지 않도록 backfill을 저우선순위로 제한한다.
- 기능 flag: KNOWLEDGE_ENABLED, DISCORD_CONTEXT_ENABLED, IMAGE_GENERATION_ENABLED. Discord 비활성 상태에서 문답 COMPLETE를 반환할 수 없다.
- 관측 지표: source gap/credential expiry, webhook receive/failure, gateway session/resume/sequence gap, queue age, source→fetch→index latency, parse failure, dirty docs, citation validity, ACL rejection, answer partial ratio, token/cost, source별 recall.
- 상태 화면은 마지막 성공과 전체 backfill coverage를 분리하고, pending attachment/unsupported block/gap을 보여준다. 일부 채널 성공을 전체 디스코드 성공으로 표시하지 않는다.
- 배포 순서: 스테이징 migration→운영 새 DB/서비스→read-only 수집→상태/검색 확인→팀 파일럿→UI flag. voice bot 재시작이 필요한 변경은 별도 예약 단계다.
- 롤백: 신규 UI/질의 flag off와 knowledge 서비스 중지. 기존 음성 서비스 유지. 데이터 보존 후 다시 시작해 cursor부터 재처리한다. 새로운 DB 볼륨 삭제는 롤백 필수 단계가 아니다.

## 17. 검증·인수 조건

상세 작업/시험 매핑은 개발 플랜에 있다. 이 문서의 요구사항 R01~R20은 다음 결과로 검증한다.

1. 각 provider fake 서버와 실제 승인된 sandbox에서 create→edit→delete→restore를 실행하고 동일 event 반복/역순 전달을 포함해 current 문서가 원본과 일치한다.
2. Discord 일반·reply·attachment-only·active/archive thread·uncached update·bulk delete·resume failure 시험을 모두 통과한다.
3. 실제 Notion 첨부 교체/속성 변경, GitHub branch push/force-push/revert, Juncoy 발언 정정/삭제가 citation과 인덱스를 갱신한다.
4. 질문 직전/생성 중 변경에도 stale current answer를 COMPLETE로 반환하지 않는다.
5. Discord 403·intent 제한·token 장애·timeout이면 질문은 PARTIAL/FAILED이며 문서 답변만으로 전체 최신 확인을 주장하지 않는다.
6. 한 출처만 봐서 틀리는 골드 질문 최소 30개, 그중 Discord가 정답을 바꾸는 10개 이상을 검증한다.
7. 골드 세트에서 evidence retrieval Recall@20 90% 이상, 주장별 정확한 citation 100%, unsupported 확정 주장 0건을 초기 gate로 둔다. 모델 판단만으로 평가하지 않고 원문/사람 체크를 사용한다.
8. 권한 없는 채널·과거 삭제 본문·다른 프로젝트·다른 branch current 오인·제안의 결정 승격 fixture에 대해 누출/오답 0건.
9. 실측 source latency/답변 시간/운영 부하를 기록한다. 목표 미달은 수치와 원인을 보고하고 목표 충족으로 표시하지 않는다.
10. 이미지 프롬프트의 evidence/style revision 변경 반영과 실제 생성 1건 이상(provider 선택 시)을 검증한다. 자동 생성·원본 쓰기·배포는 사용자 승인 범위에서만 수행한다.

## 18. 후속 범위

전체 Unreal asset graph/export, 영상 자동 분석, 멀티모달 임베딩, project claim graph 자동 고도화, Discord slash 명령/사용자별 알림, 여러 팀 프로젝트 지원은 후속 범위다. 이번 파일럿은 네 출처의 변경되는 텍스트/PDF/속성·이미지 참조 문맥과 정확한 근거 답변을 먼저 완성한다.

## 19. 참고 원본과 공식 API 근거

2026-10-06 조회 기준. 플랫폼 문서는 구현 전에 재확인한다.

- 팀 Notion: https://app.notion.com/p/3d1ec741b30480138ccaf758388c8f04
- RAG 작업: https://app.notion.com/p/3f1ec741b30480ea9f0fc45e7f5451ba
- Team_23: https://github.com/JunnnnyWon/Team_23
- Discord 최신 아트 용도 논의: https://discord.com/channels/1545264536158740590/1547913914530926742/1556933050603016233
- Discord 반실사/두 캐릭터 통일 대화: https://discord.com/channels/1545264536158740590/1547913914530926742/1556931786196389908
- Discord 수정 시각이 있는 메시지 표본: https://discord.com/channels/1545264536158740590/1547913914530926742/1556931784548159548
- [Notion Webhook 설정/서명](https://developers.notion.com/reference/webhooks)
- [Notion event 종류·집계·전달 지연·순서](https://developers.notion.com/reference/webhooks-events-delivery)
- [Notion block children·중첩·pagination](https://developers.notion.com/reference/get-block-children)
- [Notion request limits](https://developers.notion.com/reference/request-limits)
- [Notion 댓글 capability](https://developers.notion.com/reference/retrieve-a-comment)
- [GitHub webhook 응답·delivery ID](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- [GitHub 실패 webhook 자동 재전송 없음](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
- [GitHub contents와 tree/파일 제한](https://docs.github.com/en/rest/repos/contents#get-repository-content)
- [Discord Gateway/intents/resume](https://docs.discord.com/developers/events/gateway)
- [Discord Gateway event](https://docs.discord.com/developers/events/gateway-events)
- [Discord 메시지 조회/본문 권한](https://docs.discord.com/developers/resources/message)
- [Discord 활성·보관·비공개 스레드](https://docs.discord.com/developers/resources/channel)
- [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits)
- [Upstage Text Embedding API](https://console.upstage.ai/api/embeddings): 이번 조회로 정확한 모델 쌍/차원을 확인하지 못했으므로 §2.3의 실제 계정 API 검증 항목으로 남김.
