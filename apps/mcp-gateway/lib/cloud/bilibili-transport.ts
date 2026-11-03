// Deliberately excludes URLs with queries, response messages, bodies, account IDs,
// Cookie/Set-Cookie and request header values from every returned diagnostic.
export type BiliDiagnostic = {
  path: string; signed: boolean; http_status: number | null; business_code: number | null;
  body_kind: 'json' | 'html' | 'other' | 'oversize' | 'transport_error';
  risk_page: boolean; retry_after_seconds: number | null; server_clock_delta_seconds: number | null;
  elapsed_ms: number;
};
export async function inspectBiliResponse(response: Response, path: string, signed: boolean, elapsed: number): Promise<BiliDiagnostic> {
  const diagnostic: BiliDiagnostic = { path, signed, http_status: response.status, business_code: null, body_kind: 'other', risk_page: false, retry_after_seconds: null, server_clock_delta_seconds: null, elapsed_ms: elapsed };
  const retry = response.headers.get('retry-after');
  if (retry && /^\d{1,6}$/.test(retry)) diagnostic.retry_after_seconds = Number(retry);
  const date = Date.parse(response.headers.get('date') ?? '');
  if (Number.isFinite(date)) diagnostic.server_clock_delta_seconds = Math.round((date - Date.now()) / 1000);
  const copy = response.clone(); const reader = copy.body?.getReader();
  if (!reader) return diagnostic;
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 1048576) { void reader.cancel(); diagnostic.body_kind = 'oversize'; return diagnostic; }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = new TextDecoder().decode(bytes);
    try { const json = JSON.parse(body); diagnostic.body_kind = 'json'; if (typeof json?.code === 'number' && Number.isSafeInteger(json.code)) diagnostic.business_code = json.code; }
    catch { diagnostic.body_kind = /<(!doctype|html)[\s>]/i.test(body) ? 'html' : 'other'; diagnostic.risk_page = /风控|风险|请求被拦截|安全验证|risk.control|访问权限不足/i.test(body); }
  } catch { /* Preserve status even when a response body cannot be read. */ }
  return diagnostic;
}
export function biliObservedFetch(fetcher: typeof fetch, observe: (diagnostic: BiliDiagnostic) => void, standardHeaders = false): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // The adapter uses only these first-party API paths; never export an arbitrary URL.
    const path = url.hostname === 'api.bilibili.com' && /^\/x\/[a-z0-9_/-]+$/i.test(url.pathname) ? url.pathname : 'other';
    const signed = url.searchParams.has('w_rid') && url.searchParams.has('wts'); const started = Date.now();
    const headers = new Headers(init?.headers);
    if (standardHeaders) { headers.set('Accept', 'application/json, text/plain, */*'); headers.set('Accept-Language', 'zh-CN,zh;q=0.9'); }
    try {
      const response = await fetcher(input, { ...init, headers });
      observe(await inspectBiliResponse(response, path, signed, Date.now() - started));
      return response;
    } catch (error) { observe({ path, signed, http_status: null, business_code: null, body_kind: 'transport_error', risk_page: false, retry_after_seconds: null, server_clock_delta_seconds: null, elapsed_ms: Date.now() - started }); throw error; }
  };
}
