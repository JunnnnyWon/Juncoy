# API와 실시간 계약

런타임 스키마 원본은 `packages/contracts/src/index.ts`, 생성된 JSON Schema는 `docs/schemas/`입니다. `pnpm schema`로 갱신합니다. Discord ID와 event_seq는 문자열입니다. event_seq를 Number 또는 문자열 사전순으로 비교하지 않습니다.

## HTTP

| Method | 경로                                   | 내용                                                 |
| ------ | -------------------------------------- | ---------------------------------------------------- |
| GET    | /auth/discord                          | state·안전한 return_to를 보존해 OAuth 시작           |
| GET    | /auth/discord/callback                 | 일회용 state와 브라우저 바인딩 검증                  |
| POST   | /auth/logout                           | Origin 검증, 서버 세션 폐기                          |
| GET    | /api/me                                | 사용자·세션·실제/mock 모드                           |
| GET    | /api/meetings                          | 권한 있는 목록; q/status/date/cursor/limit           |
| GET    | /api/meetings/:id/snapshot             | 동일 읽기 snapshot, 최신 final 200개와 draft, cursor |
| GET    | /api/meetings/:id/events               | SSE; after 또는 Last-Event-ID                        |
| GET    | /api/meetings/:id/transcript           | before/limit/speaker 기반 canonical 페이지           |
| GET    | /api/meetings/:id/search               | q/speaker/cursor/limit 기반 전체 확정 전사 검색      |
| GET    | /api/meetings/:id/segments/:segment_id | 앞뒤 2개 문맥, 대체 ID, 선택 transcript_version      |
| GET    | /api/meetings/:id/summary              | 현재 요약 상태·입력 버전·결과                        |
| GET    | /api/meetings/:id/export               | format=md/txt, 선택 완료 transcript_version          |
| GET    | /healthz                               | API·DB 연결 확인; 음성 정상 여부와 별개              |

회의 API 전체에 같은 열람 정책을 적용합니다. 미인증은 401, 회의 없음/권한 없음은 404, 권한 확인 장애는 503 AUTHZ_UNAVAILABLE입니다. 응답은 private, no-store이며 오류에 키·토큰·원음 경로를 넣지 않습니다.

검색은 2~100자, 기본 50개·최대 100개입니다. `%`와 `_`를 리터럴로 취급합니다. 전사 페이지는 기본 100개·최대 200개입니다. history cursor는 정렬 키 기반 불투명 값이며 SSE cursor와 다릅니다. 페이지는 과거의 고정 snapshot이 아닌 조회 당시 canonical입니다.

근거 URL은 `/meetings/:id?tab=transcript&segment=:id&transcript_version=:V`입니다. 요약에서 만든 근거에는 항상 입력 버전을 넣습니다. 파라미터 없는 기존 링크는 현재 전사를 조회합니다. 진행 중 export에는 작성 시점까지의 부분 기록 표시와 생성 시각을 넣습니다.

## SSE

1. REPEATABLE READ snapshot에서 canonical·draft·참가자·누락·마커·상태와 마지막 커밋 순번을 읽습니다.
2. 해당 cursor 이후를 500개씩 읽어 replay합니다. 같은 DB 읽기 루프로 새 이벤트까지 따라갑니다.
3. EventSource 재연결의 Last-Event-ID는 query after보다 우선합니다.
4. 15초 heartbeat는 cursor 없는 주석입니다. 유효한 데이터 적용 후에만 클라이언트 applied cursor를 전진시킵니다.

이벤트: `segment.upsert`, `segment.replace`, `draft.remove`, `meeting.updated`, `participants.updated`, `gap.upsert`, `marker.upsert`, `summary.updated`.

제어 이벤트에는 durable seq가 없습니다. `sync.required`는 snapshot 재동기화, `access.revoked`는 연결 종료·메모리 비움, `service.unavailable`은 전송 중단·권한 확인 후 재시도를 뜻합니다. 미래·잘못된 cursor와 24시간 보관 범위 밖 cursor를 재사용하지 않습니다. 응답 큐는 1MB로 제한하고 역압력이 장기화된 소비자를 종료합니다.

현재 기본 동시 SSE는 사용자당 3개, 단일 길드 전체 40개입니다. 요청 제한은 인증 세션을 기준으로 하여 같은 사무실 IP의 팀원들을 하나로 묶지 않습니다. 주기적인 DB polling을 사용하므로 NOTIFY 유실로 전사를 잃지 않습니다.

## 요약 검증 보류

사실 원장 도입 후에도 공개 DTO/이벤트 이름은 바뀌지 않습니다. `UNREVIEWED`는 사람 검수를 받지 않았다는 뜻입니다. 자동 근거 검증 통과를 사람이 확인한 기록으로 표시하지 않습니다. 의미·근거·누락 검사 실패 시 `summary_status=FAILED`를 보내고 실제 모드의 요약 결과는 null로 제공합니다. 전사와 검색·내보내기 권한은 그대로 적용됩니다. 검증 중 전사가 정정되면 `STALE`로 전환하고 최신 버전을 처리합니다. 삭제 또는 과거 generation의 늦은 완료는 새 기록을 만들 수 없습니다.
