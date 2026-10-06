# 23시 정시퇴근 RAG 개발 플랜

작성일: 2026-10-06 (Asia/Seoul) · 기준: [개발 명세서](RAG_DEVELOPMENT_SPEC.md) v1.0

구현·배포를 이미 완료한 기록이 아니라 개발 순서와 인수 기준이다. 날짜는 필수 계정 접근을 확보하고 개발을 시작한다는 가정의 파일럿 목표이며, 공급자·커버리지·시험 결과에 따라 조정한다. 담당 역할은 실제 팀원에게 새 업무를 배정한 결과가 아니다.

## 1. 출시 목표

이번 주 목표는 네 출처를 종합하는 팀 문답 파일럿과 근거를 가진 이미지 프롬프트 지원이다. Discord 과거/실시간 수집과 매 질문 최신 확인은 출시 필수다. 실제 이미지 생성까지 제공하려면 이미지 공급자와 참조 이미지 정책을 초기에 확정해야 한다.

### 파일럿에 반드시 포함

- Notion 승인 루트의 본문·속성·기획/회의 PDF·관계, GitHub 지정 브랜치의 코드/문서/변경, Discord 지정 채널·스레드 과거 기록/변경, Juncoy canonical 전사.
- 이벤트 수신·누락 대조, 질문마다 Discord 최신 대화 확인, 관련 원본/브랜치/회의 버전 최신화.
- 출처 상태·미수집 범위, 충돌/미정 구분, 인용을 가진 Solar Pro 4 답변.
- 승인 스타일·레퍼런스·현재 근거를 담은 이미지 프롬프트 검토 화면.
- 원본 생성/편집/삭제/권한/장애의 동적 인수 시험.

### 후속 확장

- 전체 Unreal asset/blueprint export와 영상/첨부 자동 의미 분석.
- 자동 vision 태깅·멀티모달 임베딩·대규모 claim graph.
- Discord 질문 명령·알림·여러 프로젝트.

백필 미완료 또는 Discord 확인 실패 상태에서 프로젝트 전체를 이해한 완성 시스템이라고 보고하지 않는다.

## 2. 착수 전 확인값

| ID | 필요한 값 | 기본안 / 미확정 시 영향 | 목표 시점 |
|---|---|---|---|
| C01 | Notion 서버용 읽기 인증과 루트 공유 | notion-second는 조사용; 운영 인증 없으면 live 파일럿 불가 | 10/6 |
| C02 | GitHub App 저장소 read·webhook | fixture 개발은 가능, 실시간 연결은 설정 후 | 10/6 |
| C03 | Discord MessageContent intent와 scope | REST 성공; Gateway 실제 수신 시험 필수 | 10/6 |
| C04 | shared 원본 범위·제한 ACL | 지정 팀 루트/채널/저장소; restricted는 확인 전 차단 | 10/6 |
| C05 | 임베딩 모델 쌍·차원·길이·비용 | Upstage 우선 한국어/코드 시험, 임의 차원 migration 금지 | 10/6~7 |
| C06 | 이미지 공급자·모델·운영 인증·가격 | 미선택이면 프롬프트 지원까지만 공개 | 10/7 |
| C07 | 아트 승인자·style profile·참조 | 최신 채팅/문서로 후보 작성 후 사람이 승인 | 10/8 |
| C08 | 브랜치 기본 정책 | main/SideView/Stairs 분리, 신규 ref 탐색 | 10/6 |
| C09 | 운영 리소스·예산 상한·retention | 별도 지식 DB/큐/서비스와 요청 제한 | 10/7 |

fixture·계약·adapter·테스트는 값 확보와 병행한다. 실제 인증이나 사람이 정할 승인 범위를 가정하여 외부 설정·공유·유료 생성·배포를 수행하지 않는다.

## 3. 의존 순서

~~~text
W01 계약 -> W02 DB/큐/권한 -> W03 Discord ─┐
                         -> W04 Notion ──┤
                         -> W05 GitHub ──┼-> W07 추출/인덱스
                         -> W06 Juncoy ──┘        |
                                                  v
