/**
 * check:wrapper. Proves the no-policy law MECHANICALLY.
 *
 * The law is that this Worker contains no policy, no gates, and no second write
 * path, and that its only route to the publish machinery is an HTTP request to
 * the operator API. A law asserted only in a README is a law that drifts, so this
 * gate reads the actual source and the actual wrangler config and fails when they
 * disagree with it.
 *
 * It fails in BOTH directions on purpose. Adding a forbidden binding fails, and so
 * does removing a required tool or letting the binding allowlist drift out of
 * sync with the config. A gate that only catches additions cannot notice a
 * deletion, and half this repo's guarantees are about things that must stay.
 *
 * Pure: no network, no deployment, no Cloudflare API. Same principle as the app's
 * check:policy and check:search.
 *
 * Verified by planting violations. See the PLANTED VIOLATIONS block at the bottom.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

let failures = 0;
let assertions = 0;

function check(label, condition, detail = "") {
  assertions += 1;
  if (!condition) {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

// jsonc: strip line comments before parsing. Block comments are stripped first
// because this config's own comments name forbidden binding types in prose, and a
// parser that looked at comments would find the prose before the config. That
// exact trap has already been hit twice in this portfolio.
function readJsonc(path) {
  const raw = readFileSync(path, "utf8");
  const withoutBlocks = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLines = withoutBlocks.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(withoutLines);
}

function sourceFiles() {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ name: f, text: readFileSync(join(SRC, f), "utf8") }));
}

/**
 * TWO strippers, and picking the wrong one silently disables an assertion.
 * Verified the hard way: the first version of this gate used codeOnly()
 * everywhere, and three of eleven planted violations went undetected because the
 * thing being searched for lived in a string literal that codeOnly() had already
 * removed.
 *
 * withoutComments  strips comments, KEEPS strings. Use for assertions about
 *                  string CONTENT: urls, paths, config values, option values.
 * codeOnly         strips comments AND strings. Use for assertions about
 *                  executable code: identifiers, branches, property access.
 *
 * Both strip comments, because this file's own prose and the source's module
 * headers name the very things being forbidden. A parser that reads comments
 * finds the documentation before the code, which is a trap this portfolio has now
 * hit three times.
 */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

function codeOnly(text) {
  return withoutComments(text)
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '""')
    .replace(/"(?:\\.|[^\\"])*"/g, '""')
    .replace(/'(?:\\.|[^\\'])*'/g, '""');
}

/**
 * Resolve the wrangler config.
 *
 * The real `wrangler.jsonc` is gitignored, because it carries live KV namespace
 * ids and this repo is public. So a fresh clone has only
 * `wrangler.jsonc.example`, and this gate has to work there too or it becomes a
 * gate that only its author can run.
 *
 * Every assertion here is about binding SHAPE (which keys exist, which binding
 * names, whether the DO migration is sqlite-backed), never about id VALUES, so
 * the example proves exactly as much as the real file. Preference order is real
 * first, so a developer who has both is checked against what actually deploys.
 *
 * The gap this leaves, stated rather than hidden: on a machine with ONLY the
 * example, a forbidden binding added to the real file would not be seen. That is
 * closed below by asserting the two agree whenever both are present.
 */
function resolveConfig() {
  const real = join(ROOT, "wrangler.jsonc");
  const example = join(ROOT, "wrangler.jsonc.example");
  if (existsSync(real)) return { path: real, which: "wrangler.jsonc" };
  if (existsSync(example)) return { path: example, which: "wrangler.jsonc.example" };
  // Fails CLOSED. No config means nothing can be proven, which is not a pass.
  console.error("FAIL  no wrangler config found (neither wrangler.jsonc nor wrangler.jsonc.example)");
  process.exit(1);
}

const configSource = resolveConfig();
const config = readJsonc(configSource.path);
const files = sourceFiles();

// When both exist they must describe the same bindings, or the example is
// decoration and the fresh-clone run is checking a fiction.
if (configSource.which === "wrangler.jsonc" && existsSync(join(ROOT, "wrangler.jsonc.example"))) {
  const shape = (c) =>
    JSON.stringify({
      keys: Object.keys(c).sort(),
      kv: (c.kv_namespaces ?? []).map((n) => n.binding).sort(),
      dobj: (c.durable_objects?.bindings ?? []).map((b) => b.class_name).sort(),
      migrations: (c.migrations ?? []).map((m) => m.new_sqlite_classes ?? []).flat().sort(),
      flags: (c.compatibility_flags ?? []).slice().sort(),
      main: c.main,
      vars: Object.keys(c.vars ?? {}).sort(),
    });
  check(
    "wrangler.jsonc.example describes the same bindings as wrangler.jsonc",
    shape(config) === shape(readJsonc(join(ROOT, "wrangler.jsonc.example"))),
    "The example is what a fresh clone checks, so drift there silently weakens this gate.",
  );
}

