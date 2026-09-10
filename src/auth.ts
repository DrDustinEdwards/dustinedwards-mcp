/**
 * CLIENT LEG identity helpers: who is operating.
 *
 * Distinct from the API leg in src/api-client.ts, which is what this Worker may
 * do. Keeping them in separate files is deliberate, because conflating them is
 * the mistake the house standard names explicitly: a client-leg identity failure
 * and an API refusal mean different things and must read differently.
 *
 * Free of MCP and OAuth imports so the grant logic is testable on its own.
 */

/** The GitHub identity carried on an OAuth grant, set at consent time. */
export interface Props extends Record<string, unknown> {
  id: number;
  login: string;
  name: string | null;
}

/**
 * Is this grant the single administrator's?
 *
 * `ADMIN_GITHUB_LOGIN` accepts either a login or an immutable numeric GitHub user
 * id. The numeric form is the safer configuration, because a login can be
 * renamed and then claimed by somebody else, while an id cannot. Both are
 * supported so the setting is easy to write correctly.
 *
 * Fails CLOSED: an unset or blank value admits nobody. A single-admin server
 * whose admin is unconfigured must refuse everyone rather than admit anyone.
 */
export function isAdminUser(
  env: { ADMIN_GITHUB_LOGIN?: string },
  user: { id: number | string; login: string },
): boolean {
  const admin = (env.ADMIN_GITHUB_LOGIN ?? "").trim();
  if (!admin) return false;
  if (/^\d+$/.test(admin)) return String(user.id) === admin;
  return user.login.toLowerCase() === admin.toLowerCase();
}

/**
 * Constant-time comparison of two secrets, with both sides hashed to a fixed 32
 * bytes FIRST.
 *
 * Hashing before comparing is the part that matters and it is easy to get wrong.
 * Comparing the raw strings leaks their LENGTH through the loop bound even when
 * the comparison itself is constant time, so an attacker learns how long the
 * secret is. Hashing both operands to a fixed width removes that channel: every
 * comparison is over exactly 32 bytes regardless of the inputs.
 *
 * This mirrors what the app's own operator endpoint does, by the same reasoning.
 */
export async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * The prefix that makes a secret an agent key. Ruling 37.
 *
 * ONE SECRET PER AGENT, and the agent's NAME is the part after this prefix.
 * `AGENT_KEY_GROK` is the key for the principal `grok`. That is what makes the
 * principal impossible to spoof: it is not carried in the request, it is a
 * property of WHICH configured secret the presented key matched, so a caller
 * can prove it holds a key and can never choose what it is called.
 *
 * A single secret holding a JSON map was the alternative and is worse in the
 * way that matters: rotating one agent would rewrite every agent's key, and one
 * malformed edit would take all of them out at once.
 */
export const AGENT_KEY_PREFIX = "AGENT_KEY_";

/**
 * Which agent, if any, presented this Authorization header.
 *
 * ## WHY THIS PATH EXISTS AT ALL. Ruling 37, 2026-09-07.
 *
 * Measured across four conditions: Grok Build 1.0.13 POSTs /mcp, receives a
 * well-formed 401 naming a path-scoped PRM that answers 200, and then walks
 * nothing. No discovery, no /register, no /authorize. The defect is the
 * client's and a bug report went upstream, but an agent that cannot complete
 * OAuth cannot reach this server at all, and waiting on somebody else's release
 * is not a plan.
 *
 * ## WHAT IT DOES NOT WIDEN
 *
 * NOT ADMIN, EVER, and that needs no enforcement here because this Worker has
 * no admin rights to hand out. Every tool call leaves as one authenticated
 * request to the operator API carrying `OPERATOR_TOKEN`, and the API grants
 * that token `{ kind: "operator" }`. First publication is refused there, by
 * `firstPublish: false` on that actor kind. So an agent key buys exactly what
 * the OAuth path buys and nothing more: it changes WHO MAY ASK, never what the
 * answer is. This wrapper still contains no policy.
 *
 * ## FAILS CLOSED IN EVERY DIRECTION
 *
 * No configured keys admits nobody. A blank or whitespace-only key is skipped
 * rather than matched, so a secret set to the empty string cannot become a
 * master key. A malformed header returns null. Every candidate goes through
 * `secretsMatch`, which hashes both sides to a fixed 32 bytes first.
 *
 * EVERY KEY IS COMPARED, with no early exit on a match, so the time taken does
 * not depend on which key matched or how far down the list it sat.
 *
 * @param env the Worker environment, read for `AGENT_KEY_*` secrets
 * @param authorization the raw Authorization header, or null
 * @returns the agent principal in lower case, or null
 */
export async function agentPrincipal(
  env: Record<string, unknown>,
  authorization: string | null,
): Promise<string | null> {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return null;
  const presented = match[1]!.trim();
  if (!presented) return null;

  let found: string | null = null;
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(AGENT_KEY_PREFIX)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    // No early exit: see the constant-time note above.
    if (await secretsMatch(presented, value)) {
      found = name.slice(AGENT_KEY_PREFIX.length).toLowerCase();
    }
  }
  return found;
}