W08 검색 -> W09 최신 원문/충돌 -> W10 문답 API/UI
                                |
                                v
                       W11 이미지 프롬프트/생성
                                |
                                v
                       W12 인수/운영/배포
~~~

W03~W06은 W01/W02의 DTO·ACL·멱등 job 계약이 정해지면 병행한다. Discord는 첫 수집 구현이다. W08은 fixture로 개발하되 W09 live 확인 통과 전 최신 문답을 출시하지 않는다.

## 4. 작업과 완료 산출물

| 작업 | 구체 작업 / 파일 영역 | 의존 | 완료 판정 | 요구 |
|---|---|---|---|---|
| W01 | contracts/knowledge.ts, 지식 config, source/ACL/응답 enum | C04/C08 | DTO, current/history·Discord coverage 계약 | R02,R11,R12,R15 |
| W02 | knowledge-db migration, 큐/lease/fencing, 원본/version/tombstone | W01 | 중복/역순/lease 상실에서도 current 정합 | R01,R03,R08,R13,R14,R19 |
| W03 | discord-context, REST backfill·reply·스레드·Gateway·편집/삭제 | W02,C03 | 실제 메시지·스레드·내용 제한/resume gap 시험 | R01~R05,R13,R18 |
| W04 | Notion API/Webhook, 재귀 block·속성·relation·첨부·서명·대조 | W02,C01 | 첨부 내용, 변경/권한/미지원 coverage | R01,R03~R05,R13,R18 |
| W05 | GitHub App, webhook/HEAD/tree/blob·force-push/revert·PR/issue | W02,C02/C08 | ref 구분, webhook 누락 후 HEAD 복구 | R01,R03,R04,R06,R18 |
| W06 | Juncoy read-only workspace/event/version/canonical/삭제 대조 | W02 | 정정/대체/공유 취소 반영, 테스트 길드 제외 | R01,R03,R04,R07,R19 |
| W07 | normalize/chunk/extract, PDF/표·이미지 metadata·relation·active swap | W03~W06 | citation/span 보존, dirty/삭제 current 제외 | R05,R08,R14 |
| W08 | 임베딩/profile, structured+keyword+vector/RRF, ACL-first | W07,C05 | 한국어/코드/속성 검색, 골드 Recall@20 | R08,R09,R13 |
| W09 | refresh coordinator, 매질문 Discord, source budget·충돌·재검증 | W03~W08 | 변경중/장애 COMPLETE 오표시 0 | R02,R04,R10~R14 |
| W10 | knowledge-api 질문/status/evidence/SSE, 웹 근거·버전·부분 상태 | W09 | session/ACL 질의, 근거 링크, 지연/실패 UX | R11~R15,R18 |
| W11A | style 승인/버전, prompt composer, 참조·최신 근거 검증 | W09/W10,C07 | 아트 변경과 공간/캐릭터 제약 반영 | R16 |
| W11B | image adapter/job/result/cost, 미리보기·재생성·변경 경고 | W11A,C06/C09 | 실제 생성 1건, 모델/근거/비용 기록 | R17 |
| W12 | fixture/sandbox·권한·누락·429·부하·복원/롤백 runbook | 모든 P0 | 인수표 통과, 회의 서비스 회귀 없음 | R18~R20 |

변경 묶음: 기반 DB/계약 → Discord → Notion/GitHub → 회의/추출 → 검색/문답 → UI/이미지 → 운영. 실제 branch/PR와 원격 반영은 구현 단계의 팀 정책에 따른다.

역할 제안: 주 개발자(통합/문답), source 작업자(adapter), 아트 검토자(style/생성), 팀 검토자(골드 질문/결정 맥락), 운영 담당자(인증/webhook/자원). 이번 문서 작성은 팀원에게 메시지 전송이나 업무 배정을 포함하지 않는다.

## 5. 10월 11일 파일럿 목표 일정

