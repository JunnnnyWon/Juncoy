import { ProviderError } from "./returnzero.ts";
import type { AppConfig } from "./config.ts";
export class Soniox {
  constructor(private config: AppConfig, private fetchImpl: typeof fetch = fetch) {}
  private async request(path: string, init: RequestInit = {}) {
    const response = await this.fetchImpl("https://api.soniox.com/v1" + path, { ...init, headers: { Authorization: "Bearer " + this.config.SONIOX_API_KEY, ...init.headers }, signal: AbortSignal.timeout(60000) });
    if (init.method === "DELETE" && response.status === 404) return {};
    if (!response.ok) { const error = new ProviderError("SONIOX_HTTP_" + response.status, response.status === 429 || response.status >= 500, response.status); Object.assign(error, { retryAfterSeconds: Number(response.headers.get("retry-after") ?? 0) }); throw error; }
    const body = await response.text();
    return body ? JSON.parse(body) : {};
  }
  async submitFile(audio: Buffer, keywords: { spoken: string; weight: number }[]) {
    const file = await this.upload(audio);
    return this.createTranscription(file, keywords);
  }
  async upload(audio: Buffer) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/flac" }), "meeting.flac");
    const file = await this.request("/files", { method: "POST", body: form }) as any;
    return String(file.id);
  }
  async createTranscription(fileId: string, keywords: { spoken: string; weight: number }[], reference?: string) {
    const result = await this.request("/transcriptions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_id: fileId, model: this.config.SONIOX_MODEL, language_hints: ["ko", "en"], enable_speaker_diarization: false, client_reference_id: reference, context: { terms: keywords.map(k => k.spoken) } }) }) as any;
    return JSON.stringify({ transcription: result.id, file: fileId });
  }
  async fileStatus(id: string) {
    const job = JSON.parse(id);
    const status = await this.request("/transcriptions/" + encodeURIComponent(job.transcription)) as any;
    if (["error", "failed"].includes(status.status)) throw new ProviderError("SONIOX_TRANSCRIPTION_FAILED", false);
    if (status.status !== "completed") return { status: "processing", utterances: [] };
    const result = await this.request("/transcriptions/" + encodeURIComponent(job.transcription) + "/transcript") as any;
    const utterances: { start_at: number; duration: number; msg: string }[] = [];
    for (const token of result.tokens ?? []) {
      if (token.is_audio_event || !token.text || token.text.startsWith("<")) continue;
      const previous = utterances.at(-1);
      if (previous && token.start_ms - previous.start_at - previous.duration < 800 && token.end_ms - previous.start_at < 15000) { previous.msg += token.text; previous.duration = token.end_ms - previous.start_at; }
      else utterances.push({ start_at: token.start_ms, duration: token.end_ms - token.start_ms, msg: token.text });
    }
    return { status: "completed", utterances };
  }
  async cleanup(id: string) {
    const job = JSON.parse(id);
    await this.request("/transcriptions/" + encodeURIComponent(job.transcription), { method: "DELETE" });
    await this.request("/files/" + encodeURIComponent(job.file), { method: "DELETE" });
  }
}
