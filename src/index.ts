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
 *   /token /.well-known/*  served by the OAuth library
 *   /probe/*               the client measurement instrument, probe.ts
 *   /health                liveness
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";

import { isAdminUser, type Props } from "./auth";
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

const provider = new OAuthProvider({
  apiRoute: MCP_ROUTE,
  apiHandler,
  defaultHandler: defaultHandler as unknown as ExportedHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  // NO clientRegistrationEndpoint. Measured 2026-07-30: claude.ai sends its
  // client_id as the URL https://claude.ai/oauth/mcp-oauth-client-metadata and
  // never calls a registration endpoint, and MCP 2026-07-28 deprecates RFC 7591
  // in favour of CIMD. Building one would serve no measured client.
  clientIdMetadataDocumentEnabled: true,
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

    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
