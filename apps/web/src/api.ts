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
  const res = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store' });
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
