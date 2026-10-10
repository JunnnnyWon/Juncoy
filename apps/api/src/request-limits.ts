export function requestBucket(method: string, url: string) {
  const path = url.split("?")[0];
  if (path.startsWith("/auth/")) return { name: "auth", max: 60 };
  if (method === "GET" && (/^\/api\/assistant\/(files|art-assets)\/[^/]+\/(content|extraction)$/.test(path) || /^\/api\/assistant\/images\/[^/]+$/.test(path))) return { name: "art-read", max: 1200 };
  if (method === "GET" && (path === "/healthz" || path.startsWith("/assets/"))) return { name: "static", max: 1200 };
  return { name: "api", max: 180 };
}
