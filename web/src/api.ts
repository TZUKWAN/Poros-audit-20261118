/** API 客户端：JWT 走 Authorization 头（审查项④：Token 不进 URL）。 */
let token: string | null = localStorage.getItem("poros-token");

export function getToken(): string | null {
  return token;
}

export function setToken(t: string | null): void {
  token = t;
  if (t) localStorage.setItem("poros-token", t);
  else localStorage.removeItem("poros-token");
}

export interface ApiResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  body: T & { error?: string };
}

export async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 15000,
): Promise<ApiResult<T>> {
  let res: Response;
  const sentToken = token;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(sentToken ? { authorization: `Bearer ${sentToken}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      body: { error: "网络中断或请求超时，请重试" } as T & { error: string },
    };
  }
  if (res.status === 401 && token === sentToken) {
    setToken(null);
    window.dispatchEvent(new Event("poros-auth-expired"));
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 非 JSON（如 SSE） */
  }
  return { ok: res.ok, status: res.status, body: json as T & { error?: string } };
}

export interface OrgInfo {
  organizationId: string;
  role: string;
  email: string;
  exp?: number;
}

/** 登录指定组织并记住身份；服务端逐次核对持久会话和当前成员关系。 */
export async function login(
  email: string,
  password: string,
  organizationId: string,
): Promise<{ ok: boolean; error?: string; info?: OrgInfo }> {
  const r = await api<{ token?: string }>("POST", "/api/auth/login", {
    email,
    password,
    organizationId,
  });
  if (!r.ok || !r.body.token) return { ok: false, error: r.body.error ?? `HTTP ${r.status}` };
  setToken(r.body.token);
  // 仅用于初始展示；App 随后通过 /api/auth/me 校验身份。
  try {
    const payload = JSON.parse(atob(r.body.token.split(".")[1]!)) as OrgInfo;
    return { ok: true, info: payload };
  } catch {
    return { ok: true };
  }
}

export async function logout(): Promise<boolean> {
  const r = await api("POST", "/api/auth/logout");
  if (!r.ok && r.status !== 401) return false;
  setToken(null);
  return true;
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function download(path: string, filename: string): Promise<string | null> {
  try {
    const response = await fetch(path, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      return (
        (await response.json().catch(() => ({}))).error ?? `下载失败（HTTP ${response.status}）`
      );
    saveBlob(await response.blob(), filename);
    return null;
  } catch {
    return "下载连接中断，请重试";
  }
}
