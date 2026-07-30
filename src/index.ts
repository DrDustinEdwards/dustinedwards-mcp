/**
 * dustinedwards-mcp: the operator MCP wrapper.
 *
 * THE LAW (capsid/mcp-wrapper-standard.md, ratified 2026-07-30). This Worker
 * contains NO policy, NO gates, and NO second write path. Every tool call
 * becomes an authenticated HTTP request to POST /api/operator on the
 * dustinedwards Worker, where all rules live. If this Worker vanished, nothing
 * about what is allowed would change.
 *
 * It is a SEPARATE Worker in its own repo for a structural reason, not a
 * stylistic one: the only path from here to the publish machinery IS the API.
 * Mounted as a route on the app Worker, the cheap path would be an in-process
 * call that silently skips operator authentication and the rate limiter. Here,
 * that call is not merely discouraged, it is unreachable.
 *
 * STATUS: measurement stage. The wrapper's tool surface is not built yet,
 * because the era it targets and the shape of its client-leg auth are decided
 * by measuring a real client rather than by reading release notes. Until that
 * measurement is in, this Worker is only the probe. See src/probe.ts.
 */

import { handleProbe, type ProbeEnv } from "./probe";

export interface Env extends ProbeEnv {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = new URL(request.url).origin;
    return handleProbe(request, env, origin);
  },
} satisfies ExportedHandler<Env>;
