/**
 * The API LEG: wrapper to app.
 *
 * This is the ONLY way this Worker reaches the publish machinery, and that is
 * the whole architecture in one file. Every tool call becomes one authenticated
 * HTTP POST to /api/operator on the dustinedwards Worker, where the zod
 * frontmatter gate, the wide-dash check, the first-publish policy, the atomic
 * Git Data commit, the D1 sync and the AI index sync all live.
 *
 * Nothing here interprets a rule. It does not know what the first-publish policy
 * is, it cannot tell a policy refusal from a validation failure except by
 * reading what the API said, and it must never learn. If this file started
 * deciding things, there would be two copies of the rules and they would drift,
 * which is the failure the wrapper pattern exists to prevent.
 *
 * The credential here identifies WHAT this Worker may do. It is deliberately a
 * different value from the client-leg credential, which identifies WHO is
 * operating. A failure of one must read differently from a refusal by the other.
 */

export interface ApiEnv {
  /** The operator API endpoint, e.g. https://dustinedwards.../api/operator */
  OPERATOR_API_URL: string;
  /** The API leg bearer. Never the client-leg credential. */
  OPERATOR_TOKEN: string;
}

/**
 * What the operator API returns. This is the CONTRACT between the two Workers,
 * and it is a documented payload shape rather than shared code: this repo
 * imports nothing from the app, so the only thing that can couple them is this
 * interface, which we validate at the edge like the outside caller we are.
 */
export type ApiResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string; detail?: unknown };

export interface ApiCallResult {
  /** HTTP status the API returned. 200 means the tool succeeded. */
  status: number;
  /** True only when the API said ok AND the response parsed as expected. */
  ok: boolean;
  /** On success, the API's data. On failure, undefined. */
  data?: unknown;
  /**
   * On failure, the API's refusal prose VERBATIM. Never summarized, wrapped, or
   * softened: an agent that receives "invalid frontmatter" and nothing else
   * cannot fix its own mistake, and the API deliberately names the field and the
   * line. Rewriting this text would discard the most useful thing it sends.
   */
  error?: string;
  /** On failure, the API's structured detail (policy name, field, line, conflict). */
  detail?: unknown;
}

export class ApiLegError extends Error {
  constructor(
    message: string,
    readonly kind: "unconfigured" | "unreachable" | "malformed",
  ) {
    super(message);
    this.name = "ApiLegError";
  }
}

function assertConfigured(env: Partial<ApiEnv>): asserts env is ApiEnv {
  if (!env.OPERATOR_API_URL) {
    throw new ApiLegError(
      "The wrapper is not configured: OPERATOR_API_URL is unset. Not configured means not open.",
      "unconfigured",
    );
  }
  // The app refuses its own endpoint below 32 characters, so a token that short
  // could never work and is worth catching here rather than after a round trip.
  if (!env.OPERATOR_TOKEN || env.OPERATOR_TOKEN.length < 32) {
    throw new ApiLegError(
      "The wrapper is not configured: OPERATOR_TOKEN is unset or too short. Not configured means not open.",
      "unconfigured",
    );
  }
}

/**
 * Calls one operator tool.
 *
 * The request shape is `{ tool, args }` because that is what the API already
 * takes. It was chosen on 2026-07-28 specifically so an MCP front end could be
 * layered over it with no reshaping, since `tools/call` carries exactly a name
 * and an argument object. This function is the proof that the prediction held:
 * it is a transport, not a translator.
 */
export async function callOperator(
  env: Partial<ApiEnv>,
  tool: string,
  args: Record<string, unknown>,
): Promise<ApiCallResult> {
  assertConfigured(env);

  let response: Response;
  try {
    response = await fetch(env.OPERATOR_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPERATOR_TOKEN}`,
        // Identifies the caller in the app's logs without revealing anything.
        "user-agent": "dustinedwards-mcp/0.1 (operator MCP wrapper)",
      },
      body: JSON.stringify({ tool, args }),
    });
  } catch (cause) {
    throw new ApiLegError(
      `The operator API could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      "unreachable",
    );
  }

  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new ApiLegError(
      `The operator API returned status ${response.status} with a body that is not JSON.`,
      "malformed",
    );
  }

  // Edge validation. We are an outside caller and treat the payload as untrusted
  // shape, but we do NOT second-guess its meaning.
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { ok?: unknown }).ok !== "boolean") {
    throw new ApiLegError(
      `The operator API returned status ${response.status} with an unrecognized payload shape.`,
      "malformed",
    );
  }

  const body = parsed as ApiResponse;

  if (body.ok) {
    return { status: response.status, ok: true, data: (body as { data: unknown }).data };
  }

  return {
    status: response.status,
    ok: false,
    error: typeof body.error === "string" ? body.error : `The operator API refused with status ${response.status}.`,
    detail: body.detail,
  };
}
