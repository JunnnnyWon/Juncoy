# 후속 평가 실행

모든 결과에 `mock`, `실제 공급사 재생`, `실제 Discord`를 구분한다. 테스트 도구는 운영 요약을 게시하거나 기존 결과를 덮어쓰지 않는다. 실제 녹음·단계 출력은 `.data/qa/`의 비공개 파일에 저장하며 Git에 포함하지 않는다.

## 고정 데이터와 대본

`tests/fixtures/summary-cases.ts`에는 개발용 10종과 검증용 5종의 원문 및 정답이 함께 정의되어 있다. 전사 사실을 먼저 정하고 모델 결과와 비교한다. 골드 값을 실패 결과에 맞춰 바꾸지 않는다. `dataset-manifest.json`에 정렬한 데이터 해시, 모델 및 실행 이름이 남는다. 검증용을 디버깅에 사용했다면 보고서에 밝히며 완전히 새 홀드아웃으로 주장하지 않는다.

```bash
pnpm qa:freeze --source .data/qa/offline-20260907 --output .data/qa/summary-baseline-frozen
pnpm qa:summary --split development --campaign development-1 --output .data/qa/development-1
pnpm qa:summary --split validation --repeat 3 --campaign validation-1 --output .data/qa/validation-1
pnpm qa:summary --recording .data/qa/offline-20260907 --repeat 20 --journal postgres --campaign cold20-1 --output .data/qa/cold20-1
```

새 성능 표본은 **새 output 디렉터리와 campaign**으로 실행한다. 재개한 디렉터리는 성공 단계를 캐시하므로 cold 표본이 아니다. PostgreSQL journal의 격리 schema에서 운영의 단계 저장 경로를 사용하고 outbox를 송신하지 않는다. 입력 자료 적재 시간은 별도로 제외하며 실제 요약 단계와 원장 저장을 측정한다. 보고서의 `cache_hits=0`, 20회 이상, 전 표본 성공을 확인한 뒤 p95를 판정한다. 실패 표본을 버리고 성공 표본만으로 성능 통과를 선언하지 않는다. 요약 성능 기준은 1시간 전사 p95 120초다.

`fileLedger`는 요청별 입력 해시·성공 출력·오류·시도 수·모델·시각을 남긴다. 운영의 분산 실행은 PostgreSQL journal을 사용한다. 기존 64분 녹음 회귀는 알려진 미연시 제안의 오확정 및 후반 엔진/AD 누락을 검사한다. 이 검사는 전체 원음 정확도의 사람 정답 검수가 아니다.

## 독립 음성 트랙

```bash
pnpm qa:clips --output .data/qa/replay-clips
pnpm qa:audio --clips .data/qa/replay-clips --campaign audio-1 --output .data/qa/audio-1
pnpm qa:audio --clips .data/qa/replay-clips --glossary tests/fixtures/audio-glossary.json --campaign glossary-1 --output .data/qa/glossary-1
pnpm qa:replay --provider real --tracks 2 --seconds 30 --viewers 2 --clips .data/qa/replay-clips --campaign real-2 --output .data/qa/real-2
pnpm qa:replay --provider real --tracks 10 --seconds 600 --viewers 12 --clips .data/qa/replay-clips --campaign real-10 --output .data/qa/real-10
pnpm qa:replay --provider real --tracks 12 --seconds 600 --viewers 12 --browsers 12 --recover --clips .data/qa/replay-clips --campaign real-12 --output .data/qa/real-12
```

트랙은 macOS Yuna TTS로 각자 다른 이름·ID를 말하는 독립 파일을 생성한다. `say`는 파일로만 출력하며 스피커나 마이크를 사용하지 않는다. 기존 혼합 회의를 여러 사람처럼 분할하지 않는다. PCM 해시는 전송 전 확인한다. 실제 스트리밍 시험은 조직의 10개 한도를 공유하므로 서로 겹쳐 실행하지 않는다.

CER은 NFC, 소문자, 공백/문장부호 제거, 사전 고정된 Unity→유니티 별칭 후 문자 Levenshtein 편집 수/정답 문자 수다. 용어는 참조 파일에 미리 정한 각 트랙의 용어 출현을 센다. **공급사 원문과 표시 사전 적용 결과를 따로 보고**한다. 사후 별칭을 추가해 원문 인식률이 올라갔다고 주장하지 않는다.

