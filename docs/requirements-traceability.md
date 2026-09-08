# 요구사항 대응표

코드 구현과 실제 외부 환경 인수 결과를 구분합니다. 원본 T01~T14를 기준으로 하되 동시 STT 정책은 사용자가 선택한 10개 FIFO로 변경했습니다. AUTO-01/T15와 Enterprise 확장은 제외합니다.

| 요구사항  | 주요 구현 위치                                                                   | 검증                                                                             |
| --------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| DET-01/02 | apps/bot/src/episodes.ts, packages/db/src/index.ts                               | DB 통합: 45초·100회 중복·snooze/skip·새 인스턴스 타이머 실행                     |
| SES-01    | packages/db/src/index.ts, apps/bot/src/main.ts                                   | 동시 시작 12개→회의 1개, 부분 UNIQUE, 만료 job/fencing 거절                      |
| AUD-01    | apps/bot/src/capture.ts, audio-worker.mjs                                        | Opus→mono 16kHz worker 시험; 실제 다중 계정 시험 미수행                          |
| AUD-02    | apps/bot/src/capture.ts, scripts/verify-dave.ts                                  | 실제 DAVE protocol·원음·화자 매핑 계측 준비, BLOCKED_EXTERNAL                    |
| STT-01/02 | packages/providers/src/returnzero.ts, apps/bot/src/capture.ts                    | 실제 인증/WS, 합성 음성 파일 인식, partial/final·사전·시간 테스트                |
| STT-03    | apps/worker/src/jobs.ts, packages/db/src/index.ts                                | 실제 파일 API, 시간 복원, replacement 재실행 멱등성·과거 근거 조회               |
| WEB-01    | apps/api/src/auth.ts, server.ts                                                  | 401/404, 채널 overwrite, OAuth state/return_to, logout, 권한 회수 브라우저 시험  |
| WEB-02/03 | packages/contracts, packages/domain, apps/api, apps/web/src/use-meeting.ts       | 원자적 이벤트 저장·replay·revision·tombstone, 새로고침/네트워크 복구             |
| WEB-04    | apps/web/src/App.tsx                                                             | 전체 서버 검색, 화자 선택, 과거 근거, 가상 목록, 모바일, 누락 표시               |
| WEB-05    | apps/api/src/export.ts, apps/web/src/App.tsx, apps/worker/src/outbox.ts          | 목록→요약→버전 근거→Markdown 다운로드 브라우저 시험                              |
| SUM-01    | packages/providers/src/solar.ts, packages/domain, apps/worker/src/jobs.ts        | 실제 solar-pro3-260323 구조화 출력, 근거 enum, 담당자·날짜·자정·stale 검증       |
| OPS-01    | packages/providers/src/crypto.ts, apps/worker, infra/backup.sh, restore-drill.sh | 암호화 변조 거부, 삭제 차단, 게시 복구, 백업 생성·복원, 자동 보관 정책           |
| OPS-02    | scripts/load.ts, scripts/status.ts, capture metrics                              | 12개 구독자·4시간분 가속 재생, 실제 공급사 한도 확인; 실제 12인 60분 시험 미수행 |

## 인수 테스트 범위

| 명세 테스트 | 자동화/실측 근거                                            | 남은 확인                                             |
| ----------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| AT-01~04    | tests/integration/store.test.ts                             | 실제 Discord 입퇴장·푸시 알림 동작을 팀 환경에서 확인 |
| AT-05~07    | tests/integration/store.test.ts, outbox.test.ts             | 실제 Discord 송신 직후 강제 종료 시나리오             |
| AT-08       | apps/bot/src/main.ts 생명주기 구현                          | 진행자 승계·1인/무인 타이머 실환경 시험               |
| AT-09~10    | scripts/verify-dave.ts, capture 진단                        | 실제 12개 계정·동시 발화·닉네임·재협상                |
| AT-11~12    | tests/integration/store.test.ts, tests/unit/domain.test.ts  | 실제 공급사 중복 응답 장기 표본                       |
| AT-13       | stale consent 시작 거절, DB 수집 경계·worker gate           | 실제 철회/일시정지 이후 전송 0바이트 측정             |
| AT-14       | mock 429/단절·풀 FIFO/취소, 실제 10개 제한                  | 실제 네트워크 장애와 음성 복구 비교                   |
| AT-15       | 파일 API, FLAC round-trip, time map·replacement 멱등 시험   | 무음 절단·발언 경계 변경의 실제 화자 음성 평가        |
| AT-16       | 코드의 저장 오류 중단·원음 큐 상한                          | 실행 중 디스크·DB 장애/봇 강퇴 시험                   |
| AT-17~24    | reducer·DB·브라우저·가속 replay 시험                        | 매우 느린 실제 프록시·24시간 지난 cursor 재생 실환경  |
| AT-25~27    | 브라우저 구독·검색·필터·모바일·근거                         | 다양한 장치의 긴 스크롤 위치 보존 표본                |
| AT-28~31    | API/도메인/브라우저 권한·state·logout·XSS 시험              | 실제 사용자 OAuth 로그인·역할 회수                    |
| AT-32       | 12개 브라우저와 12개 SSE 부하 시험                          | 실제 음성 중 뷰어 전부 종료 시험                      |
| AT-33~37    | schema·근거·담당자·날짜·chunk·stale 테스트, 실제 Solar 호출 | 실제 긴 회의의 번복·의미 정확성 평가                  |
| AT-38       | mock 전체 열람·근거·export + 실제 개별 공급사               | 실제 2인 시작부터 최종 회의록까지 연결 시험           |
| AT-39~40    | 삭제 접근 차단·fencing·job lease·게시 복구, 운영 복원 시험  | 실제 수집 중 전체 프로세스 강제 재시작                |

