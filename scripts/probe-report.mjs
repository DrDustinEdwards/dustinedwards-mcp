/**
 * Reads the probe's capture log out of KV and answers the two questions that
 * decide the wrapper's shape:
 *
 *   1. Which ERA does the client speak? `initialize` means legacy, so the
 *      compatibility shim in src/legacy-era.ts is load-bearing. `server/discover`
 *      means the shim's removal condition is met for that client.
 *   2. Does the client complete the spec's OAuth 2.1 resource server story?
 *      RFC 9728 protected resource metadata, then RFC 8414, then an authorize
 *      request carrying an RFC 8707 `resource` parameter and PKCE S256.
 *
 * Reads through `wrangler kv`, NOT through an HTTP endpoint on the Worker. The
 * probe deliberately has no control plane: a capture log that describes a
 * client's authentication behaviour should not be reachable from the internet,
 * and this way there is no probe credential to leak in the first place.
 *
 *   node scripts/probe-report.mjs
 *   node scripts/probe-report.mjs --phase auth    # flip the probe's phase
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NS = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(
    /^\s*\/\/.*$/gm,
    "",
  ),
).kv_namespaces.find((n) => n.binding === "PROBE_KV").id;

// Run wrangler's JS entry point with this node binary. Not `npx` (needs a shell,
// which node warns about and which would need escaping), and not the
// node_modules/.bin/wrangler.cmd shim, which node 24 refuses to spawnSync
// without a shell and fails with EINVAL. Measured on Windows 2026-07-30.
const CLI = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

const wrangler = (...args) =>
  execFileSync(process.execPath, [CLI, ...args, "--namespace-id", NS, "--remote"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const phaseFlag = process.argv.indexOf("--phase");
if (phaseFlag !== -1) {
  const want = process.argv[phaseFlag + 1];
  if (want !== "open" && want !== "auth") {
    console.error("--phase takes 'open' or 'auth'");
    process.exit(2);
  }
  wrangler("kv", "key", "put", "probe:phase", want);
  console.log(`probe phase set to ${want}`);
  process.exit(0);
}

const keys = JSON.parse(wrangler("kv", "key", "list", "--prefix", "capture:"))
  .map((k) => k.name)
  .sort();

// Clearing matters before a real measurement: synthetic curl checks land in the
// same log and would be read as client behaviour.
if (process.argv.includes("--reset")) {
  for (const k of keys) wrangler("kv", "key", "delete", k);
  try {
    wrangler("kv", "key", "delete", "probe:seq");
  } catch {
    /* already absent */
  }
  console.log(`cleared ${keys.length} captures`);
  process.exit(0);
}

if (!keys.length) {
  console.log("No captures yet. Connect a client to the probe's /mcp URL.");
  process.exit(0);
}

const rows = keys
  .map((k) => {
    try {
      return JSON.parse(wrangler("kv", "key", "get", k));
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => a.seq - b.seq);

let currentPhase = "open";
try {
  currentPhase = wrangler("kv", "key", "get", "probe:phase").trim() || "open";
} catch {
  /* unset means open */
}

console.log(`phase=${currentPhase}  captures=${rows.length}\n`);

console.log("USER AGENTS SEEN");
const agents = new Set(rows.map((r) => r.headers?.["user-agent"]).filter(Boolean));
for (const a of agents) console.log(`  ${a}`);
if (!agents.size) console.log("  (none reported a user-agent)");

// ---- Question 1: era -----------------------------------------------------
console.log("\nERA");
const opened = rows.filter((r) => r.rpcMethod === "initialize" || r.rpcMethod === "server/discover");
if (!opened.length) {
  console.log("  UNDETERMINED: neither initialize nor server/discover captured.");
} else {
  for (const r of opened) {
    const era = r.rpcMethod === "server/discover" ? "2026-07-28 (modern)" : "LEGACY";
    const declared =
      r.body?.params?.protocolVersion ??
      r.body?._meta?.["io.modelcontextprotocol/protocolVersion"] ??
      "(none)";
    const client = r.body?.params?.clientInfo?.name ?? r.headers?.["user-agent"] ?? "?";
    console.log(`  seq ${r.seq}: ${r.rpcMethod} -> ${era}, declared ${declared}, client ${client}`);
  }
}

// ---- 2026-07-28 required headers ----------------------------------------
const posts = rows.filter((r) => r.method === "POST" && r.path === "/mcp");
console.log(`\n2026-07-28 REQUIRED FIELDS (over ${posts.length} POSTs to /mcp)`);
for (const key of ["mcp-protocol-version", "mcp-method", "mcp-name"]) {
  console.log(`  ${key}: ${posts.filter((r) => r.headers?.[key] !== undefined).length}/${posts.length}`);
}
console.log(
  `  _meta protocolVersion: ${posts.filter((r) => r.body?._meta?.["io.modelcontextprotocol/protocolVersion"] !== undefined).length}/${posts.length}`,
);

console.log("\nSIGNALS REMOVED BY 2026-07-28 (presence proves a legacy client)");
for (const [name, present] of [
  ["notifications/initialized", rows.some((r) => r.rpcMethod === "notifications/initialized")],
  ["GET /mcp SSE stream", rows.some((r) => r.method === "GET" && r.path === "/mcp")],
  ["Mcp-Session-Id header", posts.some((r) => r.headers?.["mcp-session-id"] !== undefined)],
]) {
  console.log(`  ${present ? "PRESENT" : "absent "}  ${name}`);
}

// ---- Question 2: the OAuth 2.1 RS walk ----------------------------------
console.log("\nOAUTH 2.1 RESOURCE SERVER WALK");
for (const [label, match] of [
  ["RFC 9728 protected resource metadata", (r) => r.path.startsWith("/.well-known/oauth-protected-resource")],
  ["RFC 8414 authorization server metadata", (r) => r.path === "/.well-known/oauth-authorization-server"],
  ["DCR registration (RFC 7591)", (r) => r.path === "/register"],
  ["authorize request", (r) => r.path === "/authorize"],
  ["token exchange", (r) => r.path === "/token"],
]) {
  const hit = rows.find(match);
  console.log(`  ${hit ? "YES" : "no "}  ${label}${hit ? ` (seq ${hit.seq})` : ""}`);
}

const authorize = rows.find((r) => r.path === "/authorize");
if (authorize) {
  const q = authorize.query ?? {};
  console.log("\n  authorize query parameters:");
  for (const [k, v] of Object.entries(q)) {
    console.log(`    ${k} = ${k === "code_challenge" ? `${String(v).slice(0, 12)}...` : v}`);
  }
  console.log(`\n  RFC 8707 audience binding: ${q.resource ? `YES -> ${q.resource}` : "NOT SENT"}`);
  console.log(`  PKCE S256: ${q.code_challenge_method === "S256" ? "YES" : (q.code_challenge_method ?? "absent")}`);
} else {
  console.log("\n  authorize never reached, so RFC 8707 and PKCE remain UNMEASURED.");
}

console.log("\nRAW SEQUENCE");
for (const r of rows) {
  console.log(
    `  ${String(r.seq).padStart(3)} ${r.method.padEnd(5)} ${r.path}${r.rpcMethod ? `  [${r.rpcMethod}]` : ""}`,
  );
}
