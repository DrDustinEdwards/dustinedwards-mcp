/**
 * dustinedwards-mcp: the operator MCP wrapper.
 *
 * THE LAW (Capsid capsid/mcp-wrapper-standard.md, ratified 2026-07-30). This
 * Worker contains NO policy, NO gates, and NO second write path. Every tool call
 * becomes an authenticated HTTP request to POST /api/operator on the
 * dustinedwards Worker, where all rules live. If this Worker vanished, nothing
 * about what is allowed would change.
 *
 * It is a SEPARATE Worker in its own repo for a structural reason, not a
 * stylistic one: the only path from here to the publish machinery IS the API.
 * Mounted as a route on the app Worker, the cheap path would be an in-process
 * call that silently skips operator authentication and the rate limiter. Here
 * that call is not merely discouraged, it is unreachable.
 *
 * Request routing, outermost first:
 *
 *   /mcp                   OAuthProvider validates a client-leg access token,
 *                          then apiHandler re-checks the admin grant, rate
 *                          limits, and hands off to the era router
 *   /authorize /callback   the consent flow, github-handler.ts
 *   /token /register       served by the OAuth library
 *   /.well-known/*         ditto
 *   /probe/*               the client measurement instrument, probe.ts
 *   /health                liveness
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";

import { agentPrincipal, isAdminUser, type Props } from "./auth";
import { defaultHandler, type GitHubEnv } from "./github-handler";
import { handleMcp, MCP_ROUTE } from "./mcp-handler";
import { handleProbe, type ProbeEnv } from "./probe";
import { checkRateLimit, type RateLimitEnv } from "./rate-limit";
import type { ApiEnv } from "./api-client";

export { OperatorRateLimit } from "./rate-limit";

export interface Env extends Partial<ApiEnv>, Partial<RateLimitEnv>, ProbeEnv, GitHubEnv {
  OAUTH_KV: KVNamespace;
}

const noStore = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      // Never indexed. An authenticated operator surface is not a public
      // affordance, and it is absent from llms.txt and the sitemap for the same
      // reason.
      "x-robots-tag": "noindex, nofollow",
    },
  });

/**
 * The authenticated MCP surface.
 *
 * The OAuth library has already validated the access token by the time this runs.
 * The admin check runs AGAIN here as defence in depth: a grant is long lived, and
 * this is the boundary a request actually crosses, so re-checking costs one
 * comparison and removes a class of bug where a grant outlives its authority.
 */
const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: Props }).props;

    if (!props || !isAdminUser(env, props)) {
      return noStore(
        "Forbidden. This is a single-operator server and this grant does not belong to its administrator.",
        403,
      );
    }

    // Both doors have locks. Keyed by the operator's stable GitHub id rather than
    // by IP, because the identity is known here and it is the thing worth
    // limiting. Fails closed if the binding is missing.
    const limit = await checkRateLimit(env, `operator:${props.id}`);
    if (!limit.allowed) {
      return new Response(
        "Rate limited. This wrapper allows 30 requests per 60 seconds. The operator API applies its own " +
          "limit independently of this one.",
        {
          status: 429,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "retry-after": String(limit.retryAfter),
          },
        },
      );
    }

    return handleMcp(request, env, ctx);
  },
};

/**
 * The agent-key surface: the same rate limit and the same handler, a different
 * door. Ruling 37.
 *
 * IT SHARES `handleMcp` WITH THE OAUTH PATH ON PURPOSE. Two handlers would be
 * two places for the tool surface to be defined, and the first time they
 * disagreed one door would offer something the other did not. There is one
 * MCP server here and two ways to be let in front of it.
 *
 * THE AUDIT LINE IS THE PRINCIPAL, and it is the only place the agent's name
 * appears. Worth stating plainly, because it is a real limit rather than an
 * oversight: the operator API downstream sees `OPERATOR_TOKEN` and records
 * `tokenLabel(token)`, which is the same eight hex characters for every agent
 * and for the human operator. So this log is where "grok did that" is written
 * down, and the site's own audit still says only "the operator did".
 * Distinguishing them THERE would mean the API accepting a caller-supplied
 * principal, which is a change to an auth surface and a decision for the seat.
 *
 * The line carries no key, no key length and no header, only the principal that
 * a comparison against a configured secret produced.
 */
