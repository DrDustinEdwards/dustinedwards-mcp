# CLAUDE.md - dustinedwards-mcp

Portfolio-wide rules live in Capsid, not here. Read `capsid/conventions.md`,
then `capsid/mcp-wrapper-standard.md` (the ratified house standard this repo
implements), then `dustinedwards/core.md` (the app this wraps). This file holds
only what is true of this repo.

## What this is

An MCP wrapper over the dustinedwards.info operator publish API. A separate
Cloudflare Worker, own repo, zero app bindings. Node 24.14.1 (.nvmrc).

## Session ritual

Start: read `capsid/conventions.md`, then `capsid/mcp-wrapper-standard.md`, then
`dustinedwards/core.md`.
End: write a `session-YYYY-MM-DD.md` episodic (type `episodic`, under ~2KB) to
the dustinedwards namespace. This repo shares that namespace; it does not have
its own.

## The law, and it is not negotiable

NO policy, NO gates, NO second write path. Every tool call becomes an
authenticated HTTP request to `POST /api/operator` on the dustinedwards Worker.
If this Worker vanished, nothing about what is allowed would change.

Concretely, things that must never appear in this repo:

- An import from the dustinedwards app, or any shared code with it. The contract
  is the API's documented payloads.
- A D1, R2, KV-for-app-data, or AI binding. A `GITHUB_TOKEN`. Anything that could
  reach the publish machinery other than over HTTP.
- A gate, a validation rule, or a policy decision that duplicates one the API
  already makes. Schema validation on tool INPUT is allowed and wanted, because
  it fails a bad call before a round trip; re-implementing the first-publish rule
  is not, because then there are two of it.
- A tool the operator API does not offer.

`npm run check:wrapper` asserts this mechanically and must fail in both
directions. Plant a violation and watch it fail before trusting it.

## Two legs, two credentials

- CLIENT LEG (agent to wrapper): identifies WHO is operating.
- API LEG (wrapper to app): `OPERATOR_TOKEN` bearer, the same token any raw
  caller would present. Identifies WHAT the wrapper may do.

Never the same value, never conflated in docs or error messages. A client-leg
failure must read differently from an API refusal.

## Era targeting is a MEASUREMENT, never an assumption

`2026-07-28` is the primary and design-center era. Prior-era support lives in
exactly ONE seam, `src/legacy-era.ts`, carrying its removal condition in a
comment.

Do not change the targeted era from a release note, an announcement, or a
changelog. Re-run `scripts/probe-report.mjs` against a real client and change it
from the capture. The probe exists for this and stays in the repo.

Measured 2026-07-29: Claude Code 2.1.203 is LEGACY (opens `initialize` at
`2025-11-25`, no `Mcp-Method`/`Mcp-Name`, opens a GET SSE stream).

Measured 2026-07-30: claude.ai (`clientInfo.name` = `Anthropic`) is ALSO LEGACY,
same `2025-11-25`, no `Mcp-Method`/`Mcp-Name`, no `_meta` protocolVersion.

Two independent clients, different infrastructure, both legacy. The shim is
load-bearing right now.

## Client leg is settled, and the two traps in it

OAuth 2.1 resource server per the spec, because claude.ai was measured completing
the whole flow: RFC 9728, RFC 8414, RFC 8707 audience binding, PKCE S256. No
bearer fallback and no dated debt; the standard only permits those where the
measured client CANNOT complete the flow.

- **CIMD, not DCR.** claude.ai sends `client_id` as the URL
  `https://claude.ai/oauth/mcp-oauth-client-metadata` and never calls `/register`.
  Do not build a dynamic client registration endpoint; `2026-07-28` deprecates
  RFC 7591 in favour of CIMD anyway. `@cloudflare/workers-oauth-provider` 0.8.3
  wants `clientIdMetadataDocumentEnabled: true` plus the
  `global_fetch_strictly_public` compatibility flag.
- **PRM must answer the PATH-SCOPED route.** claude.ai requests
  `/.well-known/oauth-protected-resource/mcp` BEFORE the bare
  `/.well-known/oauth-protected-resource`. A server handling only the bare form
  misses its first request.

## Errors are relayed VERBATIM

The API's refusal prose is returned unchanged: never summarized, wrapped, or
softened. A `403 first-publish-requires-admin` must reach the agent as the API
wrote it, because the agent's next move depends on reading it as policy rather
than as a transport error.

## Commands

- `npm run dev`
- `npm run deploy` (wrangler deploy)
- `npm run typecheck` (`wrangler types && tsc -b`)
- `npm run check:wrapper` gate over the no-policy law
- `npm run check:conformance` official MCP conformance suite, per era
- `node scripts/probe-report.mjs` read the client measurement
- `node scripts/probe-report.mjs --phase auth` flip the probe to capture OAuth

Check a gate's exit code DIRECTLY, never through a pipe. `tail` masks it and has
already reported exit 0 on a failing run elsewhere in this portfolio.

## The probe has no control plane, deliberately

Its capture log describes a client's auth behaviour, so it is not reachable over
HTTP. Read it with `wrangler kv` through the Cloudflare API. This also means
there is no probe credential to exist or leak. Do not add an HTTP control
endpoint back.

## Not advertised

Absent from `llms.txt`, the sitemap and every public affordance. An authenticated
operator surface is not a public affordance.

## Workflow

Mainline only while pre-production, per `dustinedwards/workflow-mainline.md`: no
branches, no PRs, commit and push immediately, gates before every push, docs in
the same commit. Scoped `git add` of named paths, never `-A`.

## House style

No em dashes. Secrets are wrangler secrets and are never read, printed, or
committed.
