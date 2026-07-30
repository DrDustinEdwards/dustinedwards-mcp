/**
 * The client measurement probe.
 *
 * This exists because the wrapper's era targeting and client-leg auth are
 * decided by MEASUREMENT, not by reading announcements. The MCP 2026-07-28
 * revision shipped final 2026-07-28 and removed the initialize handshake, but a
 * server that speaks only the new era is unreachable from a client that still
 * opens with the old one, and the spec's own compatibility matrix says legacy
 * clients have no fall-forward. So the only way to know what to build is to ask
 * the real client what it sends.
 *
 * It is also the instrument that answers the legacy shim's REMOVAL CONDITION.
 * The shim goes when this probe shows the target clients opening with
 * `server/discover`, and not before. Keep it.
 *
 * Measured with the local twin of this file on 2026-07-29:
 *   Claude Code 2.1.203 opens `initialize` at protocolVersion 2025-11-25, sends
 *   notifications/initialized, sends no Mcp-Method or Mcp-Name, and opens a
 *   GET SSE stream. Every one of those was removed or made required in
 *   2026-07-28. It also walks RFC 9728 correctly: 401 -> protected resource
 *   metadata -> authorization server metadata.
 *
 * Two phases, because one connector add cannot show both:
 *   PHASE open  answer everything, capture the protocol opening and the era
 *   PHASE auth  401 every /mcp POST, capture the OAuth 2.1 RS discovery walk,
 *               including whether the client sends an RFC 8707 `resource`
 *               parameter and whether it registers via DCR or CIMD
 *
 * Nothing here is part of the wrapper's tool surface and nothing here talks to
 * the operator API. It answers a single no-op tool so a client will complete a
 * connection and reveal its shape.
 */

export interface ProbeEnv {
  PROBE_KV: KVNamespace;
}

// Advertised newest first. A client that picks from this list tells us what it
// is willing to speak, which is a different and more useful fact than what it
// opens with.
const SUPPORTED = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];

const PHASE_KEY = "probe:phase";
const SEQ_KEY = "probe:seq";

type Phase = "open" | "auth";

const NOOP_TOOL = {
  name: "probe_noop",
  title: "Measurement probe",
  description:
    "A no-op that exists so a client will complete a connection. This server " +
    "is a protocol measurement instrument, not the operator wrapper.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // A measurement endpoint is never cached and never indexed.
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      ...headers,
    },
  });
}

/**
 * Records one request. Header capture is deliberately COMPLETE rather than an
 * allowlist: the whole point is to find out what the client sends, and an
 * allowlist can only confirm what was already suspected.
 *
 * Authorization values are recorded as a shape, never a value. A probe that
 * logged bearer tokens would be a probe that leaked them.
 */
async function record(env: ProbeEnv, request: Request, body: unknown, note?: string) {
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
    note: note ?? null,
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    rpcMethod:
      body && typeof body === "object" && "method" in body ? (body as { method?: unknown }).method : null,
    body,
  };

  // Zero padded so a plain key list sorts chronologically.
  await env.PROBE_KV.put(`capture:${String(seq).padStart(5, "0")}`, JSON.stringify(entry), {
    expirationTtl: 60 * 60 * 24 * 14,
  });
}

async function phase(env: ProbeEnv): Promise<Phase> {
  return ((await env.PROBE_KV.get(PHASE_KEY)) as Phase | null) ?? "open";
}

export async function handleProbe(request: Request, env: ProbeEnv, origin: string): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  let body: unknown = null;
  if (request.method === "POST") {
    const raw = await request.text();
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { UNPARSEABLE: raw.slice(0, 500) };
    }
  }

  // NO CONTROL PLANE, DELIBERATELY.
  //
  // An earlier draft exposed /probe/captures, /probe/phase and /probe/reset
  // behind a bearer token. All three are gone, and the token with them, because
  // the capture log and the phase switch are reachable through the Cloudflare
  // API directly:
  //
  //   wrangler kv key list   --namespace-id <id> --prefix capture: --remote
  //   wrangler kv key get    --namespace-id <id> capture:00001    --remote
  //   wrangler kv key put    --namespace-id <id> probe:phase auth --remote
  //
  // That is strictly better than an HTTP control plane: it needs no secret, it
  // adds no public surface to a Worker that is about to be internet reachable,
  // and the capture log describing a client's auth behaviour is not exposed to
  // the internet at all. The probe answers MCP and OAuth discovery. Nothing
  // else.

  // ---- RFC 9728 Protected Resource Metadata -------------------------------
  if (path.startsWith("/.well-known/oauth-protected-resource")) {
    await record(env, request, body, "RFC 9728 protected resource metadata fetched");
    return json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
  }

  // ---- RFC 8414 Authorization Server Metadata -----------------------------
  if (path === "/.well-known/oauth-authorization-server") {
    await record(env, request, body, "RFC 8414 authorization server metadata fetched");
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      // Both advertised, so the client's CHOICE between CIMD and DCR is itself
      // a measurement rather than something we force.
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      client_id_metadata_document_supported: true,
    });
  }

  if (path === "/.well-known/openid-configuration") {
    await record(env, request, body, "OIDC discovery attempted");
    return json({ error: "not_found" }, 404);
  }

  // The authorize redirect is where RFC 8707 `resource` and the client id shape
  // become visible. Stop here deliberately: this is not a real authorization
  // server and must never look like one that succeeded.
  if (path === "/authorize") {
    await record(env, request, body, "AUTHORIZE reached: check query for RFC 8707 resource + client_id");
    return new Response(
      "Measurement probe. This is not a real authorization server, so the flow stops here on purpose. " +
        "The request has been recorded.",
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } },
    );
  }

  if (path === "/register") {
    await record(env, request, body, "DCR registration attempted (RFC 7591)");
    return json(
      {
        client_id: "probe-client",
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: (body as { redirect_uris?: unknown })?.redirect_uris ?? [],
      },
      201,
    );
  }

  if (path === "/token") {
    await record(env, request, body, "token endpoint reached");
    return json({ error: "invalid_grant", probe: true }, 400);
  }

  if (path === "/health") return new Response("ok", { headers: { "cache-control": "no-store" } });

  if (path !== "/mcp") return json({ error: "not_found" }, 404);

  await record(env, request, body);

  // 2026-07-28 removed the GET stream and session deletion entirely. Answering
  // 405 is what a modern-only server is told to do, and a legacy client opening
  // a GET stream and being refused is itself a useful capture.
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  }

  if ((await phase(env)) === "auth" && !request.headers.get("authorization")) {
    return json({ error: "unauthorized" }, 401, {
      "www-authenticate": `Bearer realm="probe", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    });
  }

  const id = (body as { id?: unknown } | null)?.id ?? null;
  const rpc = (body as { method?: string } | null)?.method;
  const ok = (result: unknown) => json({ jsonrpc: "2.0", id, result });

  switch (rpc) {
    // Legacy era opening. Echo the client's own version back so it proceeds and
    // reveals the rest of its behaviour.
    case "initialize": {
      const asked = (body as { params?: { protocolVersion?: string } })?.params?.protocolVersion;
      return ok({
        protocolVersion: asked && SUPPORTED.includes(asked) ? asked : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "dustinedwards-mcp-probe", version: "0.0.0" },
      });
    }

    // 2026-07-28 opening, mandatory for modern servers.
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
          "io.modelcontextprotocol/serverInfo": {
            name: "dustinedwards-mcp-probe",
            version: "0.0.0",
          },
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
