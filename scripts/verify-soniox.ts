import { readFile } from "node:fs/promises";
import { Soniox, pcmToFlac, loadConfig } from "@meeting/providers";
const config = loadConfig();
const client = new Soniox(config);
const input = process.argv[2];
if (!input) throw new Error("Provide consented PCM16 mono 16kHz QA audio path");
const pcm = await readFile(input);
const id = await client.submitFile(await pcmToFlac(pcm), [{ spoken: "Juncoy", weight: 1 }]);
console.log("Soniox QA submitted", JSON.parse(id).transcription);
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await client.fileStatus(id);
    if (result.status === "completed") { console.log(JSON.stringify({ status: result.status, segments: result.utterances.length, audio_ms: pcm.length / 32, text_characters: result.utterances.reduce((n, row) => n + row.msg.length, 0) })); break; }
    if (attempt === 59) throw new Error("QA timeout");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
} finally { await client.cleanup(id); console.log("Soniox QA remote file and transcription deleted"); }
