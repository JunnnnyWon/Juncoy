# 어시스턴트 Git 커밋 조회 오류 수정 및 QA

## 재현과 원인

운영 대화 `깃 커밋 기록 확인`(conversation `40f40253-ef16-4ea4-8ae7-bdca534ba679`)의 실제 로그를 확인했다.

- `현재 우리 깃 커밋 기록 확인진행.` 요청은 `github.search_code`의 `query=commits`로 실행됐다. 해당 run `c0df1dc7-a4c2-48f3-aecf-112d3f07c76e`의 result event는 rows=0이었다. 커밋 전용 도구가 없었고 search 경로가 JSON.stringify로 빈 배열을 그대로 표시했다.
- 다음 `?`는 이전 요청 맥락 없이 RAG 질문으로 처리됐다. 답변 근거에는 GitHub의 Graphify SKILL.md와 무관한 Discord 자료가 포함됐고, 모델이 스킬 안내를 질문의 답처럼 출력했다.
- 실시간 읽기 도구를 추가한 첫 운영 검증에서는 연결 실패가 드러났다. 어시스턴트는 GITHUB_APP_INSTALLATION_ID만 읽었지만 수집기는 GITHUB_INSTALLATION_ID 및 GITHUB_TOKEN을 지원하고 있었다. 인증 설정 이름을 통일했다.
- 기존 프런트엔드 Markdown은 링크를 렌더링하지 않았다. 또한 전역 e숫자 제거 규칙은 커밋 해시와 URL을 손상시킬 수 있었다.

## 수정

`github.list_commits`는 프로젝트의 ACTIVE GitHub source와 allowed ref scope에서만 저장소·브랜치를 고른다. 저장소가 하나면 main/master를 우선하며, 여러 저장소면 선택을 요청한다. 지정한 저장소·브랜치가 허용 범위 밖이면 외부 요청 전에 차단한다. 기록은 GitHub의 [List commits API](https://docs.github.com/en/rest/commits/commits#list-commits)에서 읽으며 기존 설치 토큰 또는 설정된 PAT를 사용한다. 인증 정보는 출력하지 않는다.

응답은 저장소·브랜치, SHA 링크, 제목, 작성자, 한국 시간으로 표시한다. 실제 빈 결과와 연결 실패·미설정 상태를 구분한다. 커밋 읽기 요청은 코드 검색이나 RAG로 보내지 않고 실시간 조회로 연결한다. 기본 조회는 최대 10건이며 다른 연결 브랜치도 안내한다.

짧은 `?`·`왜?`·`다시`는 실제 사용자 메시지 이력을 통해 맥락을 복구한다. 이전 맥락이 없으면 질문을 요청하고 무관한 근거 검색을 실행하지 않는다. 짧은 후속 질문으로 변경·생성을 다시 실행하지 않도록 설명 모드로 제한한다(커밋 읽기는 재조회).

읽기 도구 선택에 이름뿐 아니라 설명과 JSON Schema를 제공하고 read 도구만 선택할 수 있게 했다. 읽기 결과의 원시 JSON 출력도 사용자용 문장·목록으로 바꿨다. RAG evidence 안의 스킬·시스템·도구 지시는 원문 데이터로 취급하도록 프롬프트를 보강했다. 이는 모든 의미적 prompt injection이 불가능하다는 보장은 아니다.

Markdown 링크는 HTTP(S) 또는 같은 사이트의 경로만 지원한다. 코드·링크·URL 안의 e숫자 및 SHA는 보존하고, 근거 마커는 일반 본문에서 제거한다. 스크립트 URL과 이스케이프된 커밋 제목은 링크로 해석하지 않는다.

## 검증

- 단위 테스트 132/132, TypeScript check, 웹 build 통과.
- 실제 PostgreSQL 격리 schema에서 현재 프로젝트 scope, 금지 저장소·브랜치 차단, HTTP 403, 빈 목록, source 비활성화를 검증했다. 실서비스 자료와 테스트 자료는 섞지 않았다.
- 정상 로그인된 운영 브라우저에서 원래 요청 문장을 그대로 재실행했다. `JunnnnyWon/Team_23 · main`의 실제 커밋 2건이 반환됐다. `?`도 같은 실시간 조회와 2건 결과로 이어졌다. 새로운 응답에는 Graphify 안내나 RAG 근거 8건이 붙지 않았다.
- `a2bfd2d89419f25226d614aa8d2d52747c1dc823`, `147a44e5ef547089a8d6c2f9025bc3c27dbf63be`의 전체 해시가 링크에 보존됐고 실제 anchor가 렌더링되는 것을 DOM에서 확인했다. 비공개 GitHub 웹페이지의 별도 로그인은 이 검증에 포함하지 않는다.
- `Stairs 브랜치 커밋 기록 확인`은 별도 브랜치 9건을 반환했다. 실제 이벤트 `8922e221-bf34-49e1-80a6-157d0795bcba`는 input.ref=Stairs, read_status=OK, rows=9였다. main 재조회 `591c1803-1bbc-4e38-ae79-e310bb3d446d`와 `?` 후속 조회 `aa44cd86-febb-453b-98c1-d3ffa22796f7`는 각각 OK·2건이었다. 응답은 브랜치 범위를 명시하며 기록 수를 고정하지 않는다.
- 이전 잘못된 응답과 QA 중 연결 실패 응답은 역사로 보존한다. 기존 대화 내용을 삭제·덮어쓰지 않았다.

화면 증거: `artifacts/assistant-commits-2026-10-11/followup.jpg`. artifacts는 Git 제외다. 코드 release는 `231b921`이며 API만 교체했고 회의 봇은 재시작하지 않았다. DB migration은 없다. 확인한 운영 image는 `juncoy-meeting:release-231b92152ca773fa2ecd672ea0a85fda63db9beb`, digest는 `sha256:a39f707fd43925894d4871801a8d708c181f51725068f45c56c5fcab36ed0cd0`다. API/프런트엔드 source hash가 로컬과 일치하고 health는 healthy였다.

Graphify 코드 갱신은 수행했다. SQL parser 미설치 및 기존 outbox/recovery 테스트 AST 파싱 제한은 기존 제한으로 남긴다.