| 날짜 | 목표 | 확인 가능한 결과 | 다음 단계 조건 |
|---|---|---|---|
| 10/6 화 | W01/W02, 인증/scope, Discord skeleton | DTO/DB/큐, 공식 연결, 최근 채팅 읽기 | 멱등 저장·권한 정책 |
| 10/7 수 | W03~W06, 임베딩/이미지 공급자 검증 | 과거/live 채팅, PDF/ref/전사 인입 | 네 source, Discord edit/delete |
| 10/8 목 | W07/W08, W09 refresh/충돌 | 커버리지·검색·관련 최신 원문 | 골드 검색, 매질문 Discord |
| 10/9 금 | W09/W10, W11A | 출처 문답 UI·부분 상태·아트 prompt | 동적 충돌/역사/branch 통과 |
| 10/10 토 | W11B(공급자 확정시), W12 | 실제 생성 또는 prompt-only, 인수 기록 | 필수 결함 0, 회의 회귀 없음 |
| 10/11 일 | 제한 팀 파일럿, 실패 복구 | 실제 원본 변경·질의·근거 링크·배포 | 출시 gate 통과 |

1인 개발로 전체 고도화까지 6일 안에 끝난다고 보장하지 않는다. 이는 P0 텍스트·PDF·속성·이미지 참조를 좁혀 구현하는 공격적인 파일럿 목표다. 인증 지연·백필·권한·인수 실패 시 날짜보다 gate를 우선한다. 인력이 추가되면 수집과 UI를 병행한다.

파일럿 뒤 1~2주를 안정화 목표로 둔다. 전체 첨부·Unreal export·대규모 의미 관계·아트 일관성 검증은 별도 추정한다.

## 6. 동적 인수 시험

fixture와 별도 승인된 sandbox에서 수행한다. 현재 운영 팀 문서·채팅을 시험용으로 변경하지 않는다.

| ID | 시나리오 | 통과 기준 |
|---|---|---|
| A01 | Notion 상태와 PDF 교체 | 새 속성/hash/본문, 옛 버전 current 제외 |
| A02 | 하위 block/relation/이동 | 재귀/관계/scope 갱신 |
| A03 | Notion 삭제/권한 회수/복원+늦은 update | unavailable, stale 부활 없음 |
| A04 | GitHub push/rename/delete/force-push/revert | 새 SHA/현재 코드, 옛 완료 오인 없음 |
| A05 | GitHub webhook 실패 후 회복 | HEAD 대조 복구 |
| A06 | Discord create/edit/uncached update | 편집 시각/hash/reply 반영 |
| A07 | Discord delete/bulk-delete+cache | 삭제 원문/claim/cache 차단 |
| A08 | attachment-only·첨부 제거/교체 | 첨부 문서, 없는 text 생성 없음 |
| A09 | 새/보관/복원/private 접근 상실 thread | 수집/coverage/ACL 갱신 |
| A10 | Gateway 끊김/resume | 중복 없는 replay, REST 보완/gap |
| A11 | Discord 403/intent 제한/timeout | 실패 표시, COMPLETE 금지 |
| A12 | 전사 정정/replacement/삭제/공유 취소 | 최신 canonical/revision |
| A13 | 옛 문서와 새 Discord/회의 상충 | 대상·확정성 대조, 자동 승인 없음 |
| A14 | 추격신 일부 제외/미정·치수 충돌 | 적용 범위/미정/충돌 표시 |
| A15 | Notion 완료90%·Discord 완료·main 미반영 | 상태 축 구분, 실행 완료 단정 없음 |
| A16 | 과거 시점 질문+후속 변경 | 당시/현재 구분 |
| A17 | 답변 생성 중 수정/삭제/권한 회수 | 재검증·재작성/partial |
| A18 | 중복/역순/lease 상실/index crash | 한 active 버전, stale publish 없음 |
| A19 | private 채널·사용자 cache·탈퇴 | 제목/본문/citation/cache 누출 0 |
| A20 | 프롬프트 인젝션 | 외부 실행/원본 쓰기/비밀 노출 없음 |
| A21 | 429·큰 push·parser 실패 | limiter/pending, 음성 회귀 없음 |
| A22 | 이미지 버튼/생성중 style·근거 변경 | 최신 prompt/경고, 결과 version |
| A23 | 신규 채널/DB/branch | scope 정책, 무단 확장 없음 |
| A24 | 백필 미완료/중복 회의/unknown block | gap·중복 증거 구분 |

