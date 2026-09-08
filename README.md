# Juncoy

### 23팀 Discord 회의록

Discord 음성 회의를 **실시간 전사**하고, 결정사항과 다음 할 일을 회의록으로 정리하는 팀용 서비스입니다.

[서비스 열기](https://juncoystt.junnnny.kr) · [API 문서](docs/api.md) · [운영 문서](docs/operations.md) · [검증 보고서](docs/verification-report.md)

> 현재 서비스는 23팀 Discord 서버 구성원만 이용할 수 있습니다.

## 지금 할 수 있는 일

- 모든 일반 음성방 감지 및 참석자별 음성 수집
- ReturnZero STT 실시간 전사와 Upstage Solar Pro 3 요약
- 웹에서 실시간 전사, 검색, 화자 필터, 요약, 근거 발언 확인
- Markdown·TXT 내보내기
- 암호화 원음 저장과 장애 구간 재전사
- 최대 10개 동시 STT 스트림과 FIFO 대기열
- 하나의 Discord 서버에서 한 번에 하나의 회의 기록

회의는 동의 명령 없이 `/회의 시작`으로 시작합니다. 수집은 시작 이후에만 진행하며, AFK·스테이지 채널은 제외합니다. 안내와 요약은 Discord의 `#봇` 채널에 게시됩니다.

## Discord 명령어

| 명령어                          | 설명                           |
| ------------------------------- | ------------------------------ |
| `/회의 설정`                    | 현재 감지·게시·공유 정책 확인  |
| `/회의 시작` · `/회의 종료`     | 기록 시작과 마감               |
| `/회의 상태`                    | 진행 상태와 웹 주소 확인       |
| `/회의 일시정지` · `/회의 재개` | 음성 수집 일시정지와 재개      |
| `/회의 표시`                    | 중요한 시점과 메모 기록        |
| `/회의 목록` · `/회의 보기`     | 회의록 목록과 상세 열기        |
| `/회의 정정`                    | 근거 발언의 전사 수정          |
| `/회의 재전사` · `/회의 재요약` | 원음 범위 재처리와 요약 갱신   |
| `/회의 용어`                    | 프로젝트 용어와 표준 표기 등록 |
| `/회의 삭제`                    | 회의록 삭제                    |

회의 제어는 Discord에서 하고, 전사와 요약 열람은 웹에서 합니다.

## 웹 사용

1. [서비스](https://juncoystt.junnnny.kr)에 접속합니다.
2. Discord 계정으로 로그인합니다.
3. `모든 회의`에서 23팀 회의록을 검색하거나 날짜로 좁힙니다.
4. 회의를 열어 실시간 전사·요약·근거를 확인합니다.

접근 권한은 23팀 Discord 서버 가입 여부로만 결정됩니다. 회의 참석 여부나 Discord 역할, 기록 채널 권한은 웹 열람에 영향을 주지 않습니다. 탈퇴·추방은 최대 30초 안에 현재 화면과 실시간 연결에 반영됩니다.

## 로컬 데모

Node.js 24, pnpm 10.33, PostgreSQL 17, FFmpeg가 필요합니다.

```bash
pnpm install --ignore-scripts
pnpm init:env
pnpm db:migrate
pnpm dev
```

`http://127.0.0.1:3000`에서 데모를 열 수 있습니다. `pnpm dev`는 외부 API와 Discord Gateway를 호출하지 않는 mock 모드입니다.

## 실제 실행

`.env.example`을 복사해 Discord·ReturnZero·Upstage 설정과 암호화 키를 입력합니다. 비밀값은 Git에 커밋하지 마세요.

```bash
PROVIDER_MODE=real pnpm discord:register
pnpm check
pnpm test
pnpm build
pnpm test:browser
```

운영 배포는 Docker Compose와 PostgreSQL을 사용합니다. 실제 운영 절차, 백업·복원, 보관·삭제, 롤백은 [운영 문서](docs/operations.md)를 따릅니다.

## 구조

```text
apps/bot       Discord Gateway, 회의 제어, 음성 수집
apps/api       OAuth, 회의 API, SSE 실시간 전달
apps/web       React/Vite 회의록 화면
apps/worker    전사·복구·요약·Discord 게시 작업
packages/db    PostgreSQL·Kysely·마이그레이션
packages/*     계약, 도메인 규칙, 외부 공급자 어댑터
```

데이터는 PostgreSQL 이벤트 로그와 작업 큐에 영속화합니다. 전사 원문·정정 이력·요약 근거를 보존하고, 모델 내부 reasoning은 저장하지 않습니다.

## 검증 현황

자동 검증은 Vitest 86개와 Playwright 브라우저 시나리오로 구성되어 있습니다. 실제 Discord 음성 수신과 다중 계정 인수는 mock·합성 시험과 구분해 별도로 기록합니다. 자세한 결과는 [검증 보고서](docs/verification-report.md), [요구사항 대응표](docs/requirements-traceability.md), [후속 검증 기록](docs/qa-followup-2026-09-07.md)에서 확인할 수 있습니다.

## 문서

- [아키텍처](docs/architecture.md)
- [API·SSE 계약](docs/api.md)
- [사실 원장과 요약 평가](docs/fact-ledger.md)
- [운영·보관·삭제](docs/operations.md)
- [요구사항·테스트 대응표](docs/requirements-traceability.md)
- [원본 기획서](docs/SPEC.md)

## 라이선스

현재 내부 팀 운영과 검증을 위한 저장소입니다.
