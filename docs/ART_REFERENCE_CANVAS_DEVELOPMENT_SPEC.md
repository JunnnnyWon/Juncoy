# 아트 레퍼런스 캔버스 개발 명세서

작성일: 2026-10-07 KST  
대상 저장소: JunnnnyWon/Juncoy  
기준 코드: 6a91da8a4245dc2479c6752a3505eee3cbb3e82b  
문서 버전: v1.0  
상태: 구현 전 설계 명세

## 1. 문서 목적

이 문서는 팀원이 웹 대시보드에서 캐릭터·배경·재질·텍스처·조명·구도 레퍼런스를 캔버스에 모으고, 그 의미와 사용 범위를 지정한 뒤, 승인된 스타일 규칙과 이미지 원본을 RAG 및 이미지 생성에 함께 사용하는 기능의 구현 계약이다.

현재 저장소에는 웹 어시스턴트, 프로젝트 지식 검색, 파일 업로드·색인, Notion 승인 변경, OpenRouter 이미지 생성의 기반이 들어와 있다. 그러나 이미지 업로드를 텍스트 지식으로만 처리하고, 생성 요청에 레퍼런스 이미지 픽셀을 전달하지 않으며, 캔버스·Art Bible·레퍼런스별 사용 범위가 없다. 이 문서는 그 간극을 구현 가능한 단위로 정의한다.

이 문서는 캔버스를 구현하거나 배포했다는 보고서가 아니다. 아래의 현재는 기준 코드에서 확인한 사실이고, 목표는 이 문서 이후 구현해야 할 계약이다.

## 2. 확정 결정사항

| 항목 | 결정 |
| --- | --- |
| 사용자 화면 | 모든 아트 레퍼런스 작성·분석·생성 요청은 웹 대시보드에서 처리한다. |
| Discord 봇 | 회의 녹음·전사와 허용된 Discord 텍스트 이력 수집만 담당한다. 캔버스나 이미지 생성 UI를 제공하지 않는다. |
| 텍스트 모델 | 기존 Upstage Solar Pro 계열을 오케스트레이션·분류·요약·ImageBrief 작성에 사용한다. |
| 이미지 모델 | OpenRouter를 통해 openai/gpt-image-2.5-flare를 사용한다. 다른 이미지 모델로 자동 전환하지 않는다. |
| 이미지 입력 | 승인된 레퍼런스 원본 픽셀을 역할 설명과 함께 OpenRouter 이미지 요청의 input_references로 전달한다. 텍스트 요약만으로 대체하지 않는다. |
| 프로젝트 | 1차 대상은 기존 Juncoy 프로젝트 지식 범위이며, 프로젝트·사용자 ACL을 모든 읽기와 생성에 적용한다. |
| 스타일 진실성 | 기계 분석은 초안이다. 사람이 승인한 Art Bible 규칙과 레퍼런스 사용 지시가 생성 기준이다. |
| 승인 | 보드 분석, Art Bible, ImageBrief, 생성 결과는 각각 사람이 검토할 수 있으며, 승인 전 결과는 canonical reference로 재검색하지 않는다. |

OpenRouter 모델 페이지와 이미지 생성 문서 기준의 현재 목표 계약은 전용 이미지 생성 endpoint와 input_references를 사용하는 것이다. 실제 계정·라우팅 provider가 해당 모델을 노출하는지는 배포 환경에서 모델 카탈로그와 샌드박스 요청으로 확인한다.

참고:

- OpenRouter GPT Image 2.5 Flare: https://openrouter.ai/openai/gpt-image-2.5-flare/
- OpenRouter Image Generation: https://openrouter.ai/docs/guides/overview/multimodal/image-generation

## 3. 팀 아트 방향

캔버스와 생성 파이프라인은 다음 요소를 서로 섞지 않고 별도로 기록해야 한다.

- 얼굴: 반실사 얼굴 형태와 비율.
- 모델링 언어: White Day 및 오래된 PC 호러 게임에서 느껴지는 단순화된 형상, 당시의 공간 구성, 표면 표현, 기하학적 인상.
- 재질·텍스처: 사용자가 직접 제작하는 실사 기반 표면 자료. 벽의 습기, 페인트 손상, 타일 반복, 먼지, 거친 표면처럼 재질 정보를 전달한다.
- 컨셉 아트: 완전한 실사 재질을 요구하지 않는다. 컨셉의 형태·분위기·조명·구도를 우선할 수 있다.
- 결과 해상도: 오래된 게임 감각은 미학적 참고이지 낮은 해상도 출력 요구가 아니다.
- 레퍼런스 범위: 한 이미지의 얼굴만, 다른 이미지의 의상만, 또 다른 이미지의 재질만 채택할 수 있어야 한다.

