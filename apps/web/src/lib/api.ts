import { API_BASE } from "./platform";

const TOKEN_KEY = "kreatix.token";

/** The JWT is mirrored into the `kx_t` cookie so media URLs (<img>, <iframe>)
 *  can authenticate without JS headers. Non-HttpOnly — the token already lives
 *  in localStorage, and JS needs to manage the cookie's lifecycle on logout. */
const mirrorCookie = (t: string | null) => {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = t
    ? `kx_t=${t}; Path=/; SameSite=Lax; Max-Age=604800${secure}`
    : `kx_t=; Path=/; SameSite=Lax; Max-Age=0`;
};

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) => {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
  mirrorCookie(t);
};

// restore the cookie mirror for tokens stored before this feature existed
if (getToken()) mirrorCookie(getToken());

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body && typeof init.body === "string") headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch (err) {
    // network failure — desktop serves/queues through the offline mirror
    const { offlineFallback } = await import("./offline/fallback");
    return offlineFallback<T>(path, init, err);
  }
  if (!res.ok) {
    let code = "error";
    let message = res.statusText;
    try {
      const body = await res.json();
      code = body.error ?? code;
      message = body.message ?? message;
    } catch { /* non-json */ }
    throw new ApiError(res.status, code, message);
  }
  const ct = res.headers.get("content-type") ?? "";
  const data = (ct.includes("json") ? res.json() : res.blob()) as Promise<T>;
  if (init.method === undefined || init.method === "GET") void warmMirror(path, data);
  return data;
}

/** Keep the desktop offline mirror warm from successful GETs. */
async function warmMirror<T>(path: string, data: Promise<T>): Promise<void> {
  if (!API_BASE) return; // browser — no offline mirror
  const { cacheBlob, cacheFileList } = await import("./offline/sync");
  const { store } = await import("./offline/store");
  const d = await data;
  if (/^\/api\/drive(\?|$)/.test(path) && d && typeof d === "object" && "items" in d)
    await cacheFileList((d as { items: Parameters<typeof cacheFileList>[0] }).items);
  else if (path.startsWith("/api/auth/me")) await store.meta.set("me", (d as { user: unknown }).user);
  else if (path.startsWith("/api/billing/summary")) await store.meta.set("billingSummary", d);
  else if (d instanceof Blob) {
    const id = /^\/api\/files\/([^/]+)\/(raw|pdf-bytes)/.exec(path)?.[1];
    if (id) await cacheBlob(id, b64encode(await d.arrayBuffer()), true, d.type);
  } else if (d && typeof d === "object" && "content" in d) {
    const id = /^\/api\/files\/([^/]+)\/content/.exec(path)?.[1];
    if (id) await cacheBlob(id, JSON.stringify((d as { content: unknown }).content), false);
  }
}

const b64encode = (buf: ArrayBuffer) => {
  const u8 = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192));
  return btoa(s);
};

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, file: File | Blob) =>
    request<T>(path, {
      method: "POST",
      body: file,
      headers: { "content-type": file.type || "application/octet-stream" },
    }),
};

/** URL usable in <img>/<iframe> src. Same-origin in the browser; in the
 *  desktop app it resolves to the API origin with a ?t= token (the kx_t
 *  cookie can't cross origins). */
export const mediaUrl = (path: string): string =>
  API_BASE ? `${API_BASE}${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(getToken() ?? "")}` : path;
