import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let decoder, kind;
try {
  const { OpusEncoder } = require('@discordjs/opus');
  decoder = new OpusEncoder(16000, 1);
  kind = 'native-opus';
} catch {
  const OpusScript = require('opusscript');
  decoder = new OpusScript(16000, 1, OpusScript.Application.AUDIO);
  kind = 'opusscript';
}
parentPort.postMessage({ type: 'ready', decoder: kind });
parentPort.on('message', (message) => {
  try {
    const pcm = decoder.decode(Buffer.from(message.packet));
    const bytes = Uint8Array.from(pcm);
    parentPort.postMessage(
      { type: 'pcm', pcm: bytes, capture_ms: message.capture_ms, gate: message.gate },
      [bytes.buffer],
    );
  } catch {
    parentPort.postMessage({
      type: 'decode_error',
      capture_ms: message.capture_ms,
      gate: message.gate,
    });
  }
});