제품은 “White Day 이미지를 복제하라”와 같은 단순 문장을 스타일 규칙으로 저장하지 않는다. 팀이 보유하고 사용 권한을 확인한 레퍼런스에서 구체적인 형태·재질·분위기·구도 규칙을 추출하고, 필요한 경우 작품명은 출처·권리 메모로만 보존한다.

## 4. 현재 코드 기준선

기준 커밋 6a91da8에서 확인한 연결 지점은 다음과 같다.

| 현재 영역 | 확인된 구현 | 캔버스 구현에 필요한 확장 |
| --- | --- | --- |
| 웹 어시스턴트 | apps/api/src/assistant.ts, apps/web/src/Assistant.tsx에 대화·SSE·승인·파일·이미지 패널이 있다. | 별도 art 화면 또는 어시스턴트의 캔버스 workspace와 상태 복구를 추가한다. |
| 파일 업로드 | knowledge_uploads와 init → complete → extract/indexing 흐름이 있다. PNG/JPEG/WEBP를 받을 수 있다. | 이미지 원본을 visual asset으로 등록하고 미리보기·원본 ACL·버전·권리 정보를 연결한다. |
| 이미지 생성 | packages/knowledge/src/tools/image.ts가 image.preview_generation과 image.generate를 제공한다. | preview에 선택된 레퍼런스 목록·역할·사용 지시를 포함하고, generate가 픽셀을 OpenRouter로 전달한다. |
| OpenRouter | packages/knowledge/src/image-openrouter.ts가 prompt만 전송하고 OpenRouter Images/Chat fallback을 사용한다. | openai/gpt-image-2.5-flare 고정 검증, input_references, 원본 fetch·크기·MIME 검증, 입력 해시와 응답 메타데이터를 추가한다. |
| 프롬프트 | packages/knowledge/src/image-prompt.ts가 text RAG와 승인된 style_profiles의 문자열 필드를 합친다. | 구조화된 Art Bible, role-filtered reference retrieval, 이미지 원본 evidence와 typed ImageBrief를 추가한다. |
| DB | 기존 style_profiles, image_jobs, image_results, knowledge_uploads, assistant approval/audit가 있다. | 캔버스 보드·노드·엣지·asset·extraction·style rule·job reference 테이블과 마이그레이션을 추가한다. |
| Discord·회의·GitHub·Notion | 기존 Knowledge DB와 read tools가 담당한다. | 보드·생성 요청에서 필요한 경우 최신 지식 source를 조회하고 freshness/coverage를 표시한다. |

기존 이미지 생성 코드의 OPENROUTER_IMAGE_MODEL 환경값은 설정 가능하지만, 이 기능의 기본값은 openai/gpt-image-2.5-flare로 한다. 설정이 다른 이미지 모델을 가리키면 생성하지 않고 설정 오류를 표시한다.

## 5. 사용자 흐름

전체 흐름은 다음 상태를 거친다.

Upload/Paste → Board draft → Analyze draft → Human review → Art Bible approval → ImageBrief preview → Explicit generate → Result review → Canonical approval

### 5.1 보드 만들기

1. 사용자가 웹에서 새 아트 보드를 만든다.
2. 이미지를 드래그 앤 드롭, 파일 선택, 클립보드 붙여넣기로 추가한다.
3. 이미지마다 제목, source, 사용 권리, 역할, 사용 강도, 메모를 입력한다.
4. 캔버스에서 카드·그룹·프레임·텍스트·연결선을 배치한다.
5. 자동 저장은 보드 revision으로 기록한다.
6. 사용자가 보드 분석을 실행하면 현재 revision을 고정해 분석 job을 만든다.

### 5.2 분석과 Art Bible

분석은 이미지별 설명, 객체, 얼굴 형태, 신체 비율, 재질, 조명, 색상, 구도, 카메라 시점, 분위기와 보드 전체의 공통·선택·충돌 특징을 제안한다. 역할별 규칙과 금지사항, 규칙별 근거 이미지도 제안한다.

사용자 annotation과 명시적 role/usage strength는 기계 관찰보다 우선한다. 기계 관찰은 DRAFT이며 사람이 수정·승인해야 Art Bible에 들어간다.

### 5.3 생성