골드 질문 30개: 최신 아트/기획 10개, 코드/branch 6개, 회의/역사 6개, 일정/담당 4개, 충돌/없는 정보 4개. 최소 10개는 Discord를 빼면 판단이 달라지는 문제다. citation·기대 확정성·허용 충돌 설명을 사람이 작성한다.

고정 스냅샷, 문서 검색만, 네 source+live Discord 결과를 비교한다. 채팅의 개선과 잡담/비승인 의견에 끌리는 오판을 함께 측정한다.

## 7. 출시 gate와 산출물

### Gate 1: 원본과 범위

- 네 source 실제 인증/scope/coverage.
- Discord live read/edit/delete, Notion PDF, 지정 ref, 팀 공유 전사.
- 미수집/미지원 상태 표시.

### Gate 2: 정확성

- Recall@20 90% 이상, citation/span 100%, unsupported 확정 주장 0건(골드).
- 매질문 Discord live check; 실패 complete 금지.
- 역사/branch/제안·확정/중복/충돌 시험.

### Gate 3: 변경과 권한

- 생성중 변경/삭제/권한 회수, 중복/역순/crash/누락 대조 시험.
- restricted/cache 누출 0건.

### Gate 4: 운영 보호

- 기존 pnpm check/test/build와 관련 인증·전사·요약 회귀.
- 백필/문답 병행의 회의 지연·오류·STT 영향 기록.
- 실측 source latency/답변 p95, 비용/한도·DLQ·인증 알림.
- rollback와 읽기 역할·볼륨·백업 검증.

### Gate 5: 이미지 범위

- prompt-only를 실제 생성 완료로 표시하지 않음.
- 실제 생성시 인증·참조 권한·예산·생성1건·style 검토·변경 경고.

산출물: coverage JSON, ref/cursor, A01~A24 결과, 골드 30문항 근거/평가, latency/모델/비용, 운영/rollback runbook, 미해결 목록. 비밀 환경값은 포함하지 않는다.

## 8. 리스크와 대응

| 위험 | 대응 |
|---|---|
| Notion 지연/역순 | 원문 재조회/질문 refresh/coverage |
| main이 오래됨 | 개발 ref 분리, HEAD, merge 전후 구분 |
| Discord offline 편집/삭제 누락 | 최근 대조/근거 ID 재조회/gap |
| 이미지 자료 빈 text | 첨부+부모 맥락/직접 참조, 관찰 여부 표시 |
| 빈 결정 배열/STT 오인식 | canonical/원장/정정과 직접 원문 |
| 스타일/치수/미정 충돌 | 범위/시각/승인 profile/골드 평가 |
| 운영 인증/공유 미확정 | fixture 병행, 실제 출시 gate 유지 |
| 회의 자원 간섭 | 별도 DB/큐/프로세스·pool2·limiter·부하 인수 |
| 이미지 공급자 지연 | W11A 먼저, 실제 생성 출시 분리 |

## 9. 다음 착수 순서

1. C01~C05 확인과 W01/W02 계약/migration.
2. W03 Discord 과거/실시간/매질문 읽기 시험.
3. W04~W06 네 source 동일 원본/version/ACL 계약.
4. W07~W10 검색/문답/상태 화면.
5. W11A, 공급자 결정 후 W11B.
6. W12 gate 통과 후 실제 URL·동기화·문답으로 파일럿 검증.

이번 요청에서는 명세·플랜까지 작성한다. 서비스 구현·외부 설정·공유 정책 변경·운영 배포는 후속 구현 범위다.
