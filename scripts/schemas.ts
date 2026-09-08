import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { Snapshot, Event, MeetingSummary, SummaryResult, Segment } from '@meeting/contracts';
await mkdir('docs/schemas', { recursive: true });
for (const [name, schema] of Object.entries({
  snapshot: Snapshot,
  'meeting-event': Event,
  'meeting-summary': MeetingSummary,
  'summary-result': SummaryResult,
  segment: Segment,
}))
  await writeFile(
    `docs/schemas/${name}.schema.json`,
    JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n',
  );