1. 사용자가 보드에서 이미지와 역할을 선택하거나 어시스턴트에 생성 요청을 입력한다.
2. Solar가 프로젝트 RAG, 승인된 Art Bible, 선택된 reference metadata를 이용해 ImageBrief 초안을 만든다.
3. 서버가 선택된 이미지의 ACL, 상태, hash, revision, 사용 권리를 다시 확인한다.
4. 웹은 prompt, negative constraints, reference별 사용 범위, 예상 비용, model, 선택된 source를 preview한다.
5. 사용자가 생성 버튼을 눌러야 OpenRouter 요청이 실행된다.
6. 결과는 DRAFT 또는 REVIEW로 저장된다. 사람이 canonical 승인을 하기 전에는 Art Bible 자동 업데이트나 canonical retrieval을 하지 않는다.

## 6. 캔버스 UX 명세

### 6.1 화면 구조

- 상단: 보드명, 프로젝트, revision 상태, 마지막 저장 시각, 분석 상태, 공유·권한, Art Bible 버전.
- 좌측 도구막대: 선택, 이미지 추가, 프레임, 그룹, 텍스트, 연결선, 주석, 확대/축소, 맞춤 보기.
- 중앙 캔버스: 무한 평면, 카드와 프레임, pan/zoom, multi-select, snap, keyboard undo/redo.
- 우측 inspector: 선택한 node의 역할, 사용 강도, 채택 범위, 메모, tags, source, rights, approval.
- 하단 또는 별도 drawer: 선택 레퍼런스, ImageBrief preview, 생성·검토 이력.

초기 구현은 이미지 카드·텍스트·프레임·그룹·연결선에 집중한다. 자유형 브러시, 실시간 다중 커서, 동영상 타임라인은 1차 범위에서 제외한다.

캔버스 라이브러리는 infinite canvas와 custom shape를 지원하는 라이브러리를 우선 검토한다. 1차 spike 후보는 tldraw이며, 도입 전 라이선스와 번들 크기를 확인한다. React Flow는 연결 중심 editor로 비교한다. 라이브러리 선택은 이미지 provider 선택과 별개이며 OpenRouter 모델 계약을 변경하지 않는다.

### 6.2 노드와 의미

노드 타입은 image_reference, text_note, frame, group, generated_result, image_brief다.

엣지 타입은 supports, contradicts, variant_of, uses_only, derived_from다.

카드의 공간적 근접성만으로 의미·승인·동일성을 추론하지 않는다. 그룹과 연결선에 명시된 의미만 retrieval에 사용한다.

### 6.3 레퍼런스 역할

image_reference는 여러 역할을 가질 수 있으나 역할마다 사용 강도와 범위를 별도로 저장한다.

역할:

- face_shape: 얼굴 형태·비율
- body_proportion: 신체 비율·실루엣
- clothing: 의상·장비
- modeling_language: 모델링·기하학·시대감
- environment_layout: 공간 배치·구조
- material_surface: 재질·표면 반응
- texture: 텍스처 패턴·손상·반복
- lighting: 광원·명암·색온도
- color_palette: 색상군
- composition: 화면 구성·여백·초점
- mood: 정서·공포감·분위기
- pose: 자세·동작
- camera_view: 시점·렌즈·높이

사용 강도:

- MUST_FOLLOW: 반드시 반영
- STRONG_REFERENCE: 강한 참고
- MOOD_ONLY: 분위기만 참고
- PARTIAL_REFERENCE: 지정한 영역만 참고
- EXCLUDED: 생성에서 사용 금지
- REVIEW_REQUIRED: 승인 전이라 사용 보류

예시:

- 얼굴 사진을 face_shape + PARTIAL_REFERENCE로 지정하면 얼굴 비율만 사용하고 헤어·의상·배경은 사용하지 않는다.
- 벽 사진을 material_surface + texture로 지정하면 습기·페인트 손상·타일 반복만 사용하고 사진의 구도는 사용하지 않는다.
- 사용자가 만든 실사 재질 사진은 texture/material_surface + STRONG_REFERENCE가 될 수 있다.
- 오래된 호러 게임 복도 화면은 modeling_language + environment_layout + mood가 될 수 있으며, 원본 장면을 그대로 복제하는 지시는 별도 권리 검토가 필요하다.

## 7. 이미지 asset과 분석 계약

### 7.1 업로드

이미지 업로드는 기존 knowledge_uploads 흐름을 재사용한다.

- 파일당 50 MB, 요청당 10개, 프로젝트 5 GB 제한을 유지한다.
- PNG, JPEG, WEBP의 MIME과 magic bytes를 확인한다.
- 원본은 private storage에 저장한다.
- sha256, MIME, bytes, width, height, ICC/orientation, source, uploader, created_at을 기록한다.
- 동일 프로젝트·동일 hash는 중복 원본을 만들지 않고 기존 asset을 재사용한다.
- READY가 아닌 asset은 검색·분석·이미지 생성 입력으로 사용하지 않는다.
- 삭제 또는 ACL 회수 후 해당 asset은 새 generation에 포함할 수 없고, 기존 citation은 정책에 따라 마스킹한다.

