import { markQaRun } from './qa-retention.ts';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type LedgerStore, type LedgerDescriptor, ProviderError } from '@meeting/providers';
export function fileLedger(
  directory: string,
  telemetry = { cache_hits: 0, stage_requests: 0 },
): LedgerStore {
  return {
    async open(descriptor: LedgerDescriptor) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await markQaRun(directory);
      const path = (name: string) => resolve(directory, name.replaceAll(':', '-') + '.json');
      const read = async (name: string) => {
        try {
          return JSON.parse(await readFile(path(name), 'utf8'));
        } catch (e: any) {
          if (e.code === 'ENOENT') return null;
          throw e;
        }
      };
      const save = async (name: string, value: unknown) => {
        const target = path(name),
          temp = target + '.' + randomUUID() + '.tmp';
        await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
        await rename(temp, target);
      };
      const old = await read('run');
      if (old && old.run_key !== descriptor.run_key) throw new Error('QA_OUTPUT_INPUT_CHANGED');
      const run = { ...descriptor, run_id: old?.run_id ?? randomUUID() };
      await save('run', run);
      return {
        run_id: run.run_id,
        async begin(stage, inputHash) {
          const current = await read('stage-' + stage);
          if (current && current.input_hash !== inputHash) throw new Error('STAGE_INPUT_CHANGED');
          if (current?.status === 'SUCCEEDED') {
            telemetry.cache_hits++;
            return { attempt: current.attempt, cached: current.output, model: current.model };
          }
          const attempt = (current?.attempt ?? 0) + 1;
          if (attempt > 3 || current?.terminal)
            throw new ProviderError('STAGE_RETRIES_EXHAUSTED', false);
          telemetry.stage_requests++;
          await save('stage-' + stage, {
            input_hash: inputHash,
            status: 'RUNNING',
            attempt,
            started_at: new Date().toISOString(),
          });
          return { attempt };
        },
        async success(stage, inputHash, output, model) {
          const current = await read('stage-' + stage);
          await save('stage-' + stage, {
            ...current,
            input_hash: inputHash,
            status: 'SUCCEEDED',
            output,
            model,
            completed_at: new Date().toISOString(),
          });
        },
        async failure(stage, code, terminal) {
          const current = await read('stage-' + stage);
          await save('stage-' + stage, { ...current, status: 'FAILED', code, terminal });
        },
        async complete(facts, report, result, outputHash, model) {
          await save('facts', facts);
          await save('report', report);
          await save('summary', result);
          await save('complete', {
            output_hash: outputHash,
            model,
            completed_at: new Date().toISOString(),
          });
        },
        async reject(code) {
          await save('rejected', { code, at: new Date().toISOString() });
        },
      };
    },
  };
}
