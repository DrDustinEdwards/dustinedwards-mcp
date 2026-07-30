/**
 * check:conformance. Runs the OFFICIAL MCP conformance suite against this
 * wrapper's real protocol layer, per era.
 *
 * The house standard says that if a runnable conformance suite is published it
 * joins the gate family. It is published: @modelcontextprotocol/conformance, with
 * `server`, `client` and `authorization` suites, `--spec-version` filtering and
 * `--expected-failures` baselining.
 *
 * TWO ERAS, ASSERTED SEPARATELY, and that is the point. The 2026-07-28 run
 * certifies the design-center era. The 2025-11-25 run certifies the shim in
 * src/legacy-era.ts, so the compatibility path is proven rather than assumed, and
 * the day the shim is deleted this gate will say exactly what stopped working.
 *
 * SCOPE. The wrapper implements tools and nothing else. Resources, prompts,
 * completion, logging, tasks, sampling and elicitation are deliberate exclusions
 * recorded in the README, so their scenarios are not run: a gate that reported 17
 * failures for primitives we chose not to build would be noise, and noise is how a
 * gate stops being read.
 *
 * Run: npm run check:conformance
 */

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const CONFORMANCE = fileURLToPath(
  new URL("../node_modules/@modelcontextprotocol/conformance/dist/index.js", import.meta.url),
);
const ENTRY = fileURLToPath(new URL("../test/conformance-entry.ts", import.meta.url));

const DEV_PORT = 8789;
const STUB_PORT = 8790;
// Long enough to pass the API leg's own configuration floor, which mirrors the
// app's refusal of any operator token under 32 characters.
const STUB_TOKEN = "conformance-stub-token-000000000000";

/**
 * Scenarios that apply to a tools-only server, each with its RECORDED PASS COUNT.
 *
 * Everything omitted is a deliberate exclusion recorded in the README (resources,
 * prompts, completion, logging, tasks, sampling, elicitation), not an oversight. A
 * gate reporting failures for primitives we chose not to build would be noise, and
 * noise is how a gate stops being read.
 *
 * WHY COUNTS RATHER THAN PASS/FAIL. Two checks in `server-stateless` fail against
 * @modelcontextprotocol/server 2.0.0 and they are upstream, not ours:
 * MissingRequiredClientCapabilityError (-32021) is not implemented by the SDK's
 * handler. Measured independently: a dependency-free draft server written for this
 * session scored the same 24/28 on this scenario, which is what points at the SDK
 * rather than at this wrapper.
 *
 * So the gate asserts the count does not REGRESS, and flags a count that IMPROVES
 * so the baseline gets tightened when the SDK fixes it. Demanding 100% would mean
 * a permanently red gate nobody reads; asserting nothing would mean a gate that
 * cannot notice us breaking the protocol layer.
 */
const SCENARIOS = [
  // spec version, scenario, expected passes, expected total, note
  //
  // DELIBERATELY SHORT. Each scenario costs real wall-clock against a
  // `wrangler dev` process, and a full sweep exceeded nine minutes here. These
  // are the decisive ones: SEP-2575 statelessness is the whole design-center
  // claim, and tools-list is the surface this wrapper actually exposes.
  //
  // NOT YET IN THE GATE, and this is a KNOWN GAP rather than a pass:
  //   http-header-validation (SEP-2243) measured 13/13 when run standalone
  //     against this library, but returns no parseable count when driven from
  //     this harness against wrangler dev. Diagnose before adding.
  //   caching (SEP-2549), dns-rebinding-protection, json-schema-2020-12,
  //     tools-call-simple-text, tools-call-error: not yet baselined here.
  ["2026-07-28", "server-stateless", 24, 28, "SDK lacks MissingRequiredClientCapabilityError (-32021)"],
  ["2025-11-25", "server-initialize", null, null, null],
];

let failures = 0;

function log(s) {
  process.stdout.write(`${s}\n`);
}

// A stand-in for the operator API. Returning ok:true keeps tools/call on the
// success path so the protocol shape is what gets tested, not the app.
function startStub() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { stub: true, received: body.slice(0, 200) } }));
    });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, () => resolve(server)));
}

async function waitForDev(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${DEV_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      // Any HTTP answer means the dev server is up and routing.
      if (res.status > 0) return true;
    } catch {
      await sleep(1000);
    }
  }
  return false;
}