클립보드·drag-and-drop도 결국 동일한 init → complete → analyze 상태로 들어가야 한다. 브라우저가 보낸 MIME만 믿지 않고 서버에서 실제 형식을 확인한다.

### 7.2 추출

이미지 extraction 결과는 asset_id, asset_revision, status, observations, ocr_text, machine_confidence, source를 가진다. observations에는 subjects, face_shape, body_proportion, materials, textures, lighting, palette, composition, camera_view, mood를 포함한다.

OCR·vision observation은 검색 보조 자료다. 사용자가 입력한 annotation, role, usage strength, exclusion은 명시적으로 수정하지 않는 한 기계 결과보다 우선한다. 모델이 White Day 스타일 같은 넓은 문구를 추출해도 자동으로 승인된 스타일 규칙으로 만들지 않는다.

### 7.3 retrieval

1차 retrieval은 ACL + project + approval/state + role/tag/source metadata + 텍스트 검색을 기본으로 한다. 현재 Upstage text embedding은 이미지 의미를 자동으로 표현하는 multimodal embedding으로 간주하지 않는다.

visual similarity search는 별도 adapter와 평가 세트를 만든 뒤 2차 기능으로 추가한다. 1차 생성은 사람이 선택한 이미지와 role metadata를 우선하고, 필요하면 이미지 설명을 보조 근거로 사용한다.

검색 결과에는 asset id, asset revision, board id, board revision, source, rights note, ACL 판정, role, usage strength, selected crop, user note, Art Bible rule id와 승인 version, retrieved_at, corpus generation을 포함한다.

## 8. Art Bible과 revision

### 8.1 보드 revision

보드는 mutable draft이지만 모든 저장은 revision으로 남긴다.

- board_revision은 monotonic integer 또는 UUID 기반 immutable snapshot이다.
- node/edge 위치 변경과 의미 변경을 같은 감사 가능한 revision에 묶는다.
- 분석 job은 특정 board revision을 입력으로 고정한다.
- 분석 중 새 변경이 생기면 결과에 stale_against_revision을 표시한다.
- 동시 편집 충돌은 last-write-wins로 조용히 덮지 않고 revision conflict로 표시한다.
- 자동 저장 실패 시 로컬 draft를 복구할 수 있어야 한다.

### 8.2 Art Bible

Art Bible은 보드에서 파생된 승인 가능한 style profile이다. 기존 style_profiles와 호환되는 export를 제공하되, 문자열 하나로 모든 의미를 합치지 않는다.

규칙은 rule_id, category, statement, strength, provenance, exceptions, negative_constraints, status, approved_by, approved_at을 가진다. provenance에는 asset_id, role, usage를 기록한다.

Art Bible version은 immutable하다. 수정은 새 version을 만든다. 생성 시점에는 사용자가 승인한 최신 version만 사용한다. 보드가 수정됐다고 기존 승인 version을 자동으로 덮지 않는다.

## 9. ImageBrief 계약

Solar가 만드는 ImageBrief는 자유 문자열만 반환하지 않고 다음 의미를 만족하는 구조화 객체여야 한다.

- brief_version, request, subject.
- art_direction: face_shape, body_proportion, modeling_language, material_surface, lighting, color_palette, composition, mood별 instruction과 sources.
- reference_inputs: asset_id, revision, roles, usage, instruction, crop.
- negative_constraints, provider=openrouter, model=openai/gpt-image-2.5-flare, options, evidence, status.

서버는 reference_inputs가 실제 project asset이고 READY인지, ACL·rights·revision hash가 최신인지, EXCLUDED 또는 REVIEW_REQUIRED asset이 포함되지 않았는지, 역할과 instruction이 모순되지 않는지, 근거 없는 스타일 문장이 MUST_FOLLOW로 올라가지 않았는지, model이 정확히 openai/gpt-image-2.5-flare인지 검증한다.

## 10. OpenRouter 이미지 실행 계약

### 10.1 요청

현재 image-openrouter.ts의 prompt-only 호출을 다음 의미로 확장한다.

- model: openai/gpt-image-2.5-flare
- prompt: ImageBrief에서 서버가 합성한 prompt
- input_references: 각 항목의 type=image_url과 image_url.url을 가진 배열

실제 구현은 OpenRouter 공식 문서에서 지원하는 URL 또는 data URL 형식을 확인하고 선택한다. private asset의 공개 URL을 임의로 만들지 않는다. 서버가 ACL 확인 후 private storage에서 읽어 제한된 시간 동안 provider 요청에만 사용한다.

