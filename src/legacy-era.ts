/**
 * THE PRIOR-ERA SHIM. One module, one call site, deletable as a unit.
 *
 * ============================================================================
 * REMOVAL CONDITION
 * ============================================================================
 * Delete this file and its single call site in src/mcp-handler.ts when
 * `node scripts/probe-report.mjs` shows the target clients opening with
 * `server/discover` instead of `initialize`.
 *
 * Targets and their last measurement:
 *   Claude Code 2.1.203   2026-07-29   LEGACY (initialize, 2025-11-25)
 *   claude.ai (Anthropic) 2026-07-30   LEGACY (initialize, 2025-11-25)
 *
 * Do NOT delete it on the strength of a release note, a changelog, or an
 * announcement that a client "supports" the new revision. Re-run the probe and
 * delete it on the capture. The probe exists for this.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * MCP 2026-07-28 removed the `initialize` handshake, sessions, the GET stream and
 * server-initiated requests. The house standard makes that revision the primary
 * and design-center era, so the real handler is built `legacy: 'reject'`:
 * stateless-native, modern-only, no compatibility thinking in it.
 *
 * But the spec's own compatibility matrix says a legacy client against a modern
 * server FAILS, and that legacy clients have no fall-forward mechanism. Both
 * measured target clients are legacy. A modern-only wrapper would therefore be
 * unreachable from the two clients it exists to serve. The shim is load-bearing
 * TODAY, not a courtesy to stragglers.
 *
 * WHY IT IS SHAPED THIS WAY.
 *
 * `createMcpHandler` defaults to `legacy: 'stateless'`, which would serve both
 * eras from one handler and cost nothing to write. It is deliberately NOT used,
 * because then the compatibility path would live inside the library behind a
 * flag, and "delete the shim" would mean "flip a vendor option and hope nothing
 * else changes". The library documents the alternative on `isLegacyRequest`:
 * route in user land, in front of a `legacy: 'reject'` handler. That makes the
 * seam real. Deleting this file leaves a modern-only server, provably, because
 * the modern handler was never in compatibility mode to begin with.
 *
 * The cost of the choice is honest: two handler instances over the same factory
 * rather than one. Both are stateless, so neither holds conversational state and
 * an isolate can serve any request with either.
 */

import { isLegacyRequest } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

import type { StatelessMcpHandler } from "agents/mcp/server";

/** The single predicate this module exports for the routing decision. */
export { isLegacyRequest };

/**
 * Builds the prior-era handler.
 *
 * `legacy: 'stateless'` here means each legacy request is answered by a fresh
 * server instance from the same factory, and 2025-era session operations (GET
 * and DELETE on the endpoint) are answered 405. That is the correct behaviour
 * for a stateless deployment and it matches what the modern handler does with
 * those verbs anyway, so the two eras agree on everything except the opening.
 */
export function createLegacyEraHandler(
  factory: Parameters<typeof createMcpHandler>[0],
  route: string,
): StatelessMcpHandler {
  return createMcpHandler(factory, { route, legacy: "stateless" });
}