## 장애·장시간·브라우저

```bash
pnpm qa:replay --tracks 12 --seconds 75 --viewers 12 --scenario faults --recover --output .data/qa/faults-1
pnpm qa:replay --tracks 12 --seconds 90 --viewers 12 --scenario overlap --recover --output .data/qa/overlap-1
pnpm qa:replay --tracks 12 --seconds 14400 --viewers 12 --browsers 12 --output .data/qa/soak-1
pnpm test
pnpm test:browser
```

재생 진입점은 `NODE_ENV=test`, mock 표시 회의, `test_`로 시작하는 격리 DB schema에서만 열린다. 운영 Discord 계정으로 위장하지 않는다. mock은 각 ID의 신호를 문자열로 돌려주는 모형이며 음성 인식이 아니다. `faults`는 429·연결 단절·철회를 주입한다. `overlap`은 70초 연속 동시 발화로 5초 버퍼 초과와 60초 슬롯 교대를 시험한다. `--recover`는 같은 Jobs 파일 복구 경로로 대기 범위를 처리한다.

4시간 시험의 `elapsed_wall_seconds`가 14,400 이상이어야 한다. 가속 재생을 대신 세지 않는다. 브라우저는 격리한 테스트 로그인만 사용한다. SSE reducer 전체 ID/revision/본문을 DB와 비교하고, 브라우저에 렌더링된 행도 정본과 비교한다. 체크포인트에는 버퍼·저장/송신량·예약/대기 수·메모리·cursor가 기록된다. `pnpm test:browser`는 뷰어 증가가 provider/job 수를 바꾸지 않는지 별도로 검사한다.

지연 보고서는 저장→SSE, 공급사 segment 종료시각→저장, 작성한 클립 종료→저장을 구분한다. 공급사 timestamp 오차, 클립의 끝 무음, 실제 브라우저/네트워크 차이 때문에 하나의 지표로 대체하지 않는다.

## 비용과 보관

실제 요청은 `.env`에 설정한 **운영 길드**의 월 사용량에 QA campaign으로 합산한다. 요청 전 상한 비용을 예약하고 usage 응답으로 정산한다. usage를 받지 못한 요청은 보수적인 예약 비용을 유지한다. 캠페인 기본 상한은 요약/재생 10,000원, 파일 정확도 1,000원이며 월 예산이 우선한다. 운영 키 누락을 mock으로 대체하지 않는다.

원본 실패 결과는 `qa:freeze`로 해시를 고정해 보존한다. QA 원문·사실·단계 출력은 180일 이내 제거한다. 사용한 실제 원음의 QA 사본은 성공 후 24시간·최대 7일이며, 재생 도구는 성공 시 암호화 원음 디렉터리를 정리한다. 사용자 원본 파일을 자동으로 지우지 않는다.

실제 2인 15분·12인 60분 Discord/DAVE 수신과 사람의 원음 정답 검수는 별도 인수다. 사람이 확보되기 전에는 `BLOCKED_EXTERNAL`로 남긴다.

QA 도구는 `retention.json`을 생성합니다. 운영 worker의 보관 작업은 이 표식이 있는 QA 디렉터리만 정리하며 symlink를 따라가지 않습니다. 로컬 사본은 `pnpm qa:retention`으로 같은 정책을 적용합니다.

유료 요약 평가는 한 번에 하나의 campaign만 실행합니다. CLI가 같은 운영 길드의 PostgreSQL session lock을 획득하며, 다른 평가가 진행 중이면 `QA_SUMMARY_EVAL_BUSY`로 거절합니다. 단계 병렬 수는 3개입니다. 검증용 대본 완료 후 20회 cold 시험을 순서대로 실행하세요.

`pnpm exec tsx scripts/verify-web-latency.ts --samples 200 --output .data/qa/web-render-1`은 12개 격리 브라우저에서 저장 시각부터 두 animation frame 뒤 실제로 보이는 행까지 측정합니다. 관측되지 않은 표본을 무한 지연으로 계산하며, 각 뷰어에서도 95% 이상이 1초 안에 보여야 합니다. 전사 타임스탬프는 커밋 전에 부여되므로 트랜잭션의 남은 시간까지 포함한 보수적 측정입니다.