// ---------------------------------------------------------------------------
// A. Bindings are an allowlist, derived from the config rather than restated.
// ---------------------------------------------------------------------------

// Any of these would give the wrapper a second route to app data, which is the
// one thing it must not have.
const FORBIDDEN_BINDING_KEYS = [
  "d1_databases",
  "r2_buckets",
  "ai",
  "vectorize",
  "hyperdrive",
  "queues",
  "services",
  "browser",
  "mtls_certificates",
  "analytics_engine_datasets",
  "dispatch_namespaces",
  "pipelines",
];

for (const key of FORBIDDEN_BINDING_KEYS) {
  check(
    `wrangler.jsonc has no "${key}" binding`,
    config[key] === undefined,
    `Found ${key}. The wrapper's only route to the app is an HTTP call to the operator API.`,
  );
}

const ALLOWED_KV = ["OAUTH_KV", "PROBE_KV"];
const actualKv = (config.kv_namespaces ?? []).map((n) => n.binding).sort();
check(
  "KV bindings are exactly the OAuth store and the probe log",
  JSON.stringify(actualKv) === JSON.stringify([...ALLOWED_KV].sort()),
  `Expected ${ALLOWED_KV.join(", ")} but found ${actualKv.join(", ") || "(none)"}.`,
);

const ALLOWED_DO_CLASSES = ["OperatorRateLimit"];
const actualDo = (config.durable_objects?.bindings ?? []).map((b) => b.class_name).sort();
check(
  "Durable Objects are exactly the rate limiter",
  JSON.stringify(actualDo) === JSON.stringify([...ALLOWED_DO_CLASSES].sort()),
  `Expected ${ALLOWED_DO_CLASSES.join(", ")} but found ${actualDo.join(", ") || "(none)"}.`,
);

// The limiter must be a SQLite-backed class. The async storage API was measured
// non-atomic across an await and let 8 through a ceiling of 3.
check(
  "The rate limiter is registered as a new_sqlite_classes migration",
  (config.migrations ?? []).some((m) => (m.new_sqlite_classes ?? []).includes("OperatorRateLimit")),
  "Without SQLite the counter is not atomic and the limit does not hold.",
);

// The deploy target must never be the conformance test entry, which mounts the
// handler with the client leg and the limiter removed.
check(
  "main is the production entry, not the conformance test entry",
  config.main === "src/index.ts",
  `Found main=${config.main}. test/conformance-entry.ts is a gate harness and must never deploy.`,
);

// CIMD needs this flag, and it is what the measured client actually uses.
check(
  "global_fetch_strictly_public is enabled for CIMD",
  (config.compatibility_flags ?? []).includes("global_fetch_strictly_public"),
);

// ---------------------------------------------------------------------------
// B. Credentials and vars the wrapper must never hold.
// ---------------------------------------------------------------------------

// GITHUB_TOKEN is the app's repository WRITE credential. If the wrapper held it,
// it could commit directly and bypass every gate, which is precisely the second
// write path the law forbids. The wrapper's GitHub credentials are login-only.
const FORBIDDEN_NAMES = [
  "GITHUB_TOKEN",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "AI_SEARCH",
  "ASK_BUDGET",
  "APP_KV",
];

const configText = readFileSync(configSource.path, "utf8");
for (const name of FORBIDDEN_NAMES) {
  check(
    `wrangler.jsonc does not reference ${name}`,
    !configText.includes(name),
    `${name} belongs to the app, not to the wrapper.`,
  );
  for (const f of files) {
    check(
      `src/${f.name} does not reference ${name}`,
      !withoutComments(f.text).includes(name),
      `${name} belongs to the app, not to the wrapper.`,
    );
  }
}

// ---------------------------------------------------------------------------
// C. No shared code with the app. The contract is the API's payloads.
// ---------------------------------------------------------------------------

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g;
for (const f of files) {
  const stripped = f.text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  for (const m of stripped.matchAll(IMPORT_RE)) {
    const spec = m[1];
    const local = spec.startsWith(".");
    check(
      `src/${f.name} import "${spec}" does not escape this repo`,
      !local || !spec.includes(".."),
      "A relative import climbing out of src/ would be shared code with the app.",
    );
    check(
      `src/${f.name} import "${spec}" is not an app path alias`,
      !spec.startsWith("~/") && !spec.includes("dustinedwards-info"),
      "The wrapper imports nothing from the app.",
    );
  }
}