reference 배열의 순서와 각 항목의 의미는 ImageBrief와 image_job_references에 저장한다. provider 요청에는 role과 instruction을 prompt에 명시해 이미지별 사용 범위를 보존한다. provider가 reference weight나 negative_prompt를 지원한다고 확인되지 않은 경우, 지원하지 않는 필드를 전송하지 않고 ImageBrief의 prompt constraint로 표현한다.

현재 코드의 Images → Chat fallback은 reference image를 전달하지 못한다. 캔버스 작업에서는 전용 이미지 endpoint를 우선 사용하고, 응답의 b64 또는 provider 반환 image URL을 검증한다. endpoint 또는 모델이 입력 이미지를 지원하지 않으면 명시적 provider error로 종료한다. 다른 이미지 모델로 silent fallback하지 않는다.

### 10.2 저장

image_job에는 provider, exact model id, API request id, prompt hash, ImageBrief hash, Art Bible version, board revision, reference asset id/revision/role/usage/crop/hash 목록, 생성자, project id, idempotency key, quota counter, 상태, output MIME/bytes/width/height/storage key/cost를 저장한다.

원본 reference와 결과는 private storage에 두고 웹 API가 project ACL을 확인한 뒤 스트리밍한다. 이미지 URL을 장기 public URL로 노출하지 않는다.

### 10.3 결과 검토

생성 결과는 자동으로 canonical reference가 되지 않는다.

- DRAFT: 생성 직후.
- REVIEW: 팀원이 검토 중.
- APPROVED_CANONICAL: 향후 보드·Art Bible retrieval에 사용 가능.
- REJECTED: 이력은 보존하되 canonical retrieval에서 제외.
- ARCHIVED: 삭제 대신 보관 상태로 숨김.

결과를 canonical로 승인할 때는 결과 이미지의 사용 역할과 재사용 범위를 다시 입력한다. 이전 결과를 다시 reference로 쓸 때도 별도 승인 asset revision을 만든다.

## 11. 데이터 모델

기존 테이블과 중복하지 않고 knowledge DB에 새 migration을 추가한다. 실제 컬럼명은 Kysely store convention에 맞추되 다음 의미를 보존한다.

### 11.1 art_boards

id, project_id, owner_id, name, description, status, current_revision, created_at, updated_at, archived_at. status는 DRAFT, ANALYZING, REVIEW, APPROVED, ARCHIVED다.

### 11.2 art_board_revisions

id, board_id, revision, created_by, snapshot_json, snapshot_hash, analysis_state, created_at. snapshot에는 노드·엣지·viewport metadata를 포함하되 binary를 저장하지 않고 asset id와 revision만 저장한다. analysis_state는 NONE, QUEUED, RUNNING, READY, STALE, FAILED다.

### 11.3 art_board_nodes

id, board_id, revision, node_type, asset_id, x, y, width, height, z_index, data_json, created_at. data_json에는 roles, usage strengths, crop, title, user note, tags, approval state를 저장한다.

### 11.4 art_board_edges

id, board_id, revision, source_node_id, target_node_id, edge_type, label, data_json, created_at. source/target가 같은 edge와 존재하지 않는 node를 거부한다.

### 11.5 art_reference_assets

id, project_id, upload_id, source_type, source_label, storage_key, mime, bytes, width, height, sha256, source_revision, rights_note, acl_json, state, canonical_state, created_by, created_at, updated_at. state는 UPLOADING, ANALYZING, READY, FAILED, DELETED다. canonical_state는 NONE, REVIEW, APPROVED_CANONICAL, REJECTED, ARCHIVED다.

### 11.6 art_extractions

id, asset_id, asset_revision, extractor_version, observations_json, ocr_json, machine_confidence, human_corrections_json, status, created_at, approved_by, approved_at. 같은 asset revision에 대한 extractor 재실행은 새 extraction version으로 남긴다.

### 11.7 style_profile_rules

id, project_id, art_board_id, art_board_revision, style_version, category, statement, strength, provenance_json, negative_constraints_json, status, approved_by, approved_at, created_at.

### 11.8 image_job_references

id, image_job_id, asset_id, asset_revision, role_json, usage_strength, instruction, crop_json, content_hash, acl_snapshot_json, created_at. 이 테이블이 있어야 어떤 이미지를 왜 생성에 사용했는가를 재현할 수 있다.

## 12. API와 tool 계약

### 12.1 Board API

