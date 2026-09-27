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

  const res = await fetch(path, { ...init, headers });
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
  return (ct.includes("json") ? res.json() : res.blob()) as Promise<T>;
}

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
