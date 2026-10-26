/**
 * 向 Google Maps Platform 发一个 POST 请求（Places API (New)、Routes API 都是这种形式）。
 * 不依赖 Expo，可以在 Node 里测试（fetch 可替换）。
 *
 * 结果里的 ok 只在收到 2xx 响应时为 true——这也是「计入每月次数」的唯一条件（见 src/db/apiUsage.ts）。
 */
export interface GoogleHttpResult {
  /** 收到 2xx 响应（Google 会计费的成功调用） */
  ok: boolean;
  /** 没有收到任何响应（没网、超时） */
  offline: boolean;
  httpStatus: number | null;
  json: unknown;
  message?: string;
}

export async function googlePost(
  url: string,
  opts: { key: string; fieldMask: string; body: unknown; headers?: Record<string, string>; timeoutMs?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleHttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': opts.key, 'X-Goog-FieldMask': opts.fieldMask, ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (json as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
      return { ok: false, offline: false, httpStatus: res.status, json, message: msg };
    }
    return { ok: true, offline: false, httpStatus: res.status, json };
  } catch (e) {
    return { ok: false, offline: true, httpStatus: null, json: null, message: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
