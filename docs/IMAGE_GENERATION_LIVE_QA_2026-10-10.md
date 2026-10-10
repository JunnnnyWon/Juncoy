# 이미지 생성 운영 QA — 2026-10-10

## 실행 환경과 판정

정상 OAuth 로그인된 Codex 내부 브라우저에서 어시스턴트 대화 `Notion UI 참고 게임 UI 시안 생성`으로 검증했다. 생성 준비 → 사용자 승인 → OpenRouter 실제 생성 → 채팅 결과 저장 → 이미지 확대 조회까지 6회 완료했다. 모델은 모두 `openai/gpt-image-2.5-flare`다. 원본 입력 수는 운영 DB의 `image_jobs.options.actual_inputs`와 대조했다.

| 시나리오 | 결과 ID | 실제 입력 | 화면 검토 |
|---|---|---:|---|
| 인물 없는 UI 신규 생성 | e8de1ad9-8851-48bd-96a1-0f1a321e48dd | 0 | HUD·메뉴 시안. 교복 여성·복도 없음 |
| HUD 유지, 황혼 폐허 정원으로 장면 변경 | c943a2d3-b9a3-4945-affb-f0ce0f7a372f | UI 원본 1 | HUD 상대 배치 유지, 배경 변경 |
| 화풍만 참고한 다른 후보 | 6874bd62-90fa-4701-bbc1-511ee224384d | 정원 원본 1 | 낮의 온실·높은 사선 구도. HUD·인물 없음 |
| 온실 구조·구도 유지, 조명 수정 | d04f6511-b542-48c0-8fdc-778b40df4beb | 온실 원본 1 | 구조·시점은 유사하며 더 따뜻하고 밝은 조명 |
| 주 원본 구조 + 보조 원본 조명 | ae8a26a5-ac6e-4dbf-8c18-6161209d9945 | 온실 원본 2 | 두 입력의 목적과 hash 저장. 온실·따뜻한 조명 결과 |
| 이전 결과와 무관한 배경 신규 생성 | a4fa7a30-6ca8-4d53-9924-d5af56df4f79 | 보드 원본 6 | 비 오는 밤 항구 창고, 지면 시점. HUD·인물 없음 |

결과는 모두 DONE, output SHA-256·실제 bytes·KNOWN 비용 상태를 저장했다. 공급자 request ID는 이 6건에서 NULL이므로 request ID 추적까지 검증됐다고 판정하지 않는다. 원본 이미지 링크는 `/api/assistant/images/<결과 ID>`이며 정상 로그인한 프로젝트 구성원만 열 수 있다.

## QA에서 발견하고 수정한 문제

- 명시적인 UI 신규 요청이 game_scene으로 분류되어 보드 원본을 선택했다. UI/HUD 요청 우선 분류를 적용하고 신규 UI의 입력 0개를 재검증했다 (`7e4a684`).
- 다른 후보가 edit/new로 분류되거나 이전 결과를 놓쳤다. variant 의도와 지정한 원본을 보존하도록 수정했다 (`beed2f6`, `e498f0e`).
- HUD 제외 요청을 UI 요청으로 잘못 인식했다. 제외 문맥을 먼저 적용했다 (`e498f0e`).
- 조명 수정이 장면 재구성으로 표시됐다. 과도한 유지/HUD 정규식을 제거하고 조명 전용 편집과 실제 장면 변경을 분리했다 (`7f37f1b`). 4번 결과의 과거 operation 기록은 그대로 보존한다.
- 배포 도중 API가 과거 `release-beed2f6`으로 되돌아간 상태를 발견했다. 최종 고정 release tag와 컨테이너 내부 source hash를 다시 확인했다.

## 실패와 검증 범위

배경 신규 생성의 첫 준비 요청은 MODEL_OUTPUT_INVALID로 실패했다. 짧게 다시 요청해 생성에 성공했다. 구조화 모델 응답의 모든 변형이 안정적으로 처리된다고 판정하지 않는다.

시각 검토는 사람이 결과를 직접 열어 비교한 평가다. 조명 편집은 배경을 사용했으므로 캐릭터 얼굴·의상 보존 품질까지 증명하지 않는다. UI의 마나·스태미나·스킬 등 제안 요소는 프로젝트의 확정 사양으로 간주하지 않는다. 보드 원본의 선택은 역할 우선순위 기반이며 의미 유사도 reranking과 명시 원본 7~16개 추가 요청은 이번 운영 검증 범위에 포함하지 않았다.

## 자동 검증·배포

- 최종 변경 후 unit 120/120, TypeScript check 통과.
- 기존 격리 PostgreSQL의 image-plan 통합 검증은 mock provider payload·실제 DB 저장·중복 실행·구계약 차단을 다룬다. 이번 실제 운영 생성과 구분한다.
- API image: `juncoy-meeting:release-7f37f1b`.
- Image digest: `sha256:c7d8232a7a7befc7a1243e21eaa11b674df24ef731b791b1febf86a6e76c6391`.
- API `apps/api/src/assistant.ts` SHA-256: `d5176ceec6c9b996f61a33f432fb9d9f1b79ad56e16a88019d83b3e1797d5a41`. 로컬과 컨테이너가 일치했다.
- `/healthz`: `ok:true`, `mode:real`.
- API만 교체했고 기존 Discord 회의 봇은 재시작하지 않았다. 추가 migration은 없다.
- 최종 배포 후 동일 대화에서 조명 전용 수정 준비를 다시 요청했다. 웹이 `부분 수정`으로 표시하고 세 번째 온실 원본을 지정한 것을 확인했다. 이 준비 요청은 거부 처리하여 추가 유료 생성은 실행하지 않았다.
- 운영 health는 healthy다. 화면 증거는 로컬 `artifacts/image-plan-live-qa/background-result.jpg`에 저장했다(artifacts는 Git 제외).
- 기존 백업: 서버 `.data/backups/image-plan-6feb760/`의 DB dump·env·previous image 기록을 유지한다.
- Graphify 코드 갱신: 2470 nodes / 4845 edges. SQL parser 누락 및 기존 outbox/recovery 테스트 AST 파싱 제한을 별도 유지한다.

6개 실제 생성 시나리오는 완료했다. 위 실패·request ID·캐릭터 품질·확장 선택 검증의 제한을 전체 명세 완료와 혼동하지 않는다.
