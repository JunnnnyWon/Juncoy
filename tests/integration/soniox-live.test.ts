import { expect, it } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Soniox } from "@meeting/providers";
import { Capture } from "../../apps/bot/src/capture.ts";
import { Jobs } from "../../apps/worker/src/jobs.ts";
import { fixture, guild, user } from "./helpers.ts";
it.skipIf(!process.env.SONIOX_LIVE_QA_AUDIO)("live Soniox records locally then transcribes after stop with Discord user and original time", async () => {
  const f = await fixture(); const directory = await mkdtemp(join(tmpdir(), "soniox-live-"));
  let capture: Capture | undefined;
  const remoteIds: string[] = [];
  const config = { ...f.config, STT_PROVIDER: "soniox" as const, TRANSCRIPTION_MODE: "after_meeting" as const, AUDIO_RETENTION: "forever" as const, RECORDING_STORAGE_PATH: directory };
  const provider = new Soniox(config);
  try {
    const m = await f.begin();
    capture = new Capture(f.store, config, m, { id: guild } as any, "test", { stream: () => { throw new Error("realtime provider called"); } });
    await capture.startReplay((await f.store.snapshot(guild, m.id)).participants);
    capture.ingestReplay(user, await readFile(process.env.SONIOX_LIVE_QA_AUDIO!), 5000);
    await capture.stop();
    const jobs = new Jobs(f.store, config, {} as any, { submitFile: async (audio, glossary) => { const id = await provider.submitFile(audio, glossary); remoteIds.push(id); return id; }, fileStatus: id => provider.fileStatus(id) });
    // The capture queued FINALIZE too; exercise the transcription independently.
    let transcribed = false;
    for (let attempt = 0; attempt < 80 && !transcribed; attempt++) {
      const job = await f.store.claimJob("qa");
      if (!job) { await new Promise(r => setTimeout(r, 500)); continue; }
      if (job.kind === "RETRANSCRIBE") { await jobs.retranscribe(job); await f.store.finishJob(job); transcribed = (await f.store.allSegments(guild, m.id)).length > 0; }
      else await f.store.finishJob(job);
    }
    const segments = await f.store.allSegments(guild, m.id);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every(row => row.user_id === user && row.start_ms >= 5000)).toBe(true);
    console.log("LIVE_SONIOX_E2E", { segments: segments.length, user_mapping: true, original_time_mapping: true, uploads: remoteIds.length });
  } finally { for (const id of remoteIds) await provider.cleanup(id); capture?.abort(); await f.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 180000);
