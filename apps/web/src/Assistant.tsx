import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { api } from './api.ts';

// 웹 어시스턴트 — spec §7: 대화/메시지/SSE 스트림 + 승인 카드 + 우측 일정·작업 패널.

interface Conv {
  id: string;
  title: string;
  updated_at: string;
}
interface Msg {
  id: string;
  run_id: string | null;
  role: string;
  content: string;
  attachments: any[];
  citations: any[];
  created_at: string;
}
interface Approval {
  id: string;
  kind: string;
  target: any;
  after: any;
  status: string;
  expires_at: string;
}
interface LiveRun {
  phase: string;
  status?: string;
  coverage?: any[];
  evidence: any[];
  text?: string;
}

const asArray = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

const STATUS_KO: Record<string, string> = {
  COMPLETE: '전체 확인 완료',
  PARTIAL: '부분 확인',
  NEEDS_CLARIFICATION: '추가 확인 필요',
  FAILED: '실패',
};
const PHASE_KO: Record<string, string> = {
  idle: '대기 중',
  planning_tool_call: '요청을 구조화하는 중',
  retrieving: '프로젝트 자료를 확인하는 중',
  checking_sources: '최신성을 확인하는 중',
  awaiting_approval: '승인을 기다리는 중',
  executing_tool: '작업을 실행하는 중',
  generating_image: '이미지를 생성하는 중',
  ingesting_file: '파일을 색인하는 중',
  completed: '완료',
  partial: '부분 완료',
  failed: '확인 필요',
};

export function Assistant() {
  return <AssistantBoundary><AssistantView /></AssistantBoundary>;
}

class AssistantBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('assistant-render-error', error, info); }
  render() {
    if (this.state.failed) return <section className="assistant-render-error"><strong>답변을 표시하지 못했습니다.</strong><p>서버 응답 형식을 확인하는 동안 화면을 보호했습니다. 대화를 새로고침해 다시 시도해 주세요.</p><button className="primary-button" onClick={() => this.setState({ failed: false })}>다시 표시</button></section>;
    return this.props.children;
  }
}

