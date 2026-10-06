import 'dotenv/config';
import { KnowledgeStore } from '@meeting/knowledge-db';

// 지식 DB migration — 회의 DB와 별도. KNOWLEDGE_DATABASE_URL 필수.
if (process.argv[1]?.endsWith('migrate-knowledge.ts')) {
  const url = process.env.KNOWLEDGE_DATABASE_URL;
  if (!url) throw new Error('KNOWLEDGE_DATABASE_URL is required');
  const store = new KnowledgeStore(url);
  try {
    await store.migrate();
    process.stdout.write('knowledge migrations applied\n');
  } finally {
    await store.close();
  }
}
