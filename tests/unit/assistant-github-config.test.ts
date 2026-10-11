import {afterEach,it,expect,vi} from 'vitest';
import {buildToolContext} from '../../apps/api/src/assistant.ts';
import {GitHubRest} from '../../packages/knowledge/src/github.ts';
afterEach(()=>vi.unstubAllEnvs());
it('uses the same installation variable as the knowledge worker',()=>{
  vi.stubEnv('GITHUB_APP_ID','qa');vi.stubEnv('GITHUB_APP_PRIVATE_KEY','qa');
  vi.stubEnv('GITHUB_INSTALLATION_ID','worker-installation');vi.stubEnv('GITHUB_APP_INSTALLATION_ID',undefined);
  const ctx=buildToolContext({store:{}} as any,'project','user','reader',{DISCORD_GUILD_ID:'guild'} as any);
  expect(ctx.deps.github).toBeInstanceOf(GitHubRest);
});
it('supports the legacy installation alias',()=>{
  vi.stubEnv('GITHUB_APP_ID','qa');vi.stubEnv('GITHUB_APP_PRIVATE_KEY','qa');
  vi.stubEnv('GITHUB_INSTALLATION_ID',undefined);vi.stubEnv('GITHUB_APP_INSTALLATION_ID','legacy-installation');
  expect(buildToolContext({store:{}} as any,'project','user','reader',{DISCORD_GUILD_ID:'guild'} as any).deps.github).toBeInstanceOf(GitHubRest);
});
