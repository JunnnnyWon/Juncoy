import { expect, it } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { requestBucket } from "../../apps/api/src/request-limits.ts";
it("separates artwork reads from login and normal API budgets", async () => {
  const app = Fastify();
  await app.register(rateLimit, { max: req => requestBucket(req.method, req.url).max, timeWindow: "1 minute", keyGenerator: req => requestBucket(req.method, req.url).name + req.ip });
  app.get("/api/assistant/art-assets/:id/extraction", async () => ({ ok: true }));
  app.get("/api/me", async () => ({ ok: true }));
  app.get("/auth/discord", async () => ({ ok: true }));
  try {
    for (let i = 0; i < 200; i++) expect((await app.inject("/api/assistant/art-assets/test/extraction")).statusCode).toBe(200);
    for (let i = 0; i < 180; i++) expect((await app.inject("/api/me")).statusCode).toBe(200);
    expect((await app.inject("/api/me")).statusCode).toBe(429);
    expect((await app.inject("/auth/discord")).statusCode).toBe(200);
    expect(requestBucket("POST", "/api/assistant/images/generate").name).toBe("api");
  } finally { await app.close(); }
});
