# RAG 파일럿 구현 점검 및 수정 인수인계

작성일: 2026-10-06 KST. 대상 저장소: `JunnnnyWon/Juncoy`.
점검 기준 코드: `522daee94d36b52ee2df2bc51df471fb10fb73fe` (`main`, PR #6 병합).
이 문서는 수정 전 점검 기록이다. 아래 결함을 수정했다는 뜻이 아니며, 다음 에이전트는 자신의 HEAD에서 재확인한 뒤 수정·검증 결과를 별도로 기록한다.

## 1. 목표와 읽는 순서

목표는 팀 프로젝트의 Notion·Team_23 GitHub·Discord 대화·Juncoy 회의 전사를 종합해 Solar Pro 4로 근거 있는 답변을 제공하는 것이다. 매 질문 Discord를 실제 읽고, 변경·삭제·접근 회수를 반영하며, 확인하지 못한 출처를 최신 확인 완료로 표시하지 않아야 한다. 이미지 기능은 프로젝트 맥락을 활용하는 프롬프트 지원에서 시작한다.

다음 문서를 함께 읽는다.

1. [원래 개발 명세](RAG_DEVELOPMENT_SPEC.md): 제품 동작·ACL·최신성·삭제·인수 기준.
2. [원래 개발 플랜](RAG_DEVELOPMENT_PLAN.md): W01~W12 개발 범위.
3. [구현 실행 플랜](RAG_IMPLEMENTATION_PLAN.md): 구현 에이전트가 기록한 P1~P11 상태.
4. 이 문서: 코드에서 다시 확인한 결함, 수정 우선순위, 회귀 테스트와 운영 검증.
5. [에이전트 전달용 지시문](RAG_AGENT_HANDOFF.md): 새 작업 환경에서 바로 사용할 짧은 프롬프트.

`RAG_IMPLEMENTATION_PLAN.md`의 체크 표시는 구현 보고다. 모든 명세 충족, 실제 백필 완료, 배포 완료의 증거로 사용하지 않는다.

## 2. 확인된 구현과 증거 수준

| 영역    | 코드에 존재하는 구현                                           | 아직 검증하거나 보완할 범위                                                 |
| ------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 저장소  | 별도 knowledge DB, 문서 버전, 작업 큐, 청크, 임베딩, tombstone | 버전 일치, lease 회수, 사용자별 ACL, 파생 데이터 정리                       |
| Discord | REST 수집, 메시지 해시, head 대조, 스레드 탐색 함수, Gateway   | 백필 종료 조건, 스레드 실제 수집 연결, bulk delete, ACL 변경, 내구 sequence |
| Notion  | 페이지·블록·일부 댓글, 증분/구조 대조, 서명 검증               | 페이지네이션, 속성 변경, 범위 제한, 누락 페이지·권한 회수 대조              |
| GitHub  | App/PAT, ref HEAD/tree/blob, 첫 tarball, push webhook          | PR·issue·discussion 맥락, 허용 repo/ref 검증, 삭제 후 복원·revert           |
| 회의    | canonical 전사·버전·정정/replacement 조회                      | final 필터, 공유 해제 대조, 상태 변화와 커서 정책                           |
| 검색    | trigram·vector·RRF, READY/non-dirty/비삭제 필터                | 실제 ACL, 버전 일치, 출처별 후보 분배, 한국어 검색 품질                     |
| 문답    | Solar 구조화 응답, claim/evidence/conflict/warning, `/ask` UI  | 최신 확인 판정, 생성 중 변경, 저장 답변 재검증, 이력·브랜치·SSE             |
| 이미지  | 요청·검색 청크·style profile을 문자열로 결합하는 API           | 실제 이미지 생성, 승인된 스타일만 사용, 최신 근거 확인, UI                  |
| 배포    | 별도 Compose 및 예시 환경 파일                                 | 운영 컨테이너·자격증명·intent·migration·seed·live 질의                      |

### 점검 당시 실행 결과

아래는 동일 기준 커밋을 별도 임시 worktree에서 검사한 결과다. 현재 문서 작성에서는 원본 코드를 재대조했으며 운영 서버를 변경하지 않았다.

| 검사 명령                                                | 결과                        | 해석                                                            |
| -------------------------------------------------------- | --------------------------- | --------------------------------------------------------------- |
| `pnpm install --ignore-scripts`                          | 성공                        | 의존성 설치. native lifecycle 실행 검증은 아님                  |
| `pnpm check`                                             | 성공                        | TypeScript 컴파일 검사 통과                                     |
| `pnpm test:unit`                                         | 14개 파일, 70개 테스트 통과 | 전체 unit 합계. RAG 전용 70개가 아님                            |
| `pnpm build`                                             | 성공                        | Vite 웹 production build 통과                                   |
| `pnpm test:integration`                                  | 45개 실패, 4개 skip         | 기존 회의 테스트는 DB 인증 설정 부족으로 fixture 생성 단계 실패 |
| `pnpm vitest run tests/integration/knowledge-db.test.ts` | 4개 모두 skip, exit 0       | 실제 knowledge DB 검증 성공으로 계산하면 안 됨                  |
| `pnpm format:check`                                      | 20개 파일 경고, 실패        | 그중 이번 RAG 관련 대상 검사에서는 15개 파일 경고               |
| `git diff --check origin/main^ origin/main`              | 성공                        | whitespace 검사 통과                                            |

통합 테스트의 대표 오류는 `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string`이었다. 임시 검사본에 유효한 `DATABASE_URL`을 제공하지 않은 환경 문제로, 이 결과만으로 코드 회귀를 확정하지 않는다. 지식 DB 테스트는 연결·migration 오류도 catch해서 skip하므로 오류 원인과 실제 실행 수를 별도로 확인해야 한다.

GitHub 연결에서 병합 커밋의 status와 PR-triggered workflow 조회 결과는 빈 목록이었다. CI 전체가 없다는 증거로 확대 해석하지 않는다. 구현 플랜에 있는 실API·4096차원 검증 보고는 이번 점검에서 재실행하지 않았다. 실제 Notion·GitHub·Discord·회의 DB 연동, Solar 응답, 운영 배포와 품질 평가는 미검증이다.

### 앞선 설명의 정정

- Gateway의 `MESSAGE_DELETE_BULK` 처리는 현재 코드에 없다. 단건 삭제와 구분한다.
- 회의 공유 해제는 현재 공유 목록에서 사라진 회의와 기존 지식 문서를 대조하지 않아 완성됐다고 볼 수 없다.
- Notion 전체 속성은 정규화되지 않는다. 제목과 본문·일부 댓글 위주다.
- PDF/OCR·이미지 내용 추출, GitHub PR·issue·discussion 수집, 이미지 생성 UI를 구현 완료 기능으로 소개하지 않는다.
- `crypto.randomUUID()`의 import가 없다는 이유만으로 버그로 잡지 않는다. 이 프로젝트는 Node 24를 요구하며 앞선 `pnpm check`는 통과했다.

## 3. 수정 우선순위

P1은 운영 제공 전 해결할 결함, P2는 파일럿 품질·명세 충족을 위한 보완이다. 아래의 “정적 확인”은 근거 코드를 읽어 확인한 것으로, 실제 운영 장애를 재현했다는 뜻은 아니다.

| ID      | 우선순위 | 문제                                                 | 근거 수준                   |
| ------- | -------- | ---------------------------------------------------- | --------------------------- |
| RAG-001 | P1       | 사용자·프로젝트·출처별 ACL 누락                      | 정적 확인                   |
| RAG-002 | P1       | 저장 답변에 권한·삭제 재검증 없음                    | 정적 확인                   |
| RAG-003 | P1       | 읽지 않은 출처도 LIVE_READ/COMPLETE 표시 가능        | 정적 확인                   |
| RAG-004 | P1       | 근거 revision을 생성 후 캡처하고 인용 검사가 무효    | 정적 확인                   |
| RAG-005 | P1       | 같은 내용을 다시 읽으면 dirty가 남아 검색에서 제외   | 정적 확인                   |
| RAG-006 | P1       | 문서 버전·활성 청크·오래된 worker 결과가 분리        | 정적 확인                   |
| RAG-007 | P1       | RUNNING 잡 lease 만료 회수와 쓰기 fencing 부족       | 정적 확인                   |
| RAG-008 | P1       | 질문 시 Discord 조회의 키·범위·오류·시간 제한 문제   | 정적 확인                   |
| RAG-009 | P1       | Discord 백필이 첫 slice 뒤 완료되고 head가 누락      | 정적 확인                   |
| RAG-010 | P1       | 스레드 실제 수집 연결 및 삭제·권한 이벤트 누락       | 정적 확인                   |
| RAG-011 | P1       | Gateway sequence·재연결·처리 순서·오류 내구성 부족   | 정적 확인, 연결 재현 필요   |
| RAG-012 | P1       | 회의 공유 해제·final·상태 변화 대조 부족             | 정적 확인                   |
| RAG-013 | P1       | Notion 페이지네이션·속성·삭제 대조 부족              | 정적 확인                   |
| RAG-014 | P1       | webhook이 허용 source/repo/ref/page에 결속되지 않음  | 정적 확인                   |
| RAG-015 | P1       | 기능 off와 기존 Compose 독립 기동이 불완전           | 정적 확인, Docker 재현 필요 |
| RAG-016 | P1       | DB 테스트 skip으로 실제 결함을 감출 수 있음          | 실행+정적 확인              |
| RAG-017 | P2       | history/as_of/branch/SSE·대화 옵션이 실동작하지 않음 | 정적 확인                   |
| RAG-018 | P2       | 승인되지 않은 스타일 사용, 이미지 명세 미구현        | 정적 확인                   |
| RAG-019 | P2       | 검색 출처 분배·예산·usage·미구현 범위 보고 부족      | 정적 확인                   |
| RAG-020 | P2       | 포맷 검사 실패와 완료 보고의 증거 수준 혼재          | 실행+정적 확인              |

## 4. 문제별 수정 지시와 완료 기준

### RAG-001

사용자·프로젝트·출처별 ACL을 검색 전에 적용한다.

- 근거: `packages/knowledge/src/retrieve.ts:46`의 `baseFrom`, `:94`의 vector SQL은 프로젝트 ID·READY·dirty·deleted만 확인한다. `knowledge_sources.status`, `source_scopes.allowed`, 문서 ACL, 사용자 membership/role을 검색 조건에 넣지 않는다. `apps/api/src/knowledge.ts:131`은 Discord 길드 구성원 검사만 하고, `:147` 등은 생성 순 첫 프로젝트를 선택한다.
- 영향: 길드에 가입한 사용자가 읽어서는 안 되는 채널·페이지·다른 프로젝트의 자료를 검색하거나 모델 입력으로 전달할 수 있다. DB의 ACL 관련 테이블 존재는 ACL 적용 완료의 증거가 아니다.
- 수정: 인증 사용자에서 허용 프로젝트·scope를 결정하고 keyword/vector/image 검색에 동일 필터를 적용한다. 비활성·접근 상실 source를 차단하며 권한 epoch 변경을 반영한다.
- 완료 기준: 프로젝트 A/B, 허용/비허용 채널, 권한 회수, disabled source fixture에서 금지 청크가 후보·모델 입력·응답 어느 단계에도 나타나지 않는다.

### RAG-002

저장 답변을 다시 열 때 권한과 근거 상태를 검증한다.

- 근거: `apps/api/src/knowledge.ts:168`은 `answer_runs WHERE id=...`에서 body를 그대로 반환한다. 사용자·프로젝트 접근 조건과 evidence 재검증이 없다. `packages/knowledge-db/src/index.ts:248`의 tombstone은 문서와 active chunk set을 차단하지만 저장된 `answer_runs.body`, quote, 파생 콘텐츠 정리 경로가 없다.
- 영향: 원문 삭제·채널 권한 회수 이후에도 저장 답변에서 이전 본문이 다시 노출될 수 있다. UUID를 알고 있는 다른 길드 구성원의 조회 정책도 정의되지 않았다.
- 수정: 프로젝트 공유 정책에 맞는 조회 권한을 적용하고 원문 삭제/ACL 변경 시 answer 본문·quote·캐시를 재검증 또는 마스킹한다. 자신의 답변만 조회할지 프로젝트 공유 답변인지 정책을 명시한다. 원문 보존·비동기 삭제는 명세 §8.2를 따른다.
- 완료 기준: 답변 저장→원문 삭제/공유 해제/role 변경→답변 재조회 시 민감 본문이 노출되지 않는다. 권한 없는 사용자의 ID 직접 조회도 차단된다.

### RAG-003

실제 출처 확인 결과로 coverage와 COMPLETE를 결정한다.

- 근거: `packages/knowledge/src/answer.ts:248`은 등록된 Notion/GitHub/meeting을 무조건 `LIVE_READ`, `scope_complete=true`로 만든다. 등록되지 않은 source는 `NOT_APPLICABLE`이고 Discord 미등록 시 `discordOk=true`다. `:274`의 COMPLETE 판정은 전체 source 상태·backfill·인덱스 pending·최신 확인을 검사하지 않는다.
- 영향: 토큰 없음, 수집 실패, 오래된 cursor, Discord 미등록 상태도 전체 확인 완료로 표시될 수 있다.
- 수정: source/scope별 live read, 검색 실행, freshness, 커버리지와 gap 결과를 모아 판정한다. 정상 무결과와 읽기 실패를 구분한다. 이 프로젝트에서 필수인 Discord가 비활성/미등록이면 COMPLETE를 금지한다. `last_success` 하나로 전체 scope를 최신으로 간주하지 않는다.
- 완료 기준: 토큰 없음·403·429·백필 미완료·pending index·stale cursor·관련 결과 없음 각각에서 올바른 coverage/status를 검증한다. 실패한 출처를 `NO_MATCH`나 `LIVE_READ`로 가장하지 않는다.

### RAG-004

검색 시점의 근거 버전을 고정하고 답변 본문까지 재검증한다.

- 근거: `packages/knowledge/src/answer.ts:205`의 모델 호출이 끝난 후 `:214`에서 current content hash를 캡처한다. `:125`의 `content.includes('')`는 항상 true여서 인용 검사 역할을 하지 못한다. 재검증은 dirty·source ACL·active chunk/version 일치·원본 API 상태를 확인하지 않는다. 무효 evidence를 제거해도 `:294`에서 모델의 answer 본문은 그대로 남는다.
- 영향: 생성 중 v1→v2가 되면 v1 청크 답변에 v2 revision이 붙을 수 있다. 삭제된 근거의 주장도 본문에 남을 수 있다.
- 수정: retrieve 결과에 version_id/hash/chunk_set_id/span/실제 관측 시각을 함께 캡처한다. 생성 후 같은 버전·권한·인용 span과 원본 상태를 재확인한다. 근거 탈락 시 영향받는 본문을 재생성/제거하거나 실패·부분 응답으로 처리한다. `observed_at`에 단순 응답 작성 시각을 넣지 않는다.
- 완료 기준: 느린 모델 fixture 동안 문서 수정·삭제·dirty·ACL 회수를 각각 발생시키면 오래된 주장과 잘못된 revision이 최종 응답에 남지 않는다. 존재하지 않는 인용도 통과하지 않는다.

### RAG-005

동일 내용 재수집이 검색 문서를 숨기지 않도록 한다.

- 근거: `DiscordCollector.ingestMessage` (`packages/knowledge/src/discord.ts:143`)와 `NotionCollector.ingestPage` (`packages/knowledge/src/notion.ts:198`)는 먼저 `markDocumentDirty`를 호출한다. 같은 hash면 각각 `discord.ts:158`, `notion.ts:213`에서 바로 반환한다. `markDocumentDirty`는 기존 문서에 dirty=true를 쓰고 retrieve는 NOT dirty만 읽는다.
- 영향: Discord head 대조·Notion 구조 대조가 내용이 같은 문서를 반복 읽으면 검색 가능하던 문서가 검색에서 사라질 수 있다. 재추출 잡도 생성하지 않는다.
- 재현: 문서 1회 수집·청킹·검색→동일 payload 재수집→dirty와 검색 결과 확인. DB 또는 store fixture로 재현한다.
- 수정/완료 기준: hash 비교와 dirty 전환을 원자적으로 처리하거나 동일 revision 경로를 안전하게 정리한다. 동시 최신 편집의 dirty를 잘못 해제하지 않는다. 동일 수집은 검색 가능 상태와 active set을 유지하며 변경 수집은 새 버전 준비 전 현재 근거에서 제외한다.

### RAG-006

문서 current version과 활성 청크·임베딩을 결속한다.

- 근거: `packages/knowledge-db/src/index.ts:204`는 fetch 직후 READY/dirty=false를 쓰지만 이전 active chunk set은 남는다. chunk_sets에는 version_id가 없다. `packages/knowledge/src/indexer.ts:21`은 잡 payload의 hash를 확인하지 않고 현재 문서를 추출하며, `swapChunkSet`은 문서 current/generation을 검사하지 않는다. `publishVersion`의 expectedRevision 인자도 사용되지 않는다.
- 추가 경로: `queueExtract`의 key는 document+hash이고 enqueue는 충돌 시 무시한다. v1→v2→v1 revert에서 v1 extract 잡이 이미 DONE이면 재추출 없이 v2 청크가 남을 수 있다. tombstone 해제 함수는 있지만 collectors에 실제 원본 복원 호출 경로가 없다.
- 영향: 새 문서와 오래된 청크의 조합, 늦은 worker의 덮어쓰기, revert/복원 후 검색 누락이 가능하다.
- 수정: immutable version/revision과 chunk_set·embedding·잡을 연결한다. 활성화 시 current version·generation·삭제 상태를 한 트랜잭션에서 검사하고 최신 버전 준비까지 dirty를 유지한다. 원본 존재 재확인을 포함한 복원과 revert 재사용/재인덱스 정책을 구현한다.
- 완료 기준: v1→v2, v1→v2→v1, 두 worker 역순 완료, 처리 중 삭제/복원에서 현재 본문·청크·vector가 같은 버전을 가리킨다.

### RAG-007

만료된 RUNNING 작업을 회수하고 결과 쓰기까지 fence한다.

- 근거: `packages/knowledge-db/src/index.ts:99`의 claim 대상은 PENDING/RETRYABLE뿐이다. lease 만료 RUNNING을 회수하는 경로가 없다. finish/retry는 generation만 검사하고 owner·유효 lease·RUNNING 여부를 검사하지 않는다. 문서 publish·chunk swap에는 잡 소유권 검증이 없다.
- 영향: worker가 중단되면 잡이 영구 RUNNING으로 남고, 오래된 worker 결과가 active index를 바꿀 수 있다. 현재 DB 테스트 제목은 stale generation을 언급하지만 lease 만료 후 재claim 경로를 실제 검증하지 않는다.
- 수정/완료 기준: lease 회수와 generation 증가를 구현하고 publish/index 결과 쓰기까지 같은 fence를 적용한다. worker A claim→lease 만료→B 재claim→A 늦은 완료가 거부되고 B만 current를 갱신하는 DB 테스트를 통과한다.

### RAG-008

질문마다 Discord 실제 읽기를 올바른 키와 scope로 수행한다.

- 근거: `apps/api/src/knowledge.ts:80`은 source_scopes가 아닌 connector_cursors에서 채널을 고르고 `:93`에서 guildId를 빈 문자열로 전달한다. source/project/status/allowed 검사와 thread 확인이 부족하다. `reconcileHead`가 `{ access_lost:true }`를 반환해도 결과를 검사하지 않고 `ok=true`를 반환할 수 있다. 채널 0개도 성공으로 처리한다.
- 영향: `discord::channel:message`라는 별도 문서를 만들거나, 권한 상실/미수집을 성공으로 판정할 수 있다. 이 API 쓰기는 discord-context가 유일 작성자라는 주석과도 충돌한다.
- 시간 제한: `answer.ts:169`는 설정값 대신 10초를 전달하며 live 함수는 루프 사이에서만 deadline을 확인한다. REST 한 번은 최대 30초+retry이고 전체 AbortSignal이 없다. 읽기 후 extract/index 완료를 기다리지 않아 새 대화가 같은 질문 검색에 포함되지 않을 수 있다. 선택된 과거 메시지·답글 원문의 ID 재조회도 연결되지 않았다.
- 수정/완료 기준: 올바른 guild/project와 허용 채널·스레드를 사용한다. 단일 작성자 refresh 요청 또는 ACL/버전이 있는 ephemeral evidence 방식을 선택한다. 전체 live budget과 HTTP abort를 전달하고 읽은 최신 메시지를 현재 질문 근거에 반영한다. 403·500·채널 0개·느린 API·새 메시지·오래된 메시지 편집에서 성공/실패와 evidence가 정확해야 한다.

### RAG-009

Discord 백필을 실제 과거 끝까지 이어간다.

- 근거: `packages/knowledge/src/discord.ts:215`에서 head ID를 before/newest cursor로 저장하지만 head 본문을 ingest하지 않는다. `:245`의 done은 `fetched > 0`이면 true이고 `:249`에서 backfill_done=true가 된다. `apps/discord-context/src/main.ts:18`은 slice=500이다.
- 영향: 첫 500건 뒤 과거가 남아도 완료로 표시되고 이후 호출에서 과거 수집을 건너뛴다. 고정 head는 최근 20건 창 밖으로 밀리면 빠질 수 있다.
- 수정/완료 기준: slice 소진, provider 끝, 일시 오류, 권한 실패를 구분한다. 시작 head를 저장하고 oldest cursor부터 재개한다. 1,201개 메시지 fixture를 500건씩 호출해 모든 ID가 정확히 한 번 논리 수집되고 최종 빈/짧은 페이지 확인 때만 complete가 된다. 오류 페이지에서는 cursor와 완료 상태를 잘못 전진시키지 않는다.

### RAG-010

스레드 탐색을 수집으로 연결하고 삭제·권한 변경을 처리한다.

- 근거: `discord.ts:295`의 discoverThreads는 ID 목록을 반환하지만 `apps/discord-context/src/main.ts:94`는 결과를 버린다. 초기 polling loop도 discoverThreads를 호출하거나 발견 thread를 허용 parent 정책에 따라 수집하지 않는다. 초기 seed는 text/announcement 채널 중심이다. Gateway 분기에 MESSAGE_DELETE_BULK, CHANNEL/ROLE/permission/guild access loss 처리와 thread 삭제 tombstone이 없다. 첨부 제거 시 이전 attachments 행 정리도 없다.
- 수정: 허용 parent에 속한 접근 가능한 스레드를 검증해 수집 대상에 연결한다. 공개/참여 비공개 보관 목록의 provider cursor 규칙을 구분한다. 삭제·접근 회수·첨부 제거 시 문서와 파생 자료를 차단한다.
- 완료 기준: 신규/기존/보관 thread, 100개 초과 보관 목록, bulk delete, channel 권한 회수, thread 삭제, attachment-only 편집/제거가 검색·저장 답변에 반영된다. 비허용 parent의 thread는 수집하지 않는다.

### RAG-011

Gateway 연결과 처리 진행을 내구적으로 관리한다.

- 근거: `packages/knowledge/src/discord-gateway.ts:5`의 GATEWAY에 query가 있는데 `:166`에서 query를 다시 붙인다. `:79`는 sequence 역행만 감지하고 `s > previous+1` gap은 감지하지 않는다. seq는 이벤트 내구 처리 전에 갱신되며 메모리에만 있다. `:171`은 async packet 처리를 직렬화하지 않고 오류를 catch해서 버린다. 정상 close 후 run은 재연결하지만 이를 모두 resync로 연결하지는 않는다.
- 영향: 연결 URL·재연결 상태는 실Gateway 재현이 필요하다. 코드상으로는 역순 처리, DB 실패 유실, 재시작 뒤 누락 범위를 증명할 수 없는 상태다.
- 수정/완료 기준: URL을 URL API로 조립하고 session별 received/durably processed sequence를 구분한다. 이벤트 처리 직렬화/내구 큐·오류 기록·재시작/close 복구를 구현한다. +2 gap, DB 실패, out-of-order update, invalid session, 정상/비정상 close, 프로세스 재시작 fixture와 실제 ready/resumed 관측을 남긴다.

### RAG-012

회의 공유 해제와 final·상태 변화를 반영한다.

- 근거: `packages/knowledge/src/juncoy.ts:31`은 현재 workspace_meetings에 존재하는 행만 읽고 `:151`은 이 목록만 처리한다. 목록에서 사라진 기존 회의 지식 문서를 대조하지 않는다. `:56`은 canonical만 검사하고 body의 is_final 조건이 없다. `:104`는 transcript_version이 같으면 meeting status/종료 시각 변화도 건너뛴다. 커서는 meeting_id+transcript_version이며 명세의 event_seq/cursor floor 정책이 구현된 것은 아니다.
- 수정/완료 기준: 성공한 공유 목록 조회와 기존 수집 목록을 대조해 공유 해제를 차단한다. 원본 DB 구조에 맞는 canonical+final 필터, 상태 변경 fingerprint/커서 정책을 구현한다. 공유 취소·삭제·정정·replacement·partial→final·동일 전사 버전 회의 종료가 반영되고 목록 API/DB 실패를 전체 삭제로 오해하지 않는다.

### RAG-013

Notion 전체 페이지네이션·속성·접근 회수 대조를 보완한다.

- 근거: `packages/knowledge/src/notion.ts:272`는 `searchPages(cursor)`를 호출하지만 시그니처는 `searchPages(editedAfter?, cursor?)`여서 다음 cursor가 body의 start_cursor로 전달되지 않는다. 100개 초과 workspace에서 같은 첫 페이지를 반복할 수 있다. 댓글은 첫 100개만 읽으며 본문+댓글 hash에는 title/property 변경이 포함되지 않는다. 페이지 조회에서 403/404를 받으면 tombstone하지만 검색 목록에서 사라진 기존 페이지를 재대조하는 경로가 없다.
- 범위: syncIncremental은 지정 root의 하위인지 검증하지 않고 integration 검색에 노출된 모든 페이지를 수집한다. database 속성·relation·첨부 내용은 완성된 수집 범위가 아니다.
- 수정/완료 기준: start_cursor 전달, 댓글 pagination, typed property/hash, 허용 root/data-source 범위 및 기존 페이지 접근 대조를 구현한다. 201개 페이지·101개 댓글, 제목/status/relation만 수정, 페이지 공유 해제/삭제, 비허용 root가 회귀 테스트에 포함된다. provider API 버전·data source 지원은 현재 공식 문서와 실API로 확인한다.

### RAG-014

webhook을 허용된 프로젝트·source·scope에 매핑한다.

- 근거: `apps/api/src/knowledge.ts:212`, `:240`은 각각 첫 ACTIVE source를 선택한다. GitHub payload repo/ref를 allowlist와 비교하지 않고 refresh job에 넣으며 worker도 첫 source를 선택한다. Notion pageId는 data.page_id/data.id/payload.id fallback이고 event ID와 page ID 혼동 가능성이 있다. recordSourceEvent와 enqueueJob이 별도 작업이라 이벤트 기록 후 enqueue 전 중단되면 GitHub 재전송이 duplicate로 조기 종료한다.
- 수정/완료 기준: installation/repo/ref 또는 integration/entity ID에서 정확한 source와 scope를 검증한다. source_id를 잡 payload에 유지하고, event 기록+outbox/job 생성의 원자성 및 중복 복구를 제공한다. 허용 밖 repo/ref/page는 수집하지 않는다. 공식 Notion handshake와 실제 payload fixture를 사용하고 중단/재전송이 refresh를 잃거나 중복 실행하지 않는다.

### RAG-015

기능 off와 Compose 독립 기동·migration 순서를 고친다.

- 근거: `infra/compose.yml:44`와 `:98`은 외부 discord-knowledge_default 네트워크를 항상 요구한다. `infra/compose.knowledge.yml:17`의 worker 의존성은 DB healthy뿐이며 migrate 성공 선행 조건과 seed 서비스가 없다. `apps/api/src/knowledge.ts:107`은 KNOWLEDGE_ENABLED=false여도 DB URL만 있으면 ctx를 만든다. `:136`의 일반 Error에 붙인 statusCode/code는 `apps/api/src/server.ts:93`에서 429 외에는 500/TEMPORARY_FAILURE로 변환된다. API knowledge pool의 onClose 정리·실패 ctx 재초기화도 필요하다.
- 수정/완료 기준: base meeting Compose를 knowledge 없이 기동할 수 있게 하고 integration override/profile을 둔다. fresh DB는 migrate 성공 후 worker가 시작하고 seed 실행 절차를 문서화한다. off이면 Knowledge DB/provider를 호출하지 않고 503/KNOWLEDGE_DISABLED를 반환한다. API close 시 pool 종료, 최초 DB 장애 후 복구 재시도, 무지식 환경 기동을 검증한다. 운영 회의 서비스를 직접 재기동해 시험하지 않는다.

### RAG-016

DB 통합 테스트가 실패와 미설정을 구분하도록 한다.

- 근거: `tests/integration/knowledge-db.test.ts:12`는 DB URL 없음과 연결/migration 실패 모두 ready=false로 바꿔 4개를 skip한다. 생성한 test schema/pool의 afterAll 정리도 없다. 현재 테스트는 events/tombstone/chunk set 기본 동작 위주로 실제 RAG API·수집기·경쟁 상태를 검사하지 않는다.
- 수정: DB URL을 지정한 CI에서 연결/migration 실패는 실패로 보고한다. DB 미설정 개발 실행의 skip은 명시한다. pgvector 테스트 DB와 schema/connection teardown을 준비하고 이 문서의 재현 시나리오를 회귀 테스트로 추가한다.
- 완료 기준: DB 없는 실행은 이유와 skip 수가 보이고, 잘못된 URL/망가진 migration은 CI 실패가 된다. 유효 DB에서 4개 기존 테스트와 신규 ACL/버전/lease/API 테스트가 실제 실행된다. production DB에 테스트 schema를 만들지 않는다.

### RAG-017

지원하지 않는 질의 옵션을 조용히 무시하지 않는다.

- 근거: `packages/contracts/src/knowledge.ts:149`에 history/as_of/branch/conversation_id가 있으나 answer retrieve는 현재 active set만 검색한다. as_of는 run에 저장될 뿐 검색·모델 근거 시점에 쓰이지 않고 branch/conversation_id도 동작에 반영되지 않는다. API ask는 동기 POST이며 knowledge SSE endpoint는 없다. 기존 meeting SSE는 knowledge SSE 구현 증거가 아니다.
- 수정/완료 기준: history/as_of/branch를 실제 검색·근거 버전·ACL에 적용하거나 미지원 오류로 반환한다. P9의 async 실행/SSE, conversation 맥락, 상태 UI 범위를 명세와 맞춘다. 서로 다른 branch·날짜 질문이 구분되고 검증 전 draft가 최종 답변처럼 노출되지 않는다.

### RAG-018

이미지 프롬프트의 스타일 승인과 근거 추적을 구현한다.

- 근거: `packages/knowledge/src/image-prompt.ts:20`은 approved_by/approved_at 조건 없이 최신 style version을 사용한다. buildImagePrompt는 Solar 합성이 아니라 요청·청크 일부·문자열 스타일을 결합한다. Discord live read·근거 재검증·version/hash 기록·승인 UI가 없고 실제 image provider는 연결되지 않았다. 응답 generation은 항상 provider_unconfigured다.
- 수정/완료 기준: 승인된 profile만 쓰고 승인 취소/근거 삭제/새 결정 시 stale를 처리한다. prompt-only를 UI/API에서 정확히 설명하고 근거 버전/시각을 기록한다. provider 미설정 상태는 생성 완료로 표시하지 않는다. 실제 이미지 provider 도입은 별도 선택·범위 확정 후 진행한다.

### RAG-019

검색·시간·usage 계측과 남은 범위를 정확히 보고한다.

- 근거: `packages/knowledge/src/retrieve.ts:123`의 perSourceLimit는 source별이 아니라 전체 keyword/vector SQL LIMIT이다. source 한 종류가 후보를 독점할 수 있다. Solar wrapper는 사용량을 버리고 `answer.ts:204`는 input/output tokens를 0으로 고정한다. API embedding client는 env model override를 받지 않지만 ensureProfile은 env 모델명을 기록한다. 동일 token 전역 limiter 공유 구현도 없다.
- 미구현 범위: GitHub PR/issue/discussion 수집, PDF 텍스트·OCR·이미지 이해, 코드 AST 청킹, 지속 claim 그래프 갱신, retrieval gold/Recall@20 harness. 현재 코드 청킹은 regex 경계다.
- 수정/완료 기준: source별 후보/최소 커버리지, query/document model과 profile 일치, 실제 provider usage 및 단계별 latency를 기록한다. 한국어·코드 식별자·회의·Discord 맥락 gold 질문을 평가한다. 미구현 기능은 backlog에 명시하고 완료 단계와 구분한다. 음성 봇과 token을 공유한다면 provider 요구에 맞는 공용 rate-limit 전략과 검증을 둔다.

### RAG-020

포맷과 완료 문서의 기준을 맞춘다.

- 근거: 점검 당시 format:check는 20개 파일에서 실패했고 그중 RAG 대상 15개가 포함됐다. 구현 실행 플랜에는 실제 코드와 다른 API 구조, 공유 취소·ACL-first·이미지 승인·PDF/AST 등의 완료 인상을 주는 설명이 있다.
- 수정/완료 기준: 수정 파일의 포맷을 맞추고 기존 무관한 경고와 새 경고를 구분한다. P 상태를 코드 있음/mock 검증/실API 검증/배포/팀 사용 가능으로 기록한다. 날짜·커밋·실행 명령·pass/fail/skip 수·남은 작업을 최종 보고에 포함한다.

## 5. 다음 에이전트의 실행 순서

1. 실제 저장소 root, HEAD, 원격, dirty 파일을 확인한다. 다른 작업 환경에서는 이 문서의 기준 SHA와 자기 HEAD의 차이를 확인한다. 저장소 지침과 Graphify 승인 상태를 따른다.
2. RAG-016의 재현 가능한 테스트 DB/fixture를 먼저 준비하면서 RAG-001~004의 권한·coverage·근거 검증부터 수정한다.
3. RAG-005~007의 버전·청크·잡 일관성을 수정한다. 이 공통 기반을 고치기 전에는 collector 최신성만으로 완료 판정하지 않는다.
4. RAG-008~011의 Discord 필수 읽기·백필·스레드·삭제·Gateway를 수정한다.
5. RAG-012~014의 회의·Notion·webhook 수집 범위와 삭제 대조를 수정한다.
6. RAG-015의 off/Compose/migration/seed를 검증한 뒤, 자격증명·권한이 있는 sandbox에서 네 출처를 연결해 실제 질의한다.
7. RAG-017~020을 구현하거나 명시적 미지원/backlog로 정리하고 인수 결과를 제출한다.

서로 연관된 ACL·버전·수집기 변경은 공동 테스트로 검증한다. 단순히 모든 표의 체크를 완료로 바꾸는 것으로 종료하지 않는다.

## 6. 운영 연동 상태 확인표

아래는 운영 접근 시 확인할 항목이며 이번 문서 작성에서 실값·live 상태를 확인했다는 뜻은 아니다. `.env.knowledge.example`은 예시일 뿐 실제 자격증명의 존재/부재를 증명하지 않는다. 실행 플랜의 Notion token 상태도 문단 간 다르므로 재확인한다.

| 연결           | 필요한 확인                                                                                 | 완료 증거                                                 |
| -------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Knowledge DB   | pgvector, migration, seed, source/scope, worker                                             | 건강 상태와 실제 READY 문서/청크/vector 수, backlog·gap   |
| Juncoy 회의 DB | 전용 read-only role, MEETING_DATABASE_URL, workspace 공유                                   | 조회 성공 및 정정·삭제·공유 해제 시험; 쓰기 권한 없음     |
| Notion         | 운영 integration token, 허용 root 공유, webhook                                             | 실제 허용 페이지 read·수정·archive·접근 회수 반영         |
| GitHub         | App ID/private key/installation/secret 또는 명시적 PAT polling                              | Team_23 허용 ref별 HEAD 일치와 push/delete/revert 반영    |
| Discord        | bot token, guild, VIEW_CHANNEL/READ_MESSAGE_HISTORY, MessageContent intent, discord profile | 본문 실제 수신, 과거 끝까지 백필, thread·edit·delete 반영 |
| Upstage        | Solar Pro 4 모델, embedding 모델·4096차원·usage                                             | 실제 요청 성공, profile/vector 일치, citation 포함 답변   |
| 이미지         | provider 미설정 또는 확정된 공급자, 사람 승인 style                                         | prompt-only 명시 또는 실제 결과·비용·근거 버전            |

조사용 notion-second MCP 로그인은 운영 worker의 NOTION_TOKEN과 다른 연결이다. 운영 토큰을 확보한 뒤 그 연결에서 실제 허용 루트를 읽어 검증한다. 시크릿은 Git·보고서·로그에 남기지 않는다.

## 7. 검증 명령과 인수 체크리스트

Node `>=24 <25`, pnpm `10.33.0`을 기준으로 실행한다. 다른 환경에서는 먼저 버전을 확인한다.

```bash
git status --short --branch
git rev-parse HEAD
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm check
pnpm test:unit
pnpm vitest run tests/unit/knowledge-*.test.ts
pnpm vitest run tests/integration/knowledge-db.test.ts
pnpm test:integration
pnpm build
pnpm format:check
git diff --check
```

knowledge DB/meeting DB 통합 테스트는 별도 격리된 테스트 DB URL을 설정한 환경에서 수행한다. 테스트가 skip되거나 DB 연결 단계에서 실패하면 실제 RAG 통합 성공으로 보고하지 않는다. Docker/실API/브라우저 인수는 위 명령만으로 대체할 수 없다.

- [ ] RAG-001~016을 수정하고 항목별 재현/회귀 테스트 결과를 기록했다.
- [ ] 권한 없는 자료는 검색 후보·모델 입력·저장 답변에서 차단된다.
- [ ] 네 출처 읽기 실패·무결과·pending·stale가 구분되며 Discord 확인 실패 시 COMPLETE가 금지된다.
- [ ] 동일 수집·역순 worker·revert·lease 만료·삭제/복원에서 버전과 active index가 일치한다.
- [ ] Discord 과거 전체·스레드·최신 메시지·과거 근거 재조회·편집·bulk delete·권한 회수를 시험했다.
- [ ] 회의 공유 취소와 Notion 페이지 공유 해제/삭제가 검색·답변에서 반영된다.
- [ ] knowledge off와 knowledge 미설치에서 기존 회의 스택이 독립 기동한다.
- [ ] 실제 DB 테스트가 실행됐고 migration 오류가 skip으로 숨겨지지 않는다.
- [ ] sandbox 실제 네 출처를 묻는 한국어 질문·코드 위치·결정 충돌 질문에 원문 근거와 최신성 상태가 맞는다.
- [ ] RAG-017~020은 구현 결과 또는 명시적 backlog와 미지원 응답을 기록했다.
- [ ] 기존 음성 수집·회의 API·전사·요약 회귀 검증을 완료했다.
- [ ] 변경 파일, 기준/최종 SHA, 테스트 수, 배포 여부, 남은 운영 설정을 최종 보고했다.

현재 요청의 산출물은 문서와 Git 업로드다. 구현 수정·production 배포·운영 회의 중단은 이 문서 작성에 포함되지 않았다. 다음 구현 에이전트는 받은 요청 범위에서 작업하고 배포 권한은 별도로 확인한다.
