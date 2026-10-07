# Art Canvas / Document Parse QA Handoff

작성일: 2026-10-07
대상: Juncoy 아트 레퍼런스 캔버스, Document Parse durable ingestion, ImageBrief/OpenRouter generation

## 구현 범위

- PDF Parse cache key를 project/upload/source SHA-256/parser profile/options hash로 고정하고 성공 결과만 cache한다. 강제 reparse는 cache를 우회한다.
- 업로드 worker에 lease/generation fencing, 원본 hash 재검증, 실패 상태/재시도, PDF derived page/figure storage를 연결했다. 원본 저장 key와 derived key는 분리된다.
- Parse block/page citation에 page, block, parser version, source hash를 전달하고 파일 UI에 Parse status/cache/parser/original verification 상태를 표시한다.
- typed `ImageBrief`에 board revision, Art Bible version, ordered references, asset/upload hash, roles/usage/crop, evidence/coverage, provider/model, prompt/brief hash를 저장한다.
- GPT Image 2.5 Flare 실행은 approval + brief hash + board revision + Art Bible version에 결속하고 OpenRouter reference input 순서와 source hash를 재검증한다. job 선점, 결과 MIME/hash/request ID/cost state, canonical rights note와 reusable art asset 등록을 포함한다.
- 보드에는 자유 배치/resize handle/crop, 다중 선택/16px snap 이동/group membership, semantic edge, undo/redo, history restore, rename/archive/share, 1초 직렬 autosave, IndexedDB failed draft recovery, mobile canvas/inspector tabs를 추가했다.
- art.* registry aliases는 기존 image 검증 경로를 재사용한다. `art.preview_image_brief`, `art.generate`.
- 화면 방향은 `apps/web/public/generated/art-canvas-direction.png`, `art-inspector-direction.png`, `art-imagebrief-direction.png`로 별도 제작·검수했다. Banli 결과는 UI 방향 자료이며 제품 생성 provider는 OpenRouter로 유지한다.

## 자동 검증

| Gate | 결과 | 증거 |
|---|---|---|
| TypeScript | PASS | `pnpm check` |
| Unit | PASS | 20 files / 106 tests |
| Web build | PASS | `pnpm build` |
| Meeting + knowledge integration | PASS | 11 files / 68 tests, pgvector PostgreSQL 17 test DB |
| Knowledge-specific DB | PASS | 17/17 tests, cache/fencing/parse/revision/art approval |
| Art canvas mock browser | PASS | `tests/browser/art-reference.spec.ts`, grouping/undo/redo/mobile inspector |
| Existing meeting browser | PASS | 11 tests total including art canvas, meeting live transcript, mobile overflow, retry, 12 viewers and permission revocation; 0 unexpected, 0 flaky |
| Graphify | UPDATED WITH LIMITATIONS | `graphify update .`; representative nodes verified |

Local test database: temporary container `juncoy-knowledge-test`, pgvector/pg17, port 55440. It is a test-only container and is not production data.

## Graphify limitations

- `tree_sitter_sql` dependency is unavailable, so 18 SQL files contribute no structural nodes.
- `tests/integration/outbox.test.ts` and `tests/integration/recovery-consent.test.ts` have pre-existing syntax errors and may be partially extracted.
- Graphify update succeeded and backed up prior curated graph under `graphify-out/2026-10-07/`. The updated graph contains `ImageBrief`, `ArtReferenceCanvas`, and `document_parse_derived_assets` references.

## Production gate status before this release

- Server: `junnnnyserver:/home/junnnnyserver/services/discord-meeting-bot`.
- Final release target: `juncoy-meeting:release-59ee085`. Previous rollback images `release-211c6bd`, `release-70b978b`, and `release-6966a14` remain available; backup directory observed under `.data/backups/art-release-Zk2QRWn8` and release backup under `.data/backups/art-release-70b978b-20261007`.
- API and knowledge worker now both mount `/home/junnnnyserver/services/discord-meeting-bot/.data/knowledge` at `/data/knowledge`; this was corrected after detecting the API mount gap during deployment verification.
- Final server knowledge DB migrations observed through `013_art_brief_provenance.sql`.
- Current server health/provider smoke from the preceding release included API health, Gemini Vision, Upstage Parse and OpenRouter Flare catalog checks.
- Still requiring this release: migrations 011-013, updated source/image hash, authenticated production web E2E, one real GPT Image 2.5 Flare generation, and team-data PDF/scanned-PDF quality review. These are not marked PASS until directly verified.

## Final deployment evidence

- Local release commit: `59ee0850116bbb6eab53ba1362ce7400df10ed3f`.
- Production API and knowledge worker: `juncoy-meeting:release-59ee085`; API Docker health `healthy`, worker state `running`.
- Knowledge DB max migration: `013_art_brief_provenance.sql`.
- API and worker both use the host knowledge directory at `/home/junnnnyserver/services/discord-meeting-bot/.data/knowledge` mounted as `/data/knowledge`.
- Worker logs after the final restart show meeting sync `meetings=13, synced=3, unshared=0` and Notion structure/incremental sync activity.
- Production OpenRouter Flare direct smoke from the worker returned HTTP 200 with 2,181,341 output bytes and SHA-256 `6234ed25f735bef86ec10c2080336688617158b3eb783767384b273bb076a488`. The provider returned no request ID, so request ID/cost remain explicitly unknown; the result was not registered as canonical.
- Final local browser JSON: `artifacts/browser-results.json`, expected 11, skipped 0, unexpected 0, flaky 0.
- Final local integration: 11 files / 68 tests passed with meeting PostgreSQL and pgvector PostgreSQL 17 test DB.
- Production model flags verified without printing secrets: image `openai/gpt-image-2.5-flare`, vision `google/gemini-3.7-flash`, Upstage Parse enabled with the configured document-digitization endpoint.

## Rollback

Keep the prior `release-211c6bd` image and the dated DB/env backup. New migrations are additive. If API/worker health or smoke fails, restart only API/worker with the previous image tag and preserve the new backup for diagnosis. Do not delete original uploads or the knowledge volume.

## Remaining external gates

- Normal OAuth-authenticated production browser session was not fabricated or copied. It requires a real team member login in the browser.
- Live GPT Image 2.5 Flare generation consumes provider quota and must be run only with the production account configured for this project.
- Synthetic fixture success does not replace review of the team's actual PDFs, scanned PDFs, references, and rights metadata.
