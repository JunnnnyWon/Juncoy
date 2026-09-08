import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { emptySummary, type SummaryInput } from './solar.ts';
import { ProviderError, type SpeechStream, type SttMessage } from './returnzero.ts';
export class MockSpeechStream extends EventEmitter implements SpeechStream {
  sentMs = 0;
  private openState = false;
  private seq = 0;
  private text = '';
  constructor(private options: { failOpen?: number; failAfterMs?: number } = {}) {
    super();
  }
  async open() {
    if (this.options.failOpen)
      throw new ProviderError(
        'MOCK_HTTP_' + this.options.failOpen,
        this.options.failOpen === 429,
        this.options.failOpen,
      );
    this.openState = true;
  }
  send(pcm: Buffer) {
    if (!this.openState) throw new ProviderError('MOCK_NOT_CONNECTED', true);
    this.sentMs += pcm.length / 32;
    if (this.options.failAfterMs && this.sentMs >= this.options.failAfterMs) {
      this.openState = false;
      this.emit('failure', new ProviderError('MOCK_DISCONNECTED', true));
    }
  }
  inject(text: string, final = false, start = 0, duration = 1000) {
    this.text = text;
    this.emit('transcript', {
      seq: String(this.seq),
      start_at: start,
      duration,
      final,
      text,
    } satisfies SttMessage);
    if (final) this.seq++;
  }
  finalize() {
    if (this.openState && this.text) this.inject(this.text, true);
  }
  async end() {
    if (this.openState) this.finalize();
    this.openState = false;
    this.emit('closed');
  }
  abort() {
    this.openState = false;
    this.emit('closed');
  }
}
export class MockReturnZero {
  async authenticate() {
    return 'mock-only-token';
  }
  stream() {
    return new MockSpeechStream();
  }
  private jobs = new Map<string, { start_at: number; duration: number; msg: string }[]>();
  async submitFile(_audio: Buffer) {
    const id = randomUUID();
    this.jobs.set(id, []);
    return id;
  }
  setFileResult(id: string, utterances: { start_at: number; duration: number; msg: string }[]) {
    if (!this.jobs.has(id)) throw new ProviderError('MOCK_UNKNOWN_JOB', false);
    this.jobs.set(id, utterances);
  }
  async fileStatus(id: string) {
    if (!this.jobs.has(id)) throw new ProviderError('MOCK_UNKNOWN_JOB', false);
    return { status: 'completed', utterances: this.jobs.get(id)! };
  }
}
export class MockSolar {
  async summarize(input: SummaryInput) {
    const result = emptySummary(String(input.metadata.title ?? '데모 회의'), [
      '데모 데이터를 이용한 모의 요약입니다.',
    ]);
    result.summary = input.segments.slice(0, 3).map((s) => s.text);
    result.topics = input.segments.slice(0, 3).map((s) => ({
      category: '프로그래밍' as const,
      title: s.text.slice(0, 35),
      discussion: s.text,
      evidence_segment_ids: [s.segment_id],
    }));
    const decision = input.segments.find((s) => s.text.includes('확정'));
    if (decision)
      result.decisions = [
        { decision: decision.text, reason: null, evidence_segment_ids: [decision.segment_id] },
      ];
    const task = input.segments.find((s) => s.text.includes('제가'));
    if (task)
      result.action_items = [
        {
          task: task.text,
          owner_user_id: task.user_id,
          due_date: null,
          due_date_text: null,
          evidence_segment_ids: [task.segment_id],
        },
      ];
    return { result, model: 'mock-solar' };
  }
}