- POST /api/assistant/art-boards
- GET /api/assistant/art-boards
- GET /api/assistant/art-boards/:id
- PATCH /api/assistant/art-boards/:id
- POST /api/assistant/art-boards/:id/revisions (base_revision 필수)
- POST /api/assistant/art-boards/:id/analyze
- GET /api/assistant/art-boards/:id/analysis/:jobId
- POST /api/assistant/art-boards/:id/style-drafts
- POST /api/assistant/art-boards/:id/style-drafts/:id/approve
- POST /api/assistant/art-boards/:id/style-drafts/:id/reject
- POST /api/assistant/art-boards/:id/image-briefs/preview
- POST /api/assistant/art-boards/:id/image-briefs/:id/generate
- GET /api/assistant/art-boards/:id/history

승인·commit이 필요한 endpoint는 기존 assistant approval pattern을 재사용한다. 승인 대상에는 project, board, board revision, before hash, after hash, expiry를 넣는다.

### 12.2 Asset API

- POST /api/assistant/art-assets/init
- POST /api/assistant/art-assets/:id/complete
- GET /api/assistant/art-assets/:id
- POST /api/assistant/art-assets/:id/analyze
- POST /api/assistant/art-assets/:id/canonical-review
- POST /api/assistant/art-assets/:id/archive-preview
- GET /api/assistant/art-assets/:id/content

### 12.3 Tool registry

- art.board_search
- art.board_fetch
- art.asset_search
- art.asset_fetch_metadata
- art.analyze_board
- art.preview_style_profile
- art.preview_image_brief
- art.preview_generation
- art.approve_style_profile
- art.approve_canonical_result
- art.generate

art.generate는 approval_id와 ImageBrief hash를 동시에 요구한다. tool registry 밖의 provider 호출은 허용하지 않는다. image.preview_generation은 기존 호환 endpoint로 남길 수 있지만, 새 캔버스 요청은 art.preview_image_brief를 거치게 한다.

## 13. 어시스턴트·RAG 통합

웹 어시스턴트가 “이 보드 기준으로 캐릭터 컨셉을 만들어 줘”라고 받으면 다음 순서로 실행한다.

1. Solar가 요청에서 board, subject, desired output, 변경 범위를 구조화한다.
2. 서버가 project ACL로 board와 asset을 조회한다.
3. approved Art Bible과 role-filtered references를 검색한다.
4. Discord·회의·GitHub·Notion 지식은 아트 결정을 설명하거나 최신 요구사항을 확인할 때만 text evidence로 추가한다.
5. Solar가 ImageBrief를 만들고 evidence와 source coverage를 반환한다.
6. 웹 preview가 선택된 image cards와 각 사용 범위를 보여 준다.
7. 사용자 승인 후 OpenRouter 생성 job을 실행한다.
8. 결과와 input references를 저장하고 review 상태를 표시한다.

Discord의 새 메시지나 회의록이 들어오면 기존 수집·색인 파이프라인이 corpus generation을 변경한다. 보드 분석 결과 자체는 자동으로 최신화하지 않고 stale 표시한다. 사용자가 다시 Analyze를 눌러 새 board revision에 대한 결과를 만든다.

답변에는 board revision과 Art Bible version, reference asset별 역할, Discord·회의·Notion·GitHub source 확인 상태, 읽기 실패와 관련 근거 없음의 구분, provider/model와 prompt/ImageBrief hash를 표시한다.

## 14. 보안·권한·권리

- 모든 board·asset·job 조회는 project_id와 세션 user ACL을 함께 검사한다.
- reader는 보기와 질문만, editor 이상은 업로드·분석·승인·생성을 수행한다. 기존 역할 정책을 따른다.
- reference 픽셀은 LLM 프롬프트 로그에 원본 base64로 저장하지 않는다.
- provider 요청 직전 private storage ACL과 hash를 재검증한다.
- provider로 전송된 asset id, revision, request id, 시각은 audit에 남긴다.
- signed URL은 짧은 TTL과 단일 provider request 범위로 제한한다.
- rights note가 없거나 REVIEW_REQUIRED인 asset은 generation input에서 차단한다.
- 외부 작품·인터넷 이미지의 권리 상태를 모델이 추정해 승인하지 않는다. 사람이 rights note를 입력한다.
- prompt injection이 이미지·문서·Discord 텍스트에 포함돼도 tool policy, ACL, approval을 바꿀 수 없다.
- asset 삭제·권한 회수는 tombstone을 남기고 늦게 도착한 extraction/job이 canonical을 복구하지 못하게 한다.
- 결과 이미지의 public URL과 secret을 대화·SSE payload에 넣지 않는다.

## 15. 비용·동시성·실패 처리

