import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { AppConfig } from './config.ts';
export class ProviderError extends Error {
  constructor(
    public code: string,
    public retryable: boolean,
    public httpStatus?: number,
  ) {
    super(code);
  }
}
export interface SttMessage {
  seq: string;
  start_at: number;
  duration: number;
  final: boolean;
  text: string;
  words?: unknown[];
}
const Response = z.object({
  seq: z.union([z.number(), z.string()]),
  start_at: z.number().nonnegative(),
  duration: z.number().nonnegative().default(0),
  final: z.boolean(),
  alternatives: z
    .array(z.object({ text: z.string(), words: z.array(z.unknown()).optional() }))
    .min(1),
});
export interface SpeechStream extends EventEmitter {
  open(): Promise<void>;
  send(pcm: Buffer): void;
  finalize(): void;
  end(): Promise<void>;
  abort(): void;
  sentMs: number;
}
export class ReturnZero {
  private token: string | null = null;
  private expires = 0;
  private refresh: Promise<string> | null = null;
  constructor(readonly config: AppConfig) {}
  async authenticate(force = false): Promise<string> {
    if (!force && this.token && this.expires > Date.now() + 60000) return this.token;
    if (this.refresh) return this.refresh;
    this.refresh = (async () => {
      const response = await fetch('https://openapi.vito.ai/v1/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.RTZR_CLIENT_ID,
          client_secret: this.config.RTZR_CLIENT_SECRET,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok)
        throw new ProviderError('RTZR_AUTH_' + response.status, false, response.status);
      const data = (await response.json()) as { access_token: string; expire_at: number };
      if (!data.access_token) throw new ProviderError('RTZR_INVALID_TOKEN', false);
      this.token = data.access_token;
      this.expires = Number(data.expire_at) * 1000;
      return this.token;
    })().finally(() => {
      this.refresh = null;
    });
    return this.refresh;
  }
  stream(keywords: { spoken: string; weight: number }[]): SpeechStream {
    return new ReturnZeroStream(this, keywords);
  }
  async submitFile(audio: Buffer, keywords: { spoken: string; weight: number }[]): Promise<string> {
    const form = new FormData();
    form.set(
      'config',
      JSON.stringify({
        model_name: 'sommers',
        use_diarization: false,
        use_word_timestamp: true,
        use_paragraph_splitter: false,
        use_itn: true,
        use_punctuation: true,
        keywords: keywords.map((k) => k.spoken),
      }),
    );
    form.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/flac' }), 'recovery.flac');
    const response = await this.request('/transcribe', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    const data = (await response.json()) as { id?: string };
    if (!data.id) throw new ProviderError('RTZR_INVALID_JOB', false);
    return data.id;
  }
  async fileStatus(id: string): Promise<{
    status: string;
    utterances: { start_at: number; duration: number; msg: string }[];
  }> {
    const response = await this.request('/transcribe/' + encodeURIComponent(id), {
      signal: AbortSignal.timeout(15000),
    });
    const d = (await response.json()) as any;
    if (d.status === 'failed') throw new ProviderError('RTZR_FILE_FAILED', false);
    return { status: d.status, utterances: d.results?.utterances ?? [] };
  }
  private async request(path: string, init: RequestInit): Promise<Response> {
    let response = await fetch('https://openapi.vito.ai/v1' + path, {
      ...init,
      headers: { Authorization: 'Bearer ' + (await this.authenticate()) },
    });
    if (response.status === 401)
      response = await fetch('https://openapi.vito.ai/v1' + path, {
        ...init,
        headers: { Authorization: 'Bearer ' + (await this.authenticate(true)) },
      });
    if (!response.ok)
      throw new ProviderError(
        'RTZR_HTTP_' + response.status,
        response.status === 429 || response.status >= 500,
        response.status,
      );
    return response;
  }
}
class ReturnZeroStream extends EventEmitter implements SpeechStream {
  private ws: WebSocket | null = null;
  sentMs = 0;
  private ended = false;
  private opening = false;
  private closed = false;
  private finishClosed() {
    if (!this.closed) {
      this.closed = true;
      this.emit('closed');
    }
  }
  constructor(
    private provider: ReturnZero,
    private keywords: { spoken: string; weight: number }[],
  ) {
    super();
  }
  async open() {
    if (this.ended) throw new ProviderError('RTZR_CANCELLED', false);
    this.opening = true;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await this.provider.authenticate(attempt === 1);
        if (this.ended) throw new ProviderError('RTZR_CANCELLED', false);
        const query = new URLSearchParams({
          sample_rate: '16000',
          encoding: 'LINEAR16',
          model_name: 'sommers_ko',
          domain: 'CALL',
          use_itn: 'true',
          use_punctuation: 'true',
          use_disfluency_filter: 'false',
          use_profanity_filter: 'false',
        });
        if (this.keywords.length)
          query.set('keywords', this.keywords.map((k) => k.spoken + ':' + k.weight).join(','));
        try {
          await new Promise<void>((resolve, reject) => {
            const ws = (this.ws = new WebSocket(
              'wss://openapi.vito.ai/v1/transcribe:streaming?' + query,
              { headers: { Authorization: 'Bearer ' + token }, handshakeTimeout: 5000 },
            ));
            ws.once('open', resolve);
            ws.once('unexpected-response', (_req, res) => {
              res.resume();
              ws.terminate();
              reject(
                new ProviderError(
                  'RTZR_WS_' + res.statusCode,
                  res.statusCode === 429,
                  res.statusCode,
                ),
              );
            });
            ws.on('error', () => {
              const e = new ProviderError('RTZR_WS_ERROR', true);
              reject(e);
              if (ws.readyState === WebSocket.OPEN) this.emit('failure', e);
            });
            ws.on('close', () => {
              if (this.opening) return;
              if (!this.ended) this.emit('failure', new ProviderError('RTZR_WS_CLOSED', true));
              this.finishClosed();
            });
            ws.on('message', (raw) => {
              try {
                const p = Response.parse(JSON.parse(raw.toString()));
                this.emit('transcript', {
                  seq: String(p.seq),
                  start_at: p.start_at,
                  duration: p.duration,
                  final: p.final,
                  text: p.alternatives[0]!.text,
                  words: p.alternatives[0]!.words,
                } satisfies SttMessage);
              } catch {
                this.emit('failure', new ProviderError('RTZR_INVALID_RESPONSE', false));
              }
            });
          });
          return;
        } catch (e) {
          if (!this.ended && e instanceof ProviderError && e.httpStatus === 401 && attempt === 0)
            continue;
          throw e;
        }
      }
    } finally {
      this.opening = false;
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.finishClosed();
    }
  }
  send(pcm: Buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
      throw new ProviderError('RTZR_NOT_CONNECTED', true);
    if (this.ws.bufferedAmount > 160000) throw new ProviderError('RTZR_BACKPRESSURE', true);
    this.ws.send(pcm);
    this.sentMs += pcm.length / 32;
  }
  finalize() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'Finalize' }));
  }
  async end() {
    if (this.ended) return;
    this.ended = true;
    if (!this.ws) {
      this.finishClosed();
      return;
    }
    const ws = this.ws;
    if (ws.readyState === WebSocket.CLOSED) {
      this.finishClosed();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate();
      }, 15000);
      ws.once('close', () => {
        clearTimeout(timer);
        this.finishClosed();
        resolve();
      });
      if (ws.readyState === WebSocket.OPEN) ws.send('EOS');
      else {
        ws.terminate();
      }
    });
  }
  abort() {
    this.ended = true;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.finishClosed();
    else this.ws.terminate();
  }
}