모든 인수 항목을 실제 통과했다고 표시하지 않습니다. 자동 테스트 이름이 대응하는 기능 범위를 명시하며, `BLOCKED_EXTERNAL`은 사람이 참여해야 하는 Discord 음성 및 실제 계정 브라우저 인수 시험에 적용합니다.

## 후속 계획 대응

최신 결과와 실제 인수 구분은 `qa-followup-2026-09-07.md` 및 비공개 `.data/qa/` 실행 증거를 기준으로 합니다.

| 후속 항목 | 구현·검증 위치 | 범위 |
| --- | --- | --- |
| 고정 실패/정답 대본 | scripts/freeze-summary-baseline.ts, tests/fixtures/summary-cases.ts | 10개 개발·5개 검증, SHA 고정, 실패 출력 보존 |
| 사실 원장·단계 재사용 | packages/contracts/src/facts.ts, packages/db/src/ledger.ts, migrations/004_fact_ledger.sql | job generation, 전사 버전, 입력/모델/프롬프트 해시, 최대 3회 시도 |
| 허위 확정·번복 방지 | providers/fact-ledger.ts, fact-units.ts, domain/facts.ts, tests/unit/facts.test.ts | 별도 의미 검증, 원문 인용 일치, 담당자/날짜 null, 조건부 변경 제외 |
| 사실 보존·작성 | domain/facts.ts, tests/unit/fact-pipeline.test.ts | 출력/중복/번복/비내용/보충 제외 사유, 첫 구간만 반환 시 실패 |
| 게시 검증·삭제 | db/index.ts, worker/outbox.ts, tests/integration/ledger.test.ts, outbox.test.ts | 검증 proof만 채택, FAILED 시 구 결과 숨김, 송신 receipt와 삭제 경계 |
| 10개 FIFO | bot/capture.ts, providers/stream-pool.ts, returnzero.ts | 연결 예약/열림/닫힘 포함 최대 10, 5초 버퍼·연결 교대 |
| 재생·복구·철회 | scripts/verify-replay.ts, tests/integration/replay.test.ts, recovery-consent.test.ts | 독립 PCM, 429/단절, 파일 복구, 빈 결과 보존, 모든 정책 철회, 늦은 응답 차단 |
| 원음 정답 평가 | scripts/generate-replay-clips.ts, evaluate-audio.ts | 독립 TTS 12개, 원문/표시 사전 점수를 분리 |
| 장시간·화면 지연 | verify-replay.ts, verify-web-latency.ts, tests/browser/meeting.spec.ts | 실제 경과 4시간 mock, 12뷰어, DOM/서버 일치, 표시 지연·job 증가 검사 |
| 요약 성능 | scripts/evaluate-summary.ts, lib/qa-postgres-ledger.ts | 격리 PostgreSQL 원장 포함 20회 cold, 운영 게시 없음 |
| 비용·보관 | scripts/lib/qa-budget.ts, qa-retention.ts, worker/jobs.ts | 운영 월 예산 합산, 미확정 사용량 예약 유지, 180일·원음 24시간/7일 |
| 복원·배포 | infra/backup.sh, restore-drill.sh, scripts/verify-restored-migration.ts | 운영 public schema 암호화 백업, 별도 DB 마이그레이션·삭제 ledger 확인 |
| 실제 Discord 인수 | scripts/verify-dave.ts, docs/operations.md | 2인 15분·12인 60분 및 사람 정답 검수는 BLOCKED_EXTERNAL |
