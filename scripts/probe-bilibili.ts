// Only stdin contains credentials. Never print fetch exceptions or raw bodies.
import { runBilibiliProbe, biliProbeSchema } from '../apps/mcp-gateway/lib/cloud/bilibili-diagnostics.ts';
async function main() {
  let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 24000) throw new Error(); }
  const setup = JSON.parse(text); text = '';
  const input = biliProbeSchema.parse({ group: setup.group, salt: setup.salt });
  if (setup.mode === 'local') {
    if (typeof setup.BILIBILI_COOKIE !== 'string') throw new Error();
    console.log(JSON.stringify({ runtime: 'local_node', ...await runBilibiliProbe(setup.BILIBILI_COOKIE, input) }));
  } else if (setup.mode === 'cloud') {
    const url = new URL(setup.endpoint);
    if (url.origin !== 'https://your-site.example.invalid') throw new Error();
    const response = await fetch(new URL('/api/diagnostics/bilibili', url), { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${setup.ingest_token}`, 'OAI-Sites-Authorization': `Bearer ${setup.sites_token}` }, body: JSON.stringify(input), signal: AbortSignal.timeout(45000) });
    if (!response.headers.get('content-type')?.includes('application/json')) { console.log(JSON.stringify({ runtime: 'sites_dispatch_or_transport', http_status: response.status, diagnostic_response: false })); return; }
    const data = await response.json();
    console.log(JSON.stringify({ site_http_status: response.status, ...data }));
  } else throw new Error();
}
main().catch(() => { console.log(JSON.stringify({ code: 'PROBE_FAILED' })); process.exitCode = 1; });
