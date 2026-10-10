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
- 최종 확인 시 동시 배포로 같은 commit의 full tag `juncoy-meeting:release-7f37f1b67b6224a87d3cae6f053581cff9ee64fe`가 실행 중이었다. 최종 digest는 `sha256:64065a6c27273963dd20555bfb2e13449c8d42ce1e31f3c581779b6a26d30285`다. assistant source hash는 위 배포와 동일했고 healthy였다.
- API `apps/api/src/assistant.ts` SHA-256: `d5176ceec6c9b996f61a33f432fb9d9f1b79ad56e16a88019d83b3e1797d5a41`. 로컬과 컨테이너가 일치했다.
- `/healthz`: `ok:true`, `mode:real`.
- API만 교체했고 기존 Discord 회의 봇은 재시작하지 않았다. 추가 migration은 없다.
- 최종 배포 후 동일 대화에서 조명 전용 수정 준비를 다시 요청했다. 웹이 `부분 수정`으로 표시하고 세 번째 온실 원본을 지정한 것을 확인했다. 이 준비 요청은 거부 처리하여 추가 유료 생성은 실행하지 않았다.
- 운영 health는 healthy다. 화면 증거는 로컬 `artifacts/image-plan-live-qa/background-result.jpg`에 저장했다(artifacts는 Git 제외).
- 기존 백업: 서버 `.data/backups/image-plan-6feb760/`의 DB dump·env·previous image 기록을 유지한다.
- Graphify 코드 갱신: 2470 nodes / 4845 edges. SQL parser 누락 및 기존 outbox/recovery 테스트 AST 파싱 제한을 별도 유지한다.

6개 실제 생성 시나리오는 완료했다. 위 실패·request ID·캐릭터 품질·확장 선택 검증의 제한을 전체 명세 완료와 혼동하지 않는다.

## 추가 수정 및 미검증 항목 해소

아래 내용은 위 초기 QA 이후의 추가 검증이다. 초기 미검증 기록은 역사로 남기며 현재 판정은 이 절을 따른다.

### 공급자 요청 추적

응답의 `request_id`, `generation_id`, usage의 generation ID, `x-generation-id`도 읽도록 보완했다. 공급자 ID와 내부 UUID를 구분하며, 공급자가 ID를 반환하지 않으면 NOT_RETURNED 상태로 남긴다. 비용 0도 KNOWN 값으로 보존한다. 추적 정보는 결과 완료와 같은 트랜잭션에서 job options에 저장한다.

실제 캐릭터 신규 생성 `1c02ae48-9b02-452a-9df2-758667dd5620`의 공급자 ID는 `gen-img-1791634946-o5DHllRGmi9icZ6sCvX5`다. 최종 편집 `33603cdd-e6a8-426c-ae09-ea6f793ac2b9`의 공급자 ID는 `gen-img-1791635688-RacNrClWy9KAy2vLNVQW`, 내부 번호는 `8326902c-bf6a-4351-807e-1276b6a24c68`다. 로그인된 웹 이미지 상세에서 두 번호를 확인했다. 채팅 첨부에 최상위 ID가 없어도 저장된 trace ID를 표시하도록 수정했다.

### 캐릭터 보존

짧은 검은 머리·붉은 재킷·회색 바지·손전등·정면 전신의 성인 남성 캐릭터를 신규 생성했다. 이후 얼굴·머리·의상·포즈·구도를 유지하고 조명만 따뜻하고 밝게 편집했다. 원본과 편집 결과를 직접 열어 비교했다. 첫 편집에서 모델 지시 말미에 잘못된 배경 전용 문구가 붙는 것을 발견했으며, 원래 사용자 요청만으로 출력 종류를 판정하도록 수정했다. 최종 편집은 operation=edit, output=character, 주 원본 1개이며 이 문구가 없다.

이는 한 캐릭터의 시각적 보존 회귀 검증이다. 생성 모델이 모든 이미지에서 픽셀 단위 동일성이나 신원 일치를 보장한다는 뜻은 아니다. 원본·기존 편집 이력은 모두 유지했다.

### 원본 7~16개 지정