- 이미지 생성은 사용자·프로젝트별 일일 quota와 동시 실행 상한을 둔다.
- 같은 approval과 ImageBrief hash는 idempotency key를 공유해 중복 생성하지 않는다.
- OpenRouter 429/5xx는 제한된 exponential backoff를 사용한다.
- timeout·provider schema error·input asset 회수는 FAILED와 구체적 원인으로 저장한다.
- 모델 catalog에서 openai/gpt-image-2.5-flare가 확인되지 않으면 기능을 비활성화하고 provider 설정 오류를 명시한다.
- partial failure에서는 어떤 asset/source를 읽지 못했는지 표시한다.
- 비용 응답이 provider에서 오지 않으면 cost_unknown으로 남기고 0으로 위조하지 않는다.

## 16. 개발 플랜

### Phase A — 기반과 migration

1. 현재 assistant/image/upload 코드와 store 테스트를 기준선으로 고정한다.
2. board, revision, node, edge, art asset, extraction, style rule, job reference migration을 추가한다.
3. project/user ACL, hash, tombstone, idempotency index를 검증한다.
4. 기존 style_profiles와 새 style_profile_rules 사이의 versioned adapter를 만든다.

완료 기준: migration이 기존 회의·RAG 테이블을 깨뜨리지 않고 board snapshot과 asset revision을 재조회할 수 있다.

### Phase B — 캔버스 편집기

1. canvas library spike와 license/bundle 검토.
2. image card, text note, frame, group, edge, inspector 구현.
3. board revision autosave, optimistic concurrency, undo/redo, reload recovery 구현.
4. upload/paste/drag-and-drop를 art asset init/complete로 연결.

완료 기준: 두 브라우저에서 같은 board를 편집할 때 충돌이 표시되고 새로고침 후 마지막 저장 revision이 복구된다.

### Phase C — 이미지 분석과 Art Bible

1. image extraction job과 vision/OCR adapter를 추가한다.
2. machine observations와 human corrections를 분리한다.
3. board analysis에서 role별 공통 규칙·충돌·근거를 생성한다.
4. Art Bible draft preview와 approve/reject, immutable version을 구현한다.

완료 기준: 승인하지 않은 관찰·규칙은 생성 prompt에 들어가지 않고 승인 version을 재현할 수 있다.

### Phase D — ImageBrief와 OpenRouter references

1. role-filtered retrieval을 추가한다.
2. typed ImageBrief schema와 preview UI를 만든다.
3. OpenRouter adapter를 openai/gpt-image-2.5-flare 및 input_references에 맞춘다.
4. private storage → ACL check → request payload → result storage의 hash chain을 만든다.
5. explicit approval, quota, retry, idempotency, gallery review를 연결한다.

완료 기준: 선택한 reference의 원본 픽셀이 실제 OpenRouter request에 포함되고 결과에서 사용된 asset/revision/역할을 확인할 수 있다.

### Phase E — 통합·운영 품질

1. 어시스턴트가 캔버스·Art Bible·Notion·Discord·회의·GitHub를 한 답변에서 근거별로 구분한다.
2. source freshness와 stale analysis 표시를 추가한다.
3. 삭제·권한 회수·provider 실패·재시도 복구를 점검한다.
4. 실제 OpenRouter sandbox 호출과 비용·응답 형식 검증을 수행한다.
5. 운영 문서와 agent handoff를 갱신한다.

## 17. 테스트 및 인수 기준

### 17.1 단위 테스트

- role/usage strength 조합과 EXCLUDED 차단.
- board revision hash, stale detection, optimistic concurrency conflict.
- node/edge schema, dangling edge, duplicate edge, invalid asset revision.
- asset MIME·magic bytes·hash·orientation·size 검사.
- Art Bible approval version과 unapproved rule 제외.
- ImageBrief schema, role-specific instruction, source evidence.
- OpenRouter request에 exact model과 input reference가 들어가는지.
- input reference 순서·hash·ACL 재검증.
- idempotency, quota, retry, timeout, cost unknown.

### 17.2 통합 테스트

- upload → art asset → analyze → board attach → extraction READY.
- board revision → analyze → style draft → approve → ImageBrief.
- reference 삭제/권한 회수 뒤 generation 차단.
- preview 전 외부 변경 없음, approval 후 1회 실행, 재사용 차단.
- OpenRouter provider error가 다른 모델 fallback 없이 FAILED가 되는지.
- 생성 결과가 DRAFT로 저장되고 canonical 승인 뒤에만 검색되는지.
- Discord/회의/GitHub/Notion source 중 하나가 실패할 때 PARTIAL과 coverage가 표시되는지.
- reader/editor/admin 권한이 UI와 API에서 일치하는지.

### 17.3 브라우저 테스트

