/**
 * Test-only entry point for `npm run check:conformance`. NEVER DEPLOYED: the
 * deploy target is src/index.ts, set as `main` in wrangler.jsonc, and this file
 * is reached only by passing it positionally to `wrangler dev`.
 *
 * WHY IT EXISTS. The real /mcp sits behind the OAuth 2.1 resource server, and the
 * official conformance suite has no way to complete a consent flow. Pointing the
 * suite at the probe instead would prove nothing, because the probe is not the
 * server. So this entry mounts the REAL protocol layer and the REAL five tools,
 * with only the client-leg auth and the rate limiter removed, and the API leg
 * aimed at a local stub. What gets certified is the code that ships.
 *
 * It is NOT a backdoor. It is not `main`, it is not deployed, and it only ever
 * runs inside `wrangler dev` on a loopback port for the duration of the gate.
 * check:wrapper asserts that `main` is src/index.ts, so pointing the deploy at
 * this file would fail a gate.
 */

import { handleMcp } from "../src/mcp-handler";
import type { ApiEnv } from "../src/api-client";

// wrangler.jsonc declares the Durable Object binding, so any entry it runs has to
// export the class or the dev server refuses to start.
export { OperatorRateLimit } from "../src/rate-limit";

export default {
  async fetch(request: Request, env: Partial<ApiEnv>, ctx: ExecutionContext): Promise<Response> {
    return handleMcp(request, env, ctx);
  },
} satisfies ExportedHandler<Partial<ApiEnv>>;
