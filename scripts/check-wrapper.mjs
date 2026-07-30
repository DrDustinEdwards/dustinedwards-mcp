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

import { readFileSync, readdirSync } from "node:fs";
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

/** Strip comments and string literals: assertions about CODE must not match prose. */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '""')
    .replace(/"(?:\\.|[^\\"])*"/g, '""')
    .replace(/'(?:\\.|[^\\'])*'/g, '""');
}

const config = readJsonc(join(ROOT, "wrangler.jsonc"));
const files = sourceFiles();

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

const configText = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
for (const name of FORBIDDEN_NAMES) {
  check(
    `wrangler.jsonc does not reference ${name}`,
    !configText.includes(name),
    `${name} belongs to the app, not to the wrapper.`,
  );
  for (const f of files) {
    check(
      `src/${f.name} does not reference ${name}`,
      !codeOnly(f.text).includes(name),
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
    // Documentation links in comments are fine; only flag hosts in real code.
    if (!codeOnly(f.text).includes(host)) continue;
    check(
      `src/${f.name} outbound host ${host} is allowlisted`,
      ALLOWED_HOSTS.includes(host),
      "Add it to ALLOWED_HOSTS here only if it is genuinely required, and say why.",
    );
  }
}

check(
  "The operator API URL comes from config, not a literal in source",
  files.every((f) => !codeOnly(f.text).includes("/api/operator")),
  "Hardcoding it would survive a config change and reach the wrong environment.",
);

// ---------------------------------------------------------------------------
// E. The tool surface mirrors the API and nothing more.
// ---------------------------------------------------------------------------

const toolsText = readFileSync(join(SRC, "tools.ts"), "utf8");
const EXPECTED_TOOLS = ["list_posts", "get_post", "save_post", "delete_post", "sync_status"];
const declared = [...toolsText.matchAll(/^\s{4}name:\s*"([a-z_]+)",$/gm)].map((m) => m[1]);

check(
  "The five tools are exactly the operator API's tools",
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
const tokenHolders = files.filter((f) => codeOnly(f.text).includes("OPERATOR_TOKEN")).map((f) => f.name);
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
      !codeOnly(f.text).includes(marker),
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
  const legacyUsers = files
    .filter((f) => f.name !== "legacy-era.ts" && codeOnly(f.text).includes("createLegacyEraHandler"))
    .map((f) => f.name);
  check(
    "The legacy shim has exactly one call site",
    legacyUsers.length === 1,
    `Called from: ${legacyUsers.join(", ") || "(nowhere)"}. More than one and it is no longer a seam.`,
  );
  check(
    'Only the shim serves prior-era traffic (legacy: "stateless" appears once)',
    (readFileSync(legacyPath, "utf8").match(/legacy:\s*"stateless"/g) ?? []).length === 1 &&
      files
        .filter((f) => f.name !== "legacy-era.ts")
        .every((f) => !/legacy:\s*"stateless"/.test(codeOnly(f.text))),
    "The primary handler must be legacy: \"reject\" so deleting the shim leaves a modern-only server.",
  );
  check(
    'The primary handler is modern-only (legacy: "reject")',
    /legacy:\s*"reject"/.test(readFileSync(join(SRC, "mcp-handler.ts"), "utf8")),
  );
}

// ---------------------------------------------------------------------------

console.log(`\ncheck:wrapper: ${assertions - failures}/${assertions} assertions passed`);
if (failures) {
  console.error(`\n${failures} failed. The wrapper's no-policy law is not currently provable.`);
  process.exit(1);
}
console.log("The no-policy law holds: no app imports, no app bindings, five tools, one API seam.");

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
