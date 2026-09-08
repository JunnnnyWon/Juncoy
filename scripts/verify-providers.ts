import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig, ReturnZero, Solar } from '@meeting/providers';
import type { SegmentDTO } from '@meeting/contracts';
const config = loadConfig(),
  rtzr = new ReturnZero(config),
  solar = new Solar(config);
const results: Record<string, unknown> = {
  at: new Date().toISOString(),
  mode: 'real',
  audio: 'synthetic silence; not a DAVE or recognition quality test',
};
try {
  await rtzr.authenticate();
  results.returnzero_auth = 'PASS';
  const stream = rtzr.stream([{ spoken: '유니티', weight: 2 }]);
  stream.on('failure', () => {});
  await stream.open();
  for (let i = 0; i < 5; i++) {
    stream.send(Buffer.alloc(6400));
    await new Promise((r) => setTimeout(r, 200));
  }
  stream.finalize();
  await stream.end();
  results.returnzero_websocket = 'PASS';
} catch (e) {
  results.returnzero_error = (e as any).code ?? 'CONNECTION_FAILED';
}
const segment: SegmentDTO = {
  segment_id: randomUUID(),
  user_id: '100000000000000002',
  display_name: '검증 사용자',
  start_ms: 0,
  end_ms: 2000,
  text: '회피 쿨타임은 2초로 확정합니다. 제가 반영하겠습니다.',
  is_final: true,
  revision: 1,
  corrected: false,
  quality_flags: [],
  overlap_group_id: null,
  updated_at: new Date().toISOString(),
};
try {
  const response = await solar.summarize(
    {
      meeting_id: randomUUID(),
      started_at: new Date().toISOString(),
      segments: [segment],
      participants: [
        {
          user_id: segment.user_id,
          display_name: segment.display_name,
          present: true,
          recording_eligible: true,
        },
      ],
      metadata: { synthetic: true },
      glossary: [],
      markers: [],
      gaps: [],
    },
    'provider-smoke',
    async (usage) => {
      results.solar_usage = {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      };
    },
  );
  results.solar_structured_output = 'PASS';
  results.solar_model = response.model;
} catch (e) {
  results.solar_error = (e as any).code ?? 'SCHEMA_OR_CONNECTION_FAILED';
}
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/provider-verification.json', JSON.stringify(results, null, 2));
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
