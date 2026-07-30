/**
 * The consent step: upstream GitHub login.
 *
 * `@cloudflare/workers-oauth-provider` makes this Worker an OAuth 2.1
 * authorization server for MCP clients. It does not know WHO the human is, so
 * this handler answers that by sending them to GitHub and checking the returning
 * account against the single configured administrator.
 *
 * GitHub rather than Google, per the capsid MCP precedent: it keeps the wrapper's
 * identity fully independent of dustinedwards.info's own Better Auth setup, so a
 * change to the site's Google project at DNS cutover cannot affect operator
 * access here.
 *
 * A GitHub OAuth App, not a GitHub App. Only login is needed; no repository
 * access happens in this Worker at all, because the only thing it may touch is
 * the operator API.
 */

import { isAdminUser, type Props } from "./auth";

export interface GitHubEnv {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ADMIN_GITHUB_LOGIN?: string;
  OAUTH_PROVIDER: {
    parseAuthRequest(request: Request): Promise<AuthRequest>;
    completeAuthorization(options: {
      request: AuthRequest;
      userId: string;
      metadata: Record<string, unknown>;
      scope: string[];
      props: Props;
    }): Promise<{ redirectTo: string }>;
    lookupClient(clientId: string): Promise<{ clientName?: string } | null>;
  };
}

interface AuthRequest {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  [key: string]: unknown;
}

const STATE_COOKIE = "mcp_oauth_state";

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function html(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The consent screen.
 *
 * A real form with a real submit button, because consent has to be an act. The
 * client id is shown verbatim: with CIMD it is a URL, and a human approving
 * access to a publishing surface should see exactly which client is asking.
 */
async function handleAuthorizeGet(request: Request, env: GitHubEnv): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return text(
      "This wrapper is not configured for login: GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is unset. " +
        "Not configured means not open.",
      503,
    );
  }

  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId).catch(() => null);
  const clientName = client?.clientName ?? oauthReq.clientId;

  return html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Authorize access to dustinedwards.info publishing</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.35rem; line-height: 1.3; }
  dl { margin: 1.5rem 0; }
  dt { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  dd { margin: .15rem 0 1rem; word-break: break-all; font-family: ui-monospace, monospace; font-size: .9rem; }
  ul { padding-left: 1.2rem; }
  button { font: inherit; padding: .6rem 1.2rem; border-radius: .4rem; cursor: pointer; }
</style>
</head><body>
<h1>Authorize publishing access to dustinedwards.info</h1>
<p>A client is asking to use the operator publishing tools. Approving this lets it
create, edit, unpublish, republish and delete posts on your behalf.</p>
<dl>
  <dt>Client</dt><dd>${escape(clientName)}</dd>
  <dt>Redirecting to</dt><dd>${escape(oauthReq.redirectUri)}</dd>
</dl>
<p>It will <strong>not</strong> be able to publish a post for the first time. That
stays with you.</p>
<p>You will be sent to GitHub to sign in. Only the configured administrator account
is accepted.</p>
<form method="post">
  <button type="submit">Continue to GitHub</button>
</form>
</body></html>`);
}

/**
 * Consent submitted. Stash the OAuth request in a cookie and bounce to GitHub.
 *
 * The cookie is scoped to /callback, HttpOnly, Secure and SameSite=Lax: it exists
 * only to survive the round trip and nothing else should ever read it.
 */
async function handleAuthorizePost(request: Request, env: GitHubEnv): Promise<Response> {
  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const url = new URL(request.url);

  const state = crypto.randomUUID();
  const payload = btoa(JSON.stringify({ state, req: oauthReq }));

  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", env.GITHUB_CLIENT_ID ?? "");
  github.searchParams.set("redirect_uri", `${url.origin}/callback`);
  // No scopes. Identity is all this needs, and a token that can do more than it
  // needs is a liability with no upside.
  github.searchParams.set("scope", "");
  github.searchParams.set("state", state);

  const headers = new Headers({ Location: github.toString() });
  headers.append(
    "Set-Cookie",
    `${STATE_COOKIE}=${payload}; HttpOnly; Secure; SameSite=Lax; Path=/callback; Max-Age=600`,
  );
  return new Response(null, { status: 302, headers });
}

/** Back from GitHub. Verify state, resolve the user, gate on the admin check. */
async function handleCallback(request: Request, env: GitHubEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !returnedState) return text("Missing code or state on the callback.", 400);

  const cookie = request.headers
    .get("Cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${STATE_COOKIE}=`))
    ?.slice(STATE_COOKIE.length + 1);
  if (!cookie) return text("The login session expired. Start the authorization again.", 400);

  let stashed: { state: string; req: AuthRequest };
  try {
    stashed = JSON.parse(atob(cookie));
  } catch {
    return text("The login session was unreadable. Start the authorization again.", 400);
  }
  // CSRF: the state GitHub returned must match the one we minted.
  if (stashed.state !== returnedState) {
    return text("State mismatch on the callback. The authorization was not completed.", 400);
  }

  const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/callback`,
    }),
  });
  const token = (await tokenResp.json()) as { access_token?: string; error_description?: string };
  if (!token.access_token) {
    return text(`GitHub declined the token exchange: ${token.error_description ?? "no access token"}`, 502);
  }

  const userResp = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "dustinedwards-mcp",
    },
  });
  if (!userResp.ok) return text(`GitHub would not identify the account (${userResp.status}).`, 502);
  const user = (await userResp.json()) as { id: number; login: string; name: string | null };

  if (!isAdminUser(env, user)) {
    return text(
      `Access denied. This is a single-operator server and the GitHub account "${user.login}" is not its ` +
        `administrator.`,
      403,
    );
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: stashed.req,
    userId: String(user.id),
    metadata: { login: user.login },
    scope: stashed.req.scope,
    props: { id: user.id, login: user.login, name: user.name ?? null },
  });

  const headers = new Headers({ Location: redirectTo });
  headers.append("Set-Cookie", `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/callback; Max-Age=0`);
  return new Response(null, { status: 302, headers });
}

/**
 * Everything the OAuth library does not claim.
 *
 * The library serves /token, /.well-known/oauth-authorization-server and
 * /.well-known/oauth-protected-resource itself. This handler owns the consent
 * flow and /health.
 */
export const defaultHandler = {
  async fetch(request: Request, env: GitHubEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return text("ok");
    if (pathname === "/authorize" && request.method === "GET") return handleAuthorizeGet(request, env);
    if (pathname === "/authorize" && request.method === "POST") return handleAuthorizePost(request, env);
    if (pathname === "/callback") return handleCallback(request, env);
    return text("Not found.", 404);
  },
};
