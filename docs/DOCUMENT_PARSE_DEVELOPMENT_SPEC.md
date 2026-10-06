# Upstage Document Parse 도입 개발 명세서

작성일: 2026-10-07 KST  
대상 저장소: JunnnnyWon/Juncoy  
기준 코드: 89473c0dcb44212340c4bee51567c5c6e20e1733
문서 버전: v1.1
상태: Document Parse 도입 명세 확정, 운영 검증 전

## 1. 목적

현재 Juncoy의 업로드 문서 처리는 파일을 private storage에 저장한 뒤, PDF는 로컬 PDF text extraction, DOCX는 word/document.xml 문자열 정리, TXT·Markdown·CSV는 원문 문자열로 정규화한다. 이후 일반 텍스트 청크와 Upstage embedding으로 색인한다.

이 방식은 텍스트 질문에는 동작하지만 다음 정보를 잃을 수 있다.

- PDF 페이지·섹션·제목 계층
- 표의 행·열 관계와 셀 위치
- 스캔 문서의 OCR 내용
- 문단·표·이미지·캡션의 레이아웃 순서
- citation으로 다시 열어야 하는 페이지·block 위치

이 명세는 **Upstage Document Parse만** 선택적으로 도입해 문서 구조를 보존하는 ingestion 경로를 정의한다. Information Extraction은 이번 범위에 포함하지 않는다.

핵심 원칙은 다음이다.

> 원본 파일은 불변 바이너리로 따로 보존하고, Document Parse 결과는 검색과 citation을 위한 파생 산출물로만 저장한다. Parse 과정에서 원본 이미지나 원본 PDF를 덮어쓰거나 재인코딩하지 않는다.

## 2. 확정 결정사항

| 항목            | 결정                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 외부 parser     | Upstage Document Parse만 사용한다. Information Extraction은 도입하지 않는다.                                              |
| 적용 대상       | PDF를 1차 대상으로 한다. PDF 외 형식은 기존 로컬 parser를 유지한다.                                                       |
| 이미지 파일     | PNG·JPEG·WEBP는 Document Parse에 보내지 않는다. 원본 픽셀을 그대로 보존하고 art asset/vision 경로에서 별도 처리한다.      |
| PDF 안의 이미지 | PDF 원본은 보존한다. Parse가 반환하는 figure/image 파생물은 보조 preview·검색 산출물로만 저장하며 원본을 대체하지 않는다. |
| RAG             | Parse의 구조화 결과와 기존 plain text를 함께 사용한다. Parse 결과만 유일한 원문으로 취급하지 않는다.                      |
| 답변 모델       | 기존 Upstage Solar Pro 계열을 유지한다.                                                                                   |
| 임베딩          | 기존 Upstage embedding profile을 유지한다.                                                                                |
| fallback        | Parse 장애·timeout·지원되지 않는 결과는 로컬 PDF parser로 계속 ingest한다. 상태와 fallback 원인을 기록한다.               |
| 운영 범위       | 웹 업로드·기존 knowledge source ingestion에 적용한다. Discord 봇은 Document Parse를 직접 호출하지 않는다.                 |

Upstage 공식 문서의 Document Parse 설명은 PDF를 layout-aware HTML 또는 Markdown 등 구조화된 결과로 변환하는 용도다. 이 결과는 원본 파일의 무손실 보관을 대신하지 않는다. 실제 production endpoint, 요청 필드, 응답 schema, 지원 제한은 구현 Phase 0에서 계정 환경으로 확인한다.