// ---------------------------------------------------------------------------
// D. Outbound reach. Every network destination is deliberate.
// ---------------------------------------------------------------------------

// github.com and api.github.com are the LOGIN path only (identity, no scopes
// requested, no repository access). The operator API is reached through the
// OPERATOR_API_URL var rather than a literal, so a hardcoded app URL fails here.
const ALLOWED_HOSTS = ["github.com", "api.github.com", "rate-limit.invalid"];
const URL_RE = /https?:\/\/([a-z0-9.-]+)/gi;
for (const f of files) {
  for (const m of readFileSync(join(SRC, f.name), "utf8").matchAll(URL_RE)) {
    const host = m[1].toLowerCase();
    // Documentation links in comments are fine, so comments are stripped, but
    // the host lives in a STRING literal and codeOnly() would delete it. That
    // mistake let a planted exfiltration host through undetected.
    if (!withoutComments(f.text).includes(host)) continue;
    check(
      `src/${f.name} outbound host ${host} is allowlisted`,
      ALLOWED_HOSTS.includes(host),
      "Add it to ALLOWED_HOSTS here only if it is genuinely required, and say why.",
    );
  }
}

check(
  "The operator API URL comes from config, not a literal in source",
  files.every((f) => !withoutComments(f.text).includes("/api/operator")),
  "Hardcoding it would survive a config change and reach the wrong environment.",
);

// ---------------------------------------------------------------------------
// E. The tool surface mirrors the API and nothing more.
// ---------------------------------------------------------------------------

const toolsText = readFileSync(join(SRC, "tools.ts"), "utf8");
/*
 * THE API'S TOOL LIST, MIRRORED BY HAND, and the mirror is deliberate.
 *
 * This gate cannot read the site's repository, so the list cannot be derived.
 * That makes it the one hand-kept copy in a file whose whole subject is that
 * the wrapper adds nothing: a tool declared here and absent from the API would
 * be a policy decision made in the wrapper, which is what section E exists to
 * refuse.
 *
 * The cost of a hand mirror is that it goes stale in the SAFE direction only.
 * A tool added to the API and not here is simply unavailable through MCP; a
 * tool added here and not to the API fails this assertion on the next run. The
 * asymmetry is why a hand list is acceptable at all.
 *
 * GREW TO SEVEN 2026-09-05 with the moderation queue. Approving a webmention
 * was the last step in that path that needed a human with a browser, and it
 * was proven to work by asking one to click a button so a cache purge could be
 * measured. A step only a human can take is a step taken late.
 *
 * GREW TO EIGHT 2026-09-07 with `upload_media`, on that same reasoning one step
 * further along: an agent could write a post about anything except a picture,
 * because putting an image on the site needed the browser editor. The API side
 * is an adapter over the one door `/admin/media/upload` already used, so this
 * list growing does not mean a second write path into the bucket exists.
 *
 * NOT EVERY API TOOL IS HERE, which is why this list is shorter than the API's
 * and is not the mirror going stale. The four sync and backup repairs are
 * called by `ship` and by the watchdog; exposing an unattended index rebuild to
 * a chat client would be a policy decision made here.
 */
const EXPECTED_TOOLS = [
  "list_posts",
  "get_post",
  "save_post",
  "delete_post",
  "sync_status",
  "list_mentions",
  "decide_mention",
  "upload_media",
];
const declared = [...toolsText.matchAll(/^\s{4}name:\s*"([a-z_]+)",$/gm)].map((m) => m[1]);

check(
  "The declared tools are exactly the operator API's tools",
  JSON.stringify(declared) === JSON.stringify(EXPECTED_TOOLS),
  `Expected [${EXPECTED_TOOLS.join(", ")}] but found [${declared.join(", ")}]. ` +
    "A tool the API does not offer would be a policy decision made here.",
);

