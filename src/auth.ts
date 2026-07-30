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
