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

Measured 2026-09-07: Grok Build 1.0.13 (rmcp) is LEGACY and never got that far:
it opens `GET /mcp` declaring `mcp-protocol-version: 2024-11-05`, and its auth
middleware quit before any POST because the AS metadata carried no
`registration_endpoint`. Its discovery walk lives in the Worker logs, not the
probe, because the probe stopped serving OAuth discovery routes on 2026-07-30.

Three independent clients, different infrastructure, all legacy. The shim is
load-bearing right now.

## Client leg is settled, and the two traps in it

OAuth 2.1 resource server per the spec, because claude.ai was measured completing
the whole flow: RFC 9728, RFC 8414, RFC 8707 audience binding, PKCE S256. No
bearer fallback and no dated debt; the standard only permits those where the
measured client CANNOT complete the flow.

- **CIMD AND DCR, both, each on a measurement.** claude.ai (2026-07-30) sends
  `client_id` as the URL `https://claude.ai/oauth/mcp-oauth-client-metadata` and
  never calls `/register`, so `clientIdMetadataDocumentEnabled: true` plus the
  `global_fetch_strictly_public` compatibility flag stay. Grok Build 1.0.13
  (2026-09-07, rmcp) CANNOT do CIMD and requires RFC 7591 dynamic registration;
  without a `registration_endpoint` it stops at "OAuth authorization required"
  and never opens a browser, so `clientRegistrationEndpoint: "/register"` exists
  for it. The earlier ruling here ("do not build a registration endpoint") was
  measurement-true on 2026-07-30 and is superseded by the Grok capture.
  Registration mints an identity only: a grant still goes through the GitHub
  consent flow and `isAdminUser`, so DCR widens who may ask, never who is let in.
  Both paths are pinned by `check:wrapper` and by the conformance gate's
  authorization section, in both directions.
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
- `npm run build` (`wrangler deploy --dry-run`). NOT the same check as typecheck.
- `npm run check:wrapper` gate over the no-policy law, 230 assertions
- `npm run check:wrapper:plant` proves that gate actually fails, 15 violations
- `npm run check:conformance` official MCP suite, per era, plus the
  authorization server against the real deploy entry. A BASELINE, not a sweep.
- `node scripts/probe-report.mjs` read the client measurement
- `node scripts/probe-report.mjs --reset` clear captures before a real measurement

The probe no longer has phases. It served OAuth discovery routes only while those
were unclaimed; they now belong to the real authorization server, and the walk
they existed to capture has been measured and recorded in the README.

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

## Gate discipline learned in this repo's first session

- **Typecheck is not a build.** Two commits shipped with runtime deps absent from
  `package.json` while `npx tsc -b` stayed green, because `node_modules` still had
  them. Run `npm run build`.
- **A gate never observed failing has not been verified, and that includes the
  HARNESS.** The first plant harness reverted with `git checkout -- .`, which does
  not touch untracked files, so residue accumulated and every result after the
  first was contaminated. It also destroyed uncommitted work. `plant-violations.sh`
  snapshots and restores the exact files it edits and re-checks the baseline
  between plants.
- **Commit before running anything that reverts.** The mainline ruling already says
  never leave work uncommitted; this is why.
- **Two strippers, and picking the wrong one silently disables an assertion.**
  `withoutComments` keeps string literals and is for content; `codeOnly` removes
  them and is for code. Four planted violations walked through a gate that used the
  wrong one.
- **Check exit codes directly, never through a pipe**, and beware the reverse: on
  Windows the conformance suite aborts on a libuv `UV_HANDLE_CLOSING` assertion
  AFTER printing results, so a passing scenario exits non-zero. Judge the parsed
  count and surface the crash.
- **Use a heredoc for commit messages.** Backticks inside `git commit -m "..."` are
  command-substituted by bash and silently delete words from the message.
- **Post-deploy readings are unstable.** A `POST` returned Cloudflare **error 1104**
  while `/health` was already 200. Same trap core.md records as 404s, different
  code. Poll until stable.