function AssistantView() {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [panelTab, setPanelTab] = useState<'files' | 'images'>('images');
  const [files, setFiles] = useState<any[] | null>(null);
  const [images, setImages] = useState<any[] | null>(null);
  const [selectedImage, setSelectedImage] = useState<any | null>(null);
  const [editImage, setEditImage] = useState<any | null>(null);
  useEffect(() => {
    if (!selectedImage) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedImage(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedImage]);
  const [mobileSideOpen, setMobileSideOpen] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const selectedFile = (files ?? []).find((file: any) => file.id === selectedFileId) ?? null;
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const esRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadConvs = async () => {
    try {
      setConvs(asArray<Conv>(await api<Conv[]>('/api/assistant/conversations')).filter((item): item is Conv => Boolean(item && typeof item === 'object')));
    } catch (e: any) {
      setError(
        e?.status === 503
          ? '어시스턴트가 비활성화되어 있습니다.'
          : '대화 목록을 불러오지 못했습니다.',
      );
    }
  };
  useEffect(() => void loadConvs(), []);

  const openConv = async (id: string) => {
    esRef.current?.close();
    setConvId(id);
    setLive(null);
    const r = await api<{ conversation: Conv; messages: Msg[]; pending_approvals: Approval[] }>(
      `/api/assistant/conversations/${id}`,
    );
    setMessages(asArray<Msg>(r.messages).filter((item): item is Msg => Boolean(item && typeof item === 'object')));
    setApprovals(asArray<Approval>(r.pending_approvals).filter((item): item is Approval => Boolean(item && typeof item === 'object')));
  };

  const newConv = async () => {
    const { id } = await api<{ id: string }>('/api/assistant/conversations', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await loadConvs();
    setMessages([]);
    setConvId(id);
  };

  const renameConv = async (conversation: Conv) => {
    const title = window.prompt('대화 이름', conversation.title);
    if (!title?.trim() || title.trim() === conversation.title) return;
    await api('/api/assistant/conversations/' + conversation.id, { method: 'PATCH', body: JSON.stringify({ title: title.trim() }) });
    await loadConvs();
  };

  const deleteConv = async (conversation: Conv) => {
    if (!window.confirm('이 대화와 모든 메시지·실행 기록을 삭제할까요?')) return;
    await api('/api/assistant/conversations/' + conversation.id, { method: 'DELETE' });
    if (conversation.id === convId) {
      esRef.current?.close();
      setConvId(null);
      setMessages([]);
      setApprovals([]);
    }
    await loadConvs();
  };

  const deleteAllConvs = async () => {
    if (!window.confirm('현재 계정의 대화와 모든 메시지·승인·실행 기록을 전부 영구 삭제할까요? 이 작업은 복구할 수 없습니다.')) return;
    await api<{ deleted: number }>('/api/assistant/conversations', { method: 'DELETE' });
    esRef.current?.close();
    setConvId(null);
    setMessages([]);
    setApprovals([]);
    setLive(null);
    await loadConvs();
  };

  const streamRun = (runId: string) => {
    esRef.current?.close();
    const es = new EventSource(`/api/assistant/runs/${runId}/stream`);
    esRef.current = es;
    const liveRun: LiveRun = { phase: 'idle', evidence: [], text: '' };
    setLive({ ...liveRun });
    es.onmessage = () => {};
    for (const kind of [
      'phase',
      'evidence',
      'coverage',
      'tool_call',
      'result',
      'error',
      'done',
      'approval',
      'delta',
    ]) {
      es.addEventListener(kind, (ev) => {
        const data = JSON.parse((ev as MessageEvent).data || '{}');
        if (kind === 'phase') liveRun.phase = data.phase;
        else if (kind === 'evidence') liveRun.evidence.push(data);
        else if (kind === 'coverage') liveRun.coverage = asArray(data.source_coverage);
        else if (kind === 'delta') liveRun.text = (liveRun.text ?? '') + String(data.text ?? '');
        else if (kind === 'result') liveRun.status = data.status;
        else if (kind === 'error') liveRun.status = 'FAILED';
        else if (kind === 'approval' && convId)
          void api<{ pending_approvals: Approval[] }>(
            `/api/assistant/conversations/${convId}`,
          ).then((r) => setApprovals(asArray<Approval>(r.pending_approvals)));
        setLive({ ...liveRun, evidence: [...liveRun.evidence] });
        if (kind === 'result') {
          if (data.image_generated) { setPanelTab('images'); void api<any[]>('/api/assistant/images').then(setImages); }
          es.close();
          setLive(null);
          if (convId) void openConv(convId);
        } else if (kind === 'error') {
          es.close();
          setLive({ ...liveRun, evidence: [...liveRun.evidence] });
        }
      });
    }
    es.onerror = () => {
      es.close();
    };
  };

  const send = async () => {
    if (!input.trim() || !convId || busy) return;
    setBusy(true);
    try {
      const content = input.trim();
      const r = await api<{ run_id: string; message_id: string; title?: string }>(
        `/api/assistant/conversations/${convId}/messages`,
        { method: 'POST', body: JSON.stringify({ content, attachments: editImage ? [{ type: 'edit_image', id: editImage.id }] : [] }) },
      );
      setInput('');
      setEditImage(null);
      setMessages((m) => [
        ...m,
        {
          id: r.message_id,
          run_id: r.run_id,
          role: 'user',
          content,
          attachments: [],
          citations: [],
          created_at: new Date().toISOString(),
        },
      ]);
      // The API generates the first-message title before returning; refresh the rail immediately.
      if (r.title) setConvs((current) => current.map((conversation) => conversation.id === convId ? { ...conversation, title: r.title! } : conversation));
      else await loadConvs();
      streamRun(r.run_id);
    } finally {
      setBusy(false);
    }
  };

  const startPrompt = async (prompt: string) => {
    const { id } = await api<{ id: string }>('/api/assistant/conversations', { method: 'POST', body: JSON.stringify({}) });
    await loadConvs();
    setConvId(id);
    setMessages([]);
    setApprovals([]);
    setInput(prompt);
  };

  const decide = async (id: string, approve: boolean) => {
    await api(`/api/assistant/approvals/${id}/${approve ? 'approve' : 'reject'}`, {
      method: 'POST',
    });
    setApprovals((a) => a.filter((x) => x.id !== id));
    if (approve) { setPanelTab('images'); setImages(await api<any[]>('/api/assistant/images')); }
  };

  useEffect(() => {
    const path = panelTab === 'files' ? '/api/assistant/files' : '/api/assistant/images';
    const set = panelTab === 'files' ? setFiles : setImages;
    api<any[]>(path)
      .then((value) => set(asArray(value)))
      .catch(() => set([]));
  }, [panelTab]);

  const uploadFile = async (f: File) => {
    const buf = await f.arrayBuffer();
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    const sha = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const init = await api<{ id: string; storage_key: string; reused: boolean }>(
      '/api/assistant/files/init',
      {
        method: 'POST',
        body: JSON.stringify({ filename: f.name, mime: f.type, bytes: f.size, sha256: sha }),
      },
    );
    if (!init.reused) {
      await api(`/api/assistant/files/${init.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
    }
    setPanelTab('files');
    api<any[]>('/api/assistant/files')
      .then(setFiles)
      .catch(() => {});
  };

  const deleteFile = async (id: string) => {
    await api(`/api/assistant/files/${id}/delete-preview`, { method: 'POST' });
    const r = await api<{ pending_approvals: Approval[] }>(
      `/api/assistant/conversations/${convId}`,
    );
    setApprovals(asArray<Approval>(r.pending_approvals).filter((item): item is Approval => Boolean(item && typeof item === 'object')));
  };
  const reparseFile = async (id: string) => {
    await api('/api/assistant/files/' + id + '/reparse', { method: 'POST' });
    const r = await api<any[]>('/api/assistant/files');
    setFiles(asArray(r));
  };
  useEffect(() => {
    const element = bottomRef.current;
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [messages, live]);
  useEffect(() => () => esRef.current?.close(), []);

  return (
    <div className="assistant workspace-assistant">
      <aside className="assistant-convs">
        <div className="assistant-rail-head">
          <div>
            <span className="eyebrow">JUNCOY / WORKSPACE</span>
            <h1>프로젝트 어시스턴트</h1>
          </div>
          <span className="live-dot" title="지식 연결 상태" />
        </div>
        <button className="primary-button assistant-new" onClick={() => void newConv()}>
          <span>+</span> 새 대화
        </button>
        {!!convs.length && <button className="assistant-delete-all" onClick={() => void deleteAllConvs()}>대화 기록 전체 삭제</button>}
        <div className="assistant-nav-label">대화 기록</div>
        {asArray<Conv>(convs).filter((c) => c && typeof c === 'object').map((c) => (
          <div key={c.id} className={`conv-item-wrap ${c.id === convId ? 'active' : ''}`}>
            <button className="conv-item" onClick={() => void openConv(c.id)}>{c.title}</button>
            <button className="conv-rename" aria-label={c.title + ' 이름 수정'} title="대화 이름 수정" onClick={() => void renameConv(c)}>✎</button>
            <button className="conv-delete" aria-label={c.title + ' 삭제'} title="대화 삭제" onClick={() => void deleteConv(c)}>×</button>
          </div>
        ))}
        {!convs.length && <p className="dim">대화가 없습니다.</p>}
      </aside>

      <section className="assistant-main">
        <div className="assistant-topbar">
          <div>
            <span className="eyebrow">PROJECT KNOWLEDGE / LIVE</span>
            <h2>
              {convId
                ? (convs.find((c) => c.id === convId)?.title ?? '새 대화')
                : '작업을 시작하세요'}
            </h2>
          </div>
          <div className="source-health">
            <span className="health-dot" /> 최신 소스 상태는 질문 결과에서 확인
          </div>
        </div>
        {!convId ? (
          <div className="assistant-empty assistant-empty-rich">
            <div className="empty-orbit">AI</div>
            <span className="eyebrow">ASK THE PROJECT</span>
            <h2>
              프로젝트의 맥락을
              <br />한 곳에서 탐색하세요.
            </h2>
            <p>회의록, Discord, GitHub, Notion을 참고해 답하고 이미지를 만듭니다. 참고 문서는 Notion에 올려 주세요.</p>
            <div className="prompt-starters">
              <button
                onClick={() => {
                  void startPrompt('최근 회의와 Discord에서 아트 방향에 합의된 내용을 정리해 줘.');
                }}
              >
                최근 아트 결정 요약
              </button>
              <button
                onClick={() => {
                  void startPrompt('이번 주 작업 중 마감이 임박한 항목을 보여 줘.');
                }}
              >
                이번 주 작업 확인
              </button>
              <button
                onClick={() => {
                  void startPrompt('이 프로젝트의 현재 비주얼 방향을 설명해 줘.');
                }}
              >
                비주얼 방향 탐색
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="assistant-msgs">
              {asArray<Msg>(messages).map((m) => (
                <div key={m.id} className={`msg msg-${m.role}`}>
                  <div className="msg-author">{m.role === 'user' ? '나' : '프로젝트 어시스턴트'}</div>
                  <div className="msg-body">{renderMarkdown(m.content)}</div>
                  {asArray<any>(m.attachments).filter(item => item?.type === 'generated_image').map(image => <button key={image.id} className="chat-generated-image" aria-label="생성 이미지 크게 보기" onClick={() => setSelectedImage(image)}><img src={'/api/assistant/images/' + image.id} alt="채팅에서 생성한 이미지" loading="lazy" /></button>)}
                  <CitationList citations={m.citations} />
                  {asArray<any>(m.attachments).filter(image => image?.type === 'generated_image').map(image => <button key={'edit-' + image.id} className="ghost-button" onClick={() => setEditImage(image)}>이 이미지 수정</button>)}
                </div>
              ))}
              {live && (
                <div className="msg msg-assistant">
                  <div className="run-phase">
                    상태: {PHASE_KO[live.phase] ?? live.phase}
                    {live.status && <strong> · {STATUS_KO[live.status] ?? live.status}</strong>}
                  </div>
                  {!!live.text && <div className="msg-body live-answer">{renderMarkdown(live.text)}</div>}
                  {!!live.coverage?.length && (
                    <div className="coverage">
                      {asArray<any>(live.coverage).filter((c) => c && typeof c === 'object').map((c: any, index: number) => (
                        <span
                          key={c.source ?? index}
                          className={`chip ${c.read_status === 'LIVE_READ' ? 'ok' : 'warn'}`}
                        >
                          {c.source}{' '}
                          {c.read_status === 'LIVE_READ'
                            ? '✓'
                            : c.read_status === 'FAILED'
                              ? '✗'
                              : '–'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
            {!!approvals.length && (
              <div className="approvals">
                {asArray<Approval>(approvals).filter((a) => a && typeof a === 'object').map((a) => (
                  <div key={a.id} className="approval-card">
                    <div className="approval-head">
                      {a.kind} · 만료 {new Date(a.expires_at).toLocaleTimeString('ko-KR')}
                    </div>
                    <ApprovalSummary approval={a} />
                    <div className="approval-actions">
                      <button className="primary-button" onClick={() => void decide(a.id, true)}>
                        승인
                      </button>
                      <button className="ghost-button" onClick={() => void decide(a.id, false)}>
                        거부
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="assistant-input">
              {editImage && <div className="chat-edit-target"><img src={'/api/assistant/images/' + editImage.id} alt="수정할 이미지" /><span>이 이미지를 수정합니다</span><button aria-label="수정 대상 선택 해제" onClick={() => setEditImage(null)}>×</button></div>}
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void send()}
                placeholder="질문하거나 작업을 요청하세요…"
                aria-label="어시스턴트 입력"
              />
              <button
                className="primary-button"
                disabled={busy || !input.trim()}
                onClick={() => void send()}
              >
                보내기 <span>↗</span>
              </button>
            </div>
          </>
        )}
      </section>

      {selectedImage && <div className="image-modal-backdrop" onClick={() => setSelectedImage(null)}><section className="image-modal" role="dialog" aria-modal="true" aria-label="생성 이미지 상세" onClick={event => event.stopPropagation()}><button autoFocus className="image-modal-close" aria-label="이미지 상세 닫기" onClick={() => setSelectedImage(null)}>×</button><img src={'/api/assistant/images/' + selectedImage.id} alt="생성 이미지" /><div><h2>생성 이미지</h2><p>{selectedImage.prompt}</p><dl><dt>생성 모델</dt><dd>{selectedImage.model}</dd><dt>만든 시간</dt><dd>{new Date(selectedImage.created_at).toLocaleString('ko-KR')}</dd><dt>파일 크기</dt><dd>{Math.round(Number(selectedImage.bytes) / 1024)}KB</dd></dl><a href={'/api/assistant/images/' + selectedImage.id} target="_blank" rel="noreferrer">원본 이미지 열기 ↗</a></div></section></div>}
      {error && (
        <div className="toast" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function safeText(value: unknown, fallback = '') {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['summary', 'message', 'text', 'title', 'name', 'description']) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
    return '요청 처리 결과를 확인했습니다.';
  }
  return fallback;
}

function renderMarkdown(value: unknown) {
  const text = safeText(value, '응답 내용이 없습니다.')
    .replace(/\(?\s*e\d+(?:\s*,\s*e\d+)*\s*\)?/gi, '')
    .replace(/\[e\d+\]/gi, '')
    .replaceAll('\\n', '\n')
    .replace(/ {2,}/g, ' ')
    .trim();
  return text.split(/\n/).map((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return <div key={index} className="md-spacer" />;
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    const content = formatInline(heading?.[2] ?? bullet?.[1] ?? numbered?.[1] ?? trimmed);
    if (heading) return <h3 key={index} className="md-heading">{content}</h3>;
    if (bullet || numbered) return <div key={index} className="md-bullet"><span>{numbered ? numbered[0].split(/[.)]/)[0] + '.' : '•'}</span>{content}</div>;
    return <p key={index}>{content}</p>;
  });
}

function formatInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

function CitationList({ citations }: { citations: unknown }) {
  const items = asArray<any>(citations).filter((item) => item && typeof item === 'object' && (item.url || item.quote || item.stable_key));
  if (!items.length) return null;
  return <details className="message-citations"><summary>참고 자료 {items.length}건</summary>{items.map((citation: any, index: number) => { const quote = safeText(citation.quote ?? citation.excerpt ?? citation.stable_key, '근거 세부 정보').replace(/\s+/g, ' ').trim(); const shortQuote = quote.length > 150 ? quote.slice(0, 150) + '…' : quote; return <div key={citation.id ?? index} className="citation-row"><strong>{safeText(citation.source ?? citation.title, '프로젝트 자료')}</strong><span>{shortQuote}</span><small>{citation.page_start ? '페이지 ' + citation.page_start : ''}{citation.parser_version ? ' · ' + citation.parser_version : ''}</small>{typeof citation.url === 'string' && citation.url && <a href={citation.url} target="_blank" rel="noreferrer">원문 열기 ↗</a>}</div>; })}</details>;
}

function renderMessage(rawContent: unknown) {
  return <>{renderMarkdown(rawContent)}</>;
}

function humanizeKey(key: string) {
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ApprovalSummary({ approval }: { approval: Approval }) {
  const data = approval.after && typeof approval.after === 'object' ? approval.after as Record<string, unknown> : {};
  const title = data.name ?? data.title ?? data.filename ?? data.task ?? data['이름'] ?? approval.kind;
  const date = data.date_start ?? data.start ?? data.date;
  const description = data.description ?? data.note ?? data.content ?? data['설명'] ?? data.prompt;
  return <div className="approval-summary"><h3>{safeText(title, '승인 필요한 작업')}</h3>{date != null && <p className="approval-date">{safeText(date)}</p>}{description != null && <p>{safeText(description)}</p>}</div>;
}