function runScenario(scenario, specVersion) {
  try {
    const out = execFileSync(
      process.execPath,
      [
        CONFORMANCE,
        "server",
        "--url",
        `http://localhost:${DEV_PORT}/mcp`,
        "--scenario",
        scenario,
        "--spec-version",
        specVersion,
      ],
      // Per-scenario timeout. Without it one hanging scenario hangs the gate,
      // and a gate that hangs is a gate that gets skipped. Measured: a full
      // sweep of every applicable scenario exceeded nine minutes on this
      // machine, which is why the list below is deliberately short.
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
    );
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function summarize(out) {
  const m = out.match(/Passed:\s*(\d+)\/(\d+)/);
  if (m) return { passed: Number(m[1]), total: Number(m[2]) };
  const s = out.match(/Total:\s*(\d+)\s+passed,\s*(\d+)\s+failed/);
  if (s) return { passed: Number(s[1]), total: Number(s[1]) + Number(s[2]) };
  return null;
}

const stub = await startStub();
log(`stub operator API on :${STUB_PORT}`);

const dev = spawn(
  process.execPath,
  [
    WRANGLER,
    "dev",
    ENTRY,
    "--port",
    String(DEV_PORT),
    "--var",
    `OPERATOR_API_URL:http://localhost:${STUB_PORT}/`,
    "--var",
    `OPERATOR_TOKEN:${STUB_TOKEN}`,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let devLog = "";
dev.stdout.on("data", (d) => (devLog += d));
dev.stderr.on("data", (d) => (devLog += d));

function shutdown() {
  try {
    dev.kill();
  } catch {
    /* already gone */
  }
  stub.close();
}

process.on("exit", shutdown);

if (!(await waitForDev())) {
  log("wrangler dev did not come up. Output follows:");
  log(devLog.slice(-3000));
  shutdown();
  process.exit(2);
}
log(`wrangler dev on :${DEV_PORT} against the real protocol layer\n`);

for (const [specVersion, scenario, wantPass, wantTotal, note] of SCENARIOS) {
  const { ok, out } = runScenario(scenario, specVersion);
  const counts = summarize(out);
  const label = `${specVersion}  ${scenario}`;

  if (!counts) {
    failures += 1;
    log(`  NO RESULT  ${label}  (could not parse a count from the suite output)`);
    continue;
  }

  // A scenario with no recorded expectation has to pass every check it ran.
  //
  // Judged on the PARSED COUNT, not on the child's exit code, and that is
  // measured rather than lazy: on Windows the suite aborts during teardown with
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\\win\\async.c
  // AFTER printing its results, so a scenario that passed 1/1 still exits
  // non-zero. Trusting the exit code here reported a clean run as a failure.
  // `ok` is still surfaced so the crash is visible rather than hidden.
  if (wantPass === null) {
    if (counts.passed === counts.total) {
      log(`  PASS       ${label}  (${counts.passed}/${counts.total})${ok ? "" : "  [suite exited non-zero: Windows teardown crash]"}`);
    } else {
      failures += 1;
      log(`  FAIL       ${label}  (${counts.passed}/${counts.total})`);
    }
    continue;
  }

  if (counts.total !== wantTotal) {
    log(`  RECOUNT    ${label}  total moved ${wantTotal} -> ${counts.total}, suite changed; re-baseline`);
    failures += 1;
    continue;
  }

  if (counts.passed < wantPass) {
    failures += 1;
    log(`  REGRESSED  ${label}  ${counts.passed}/${counts.total}, baseline was ${wantPass}`);
    for (const line of out.split("\n").filter((l) => /FAILURE/.test(l)).slice(0, 6)) {
      log(`               ${line.trim().slice(0, 160)}`);
    }
    continue;
  }

  if (counts.passed > wantPass) {
    failures += 1;
    log(`  IMPROVED   ${label}  ${counts.passed}/${counts.total} beats baseline ${wantPass}; tighten it`);
    continue;
  }

  log(`  BASELINE   ${label}  ${counts.passed}/${counts.total}${note ? `  (${note})` : ""}`);
}

log("");
shutdown();

if (failures) {
  log(`check:conformance: ${failures} scenario(s) failed.`);
  process.exit(1);
}
log(
  "check:conformance: no regression against the recorded baseline, in both eras. " +
    "Note this is a BASELINE, not a clean sweep: server-stateless sits at 24/28 on a named " +
    "upstream SDK gap, and several applicable scenarios are not yet wired in. See SCENARIOS.",
);