// Every tool must reach the API through the one transport. A handler that did
// anything else would be a second write path.
const runCalls = [...toolsText.matchAll(/run\(env,\s*"([a-z_]+)"/g)].map((m) => m[1]);
for (const name of EXPECTED_TOOLS) {
  check(`Tool ${name} dispatches through run() to the operator API`, runCalls.includes(name));
}

// The API leg's credential is confined to the module that owns it.
const tokenHolders = files.filter((f) => withoutComments(f.text).includes("OPERATOR_TOKEN")).map((f) => f.name);
check(
  "OPERATOR_TOKEN appears only in api-client.ts",
  JSON.stringify(tokenHolders) === JSON.stringify(["api-client.ts"]),
  `Found in: ${tokenHolders.join(", ") || "(nowhere)"}. The API leg has one owner.`,
);

// The API leg has one definition and one consumer. api-client.ts defines
// callOperator; tools.ts is the only module allowed to invoke it. Spreading the
// call across modules would mean several places knew how to reach the app, which
// is how a second write path starts.
const callers = files
  .filter((f) => f.name !== "api-client.ts" && /callOperator\s*\(/.test(codeOnly(f.text)))
  .map((f) => f.name);
check(
  "callOperator has exactly one consumer, tools.ts",
  JSON.stringify(callers) === JSON.stringify(["tools.ts"]),
  `Called from: ${callers.join(", ") || "(nowhere)"}. The API leg is one seam with one consumer.`,
);

check(
  "Only api-client.ts performs the operator API fetch",
  files.every((f) => f.name === "api-client.ts" || !/fetch\(env\.OPERATOR_API_URL/.test(codeOnly(f.text))),
);

// ---------------------------------------------------------------------------
// F. No policy DECISIONS. Describing a policy is required; enforcing one is not.
// ---------------------------------------------------------------------------

// The tool descriptions must MENTION the first-publish rule so an agent reads a
// refusal as policy. But no code may BRANCH on it: that would be a second,
// drifting copy of a rule the API owns. So the assertion is asymmetric on purpose,
// and it is the subtlest thing this gate does.
check(
  "save_post's description states the first-publish policy",
  /first-publish-requires-admin/.test(toolsText),
  "An agent that has not been told the rule reads a 403 as a malfunction and retries.",
);

const POLICY_BRANCHES = [
  /if\s*\([^)]*firstPublished/,
  /if\s*\([^)]*operatorMayPublish/,
  /firstPublished\s*[=!]==/,
  /operatorMayPublish\s*[=!]==/,
  /if\s*\([^)]*\bdraft\b[^)]*\)\s*\{[^}]*throw/,
];
for (const f of files) {
  const code = codeOnly(f.text);
  for (const re of POLICY_BRANCHES) {
    check(
      `src/${f.name} does not branch on publish state (${re.source})`,
      !re.test(code),
      "Deciding this here would duplicate a rule the operator API owns.",
    );
  }
}

// The gates belong to the app. If any of these appeared here it would mean the
// wrapper had started validating content, and two validators drift.
const FORBIDDEN_GATE_MARKERS = ["frontmatterSchema", "wideDash", "publiclyVisible", "renderPost", "savePost("];
for (const f of files) {
  for (const marker of FORBIDDEN_GATE_MARKERS) {
    check(
      `src/${f.name} does not re-implement the app's ${marker} gate`,
      !withoutComments(f.text).includes(marker),
      "The gates run server side in the app. There is exactly one copy of each.",
    );
  }
}

// ---------------------------------------------------------------------------
// G. The legacy shim stays isolated and keeps its removal condition.
// ---------------------------------------------------------------------------

const legacyPath = join(SRC, "legacy-era.ts");
let legacyText = "";
try {
  legacyText = readFileSync(legacyPath, "utf8");
} catch {
  legacyText = "";
}

if (legacyText) {
  check(
    "The legacy shim documents its removal condition",
    /REMOVAL CONDITION/.test(legacyText) && /probe-report/.test(legacyText),
    "A shim without a stated removal condition becomes permanent by default.",
  );
  // Counting FILES was wrong: two calls inside one file kept the count at 1 and a
  // planted second call site went undetected. Count the calls themselves.
  const callSites = files
    .filter((f) => f.name !== "legacy-era.ts")
    .flatMap((f) =>
      [...codeOnly(f.text).matchAll(/createLegacyEraHandler\s*\(/g)].map(() => f.name),
    );
  check(
    "The legacy shim has exactly one call site",
    callSites.length === 1,
    `Call sites: ${callSites.join(", ") || "(none)"}. More than one and it is no longer a seam.`,
  );
  // These are STRING option values, so comments are stripped but literals are
  // kept. Reading the raw file instead would let the module header's prose
  // satisfy the assertion, which is exactly how a planted era switch survived.
  const legacyCode = withoutComments(readFileSync(legacyPath, "utf8"));
  const handlerCode = withoutComments(readFileSync(join(SRC, "mcp-handler.ts"), "utf8"));

  check(
    'Only the shim serves prior-era traffic (legacy: "stateless" appears once, in the shim)',
    (legacyCode.match(/legacy:\s*"stateless"/g) ?? []).length === 1 &&
      files
        .filter((f) => f.name !== "legacy-era.ts")
        .every((f) => !/legacy:\s*"stateless"/.test(withoutComments(f.text))),
    'The primary handler must be legacy: "reject" so deleting the shim leaves a modern-only server.',
  );
  check(
    'The primary handler is modern-only (legacy: "reject")',
    /legacy:\s*"reject"/.test(handlerCode) && !/legacy:\s*"stateless"/.test(handlerCode),
  );
}

// ---------------------------------------------------------------------------
// H. The client leg serves BOTH measured identity paths.
// ---------------------------------------------------------------------------

// Each of these is a measured requirement of a real client, not a preference.
// Removing either would lock out a client that was watched needing it, so both
// are asserted to STAY. The dates are the captures to argue with.
const indexText = files.find((f) => f.name === "index.ts")?.text ?? "";

// The option and its boolean are executable code, so codeOnly() applies; this
// file's own comments discuss the option by name and must not satisfy it.
check(
  "CIMD stays enabled (claude.ai, measured 2026-07-30, never calls /register)",
  /clientIdMetadataDocumentEnabled:\s*true/.test(codeOnly(indexText)),
  "claude.ai identifies itself by a client metadata URL. Without CIMD it cannot connect.",
);

// "/register" is a STRING option value, so withoutComments() keeps it while
// still refusing to let the comment block above the option satisfy the check.
check(
  'DCR stays configured at "/register" (Grok Build 1.0.13 rmcp, measured 2026-09-07)',
  /clientRegistrationEndpoint:\s*"\/register"/.test(withoutComments(indexText)),
  "Grok's rmcp client cannot do CIMD; without RFC 7591 registration it cannot " +
    "mint a client identity and stops before opening a browser.",
);

// --- the agent key path, ruling 37 -----------------------------------------

/*
 * A SECOND DOOR IS THE MOST DANGEROUS THING IN THIS REPO, so it is asserted
 * harder than the first. The law does not forbid it: an agent key is client-leg
 * IDENTITY, the same category as an OAuth grant, and it changes who may ASK
 * rather than what the answer is. What the law does forbid is a second door
 * that reaches the publish machinery by a different route, or that carries any
 * right the first one does not.
 */
/*
 * TWO VIEWS OF THE SAME SOURCE, and the choice per assertion is deliberate.
 *
 * `codeOnly` blanks every string and template literal, which is right for
 * STRUCTURE (is the admin check called, is there a second handleMcp) and wrong
 * for anything whose subject IS a string: the audit key, the rate-limit
 * identity, `rights: "operator"`. Those need `withoutComments`, which keeps
 * string values and still refuses to let this file's own prose satisfy a check.
 * That is the same split the `/register` assertion above makes, for the same
 * reason, and getting it backwards cost five failing assertions on the first
 * run of this block.
 */
const authText = files.find((f) => f.name === "auth.ts")?.text ?? "";
const authCode = codeOnly(authText);
const indexCode = codeOnly(indexText);
const authStrings = withoutComments(authText);
const indexStrings = withoutComments(indexText);

check(
  "the agent key path is scoped to the MCP route",
  /url\.pathname === MCP_ROUTE/.test(indexCode),
  "An agent key is an alternative to HOLDING a grant, not to the protocol " +
    "around one. Widened past /mcp it would sit in front of the consent flow " +
    "and the token endpoint, which are the provider's.",
);

check(
  "the agent path reaches the tool surface through the SAME handleMcp",
  (indexCode.match(/handleMcp\(request, env, ctx\)/g) ?? []).length === 2,
  "Two handlers would be two places the tool surface is defined, and the first " +
    "time they disagreed one door would offer something the other did not. " +
    "Expected exactly two call sites: the OAuth one and the agent one.",
);

check(
  "the agent path is rate limited under its own identity",
  /checkRateLimit\(env, `agent:\$\{principal\}`\)/.test(indexStrings),
  "Sharing the operator's bucket would let one agent rate limit Dustin out of " +
    "his own server. Both doors have locks, and they are different locks.",
);

check(
  "the principal comes from the matched SECRET NAME, never from the request",
  /*
   * THE CHAIN, not the absence of a word. The first version asserted that
   * "principal" appeared nowhere before the `agentPrincipal(` call, which is
   * false for an innocent reason: `agentHandler` declares a `principal`
   * parameter above the call site, so the assertion failed on correct code.
   *
   * What matters is where the value COMES FROM. `agentPrincipal` derives it
   * from the matched secret's NAME, and index.ts passes that return value
   * straight through to the handler. Nothing reads it off the request.
   */
  /name\.slice\(AGENT_KEY_PREFIX\.length\)/.test(authCode) &&
    /const principal = await agentPrincipal\(/.test(indexCode) &&
    /agentHandler\(request, env, ctx, principal\)/.test(indexCode),
  "If a caller could name itself, the audit line would record whatever it " +
    "typed. The principal must be a property of WHICH configured secret the " +
    "presented key matched.",
);

check(
  "an empty or blank agent secret cannot match",
  /typeof value !== "string" \|\| !value\.trim\(\)/.test(authStrings),
  "A secret accidentally set to the empty string would otherwise become a key " +
    "that any bearer satisfies. Fail closed.",
);

check(
  "the agent comparison goes through secretsMatch, never a string compare",
  /await secretsMatch\(presented, value\)/.test(authCode),
  "A raw compare leaks the secret's length through the loop bound. " +
    "secretsMatch hashes both sides to a fixed 32 bytes first.",
);

/*
 * THE AUDIT LINE, AND WHAT IT MUST NOT CARRY. The principal is the point of the
 * line; the negative half matters more, because a log carrying the key would
 * move a secret into a sink nobody treats as one.
 */
check(
  "the audit line records the principal",
  /audit: "agent-key-accepted"/.test(indexStrings) && /principal,/.test(indexStrings),
  "Ruling 37: the call is logged as its own principal. Without it the second " +
    "door is indistinguishable from the first in the logs.",
);

check(
  "the audit line carries no key material",
  !/authorization/i.test(
    indexStrings.slice(
      indexStrings.indexOf('audit: "agent-key-accepted"'),
      indexStrings.indexOf("checkRateLimit(env, `agent:"),
    ),
  ),
  "The Authorization header, the key, or any slice or length of it must never " +
    "reach a log line.",
);

/*
 * THE REFUSAL THE RULING NAMES, asserted where this Worker can carry it: it
 * does not implement first-publish policy and must not start.
 *
 * "First publish stays Dustin's" is enforced by the operator API, which grants
 * OPERATOR_TOKEN `{ kind: "operator" }` and refuses first publication on that
 * actor kind. The wrapper's job is to have no opinion, so what is asserted here
 * is that the agent door introduces no second credential and no claim to admin.
 */
check(
  "the agent path mints no credential of its own",
  !/OPERATOR_TOKEN/.test(indexCode),
  "index.ts must never touch the API credential. If the agent door chose a " +
    "token, the API's actor kind would become this Worker's decision and " +
    "first-publish policy would move here with it.",
);

check(
  "no admin right is named on the agent path, and operator is",
  !/isAdminUser\([^)]*principal/.test(indexCode) && /rights: "operator"/.test(indexStrings),
  "Ruling 37: operator rights only, never admin. The agent path must not " +
    "consult the admin check at all, because passing it would be the bug.",
);

// ---------------------------------------------------------------------------

console.log(`\ncheck:wrapper: ${assertions - failures}/${assertions} assertions passed`);
if (failures) {
  console.error(`\n${failures} failed. The wrapper's no-policy law is not currently provable.`);
  process.exit(1);
}
console.log(
  `The no-policy law holds: no app imports, no app bindings, ${EXPECTED_TOOLS.length} tools, one API seam.`,
);

/*
 * PLANTED VIOLATIONS. See scripts/plant-violations.sh, which is the harness that
 * proves this gate actually fails. Run it with `npm run check:wrapper:plant`.
 *
 * A gate never observed failing has not been verified, and that applies to the
 * HARNESS too. The first attempt at this reverted with `git checkout -- .`, which
 * does not touch untracked files, so each plant's residue survived into the next
 * one and every result after the first was contaminated: they failed, but not
 * necessarily for the reason under test. The harness now snapshots and restores
 * the exact files it edits, so each plant is independent, and it verifies the
 * baseline is green again afterwards.
 *
 * That mistake also destroyed uncommitted work, which is the hazard
 * dustinedwards/workflow-mainline.md records as one of this project's recurring
 * failures. Commit before running a harness that reverts anything.
 */