아트보드에 별도의 직접 선택 목록을 추가했다. 기본 자동 선택은 최대 6개이며, 지정 원본은 사용자 순서로 최대 16개까지 사용한다. 중복·누락·준비되지 않은 원본은 실패시키고 조용히 생략하지 않는다. 제외된 테스트 자료는 목록에서 선택할 수 없다. 검토 패널·생성 중 표시·결과 패널을 연결했으며, 새로고침 시 유효한 미승인 초안을 복구한다.

격리 PostgreSQL schema에서 유효한 PNG 원본 7개와 16개를 등록하고 mock provider payload의 순서·base64·실제 입력 이력·image_job_references 개수를 검증했다. 서비스 DB의 팀 자료와 섞지 않았다.

실제 OpenRouter 모델에도 합성 색상 PNG 16개를 전송해 생성에 성공했다. 공급자 ID는 `gen-img-1791635235-EgAwYGVLTyvTHpQnZGeS`, 출력 SHA-256은 `9462982f0ee143d66551d673be9c49acfe26daedffc487daaf2c555869f994a8`, 크기는 2,574,152 bytes, 비용은 $0.010533이다. 이는 16개 입력의 실호출 검증이며 팀 레퍼런스 품질 검증과 구분한다. 증거는 로컬 `artifacts/image-plan-live-qa/sixteen-provider-evidence.json` 및 `sixteen-provider-result.png`다.

팀 자료 7개(의상재질 1~5, 예상컨셉아트 1~2)를 웹에서 직접 선택했다. 이전에 형식 오류가 났던 긴 항구 배경 요청을 그대로 사용해 준비에 성공했으며, 새로고침 후 승인 초안 복구 → 확인 후 생성 → 결과 원본 열기까지 완료했다. 결과 ID는 `5008c144-744e-4750-969f-07ec88f1b122`, 공급자 ID는 `gen-img-1791636129-arAkfsb4jttjg5aAcZMp`다. DB에서 actual_inputs 7개, image_job_references 7개, 승인된 순서·hash·purpose·usage·crop과 실제 입력 목록의 정확한 일치(`approval_inputs_match=true`)를 확인했다. 출력 SHA-256은 `162010bd23dee303e8b925a352f25bfb49cca3834c0d159a9c4355b67a3fb566`, 크기는 2,184,660 bytes, 비용은 $0.0683이다. 인물·HUD 없는 비 오는 항구 창고 결과를 직접 검토했다.

### UI 시안과 형식 오류

UI 생성 계획에 review_notice를 승인 hash와 결속했다. 승인 화면과 생성 prompt에 디자인 제안임을 표시하며, 논의·예시를 확정 기능으로 간주하지 않도록 안내한다. 실제 로그인된 웹에서 새 UI 요청의 제안 문구와 원본 0개를 확인한 뒤 승인하지 않고 거부했다. 팀 기획을 에이전트가 임의로 확정 승인하지 않는다.

Solar 구조화 응답은 완결된 JSON code fence를 처리하고 검증 오류·이전 출력을 함께 보내 최대 3회 교정한다. 매번 같은 schema로 검증하고 잘린 JSON은 거부하며, 실패 시에도 임의 데이터를 채택하지 않는다. 교정 호출의 토큰 사용량은 합산한다. malformed/truncated/길이 초과와 제한된 실패의 자동 테스트를 통과했다. 모델 응답 오류가 영원히 재발하지 않는다는 보장은 하지 않는다.

최종 자동 검증은 unit 124/124, TypeScript check, 웹 build 통과다. 실제 PostgreSQL 격리 schema의 image-plan 통합 테스트도 통과했다. Discord 회의 봇은 재시작하지 않았고 추가 migration은 없다.

추가 수정의 최종 코드 release는 `54d3b45`다. 운영 image는 `juncoy-meeting:release-54d3b45`, 확인한 digest는 `sha256:48fb62e696d995eaf83feab5204cde80f90d85701432f343084f7b6381b4f67c`다. API·아트보드 UI·이미지 provider의 로컬/컨테이너 source SHA-256이 일치했고 health는 healthy다. 기존 DB/env/image 백업을 유지했다.

