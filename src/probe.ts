/**
 * The client measurement probe. THE INSTRUMENT, not a feature.
 *
 * Its one remaining job is to answer the removal condition in src/legacy-era.ts:
 * do the target clients still open with `initialize`, or have they moved to
 * `server/discover`? The shim is deleted on a capture from this endpoint, never on
 * a release note.
 *
 * Mounted at /probe/mcp, OUTSIDE the OAuth provider. That is deliberate: it exists
 * to observe how an unauthenticated client behaves, so putting it behind
 * authentication would defeat it. It answers one no-op tool and has no route to
 * the operator API, so there is nothing here to protect.
 *
 * SCOPE NARROWED 2026-07-30. An earlier version also served RFC 9728 and RFC 8414
 * metadata at the root to capture the OAuth 2.1 discovery walk. Those routes now
 * belong to the real authorization server, and the walk has been measured and
 * recorded in the README, so the probe no longer serves them.
 *
 * MEASUREMENTS SO FAR
 *   Claude Code 2.1.203   2026-07-29   LEGACY: initialize, 2025-11-25, no
 *                                      Mcp-Method or Mcp-Name, opens a GET stream
 *   claude.ai (Anthropic) 2026-07-30   LEGACY: initialize, 2025-11-25, no
 *                                      Mcp-Method or Mcp-Name, no _meta version
 *   Grok Build 1.0.13     2026-09-07   LEGACY, and blocked before initialize:
 *                                      opens GET /mcp declaring
 *                                      mcp-protocol-version: 2024-11-05, then its
 *                                      rmcp auth middleware found the origin's AS
 *                                      metadata (path-scoped PRM first), saw no
 *                                      registration_endpoint, and quit; it does
 *                                      RFC 7591 DCR, not CIMD. No POST was ever
 *                                      sent. Discovery walk read from the Worker
 *                                      logs, since it hit the real AS routes.
 *
 * Read captures with `node scripts/probe-report.mjs`, which goes through the
 * Cloudflare API. There is no HTTP control plane on purpose: a log describing a
 * client's behaviour should not be internet reachable, and this way there is no
 * probe credential to exist or leak.
 */

export interface ProbeEnv {
  PROBE_KV: KVNamespace;
}

/** Advertised newest first. What a client PICKS from this is itself a finding. */
const SUPPORTED = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];

const SEQ_KEY = "probe:seq";

const NOOP_TOOL = {
  name: "probe_noop",
  title: "Measurement probe",
  description:
    "A no-op that exists so a client will complete a connection and reveal its " +
    "protocol shape. This endpoint is a measurement instrument, not the operator " +
    "wrapper, and it can change nothing.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      ...headers,
    },
  });
}

/**
 * Records one request.
 *
 * Header capture is COMPLETE rather than an allowlist, because the point is to
 * discover what a client sends and an allowlist can only confirm what was already
 * suspected. Authorization values are recorded as a shape and never a value: a
 * probe that logged bearer tokens would be a probe that leaked them.
 */
async function record(env: ProbeEnv, request: Request, body: unknown): Promise<void> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  for (const [k, v] of request.headers) {
    headers[k] = k.toLowerCase() === "authorization" ? `<${v.split(" ")[0] ?? "opaque"} redacted>` : v;
  }

  const seq = Number((await env.PROBE_KV.get(SEQ_KEY)) ?? "0") + 1;
  await env.PROBE_KV.put(SEQ_KEY, String(seq));

  const entry = {
    seq,
    at: new Date().toISOString(),
    method: request.method,
    // Recorded without the /probe prefix so a capture reads like the real
    // endpoint's traffic, which is what it is standing in for.
    path: url.pathname.replace(/^\/probe/, "") || "/",
    query: Object.fromEntries(url.searchParams),
    headers,
    rpcMethod:
      body && typeof body === "object" && "method" in body ? (body as { method?: unknown }).method : null,
    body,
  };

  // Zero padded so a plain key list sorts chronologically. Two week TTL: a
  // measurement older than that should be re-taken, not read.
  await env.PROBE_KV.put(`capture:${String(seq).padStart(5, "0")}`, JSON.stringify(entry), {
    expirationTtl: 60 * 60 * 24 * 14,
  });
}

export async function handleProbe(request: Request, env: ProbeEnv, _origin: string): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/^\/probe/, "") || "/";

  if (path === "/health") return new Response("ok", { headers: { "cache-control": "no-store" } });
  if (path !== "/mcp") return json({ error: "not_found" }, 404);

  let body: unknown = null;
  if (request.method === "POST") {
    const raw = await request.text();
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { UNPARSEABLE: raw.slice(0, 500) };
    }
  }

  await record(env, request, body);

  // 2026-07-28 removed the GET stream and session deletion. A legacy client
  // opening a GET stream and being refused is itself a useful capture.
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });

  const id = (body as { id?: unknown } | null)?.id ?? null;
  const rpc = (body as { method?: string } | null)?.method;
  const ok = (result: unknown) => json({ jsonrpc: "2.0", id, result });

  switch (rpc) {
    // Legacy opening. Echo the client's own version so it proceeds and reveals
    // the rest of its behaviour rather than stopping at a negotiation failure.
    case "initialize": {
      const asked = (body as { params?: { protocolVersion?: string } })?.params?.protocolVersion;
      return ok({
        protocolVersion: asked && SUPPORTED.includes(asked) ? asked : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "dustinedwards-mcp-probe", version: "0.0.0" },
      });
    }

    // 2026-07-28 opening, mandatory for modern servers. A capture here is the
    // event that retires src/legacy-era.ts.
    case "server/discover":
      return ok({
        resultType: "complete",
        supportedVersions: SUPPORTED,
        capabilities: { tools: {} },
        ttlMs: 60_000,
        // Measured against the official conformance suite: cacheScope must be
        // "public" or "private". "session" fails SEP-2549.
        cacheScope: "private",
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: "dustinedwards-mcp-probe", version: "0.0.0" },
        },
      });

    case "tools/list":
      return ok({ resultType: "complete", tools: [NOOP_TOOL], ttlMs: 60_000, cacheScope: "private" });

    case "tools/call":
      return ok({
        resultType: "complete",
        content: [{ type: "text", text: "Measurement probe. Nothing was done." }],
      });

    case "ping":
      return ok({});

    default:
      if (typeof rpc === "string" && rpc.startsWith("notifications/")) {
        return new Response(null, { status: 202 });
      }
      return json(
        { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(rpc)}` } },
        404,
      );
  }
}
