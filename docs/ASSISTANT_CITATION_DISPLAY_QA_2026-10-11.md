# 답변의 빈 근거 괄호 수정

## 원인과 변경

운영의 `프로젝트 비주얼 방향 설명` 대화(a2682d68-74f7-48f6-9b1d-a828d218b451), 기존 run 237c0c8d-1060-48ef-98a5-7ac858b079e9의 저장된 답변에 문장 끝 `[]` 5개가 있었다. 서버가 e숫자 ID만 먼저 제거해 괄호를 남겼고, 화면도 이미 빈 괄호가 된 과거 답변을 정리하지 못했다.

공통 cleanEvidenceText를 contracts에 추가하여 서버와 화면에서 같은 규칙을 사용한다. [e1]·(e2, e24)는 괄호째 지우고, 기존에 남은 문장 끝 빈 근거 괄호를 정리한다. 코드·코드 블록·JSON·빈 배열 값·Markdown 링크·URL·커밋 해시는 보존한다. 모델에도 answer 본문은 근거 표시를 쓰지 않고 claims.evidence_ids로만 연결하도록 명시했다.

과거 메시지·claims·실제 근거 목록은 DB에서 삭제하거나 덮어쓰지 않는다. 과거 메시지는 표시할 때 정리하며, 새 RAG 답변은 저장 전에 정리한다. 이 작업은 비주얼 방향 설명의 사실 여부나 RAG 자료 품질 평가를 포함하지 않는다.

## 검증과 배포

- 단위 테스트 135/135, TypeScript check, 웹 build 통과.
- 과거 답변을 정상 로그인된 운영 브라우저에서 다시 열었다. 본문에 빈 근거 괄호가 없고 기존 참고 자료 8건은 그대로 제공됐다.
- 같은 질문을 다시 요청했다. 새 run e9e84f4f-72f3-47e7-a550-6a247ee274a8의 assistant message f57fd5cf-82bd-4113-8d5b-26ef9324ce66은 저장된 본문에 []·[e숫자]가 없고 citations는 8건이었다. 과거 메시지 182a9f43-056b-4728-9eb7-deb58f86f212의 DB 원문에는 []가 그대로 남아 있어 데이터 덮어쓰기 없이 화면에서 정리됨을 확인했다. 브라우저의 두 assistant 본문 모두 emptyMarkers=false였다.
- 최초 자동 배포는 컨테이너 종료 후 이전 이미지로 롤백했다. 출발 당시에는 이전 자동 배포 덮어쓰기로 추정했지만, 실제 Actions 로그에서 롤백을 확인했다. 공식 infra/deploy-api.sh의 배포 잠금·백업·health 검증으로 재배포했고 정상 완료했다. 해당 Actions run 38130937610도 실패 job 재실행 후 check/deploy 모두 success였다. 종료 신호의 최초 원인은 확정하지 않았다.
- 코드 release: d93d1035cf608183bc8f997d30ca494e9c26f2ec. API만 교체하며 기존 bot/worker 컨테이너 ID를 그대로 유지한 것을 배포 스크립트가 검증했다. 추가 migration은 없다.
- 화면 증거: artifacts/citation-display-2026-10-11/existing-answer.jpg. artifacts는 Git 제외다.
- 새 답변 증거: artifacts/citation-display-2026-10-11/new-answer.jpg. 최종 운영 image는 juncoy-meeting:release-d93d1035cf608183bc8f997d30ca494e9c26f2ec, 확인한 digest는 sha256:184ba792f05139e721688229f40e9aa964dd87db4354694d0b3dbbfd09d9f593이었다. 공통 정리 함수의 로컬/컨테이너 SHA-256은 850112324b139579a92e0f93f13c9f294b5edc2eb347ee9e1ca5ed522e401312로 일치했다.

Graphify 코드 갱신을 수행했으며 기존 SQL parser 미설치와 outbox/recovery 테스트 AST 파싱 제한은 유지한다.
