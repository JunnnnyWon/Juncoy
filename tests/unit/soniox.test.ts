import { expect, it, vi } from "vitest";
import { Soniox } from "../../packages/providers/src/soniox.ts";
const config = { SONIOX_API_KEY: "test", SONIOX_MODEL: "stt-async-v5" } as any;
it("uploads Korean per-user audio and normalizes timed tokens without diarization", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: "file" })).mockResolvedValueOnce(Response.json({ id: "transcription" })).mockResolvedValueOnce(Response.json({ status: "completed" })).mockResolvedValueOnce(Response.json({ tokens: [{ text: "안녕", start_ms: 100, end_ms: 200 }, { text: "하세요", start_ms: 200, end_ms: 400 }] }));
  const client = new Soniox(config, fetcher);
  const id = await client.submitFile(Buffer.from("audio"), [{ spoken: "Juncoy", weight: 1 }]);
  const payload = JSON.parse(fetcher.mock.calls[1][1].body);
  expect(payload.language_hints).toContain("ko");
  expect(payload.enable_speaker_diarization).toBe(false);
  expect((await client.fileStatus(id)).utterances).toEqual([{ start_at: 100, duration: 300, msg: "안녕하세요" }]);
});
it("polls pending requests without uploading again and classifies failures", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ status: "transcribing" })).mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(new Response("", { status: 401 }));
  const client = new Soniox(config, fetcher);
  const id = JSON.stringify({ transcription: "t", file: "f" });
  expect((await client.fileStatus(id)).status).toBe("processing");
  await expect(client.fileStatus(id)).rejects.toMatchObject({ retryable: true, httpStatus: 429 });
  await expect(client.fileStatus(id)).rejects.toMatchObject({ retryable: false, httpStatus: 401 });
  expect(fetcher.mock.calls.every(call => !call[1].method)).toBe(true);
});
