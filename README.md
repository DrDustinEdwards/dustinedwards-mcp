# dustinedwards-mcp

An MCP wrapper over the [dustinedwards.info](https://dustinedwards.info) operator
publish API. It exposes seven tools to an AI agent and **contains no policy of
its own**.

House standard: Capsid `capsid/mcp-wrapper-standard.md`, ratified 2026-07-30.
This repo is the reference implementation that standard describes; the foxing
Workers port and the foxhound ops MCP copy its shape at their cutovers.

## Status: VERIFIED END TO END, 2026-07-30

Run from a real MCP client through the real OAuth flow, against production.

| Step | Result |
|---|---|
| OAuth 2.1 flow | CIMD client resolved by name, PKCE S256, GitHub admin gate, token issued |
| Legacy `initialize` (2025-11-25) | 200 |
| Modern `server/discover` (2026-07-28) | 200, `supportedVersions: ["2026-07-28"]` |
| `tools/list` | 5 tools, annotations correct (`delete_post` destructive, reads read-only) |
| `list_posts` / `get_post` / `sync_status` | correct, `headSha` matching the repo |
| `save_post` create draft | commit `4686349c`, `askSync uploaded 0` (drafts stay out of the AI index) |
| **first-publish attempt** | **refused 403 `first-publish-requires-admin`, prose verbatim** |
| `save_post` edit | commit `8043683f` |
| wide-dash gate | refused, verbatim, naming line 10 column 18 |
| invalid slug | refused at the schema, before any HTTP round trip |
| `delete_post` | commit `e2417aa5` |
| Commits on `main` | all three carry `[operator:cb8eb348]`, each atomic (markdown + artifact) |
| Site's `check:content` afterwards | green, so the operator path never leaves the repo mid-gate |
| Rate limiter | 45 concurrent requests: 28 allowed, 17 refused with `Retry-After` |

**The `resource` risk did not materialise.** Token exchange succeeded with a
path-qualified `resource` against a PRM advertising origin-only, so
`resourceMatchOriginOnly` is NOT needed and remains unset at the strict RFC 8707
default.

**Two findings from the run, neither a wrapper bug.**

1. **`_meta` belongs inside `params`**, not at the top level of the JSON-RPC
   message. A top-level `_meta` is rejected `-32600` "not a valid JSON-RPC
   message", which reads like a server fault and is a malformed client. Exactly
   the class of mistake the conformance suite exists to catch.
2. **Every pre-existing post has `first_published: null`**, including the one that
   is live, because they predate the stamping mechanism. So `operatorMayPublish`
   is false for all of them, and if the live post were ever unpublished an operator
   could not republish it. That is an app-side data gap, not a wrapper concern.

**Not verified:** the adds-nothing claim by running the same operations RAW
against the operator API and diffing. That needs `OPERATOR_TOKEN` in a shell.
What is verified is that the commits, the gate prose, the policy name and the
`[operator:...]` marker are the API's own, unmodified.

## How it was built: measurement stage

The era this wrapper targets was decided by MEASUREMENT before a line of the tool
surface was written, and that sequencing was deliberate. The MCP `2026-07-28`
revision shipped final on 2026-07-28 and removed the `initialize` handshake,
sessions, the GET stream and server-initiated requests. The spec's own
compatibility matrix says a legacy client talking to a modern server **fails, with
no fall-forward**. So the first commit in this repo was the probe in
`src/probe.ts`, not the wrapper, and the probe is still here as the instrument
that answers the shim's removal condition.

See [Era targeting](#era-targeting) for what it measured.

## The law

The wrapper contains **no policy, no gates, and no second write path.** Every
tool call becomes an authenticated HTTP request to `POST /api/operator` on the
dustinedwards Worker, where all rules live. If this Worker vanished, nothing
about what is allowed would change.

```
  AI agent
     |  client leg: identifies WHO is operating
     v
  dustinedwards-mcp  (this Worker)         no D1, no R2, no GitHub token
     |  API leg: OPERATOR_TOKEN, identifies WHAT it may do
     v
  POST /api/operator  on the dustinedwards Worker
     |
     +-> zod frontmatter gate, wide-dash check, first-publish policy,
         one atomic Git Data commit, D1 sync, AI index sync
```

It is a **separate Worker in its own repo** for a structural reason, not a
stylistic one: the only path from here to the publish machinery *is* the API.
Mounted as a route on the app Worker, the cheap path would be an in-process call
that silently skips operator authentication and the rate limiter. Here that call
is not merely discouraged, it is unreachable.

The contract between wrapper and app is the API's documented payloads, never
shared code. This Worker validates responses at its edge like the outside caller
it is.

## Two legs, two credentials

| Leg | Credential | Answers |
|---|---|---|
| Client (agent to wrapper) | per the era measurement, see below | **who** is operating |
| API (wrapper to app) | `OPERATOR_TOKEN` bearer | **what** the wrapper may do |

Never the same value. A client-leg identity failure must read differently from
the API refusing an operation, because they mean different things and an agent
that conflates them cannot correct itself.

## Era targeting

Measured, dated, and re-measurable with `scripts/probe-report.mjs`.

**Claude Code 2.1.203, measured 2026-07-29:** opens `initialize` declaring
`2025-11-25`, sends `notifications/initialized`, sends **no** `Mcp-Method` or
`Mcp-Name`, and opens a `GET /mcp` SSE stream. Every one of those was removed, or
made required, by `2026-07-28`. It is a **legacy-era client.** It does, however,
walk RFC 9728 correctly: `401` to protected resource metadata to authorization
server metadata.

**claude.ai, measured 2026-07-30** against this probe on the live deploy. Its
`clientInfo` is `{name: "Anthropic", version: "1.0.0"}` and it is also a
**legacy-era client**: opens `initialize` declaring `2025-11-25`, sends neither
`Mcp-Method` nor `Mcp-Name`, and carries no `_meta` protocolVersion. Two agents
are involved: server-side discovery from `python-httpx/0.28.1`, then the consent
redirect in the operator's own browser.

**Grok Build 1.0.13, measured 2026-09-07** against the probe and the Worker
logs. Also **legacy-era**, and further back than either: it opens `GET /mcp`
declaring `mcp-protocol-version: 2024-11-05`, and it never reached a POST at
all, because its rmcp auth middleware ran discovery first (path-scoped PRM,
then RFC 8414), found no `registration_endpoint`, and stopped. See the
client-leg section below for what that forced.

Three independent clients on different infrastructure, all legacy. Consequence:
`2026-07-28` is the primary and design-center era, and prior-era support lives in
exactly one seam, `src/legacy-era.ts`, carrying its own removal condition.
**The shim is load-bearing today, not vestigial.** It goes when the probe shows
the target clients opening with `server/discover`, which is why the probe stays
in the repo as the instrument that answers the question.

## Client-leg auth: the spec's OAuth story, because the client completes it

The house standard makes this conditional on measurement: the spec's own OAuth
2.1 resource server story, with a bearer fallback ONLY if the measured client
cannot complete the flow. It can, so there is no fallback and no dated debt.

Measured against claude.ai, 2026-07-30:

| Requirement | Result |
|---|---|
| RFC 9728 protected resource metadata | YES, and it requests the path-scoped `/.well-known/oauth-protected-resource/mcp` FIRST |
| RFC 8414 authorization server metadata | YES |
| RFC 8707 audience binding | YES, `resource` = this server's `/mcp` URL |
| PKCE S256 | YES |
| Client identity | **CIMD, not DCR.** `client_id` is the URL `https://claude.ai/oauth/mcp-oauth-client-metadata`, and `/register` was never called |
| Redirect URI | `https://claude.ai/api/mcp/auth_callback` |

Two consequences for the build as measured then. Dynamic client registration
was **not needed by any measured client**, which matches `2026-07-28`
deprecating RFC 7591 in favour of CIMD. And the PRM route must answer the
**path-scoped** form, not only the bare one; a server that only handles
`/.well-known/oauth-protected-resource` would miss claude.ai's first request.

**The first half of that was superseded by measurement on 2026-09-07.** Grok
Build 1.0.13's rmcp client is the counterexample the earlier note said did not
exist: it cannot do CIMD and requires RFC 7591 dynamic registration. Against
metadata carrying no `registration_endpoint` it cannot mint a client identity,
so it cannot build an authorization URL, and it stops at "OAuth authorization
required" without ever opening a browser. So the server now carries **both
identity paths**: `clientIdMetadataDocumentEnabled: true` for claude.ai, and
`clientRegistrationEndpoint: "/register"` for Grok. Registration only mints a
client identity; a grant is still issued solely through the GitHub consent flow,
and `isAdminUser` still admits exactly the configured administrator, so DCR
widens who may ask, never who is let in.

`@cloudflare/workers-oauth-provider` supports this directly via
`clientIdMetadataDocumentEnabled`, which requires the
`global_fetch_strictly_public` compatibility flag. That is the same library the
capsid MCP uses, so the precedent covers the measured flow.

**Pinned to 0.10.3 exactly, on a differential taken 2026-09-07.** Adding
`/register` did not move Grok Build 1.0.13: with the registration endpoint
advertised and answering `201` to a localhost callback, the client still sent one
unauthenticated `POST /mcp`, took the `401`, and never followed the
`WWW-Authenticate` pointer to discovery. Nothing else reached the Worker, and
pressing the connector's authenticate key emitted no request at all. The capsid
MCP authenticates from that same Grok build on the same machine and was running
0.10.3 while this Worker ran 0.8.3, which is the difference this pin closes. The
other differences that fell out of that comparison, and which remain untested as
causes, are that capsid does not enable CIMD, offers `S256` alone rather than
`plain` beside it, and advertises
`authorization_response_iss_parameter_supported`.

**Caveat on the instrument.** The probe serves PRM unconditionally, so its `open`
phase was never truly authless, which is why claude.ai authenticated despite a
`200` on `initialize`. That produced both measurements in one connector add. It
also means whether claude.ai would accept a genuinely authless server is
UNMEASURED here, and is not claimed either way.

## Gates

| Gate | Proves | State |
|---|---|---|
| `npm run typecheck` | `wrangler types && tsc -b` | green |
| `npm run build` | a dry-run bundle. 1,154.46 KiB raw, 208.00 KiB gzip, measured 2026-09-07 on wrangler 4.129.0 | green |
| `npm run check:wrapper` | the no-policy law, mechanically. 230 assertions | green, 15/15 planted violations caught |
| `npm run check:wrapper:plant` | that `check:wrapper` actually fails | 15 caught, 0 missed |
| `npm run check:conformance` | the official suite against the real protocol layer, per era, plus the authorization server against the real deploy entry | **baseline, not a clean sweep** |

`npm run build` exists because **typecheck is not a build.** Two commits shipped
with the runtime dependencies missing from `package.json` and typecheck passed
throughout, because `node_modules` still held them locally. Only a real bundle
catches that.

`check:wrapper` fails in both directions: a forbidden binding fails, and so does a
missing tool, a second call site on the era shim, or a policy statement dropped
from a tool description. Verified by planting eleven violations. The first attempt
at that harness was itself wrong, and fixing it exposed four real blind spots in
the gate, all from one cause: the comment-stripper also removed string literals,
so assertions searching for a URL or an option value were reading text with that
value already deleted. There are now two strippers and a comment saying which to
use when.

### check:conformance is a baseline, and says so

`@modelcontextprotocol/conformance` is genuinely runnable (`server` / `client` /
`authorization` subcommands, `--spec-version` filtering). It runs against
`test/conformance-entry.ts`, which mounts the **real** handler and the real five
tools with only the client leg and the limiter removed, and the API leg aimed at a
local stub. So what is certified is the code that ships, not a stand-in.

| Era | Scenario | Result |
|---|---|---|
| 2026-07-28 | `server-stateless` (SEP-2575) | 24/28 baseline |
| 2025-11-25 | `server-initialize` | 1/1 |
| 2026-07-28 | `authorization-server-metadata-endpoint` | 2/2 |

The authorization scenario runs against a second `wrangler dev` mounting the
**real deploy entry** (`src/index.ts`, OAuth provider included, its own
`--persist-to` because two dev processes sharing state deadlock the Durable
Object's SQLite). The official scenario treats registration as optional, so the
harness adds three checks of its own, planted red before being trusted: the
metadata advertises CIMD (claude.ai's path) and `registration_endpoint` (Grok's
path), and a `POST /register` against the local dev actually mints a
`client_id`.

The 4 shortfalls are **upstream**: `@modelcontextprotocol/server` 2.0.0 does not
implement `MissingRequiredClientCapabilityError` (-32021). Attributed upstream
rather than to this repo because a dependency-free draft server written in the same
session scored the same 24/28 on that scenario. The gate fails on a regression
**and** on an improvement, so when the SDK fixes it the baseline gets tightened
rather than quietly over-passing.

**Known gaps, not passes.** `http-header-validation` measured 13/13 standalone but
returns no parseable count through this harness; `caching`,
`dns-rebinding-protection`, `json-schema-2020-12` and the `tools-call` scenarios
are not yet wired in. A full sweep exceeded nine minutes, hence the short list and
the per-scenario timeout.

That library-versus-hand-roll comparison is also what settled the implementation
choice:

| Scenario | hand-rolled draft | `agents` + MCP SDK v2 |
|---|---|---|
| `server-stateless` | 0/8 | 24/28 |
| `http-header-validation` | 3/8 | 13/13 |

A 2026-07-28 server owes about twenty discrete MUSTs across three SEPs, including
details no prose surfaced: `cacheScope` must be `"public"` or `"private"`, and
JSON-RPC method values are case-sensitive. Hand-rolling was a correctness
liability, not a line-count saving.

## Deploy state and the one open risk

Deployed at `https://dustinedwards-mcp.dustin-edwards.workers.dev`, version
`c2b3a458-f26c-4480-bc25-983ca86751bc`, Worker startup 108 ms.

Verified on the live deploy with **no secrets set**, which is the fails-closed
property rather than an accident:

- `/mcp` unauthenticated returns `401` with `WWW-Authenticate` pointing at the
  **path-scoped** PRM, which is the form claude.ai requests first.
- `/authorize` with no GitHub credentials returns **503**. Not configured means not
  open.
- `/probe/mcp` still answers both eras.

**OPEN RISK, unresolved until the first real connection.** The library advertises
`resource` in its PRM as the **origin**, while claude.ai was measured sending
`resource=<origin>/mcp` **with the path**, and `workers-oauth-provider` defaults to
strict RFC 8707 exact matching. If the token exchange fails, the first thing to try
is `resourceMatchOriginOnly: true` in the `OAuthProvider` options. It is
deliberately **not** set pre-emptively: it loosens audience binding, and setting it
on a guess would weaken the exact property the spec's auth story exists to provide.

## Scope exclusions

Considered and deliberately excluded until a measured need exists. Recorded here
so a future session does not helpfully add them.

- **MCP Apps** (SEP-1865). A publish wrapper has no UI to host.
- **Tasks** (SEP-2663). The longest operation here is one commit.
- **MRTR / `input_required`** (SEP-2322). Policy decisions belong to the API and
  to the human, never to an interactive negotiation with the wrapper.
- **Resources and Prompts primitives.** The API offers tools; mirroring it as
  resources would be a second surface with no second caller.
- **Response caching, retries, multi-project multiplexing.** The client already
  retries, and composition is the agent's job.
- **Any tool the operator API does not already offer.** A tool the API lacks is a
  policy decision, and policy does not live here.

## Operating the probe

The probe has **no HTTP control plane, deliberately.** Its capture log describes
a client's authentication behaviour and should not be reachable from the
internet, and this way there is no probe credential to exist or leak. Read it
through the Cloudflare API instead:

```sh
node scripts/probe-report.mjs               # the analysed report
node scripts/probe-report.mjs --phase auth  # force the OAuth discovery walk
```

Phase `open` answers everything and captures the protocol opening. Phase `auth`
returns `401` with a `WWW-Authenticate` pointer and captures the OAuth 2.1
resource server walk. Two phases because one connector add cannot show both.

## Not advertised

This endpoint is absent from `llms.txt`, the sitemap, and every public affordance
on dustinedwards.info. An authenticated operator surface is not a public
affordance. That is a rule from the house standard, not an oversight.

## Workflow

Mainline only while pre-production, per Capsid
`dustinedwards/workflow-mainline.md`: no feature branches, no PRs, commit and
push immediately, gates before every push. That ruling sunsets at the
dustinedwards.info DNS cutover.
