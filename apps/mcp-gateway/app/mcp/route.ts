import { env } from "cloudflare:workers";
import { handleMcp, limitedText, type GatewayConfig } from "@/lib/gateway-core";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > 16384) return new Response("Request too large", { status: 413 });
  let text: string;
  try { text = await limitedText(request, 16384); } catch { return new Response('Request too large', { status: 413 }); }
  if (text.length > 16384) return new Response("Request too large", { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 }); }
  const authenticated = request.headers.get("oai-authenticated-user-email") ? request.headers.get("oai-authenticated-user-id") : null;
  const result = await handleMcp(body, authenticated, env as GatewayConfig);
  return result.http === 204 ? new Response(null, { status: 204 }) : Response.json(result.body, { status: result.http, headers: { "Cache-Control": "no-store" } });
}
export function GET() { return new Response("Use POST /mcp", { status: 405, headers: { Allow: "POST" } }); }
