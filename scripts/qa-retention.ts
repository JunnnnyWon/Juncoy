import { resolve } from 'node:path';
import { cleanQaRuns } from './lib/qa-retention.ts';
const removed = await cleanQaRuns(resolve(process.argv[2] ?? '.data/qa'));
process.stdout.write(JSON.stringify({ removed_directories: removed.length }) + '\n');
