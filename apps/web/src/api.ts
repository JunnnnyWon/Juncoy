export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterMs = 0,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  // JSON 문자열 본문엔 기본 Content-Type을 단다 — 없으면 서버가 text/plain으로
  // 해석해 파서가 없어 거절된다 (octet-stream 업로드는 호출자가 명시).
  const headers = new Headers(options.headers);
  if (typeof options.body === 'string' && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  const res = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      body.error?.code ?? 'NETWORK_ERROR',
      body.error?.message ?? '요청을 처리하지 못했습니다.',
      Math.max(0, Number(res.headers.get('Retry-After') ?? 0) * 1000) || 0,
    );
  }
  return res.json();
}