- 새 보드, 업로드, 붙여넣기, 카드 배치, 그룹/프레임, inspector 편집.
- board reload와 revision history.
- 분석 draft 수정·승인·거부.
- ImageBrief preview에서 reference별 역할/사용 범위 확인.
- 생성 승인·진행 상태·결과 gallery·canonical review.
- 세션 만료, 다른 프로젝트 asset 접근, 삭제된 asset 링크.

### 17.4 인수 기준

- 팀원이 웹 캔버스에서 레퍼런스 이미지를 추가하고 역할·사용 범위·메모를 지정할 수 있다.
- 캔버스 공간 배치와 명시적 group/edge가 분석 의미로 보존된다.
- 사용자가 승인한 Art Bible version만 생성에 사용된다.
- 얼굴 형태, 모델링 언어, 재질·텍스처, 컨셉 아트의 사실성 수준이 별도 필드로 보존된다.
- OpenRouter의 openai/gpt-image-2.5-flare에 승인된 레퍼런스 픽셀이 전달된다.
- reference asset 하나를 얼굴만 또는 재질만 사용하도록 제한할 수 있다.
- 생성 결과는 자동 canonical이 아니며 승인 전 future retrieval에서 제외된다.
- 어떤 board revision, Art Bible, reference asset, source evidence로 생성했는지 재현할 수 있다.
- Discord 봇은 캔버스나 이미지 생성 도구를 실행하지 않는다.
- 실제 운영 배포·OpenRouter live 호출이 검증되지 않은 상태를 완료로 표시하지 않는다.

## 18. 환경 변수와 운영 설정

    ART_CANVAS_ENABLED=false
    ART_ANALYSIS_ENABLED=false
    OPENROUTER_API_KEY=
    OPENROUTER_IMAGE_MODEL=openai/gpt-image-2.5-flare
    OPENROUTER_IMAGE_ENDPOINT=https://openrouter.ai/api/v1/images
    IMAGE_GENERATION_ENABLED=false
    IMAGE_CONCURRENCY=2
    IMAGE_DAILY_LIMIT=50
    ART_REFERENCE_MAX_INPUTS=16
    ART_REFERENCE_MAX_BYTES=52428800
    ART_ASSET_STORAGE_DIR=/data/knowledge/uploads

OPENROUTER_IMAGE_MODEL은 배포 편의를 위한 설정값이지만 application startup health check에서 정확한 허용 모델과 일치하는지 검사한다. 실제 secret은 Git에 저장하지 않는다. feature flag가 꺼져 있을 때 UI는 비활성 상태를 성공처럼 표시하지 않는다.

## 19. 구현 시 수정 대상

구현자는 다음 파일을 우선 검토한다.

    apps/web/src/Assistant.tsx
    apps/web/src/style.css
    apps/api/src/assistant.ts
    packages/contracts/src/assistant.ts
    packages/knowledge/src/image-openrouter.ts
    packages/knowledge/src/image-prompt.ts
    packages/knowledge/src/tools/image.ts
    packages/knowledge/src/uploads.ts
    packages/knowledge-db/migrations/003_assistant.sql
    packages/knowledge/src/index.ts

새 모듈 후보:

    packages/knowledge/src/art-board.ts
    packages/knowledge/src/art-reference.ts
    packages/knowledge/src/art-analysis.ts
    packages/knowledge/src/image-brief.ts
    packages/knowledge/src/tools/art.ts
    apps/web/src/ArtReferenceCanvas.tsx

실제 구현자는 기존 store와 tool registry의 naming·ACL·approval convention을 먼저 따르고 migration 번호와 API contract를 저장소의 현재 상태에 맞춰 조정한다. 후보 파일명은 구현 지점을 안내하기 위한 것이며 이미 존재한다고 가정하지 않는다.

## 20. 구현 전 확인이 필요한 항목

- 팀이 보유한 White Day 및 구형 호러 게임 레퍼런스의 정확한 파일, 출처, 사용 권리.
- OpenRouter 계정에서 openai/gpt-image-2.5-flare가 현재 활성 provider로 노출되는지.
- OpenRouter의 현재 input reference data URL/URL 크기와 이미지 수 제한.
- 이미지 vision extraction을 수행할 내부 provider와 비용·보관 정책.
- 캔버스 라이브러리의 라이선스·번들 크기·모바일 지원.
- 프로젝트 내 Art Bible 승인자와 editor/admin 매핑.
- 생성 결과를 canonical로 승인할 팀의 리뷰 기준.

이 항목은 모델이 임의로 확정하지 않는다. 확인되지 않은 실제 레퍼런스·권리·live provider 상태는 검증 필요로 표시한다.
