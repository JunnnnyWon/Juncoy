# RAG 수정 작업 — 에이전트 전달용

상세 근거와 완료 기준은 [2026-10-06 구현 점검표](RAG_IMPLEMENTATION_AUDIT_2026-10-06.md)에 있다. 아래 지시문을 복사해 다음 에이전트에게 전달하면 된다. 기준 코드는 `522daee94d36b52ee2df2bc51df471fb10fb73fe`이며, 후속 커밋에서는 문제가 이미 수정됐는지 먼저 확인한다.

## 복사할 작업 지시문

```text
JunnnnyWon/Juncoy의 RAG 파일럿을 점검표에 따라 수정하고 검증해 줘.

먼저 실제 저장소 root, HEAD, 원격, 기존 변경을 확인하고 저장소 지침을 읽어.
docs/RAG_IMPLEMENTATION_AUDIT_2026-10-06.md, RAG_DEVELOPMENT_SPEC.md,
RAG_DEVELOPMENT_PLAN.md, RAG_IMPLEMENTATION_PLAN.md를 읽고 시작해.

목표는 Solar Pro 4로 Notion·Team_23 GitHub·Discord·Juncoy 회의 자료를
종합해 최신 근거 있는 문답을 제공하는 거야. 매 질문 Discord를 실제로
읽어야 하고, 읽지 못한 출처를 LIVE_READ/전체 확인 완료로 표시하면 안 돼.

우선 RAG-001~016의 P1 결함부터 처리해.
- 사용자/프로젝트/출처/문서 ACL과 저장 답변 재조회 권한·삭제 검증
- 실제 읽기 결과 기반 coverage/COMPLETE, 생성 중 근거 변경 처리
- 동일 내용 재수집 dirty 문제, 문서 버전·청크·임베딩 결속, lease 회수/fencing
- Discord live read의 빈 guild 키·scope·오류·timeout·인덱스 반영 문제
- Discord 백필 조기 종료, 스레드 수집 연결, bulk delete/권한 회수
- Gateway 내구 sequence·처리 순서·오류·재연결
- 회의 공유 해제/final/상태 변화, Notion pagination/속성/접근 회수
- webhook source/scope 매핑·원자적 잡 생성
- knowledge off, 기존 Compose 독립 기동, migration/seed 순서
- DB 통합 테스트의 실패를 skip으로 감추는 문제

RAG-017~020도 검토해. history/as_of/branch/SSE·스타일 승인·검색 출처 분배·
usage·예산·포맷·미구현 범위는 구현하거나 명시적 미지원/backlog로 기록해.
이미지 공급자는 현재 미설정이므로 실제 생성 완료로 소개하지 마.

항목별로 현재 코드에서 재현하고 테스트를 추가한 뒤 수정해.
실제 DB 테스트는 격리된 테스트 DB에서 실행하고 pass/fail/skip을 구분해.
기존 음성 봇과 회의 기록 기능의 회귀를 확인하고, production 서비스를
재기동하거나 운영 DB에 테스트 데이터를 넣는 일은 별도 배포 요청 없이 하지 마.
시크릿은 Git/로그/보고서에 남기지 마.

pnpm check, test:unit, knowledge 단위/DB 통합 테스트, test:integration,
build, format:check와 필요한 실API·브라우저 인수를 실행해.
credentials/intent가 없으면 fixture로 가능한 수정은 완료하고 실제 연결의
미검증 범위와 필요한 설정만 구체적으로 남겨.

끝나면 각 RAG ID의 수정 파일·테스트·남은 작업, 최종 SHA,
코드/mock/실API/배포/팀 사용 가능 상태를 정리해 줘.
Graphify를 사용 중이면 변경 후 기존 범위를 보존해 갱신하고 실제 반영을 확인해.
```

## 다른 작업 환경에서 받기

기존 clone에서는 사용자 변경을 확인한 뒤 `git fetch origin`으로 최신 문서 커밋을 받고 해당 branch를 사용한다. 깨끗한 `main`이 단순히 뒤처져 있다면 `git pull --ff-only origin main`으로 받을 수 있다. divergent/dirty 상태에서 reset으로 덮어쓰지 않는다.

GitHub 저장소: <https://github.com/JunnnnyWon/Juncoy>. 문서의 경로·코드 참조는 저장소 root 기준으로 작성되어 있어 macOS의 원래 절대 경로가 없어도 사용할 수 있다.