async function agentHandler(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  principal: string,
): Promise<Response> {
  console.log(
    JSON.stringify({
      audit: "agent-key-accepted",
      principal,
      // Present so a reader can tell a tools/call from a handshake without the
      // body. Never the Authorization header, and never any part of the key.
      method: request.method,
      rights: "operator",
    }),
  );

  /*
   * KEYED BY THE PRINCIPAL, not by IP and not shared with the operator. The
   * OAuth path limits `operator:<github id>`; an agent gets its own bucket, so
   * one agent exhausting its allowance cannot rate limit Dustin out of his own
   * server, and vice versa. Fails closed when the binding is missing, exactly
   * as the other door does.
   */
  const limit = await checkRateLimit(env, `agent:${principal}`);
  if (!limit.allowed) {
    return new Response(
      "Rate limited. This wrapper allows 30 requests per 60 seconds. The operator API applies its own " +
        "limit independently of this one.",
      {
        status: 429,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": String(limit.retryAfter),
        },
      },
    );
  }

  return handleMcp(request, env, ctx);
}

const provider = new OAuthProvider({
  apiRoute: MCP_ROUTE,
  apiHandler,
  defaultHandler: defaultHandler as unknown as ExportedHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  // BOTH client identity paths, each on its own measurement:
  //
  // CIMD. Measured 2026-07-30: claude.ai sends its client_id as the URL
  // https://claude.ai/oauth/mcp-oauth-client-metadata and never calls a
  // registration endpoint. MCP 2026-07-28 deprecates RFC 7591 in favour of CIMD,
  // so this stays the design-center path.
  //
  // DCR. Measured 2026-09-07: Grok Build 1.0.13's rmcp client cannot do CIMD and
  // requires RFC 7591 dynamic registration. With no registration_endpoint in the
  // AS metadata it stopped at "OAuth authorization required" without ever
  // building an authorization URL, so no browser opened. The earlier note here
  // ("building one would serve no measured client") was true on 2026-07-30 and
  // is superseded by that capture.
  //
  // Registration only mints a client identity. A registered client still gets a
  // grant solely through the GitHub consent flow, and isAdminUser admits exactly
  // the configured administrator, so DCR widens who may ASK, never who is let in.
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/register",
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // The measurement instrument sits OUTSIDE the OAuth provider deliberately.
    // It exists to observe unauthenticated client behaviour, so putting it behind
    // authentication would defeat it. It exposes one no-op tool and has no route
    // to the operator API.
    if (url.pathname.startsWith("/probe")) {
      return handleProbe(request, env, url.origin);
    }

    /*
     * THE AGENT KEY PATH. Ruling 37.
     *
     * BEFORE the provider, because the provider owns `/mcp` and answers 401 to
     * anything carrying a token it did not mint. An agent key is not one of
     * those, so it is recognised here or not at all.
     *
     * IT IS TRIED, NEVER REQUIRED. `agentPrincipal` returns null for a missing
     * header, a malformed one, a key matching nothing, and for a Worker with no
     * `AGENT_KEY_*` secret configured at all. Every one of those falls through
     * to the provider, which answers exactly as it did before. So this Worker's
     * behaviour with no agent secret set is unchanged, and that is the state it
     * deploys in.
     *
     * SCOPED TO `/mcp`. The consent flow, the token endpoint, `/register` and
     * the metadata documents stay the provider's business: an agent key is an
     * alternative to HOLDING a grant, not to the protocol around one.
     */
    if (url.pathname === MCP_ROUTE) {
      const principal = await agentPrincipal(
        env as unknown as Record<string, unknown>,
        request.headers.get("authorization"),
      );
      if (principal) return agentHandler(request, env, ctx, principal);
    }

    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
