import { describe, expect, it } from 'vitest';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { appJwt, verifyWebhookSignature } from '@meeting/knowledge';

describe('github webhook signature', () => {
  const secret = 'test-secret';
  const body = '{"ref":"refs/heads/main"}';
  const good = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a correct signature, rejects bad ones', () => {
    expect(verifyWebhookSignature(secret, body, good)).toBe(true);
    expect(verifyWebhookSignature(secret, body + 'x', good)).toBe(false);
    expect(verifyWebhookSignature('wrong', body, good)).toBe(false);
    expect(verifyWebhookSignature(secret, body, null)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha1=' + good.slice(7))).toBe(false);
  });
});

describe('appJwt', () => {
  it('produces a signed RS256 JWT with iss/exp', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const jwt = appJwt('12345', privateKey);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString()).alg).toBe('RS256');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(payload.iss).toBe('12345');
    expect(payload.exp - payload.iat).toBe(600);
    expect(s.length).toBeGreaterThan(100);
  });
});