참고: [Upstage Document Parsing API](https://console.upstage.ai/api/parse/document-parsing)

## 3. 현재 구현 기준선

기준 커밋 89473c0에서 확인된 흐름은 다음과 같다.

    POST /api/assistant/files/init
      → 파일 바이트 complete
      → sha256·MIME·magic bytes 검사
      → private storage 저장
      → extract job 생성
      → document_versions.normalized 저장
      → chunk set 생성
      → Upstage embedding
      → READY 검색 공개

관련 코드:

- packages/knowledge/src/uploads.ts: MIME, magic bytes, PDF/DOCX/text 로컬 추출, private storage
- apps/api/src/assistant.ts: upload init/complete 및 extract job 생성
- packages/knowledge/src/indexer.ts: normalized document → chunk set → embedding
- packages/knowledge/src/chunk.ts: 문서·회의·Discord·GitHub별 chunk 규칙
- packages/providers/src/knowledge-config.ts: Upstage key/model과 knowledge 환경 설정
- packages/knowledge-db/migrations/003_assistant.sql: knowledge_uploads, knowledge_upload_versions

현재 구현은 PDF에 활성화된 경우 Upstage Document Parse adapter를 HTTP 요청으로 시도하고, 실패하면 기존 pdfjs 로컬 추출로 fallback한다. PNG·JPEG·WEBP는 Parse에 보내지 않으며, 이미지 분석이 활성화된 경우에도 원본 바이트를 별도 파생 텍스트로만 처리한다. 이 구현은 아직 실제 Upstage 계정의 응답 fixture, durable worker 재처리, derived asset 저장, block-aware citation까지 운영 검증된 상태가 아니므로 아래 개발 플랜의 완료 기준을 충족하기 전에는 운영 완료로 표시하지 않는다.

### 3.1 이번 도입에서 반드시 지키는 경계

Document Parse는 PDF의 문서 구조를 RAG에 제공하는 ingestion adapter다. 다음 기능은 이번 도입의 성공 조건이 아니며, Parse 성공을 이유로 자동 실행하지 않는다.

- PNG·JPEG·WEBP를 Parse에 전송하거나 Parse 결과로 교체하지 않는다.
- Information Extraction을 추가하거나 구조화 필드를 자동으로 업무 데이터로 확정하지 않는다.
- Parse 결과만으로 Notion, 일정, Discord, GitHub를 수정하지 않는다.
- Parse 결과의 이미지·figure 파생물을 이미지 생성 reference로 자동 선택하지 않는다.
- 실제 API 계약이 확인되기 전까지 응답 필드를 추측해 production 성공으로 표시하지 않는다.

원본 보존 검증은 parser 성공 여부와 독립적으로 수행한다. parser가 실패해도 원본 hash가 업로드 시점과 동일하면 원본 보존 조건은 통과하고, parser가 성공해도 hash가 달라지면 전체 ingestion을 운영 성공으로 공개하지 않는다.

## 4. 처리 정책

### 4.1 파일 분기

    PDF
      ├─ Parse enabled + PDF 조건 충족 → Upstage Document Parse
      ├─ Parse 실패/timeout/비활성 → 로컬 pdfjs fallback
      └─ 원본 PDF는 항상 동일 hash로 private storage에 보존

    DOCX/TXT/Markdown/CSV
      └─ 기존 로컬 parser 유지

    PNG/JPEG/WEBP
      └─ Document Parse에 전송하지 않음
         → 원본 asset 등록
         → art reference 또는 향후 vision extraction 경로

    Discord/회의록/GitHub/Notion
      └─ 기존 native collector와 구조화된 source parser 유지

### 4.2 PDF Parse 적용 조건

기본값은 PDF에 Parse를 시도하는 것이다. 다음 조건에서는 사전 검사를 통해 로컬 fallback을 선택할 수 있다.

- 빈 파일, 손상 PDF, magic bytes 불일치
- 프로젝트 또는 전역 Parse feature flag가 꺼짐
- 파일 크기·페이지 수가 운영 제한을 초과함
- 같은 sha256 + parser_version + parse_options 결과가 성공적으로 존재함
- 보안 정책상 외부 provider 전송이 금지된 프로젝트

PDF를 Parse할지 여부는 파일 확장자 문자열만으로 판단하지 않고 MIME·magic bytes·실제 parser 결과를 함께 확인한다.

### 4.3 이미지 무손실 원칙

이미지는 Document Parse 파이프라인의 입력이 아니다. 다음 invariant를 테스트와 운영 점검에서 보장한다.

1. 업로드 완료 후 저장된 원본 바이트의 SHA-256은 재계산해도 동일하다.
2. Parse 요청·응답·HTML/Markdown 정규화가 원본 storage key의 파일을 수정하지 않는다.
3. PDF에서 추출한 figure preview는 derived key로 저장하고 원본 PDF와 별도 row로 관리한다.
4. 이미지 원본은 orientation 보정, 리사이즈, 재인코딩, 색상 변환을 하지 않는다.
5. 썸네일이 필요하면 별도 derived thumbnail을 만들고 원본과 derived_from_hash를 연결한다.
6. 이미지 파일을 RAG 텍스트로 바꾸는 경우에도 original asset은 삭제·교체되지 않는다.
7. OpenRouter 이미지 생성 reference로 사용하는 파일은 원본 storage에서 읽으며 Parse 결과나 썸네일을 reference로 사용하지 않는다.

## 5. Upstage Document Parse adapter

새 adapter 후보:

    packages/knowledge/src/document-parse-upstage.ts

adapter는 HTTP 세부사항을 API route와 indexer에서 숨기고 다음 계약을 제공한다.

    export type ParsedDocumentBlock = {
      block_id: string;
      page: number | null;
      block_type: 'heading' | 'paragraph' | 'table' | 'list' | 'image' | 'caption' | 'unknown';
      text: string;
      html?: string;
      bbox?: [number, number, number, number];
      order: number;
      parent_block_id?: string;
      asset_key?: string;
      metadata: Record<string, unknown>;
    };

    export type DocumentParseResult = {
      provider: 'upstage';
      product: 'document-parse';
      parser_version: string;
      source_sha256: string;
      output_format: 'html' | 'markdown' | 'text';
      plain_text: string;
      blocks: ParsedDocumentBlock[];
      pages: { page: number; text: string; block_ids: string[] }[];
      derived_assets: {
        key: string;
        mime: string;
        sha256: string;
        derived_from_source_sha256: string;
        page: number | null;
      }[];
      warnings: string[];
    };

adapter 규칙:

- API key는 서버 환경변수로만 읽고 model prompt나 저장된 document content에 넣지 않는다.
- 원본 PDF를 provider에 전송하기 직전에 sha256을 재검증한다.
- 요청 timeout, retry, response size limit을 둔다.
- provider response의 content type과 JSON/HTML/Markdown body를 검증한다.
- Parse response에 원본 파일이 포함되어도 원본으로 덮어쓰지 않고 폐기하거나 derived asset으로 저장한다.
- provider가 반환한 URL은 장기 저장하지 않는다. 필요한 파생 파일은 서버가 검증 후 private storage에 복사한다.
- Parse 결과가 비어 있거나 block/page 정보가 없으면 실패로 보고 로컬 fallback을 시도한다.
- provider 응답 전문과 원본 바이너리를 로그에 기록하지 않는다. request id, status, latency, hash만 남긴다.

## 6. 데이터 모델 확장

기존 knowledge_uploads와 knowledge_upload_versions를 재사용하고, 다음 필드를 추가하거나 별도 테이블로 확장한다. 정확한 migration 번호는 구현 시점의 최신 migration을 기준으로 정한다.

### 6.1 knowledge_upload_versions 확장

    parser_kind             local | upstage_document_parse
    parser_version          parser/provider version
    parse_options_hash      parse option hash
    parse_status            NOT_REQUESTED | RUNNING | READY | FALLBACK | FAILED
    parse_request_id        provider request id, nullable
    parse_started_at
    parse_finished_at
    parse_latency_ms
    parse_error_code
    source_sha256           immutable source hash
    normalized_hash         parsed normalized payload hash

### 6.2 document_parse_blocks

    id
    upload_version_id
    block_id
    page_number
    ordinal
    block_type
    text
    html
    bbox_json
    parent_block_id
    metadata_json
    content_hash
    created_at
    UNIQUE(upload_version_id, block_id)

### 6.3 document_parse_derived_assets

    id
    upload_version_id
    page_number
    storage_key
    mime
    bytes
    sha256
    derived_from_source_sha256
    kind: figure | page_preview | thumbnail
    created_at

원본 knowledge_uploads.storage_key와 derived asset storage key는 절대 같은 값을 사용하지 않는다.

### 6.4 document_parse_pages

    upload_version_id
    page_number
    text
    block_ids_json
    page_hash
    created_at
    UNIQUE(upload_version_id, page_number)

document_versions.normalized에는 backward-compatible하게 text를 유지하고, 새 결과에는 다음을 추가한다.

    {
      "text": "평탄화된 검색용 텍스트",
      "blocks": [
        {
          "block_id": "p3-b12",
          "page": 3,
          "type": "table",
          "text": "...",
          "bbox": [0, 0, 100, 100],
          "order": 12
        }
      ],
      "pages": [{ "page": 3, "block_ids": ["p3-b12"] }],
      "parser": {
        "kind": "upstage_document_parse",
        "version": "...",
        "source_sha256": "...",
        "normalized_hash": "..."
      }
    }

기존 chunkDocument()가 normalized.text만 읽어도 동작하도록 유지한다. 이후 block-aware chunker를 추가해 page/section/table metadata를 chunk span에 붙인다.

## 7. Ingestion 상태 머신

현재 UPLOADED → EXTRACTING → INDEXING → READY를 유지하면서 parser 상태를 별도로 표시한다.

    UPLOADED
      → PARSING
          → PARSED
          → INDEXING
          → READY

    PARSING
      → PARSE_FALLBACK
          → LOCAL_EXTRACTED
          → INDEXING
          → READY

    PARSING
      → PARSE_FAILED
          → FAILED 또는 LOCAL_EXTRACTED

원본 업로드 상태와 Parse 파생 상태를 하나의 문자열에 억지로 합치지 않는다. UI에는 다음처럼 표시한다.

    업로드: INDEXING
    문서 구조: Upstage Parse 완료
    검색 색인: 처리 중
    원본 이미지: 보존됨

fallback이 발생해도 Parse가 성공했다고 표시하지 않는다. 로컬 추출로 계속 처리한 경우 parser_kind=local, parse_status=FALLBACK을 보여 준다.

## 8. Worker 처리 흐름

기존 extract job을 다음처럼 확장한다.

1. job payload의 document_id, content_hash, upload_id를 검증한다.
2. 현재 document version과 content hash가 일치하는지 확인한다.
3. source MIME이 PDF인지 판단한다.
4. PDF이면 Parse policy와 cache를 확인한다.
5. cache miss이면 Upstage adapter를 호출한다.
6. 응답 검증 후 blocks/pages/derived assets를 private storage와 DB에 저장한다.
7. normalized.text와 구조화 metadata를 document version에 publish한다.
8. Parse 실패 시 로컬 pdfjs extraction을 수행하고 fallback 상태를 저장한다.
9. chunk set을 만든다.
10. embedding job을 실행한다.
11. 모든 활성 chunk와 embedding이 준비되면 document를 READY로 공개한다.

worker는 같은 hash에 대해 중복 Parse를 하지 않는다. idempotency key는 다음을 포함한다.

    parse:{upload_id}:{source_sha256}:{parser_version}:{parse_options_hash}

## 9. Chunk와 citation

### 9.1 호환 단계

첫 구현에서는 normalized.text를 유지해 현재 검색을 깨뜨리지 않는다. Parse block metadata는 각 chunk의 span과 metadata에 복사한다.

    {
      "document_key": "upload:uuid",
      "page_start": 4,
      "page_end": 4,
      "block_ids": ["p4-b2", "p4-b3"],
      "section_path": ["캐릭터", "얼굴 기준"],
      "block_types": ["heading", "paragraph"]
    }

### 9.2 citation

답변 evidence에는 다음을 추가한다.

- upload_id
- source_sha256
- parser_kind
- parser_version
- page
- block_id
- section_path
- quote
- observed_at

페이지·block을 재조회할 수 없거나 현재 revision hash가 바뀌면 기존 RAG와 동일하게 EVIDENCE_CHANGED로 처리한다.

## 10. 이미지 보존과 아트 캔버스 연결

Document Parse 도입은 아트 레퍼런스 캔버스 명세의 원본 이미지 보존 계약을 강화한다.

- 일반 이미지 업로드는 Parse에 보내지 않고 art_reference_assets 또는 기존 upload 원본을 유지한다.
- PDF 안의 이미지가 캔버스에 추가되는 경우에도 원본 PDF의 해당 page/region citation과 derived preview를 연결한다.
- OpenRouter reference input은 art_reference_assets.storage_key의 원본에서 읽는다.
- Parse의 HTML/Markdown 안에 삽입된 이미지를 generation reference로 자동 사용하지 않는다.
- Parse가 반환한 figure가 canonical asset이 되려면 팀원이 별도로 승인하고 새 asset revision을 만들어야 한다.
- 이미지 byte hash, MIME, width, height, orientation과 권리 메모를 보존한다.

## 11. API 및 환경 설정

### 11.1 내부 API

기존 업로드 endpoint를 유지하고 상태·parser 정보를 추가한다.

- GET /api/assistant/files/:id: upload state와 parse status를 함께 반환
- GET /api/assistant/files/:id/parse: page/block/parser metadata 조회
- GET /api/assistant/files/:id/derived-assets/:assetId: ACL 확인 후 derived preview 반환
- POST /api/assistant/files/:id/reparse: editor 이상, 새 parser version으로 재처리 preview/job

reparse는 원본 upload를 변경하지 않고 새 knowledge_upload_versions를 만든다.

### 11.2 환경 변수

    UPSTAGE_DOCUMENT_PARSE_ENABLED=false
    UPSTAGE_DOCUMENT_PARSE_ENDPOINT=
    UPSTAGE_DOCUMENT_PARSE_TIMEOUT_MS=60000
    UPSTAGE_DOCUMENT_PARSE_MAX_BYTES=52428800
    UPSTAGE_DOCUMENT_PARSE_OUTPUT_FORMAT=html
    UPSTAGE_DOCUMENT_PARSE_RETRY_MAX=2
    UPSTAGE_DOCUMENT_PARSE_FALLBACK_LOCAL=true
    UPSTAGE_DOCUMENT_PARSE_CACHE=true

실제 production endpoint와 요청 필드는 공식 API 문서 및 계정 환경에서 구현 전에 확인한다. 문서에 확인되지 않은 field를 임의로 코드화하지 않는다.

## 12. 보안·개인정보·운영

- 외부 provider로 보내기 전 project/user ACL과 source scope를 검사한다.
- 원본 PDF와 Parse derived data는 private storage/DB에 둔다.
- provider 요청 로그에는 content, base64, OCR 원문을 남기지 않는다.
- API key는 환경변수·secret manager 외에 저장하지 않는다.
- 문서에 포함된 prompt injection은 source data로 처리하며 parser·tool·ACL 정책을 바꾸지 못한다.
- timeout·429·5xx는 제한된 backoff 후 fallback한다.
- provider가 partial response를 반환하면 성공으로 공개하지 않고 warning과 상태를 저장한다.
- 원본 hash가 결과와 맞지 않으면 Parse 결과를 폐기한다.
- 삭제·접근 회수된 upload의 Parse blocks, derived assets, chunks, embeddings를 검색에서 차단한다.
- 보존 기간 만료 시 원본과 derived를 같은 deletion tombstone으로 처리한다.

## 13. 비용·성능·관측성

다음 값을 upload version과 metrics에 기록한다.

- parse request count
- parse cache hit/miss
- parse latency
- parse bytes/pages
- fallback count
- response validation failure count
- derived asset count
- chunk count
- embedding count
- 원본 보존 성공 여부

목표 SLO는 실제 샘플 측정 후 확정한다. 초기 비교 기준은 로컬 parser 대비 다음이다.

- 표 복원 정확도
- OCR 정확도
- heading/section 보존율
- page/block citation 정확도
- 처리 시간
- 파일당 비용
- provider 실패 시 fallback 성공률
- 원본 SHA-256 보존율: 100%

## 14. 테스트 및 인수 기준

### 14.1 단위 테스트

- PDF·DOCX·텍스트·이미지 MIME 분기
- PDF magic bytes와 손상 파일 rejection
- Parse request payload의 source hash·timeout·retry
- HTML/Markdown/text response validation
- blocks/pages 정규화 및 block id uniqueness
- Parse cache idempotency
- fallback 상태 전이
- normalized.text backward compatibility
- chunk span의 page/block metadata
- citation의 parser version/source hash
- 원본 bytes hash가 Parse 전후 동일함
- derived asset key가 원본 storage key와 다름

### 14.2 통합 테스트

- PDF upload → Parse → blocks/pages → chunk → embedding → READY
- Parse timeout → local pdfjs fallback → READY
- Parse partial/invalid response → 결과 비공개 및 fallback
- 동일 hash 재업로드 → Parse cache hit 및 중복 요청 없음
- PDF 원본을 Parse 응답으로 덮어쓰려는 경로가 존재하지 않음
- PNG/JPEG/WEBP upload → Parse 미호출 → 원본 hash 보존
- PDF figure derived asset은 생성 reference로 자동 선택되지 않음
- 삭제/ACL 회수 후 원본·derived·chunk citation 차단
- 새 parser version reparse가 이전 version과 원본을 보존함

### 14.3 인수 기준

- PDF의 원본 바이트가 업로드 전후 동일하다.
- PDF Parse 결과가 페이지·block·표·heading metadata와 함께 재조회된다.
- 기존 normalized.text 기반 RAG 검색이 깨지지 않는다.
- Parse 장애 시 로컬 fallback으로 ingestion을 계속할 수 있다.
- Parse 성공 여부와 fallback 여부가 UI와 audit에 정확히 표시된다.
- PNG·JPEG·WEBP는 Document Parse에 전송되지 않는다.
- 이미지 원본과 OpenRouter reference input은 Parse derived 결과와 분리된다.
- PDF 안의 figure 추출물은 원본을 대체하지 않는다.
- citation에 page/block/source hash/parser version이 포함된다.
- 현재 운영 source인 Discord·회의록·GitHub·Notion collector는 변경하지 않는다.
- Document Parse 도입만으로 Information Extraction 또는 자동 일정·작업 변경이 발생하지 않는다.

## 15. 개발 플랜

### Phase 0 — 샘플·계약 고정

1. 실제 팀 문서 20~30개를 유형별로 선정한다.
2. 원본 SHA-256과 기대 citation 위치를 기준 fixture로 저장한다.
3. Upstage 계정의 실제 endpoint, 인증, 지원 MIME, output format, 응답 schema를 확인한다.
4. parser adapter 계약과 feature flag를 먼저 고정한다.

완료 기준: 샘플 원본과 기대 결과의 검증 기준이 있고 API 계약을 추측하지 않는다.

### Phase 1 — adapter·파생 저장

1. document-parse-upstage.ts를 구현한다.
2. upload version에 parser 상태·hash·latency·request id를 저장한다.
3. blocks/pages/derived assets migration을 추가한다.
4. 원본 immutable/hash invariant 테스트를 추가한다.

완료 기준: provider 응답과 원본 storage가 완전히 분리되어 저장된다.

### Phase 2 — worker·RAG 연결

1. PDF extract job에 Parse policy를 연결한다.
2. Parse 결과의 normalized.text와 block metadata를 publish한다.
3. block-aware chunk span과 citation을 추가한다.
4. timeout/실패 시 로컬 fallback을 연결한다.

완료 기준: 기존 검색과 새 page/block citation이 동시에 동작한다.

### Phase 3 — 웹 상태·재처리

1. 업로드 화면에 parser 상태와 원본 보존 상태를 표시한다.
2. Parse page/block preview endpoint를 추가한다.
3. editor 이상만 reparse를 실행할 수 있게 한다.
4. cache, quota, metrics, audit를 추가한다.

완료 기준: 팀원이 Parse 성공·fallback·원본 보존을 화면에서 구분할 수 있다.

### Phase 4 — 품질 검증·점진적 활성화

1. 로컬 parser와 Parse 결과를 같은 fixture로 비교한다.
2. citation·표·OCR·처리시간·비용을 평가한다.
3. feature flag를 프로젝트 일부에만 활성화한다.
4. 원본 hash mismatch가 한 건이라도 발생하면 rollout을 중단한다.

완료 기준: 실제 샘플에서 품질과 비용을 확인하고 이미지 원본 손상 0건을 입증한다.

## 16. 구현 대상 파일

우선 검토:

    apps/api/src/assistant.ts
    packages/knowledge/src/uploads.ts
    packages/knowledge/src/indexer.ts
    packages/knowledge/src/chunk.ts
    packages/knowledge/src/answer.ts
    packages/knowledge-db/migrations/003_assistant.sql
    packages/providers/src/knowledge-config.ts
    apps/knowledge-worker/src/main.ts

새 모듈 후보:

    packages/knowledge/src/document-parse-upstage.ts
    packages/knowledge/src/document-parse-normalize.ts
    packages/knowledge/src/document-parse-policy.ts
    packages/knowledge/src/tools/document-parse.ts

후보 파일명은 구현 지점 안내이며 이미 존재한다고 가정하지 않는다. 구현자는 최신 migration과 Kysely store convention을 먼저 확인한다.

## 17. 범위 제외

- Information Extraction 도입
- 이미지 파일을 Document Parse에 보내는 처리
- 이미지 원본 재인코딩·리사이즈·색상 변환
- Document Parse 결과만으로 일정·작업·Notion을 자동 변경하는 기능
- Discord 봇에서 parser나 외부 provider를 직접 호출하는 기능
- 기존 OpenRouter 이미지 생성 provider 변경
- 원본 파일을 Parse output으로 교체하는 migration

이 명세는 문서 구조 보존과 RAG citation 개선을 위한 것이며, 아트 레퍼런스 이미지의 원본 픽셀 보존 계약을 최우선으로 둔다.
