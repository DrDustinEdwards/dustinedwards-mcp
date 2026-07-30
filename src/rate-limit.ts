/**
 * Rate limiting on the wrapper endpoint. Both doors have locks.
 *
 * Protocol-stateless does not mean infrastructure-stateless. MCP 2026-07-28
 * removed conversational state from the protocol; a limiter is infrastructure and
 * is unaffected by that.
 *
 * WHY A DURABLE OBJECT WITH SYNCHRONOUS SQLITE, and this is measured on this
 * account rather than preferred. From the dustinedwards Worker's Ask guards:
 *
 *   - The GA `ratelimit` binding refused 1, then 2, then 9, then 0 of twelve
 *     concurrent requests against a limit of five. Cloudflare documents it as
 *     permissive and eventually consistent. It does not count.
 *   - A Durable Object using async `storage.get` then `storage.put` allowed 8
 *     through a ceiling of 3, because a read and a write spanning `await` inside
 *     a DO is not atomic.
 *   - The SYNCHRONOUS SQLite API inside a DO allowed exactly the configured
 *     number. `sql.exec` has no await, which is the entire point, and it is why
 *     the class is registered as `new_sqlite_classes`.
 *
 * A fixed window still permits up to 2x across a boundary. That is the ordinary
 * property of a fixed window, not a leak, and it is recorded here so nobody
 * "fixes" it by accident.
 *
 * VERIFYING THIS NEEDS A CONCURRENT BURST. A sequential loop straddles the window
 * boundary and produces zero refusals, which reads exactly like a dead limiter.
 * That trap has now been walked into twice in this portfolio.
 */

/** Requests allowed per window, per identity. */
const LIMIT = 30;
/** Window length in seconds. */
const WINDOW_SECONDS = 60;

export class OperatorRateLimit implements DurableObject {
  private readonly sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql;
    // Synchronous, so it cannot interleave with a counter update.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS hits (window_start INTEGER PRIMARY KEY, count INTEGER NOT NULL)",
    );
  }

  async fetch(_request: Request): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % WINDOW_SECONDS);

    // One statement, no await inside the read-modify-write. This is the property
    // the async storage API could not provide.
    const row = this.sql
      .exec<{ count: number }>(
        "INSERT INTO hits (window_start, count) VALUES (?, 1) " +
          "ON CONFLICT(window_start) DO UPDATE SET count = count + 1 " +
          "RETURNING count",
        windowStart,
      )
      .one();

    // Old windows are dead weight; drop them opportunistically.
    this.sql.exec("DELETE FROM hits WHERE window_start < ?", windowStart - WINDOW_SECONDS * 2);

    const count = row.count;
    const allowed = count <= LIMIT;
    const retryAfter = windowStart + WINDOW_SECONDS - now;

    return Response.json(
      { allowed, count, limit: LIMIT, retryAfter },
      { status: allowed ? 200 : 429, headers: allowed ? {} : { "retry-after": String(retryAfter) } },
    );
  }
}

export interface RateLimitEnv {
  OPERATOR_RATE_LIMIT: DurableObjectNamespace;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfter: number;
}

/**
 * Checks the limit for one identity.
 *
 * Fails CLOSED when the binding is absent. An unprotected surface on a write path
 * must not serve, which is the same stance the app takes: removing its Durable
 * Object binding disables Ask rather than un-protecting it.
 */
export async function checkRateLimit(
  env: Partial<RateLimitEnv>,
  identity: string,
): Promise<RateLimitDecision> {
  if (!env.OPERATOR_RATE_LIMIT) return { allowed: false, retryAfter: WINDOW_SECONDS };

  const id = env.OPERATOR_RATE_LIMIT.idFromName(identity);
  const response = await env.OPERATOR_RATE_LIMIT.get(id).fetch("https://rate-limit.invalid/check");
  const body = (await response.json()) as { allowed?: boolean; retryAfter?: number };

  return {
    allowed: body.allowed === true,
    retryAfter: typeof body.retryAfter === "number" ? body.retryAfter : WINDOW_SECONDS,
  };
}
