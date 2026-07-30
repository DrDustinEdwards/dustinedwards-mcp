# dustinedwards-mcp

An MCP wrapper over the [dustinedwards.info](https://dustinedwards.info) operator
publish API. It exposes five tools to an AI agent and **contains no policy of its
own**.

House standard: Capsid `capsid/mcp-wrapper-standard.md`, ratified 2026-07-30.
This repo is the reference implementation that standard describes; the foxing
Workers port and the foxhound ops MCP copy its shape at their cutovers.

## Status: measurement stage

The tool surface is **not built yet**, and that is deliberate sequencing rather
than an unfinished thought. The MCP `2026-07-28` revision shipped final on
2026-07-28 and removed the `initialize` handshake, sessions, the GET stream and
server-initiated requests. The spec's own compatibility matrix says a legacy
client talking to a modern server **fails, with no fall-forward**. So which era
this wrapper targets is a question about what real clients actually send, and the
only honest way to answer it is to measure.

Right now this Worker is only the probe in `src/probe.ts`. See
[Era targeting](#era-targeting) for what has been measured so far.

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

**claude.ai:** pending. It is the stated consumer, so the client-leg auth
decision waits on it.

Consequence: `2026-07-28` is the primary and design-center era, and prior-era
support lives in exactly one seam, `src/legacy-era.ts`, carrying its own removal
condition. **The shim is load-bearing today, not vestigial.** It goes when the
probe shows the target clients opening with `server/discover`, which is why the
probe stays in the repo as the instrument that answers the question.

## Gates

| Gate | Proves |
|---|---|
| `npm run typecheck` | `wrangler types && tsc -b` |
| `npm run check:wrapper` | the no-policy law, mechanically: no imports from the app, no D1/R2/GitHub binding, bindings allowlist derived from `wrangler.jsonc`, failing in both directions |
| `npm run check:conformance` | the official `@modelcontextprotocol/conformance` suite, per era |

The conformance suite is real and runnable (`@modelcontextprotocol/conformance`,
`server` / `client` / `authorization` subcommands, `--spec-version` filtering,
`--expected-failures` baselining). Running it against a hand-rolled draft server
during this repo's first session is what settled the library-versus-hand-roll
question:

| Scenario | hand-rolled draft | `agents` + MCP SDK v2 |
|---|---|---|
| `server-stateless` (SEP-2575) | 0/8 | 24/28 |
| `http-header-validation` (SEP-2243) | 3/8 | 13/13 |

A 2026-07-28 server owes about twenty discrete MUSTs across three SEPs, including
details no prose surfaced: `cacheScope` must be `"public"` or `"private"`, and
JSON-RPC method values are case-sensitive. Hand-rolling was a correctness
liability, not a line-count saving.

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