추가 화면 증거는 `artifacts/image-plan-live-qa/character-original.jpg`, `character-final-edit.jpg`, `ui-proposal-notice.jpg`, `seven-originals-board.jpg`, `seven-originals-result.jpg`다. artifacts는 Git 제외다. 결과 이미지는 운영의 private endpoint에서 다시 열 수 있으며 자동 canonical 승인하지 않았다. 이번에 열거한 미검증 항목은 수정·검증했지만, 이를 이전 두 명세 전체의 인수 완료로 확대하지 않는다.

## 아트보드 생성 UI 정리 및 사용 안내

코드 release `f32bc95`에서 생성 관련 컨트롤을 오른쪽 패널로 모았다. 헤더에는 보드 이름·저장 상태·작업 버튼을 남기고 긴 원본 목록을 제거했다. 오른쪽은 이미지 정보 / 이미지 만들기 / 생성 결과로 전환한다. 기존 React/CSS·보드 API를 유지하며 배치·간격·상태 표시를 중심으로 개선했다.

- **이미지 정보:** 보드에서 이미지를 누르면 역할·사용 강도·팀 메모·AI 관찰을 확인하고 수정한다.
- **이미지 만들기:** 원하는 장면 입력 → 자동 또는 직접 선택 → 생성 조건 확인 → 유지/변경/자유 구성·참고 원본·프로젝트 자료 검토 → 확인 후 생성. 준비만으로 이미지 생성 비용이 발생하지 않는다(텍스트 모델 호출은 발생한다).
- **자동 선택:** 요청과 관련된 원본 최대 6개를 고른다. 자료가 부족하면 더 적게 사용한다.
- **직접 선택:** 파일명 검색과 썸네일로 고르며 최대 16개다. 입력 순서는 선택한 순서다. 이번 QA에서 직접 1개를 골랐는데 자동 5개가 추가되는 문제를 발견해, 직접 선택은 고른 원본만 사용하도록 수정했다. 검토 화면에서도 정확히 1개가 보이는 것을 재검증했다.
- **생성 결과:** 이미지를 누르면 원본을 연다. 생성 정보는 모델·참고 원본 수·공급자 요청 번호를 펼쳐 확인한다. 이전 결과 더 보기로 6개씩 추가한다. 출처·사용 범위를 입력해 별도로 참고 자료 승인을 할 수 있다. 이미지별 권리 메모는 서로 공유하지 않는다.
- **아트바이블:** 레퍼런스 분석으로 만든 공통 그림체·재질 기준을 검토·승인하는 영역이다. 이미지 생성 검토 화면과 구분해 접근한다.

로그인된 운영 브라우저에서 패널 전환, 검색, 원본 선택, 검토 수 일치, 준비 취소, 결과 상세 펼치기, 이전 결과 6→12개 표시를 검증했다. 이번 UI QA에서는 유료 이미지 생성이나 참고 자료 승인을 실행하지 않았다. QA용 준비 요청은 취소했다. unit 124개·타입 검사·웹 build가 통과했다.

실제 CSS viewport 1440px, 767/769px(사용자 브라우저 확대율로 인한 반올림), 390px에서 document scrollWidth가 viewport와 일치했다. 390px에서 도구 모음은 약 167px에서 55px로 줄었고, 패널과 캔버스는 모바일 전환 버튼으로 접근했다. 화면 증거는 `art-layout-desktop.jpg`, `art-layout-mobile.jpg`, `art-layout-tablet.jpg`, `art-layout-review-desktop.jpg`, `art-layout-results-desktop.jpg`이며 기존 artifacts QA 폴더에 있다.

최종 확인한 운영 image는 `juncoy-meeting:release-f32bc95f234033f4de8d0c6dcb842c5507946cb1`, digest는 `sha256:7b7090b58e2529b72b48e31dda76cbc62075972ae9ab3ef49c2437c04ab5591d`다. 생성 설정 UI와 원본 선택 로직의 로컬/컨테이너 hash가 일치했고 API는 healthy였다. DB migration과 회의 봇 재시작은 없었다. Graphify SQL 파서·기존 테스트 AST 제한은 그대로 남는다.
