-- RAG-006: chunk_set이 특정 document_version에 결속되고, out-of-order publish가
-- 현재 버전과 어긋나지 않도록 pending_revision 추적을 추가한다.

-- 문서가 "지금 어떤 원본 revision을 가져오는 중인지"를 기록한다.
-- markDocumentDirty가 최신 관측 revision으로 갱신하고, publishVersion은
-- expectedRevision과의 불일치를 거부해 오래된 fetch 결과가 current를 덮지 못한다.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pending_revision text;

-- chunk_set을 만든 대상 버전을 기록한다. 검색/근거 조회는
-- chunk_sets.version_id = documents.current_version_id 조인을 요구하므로
-- 순서 역전으로 활성화된 오래된 청크는 조회에서 자연히 배제된다.
ALTER TABLE chunk_sets ADD COLUMN IF NOT EXISTS version_id uuid
  REFERENCES document_versions(id);
-- 기존 활성 set은 현재 버전의 청크였다고 간주해 채운다.
UPDATE chunk_sets cs SET version_id = d.current_version_id
  FROM documents d
  WHERE cs.document_id = d.id AND cs.version_id IS NULL;
ALTER TABLE chunk_sets ALTER COLUMN version_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS chunk_sets_version ON chunk_sets(version_id);
CREATE INDEX IF NOT EXISTS chunk_sets_doc_active ON chunk_sets(document_id, active);

-- RAG-001: 기존 문서의 acl.scope 백필 — 새 수집은 markDocumentDirty가 acl을 쓰고
-- 과거 문서는 여기서 계산한다. scope가 NULL이면 ACL 필터를 통과하지만
-- guild가 있으면 질문자 guild와 일치해야 한다.
-- discord key: discord:<guild>:<channel>:<message>
UPDATE documents d SET acl = jsonb_build_object(
    'guild', split_part(d.stable_key, ':', 2),
    'channel', split_part(d.stable_key, ':', 3),
    'scope', 'channel:' || split_part(d.stable_key, ':', 3))
  FROM knowledge_sources s
  WHERE s.id=d.source_id AND s.kind='discord' AND d.acl->>'scope' IS NULL;
-- meeting: metadata의 origin_guild_id
UPDATE documents d SET acl = jsonb_build_object(
    'guild', d.metadata->>'origin_guild_id',
    'scope', 'guild:' || (d.metadata->>'origin_guild_id'))
  FROM knowledge_sources s
  WHERE s.id=d.source_id AND s.kind='meeting' AND d.acl->>'scope' IS NULL
    AND d.metadata->>'origin_guild_id' IS NOT NULL;
-- github: metadata의 ref/repo
UPDATE documents d SET acl = jsonb_build_object(
    'repo', d.metadata->>'repo',
    'ref', d.metadata->>'ref',
    'scope', 'ref:' || (d.metadata->>'ref'))
  FROM knowledge_sources s
  WHERE s.id=d.source_id AND s.kind='github' AND d.acl->>'scope' IS NULL
    AND d.metadata->>'ref' IS NOT NULL;
-- notion: 워크스페이스 루트 scope
UPDATE documents d SET acl = jsonb_build_object('scope', 'root:workspace')
  FROM knowledge_sources s
  WHERE s.id=d.source_id AND s.kind='notion' AND d.acl->>'scope' IS NULL;
-- scope 키 조회를 자주 쓰므로 인덱스를 둔다.
CREATE INDEX IF NOT EXISTS documents_acl_scope ON documents((acl->>'scope'));
CREATE INDEX IF NOT EXISTS documents_acl_guild ON documents((acl->>'guild'));
