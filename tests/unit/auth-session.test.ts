import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ first: vi.fn(), execute: vi.fn() }));
vi.mock("@meeting/db", () => ({ first: mocks.first, sql: (_strings: unknown, ...values: unknown[]) => ({ execute: () => mocks.execute(values) }) }));
import { Auth, SESSION_MAX_AGE_SECONDS } from "../../apps/api/src/auth.ts";
it("renews existing sessions but never revives an expired session", async () => {
  expect(SESSION_MAX_AGE_SECONDS).toBe(2592000);
  const auth = new Auth({ db: {} } as any, {} as any);
  const session = { id_hash: "test", expires_at: new Date() } as any;
  const expires_at = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  mocks.first.mockResolvedValueOnce({ expires_at });
  await auth.renew(session);
  expect(session.expires_at).toEqual(expires_at);
  mocks.first.mockResolvedValueOnce(undefined);
  await expect(auth.renew(session)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
});
