#!/usr/bin/env bash
#
# Proves check:wrapper actually fails. A gate never observed failing has not been
# verified.
#
# WHY THIS SNAPSHOTS INSTEAD OF USING GIT. The first version of this harness
# reverted with `git checkout -- .`, which does not touch UNTRACKED files. Every
# plant that edited a then-untracked module survived into the next plant, so the
# results after the first were contaminated: the gate failed, but not necessarily
# for the reason under test. It also destroyed uncommitted work, which is the
# hazard dustinedwards/workflow-mainline.md records as one of this project's
# recurring failures.
#
# So: snapshot the exact files each plant edits, restore from the snapshot, and
# assert the baseline is green again between every plant. Independent by
# construction, and it cannot eat anything.
#
# Exit codes are read DIRECTLY, never through a pipe. `tail` masks them and has
# already reported success on a failing run elsewhere in this portfolio.

set -u
cd "$(dirname "$0")/.." || exit 2

SNAP="$(mktemp -d)"
trap 'rm -rf "$SNAP"' EXIT

FILES="src/tools.ts src/api-client.ts src/legacy-era.ts src/mcp-handler.ts wrangler.jsonc"

snapshot() {
  for f in $FILES; do
    mkdir -p "$SNAP/$(dirname "$f")"
    cp "$f" "$SNAP/$f"
  done
}

restore() {
  for f in $FILES; do cp "$SNAP/$f" "$f"; done
}

gate() {
  node scripts/check-wrapper.mjs >/dev/null 2>&1
  echo $?
}

pass=0
missed=0
contaminated=0

expect_fail() {
  label="$1"
  code=$(gate)
  if [ "$code" = "1" ]; then
    echo "  CAUGHT (exit 1)   $label"
    pass=$((pass + 1))
  else
    echo "  MISSED (exit $code)   $label   <-- the gate does NOT catch this"
    missed=$((missed + 1))
  fi
  restore
  # The baseline must be green again, or the next result means nothing.
  back=$(gate)
  if [ "$back" != "0" ]; then
    echo "         !! baseline did not return to green (exit $back): results after this are contaminated"
    contaminated=$((contaminated + 1))
  fi
}

snapshot

base=$(gate)
if [ "$base" != "0" ]; then
  echo "BASELINE NOT GREEN (exit $base). Fix the tree before trusting anything below."
  exit 2
fi
echo "baseline: exit 0 (green)"
echo

# 1. A forbidden binding. A D1 database would be a second route to app data.
python3 -c "
p='wrangler.jsonc'; s=open(p,encoding='utf-8').read()
s=s.replace('\"kv_namespaces\": [', '\"d1_databases\": [{\"binding\":\"DB\",\"database_name\":\"x\",\"database_id\":\"x\"}],\n\t\"kv_namespaces\": [',1)
open(p,'w',encoding='utf-8',newline='').write(s)"
expect_fail "1. d1_databases binding added"

# 2. Tool surface drift. A renamed tool no longer mirrors the API.
python3 -c "
p='src/tools.ts'; s=open(p,encoding='utf-8').read()
s=s.replace('    name: \"sync_status\",','    name: \"pipeline_status\",',1)
open(p,'w',encoding='utf-8',newline='').write(s)"
expect_fail "2. tool renamed away from the API's five"

# 3. The API-leg credential read from a second module.
python3 -c "
p='src/tools.ts'; s=open(p,encoding='utf-8').read()
s=s.replace('async function run(','function leak(e){ return e.OPERATOR_TOKEN; }\n\nasync function run(',1)
open(p,'w',encoding='utf-8',newline='').write(s)"
expect_fail "3. OPERATOR_TOKEN read outside api-client.ts"

# 4. A policy DECISION. Branching on publish state duplicates the API's rule.
python3 -c "
p='src/tools.ts'; s=open(p,encoding='utf-8').read()
s=s.replace('  try {','  if (args.firstPublished === null) { throw new Error(\"no\"); }\n  try {',1)
open(p,'w',encoding='utf-8',newline='').write(s)"
expect_fail "4. code branches on firstPublished"

# 5. Hardcoded API path. Would survive a config change and hit the wrong env.
python3 -c "
p='src/api-client.ts'; s=open(p,encoding='utf-8').read()
s=s.replace('fetch(env.OPERATOR_API_URL, {','fetch(\"https://dustinedwards.dustin-edwards.workers.dev/api/operator\", {',1)
open(p,'w',encoding='utf-8',newline='').write(s)"
expect_fail "5. operator API path hardcoded in source"

# 6. A shim with no stated removal condition becomes permanent by default.
python3 -c "
p='src/legacy-era.ts'; s=open(p,encoding='utf-8').read()
s=s.replace('REMOVAL CONDITION','(note removed)',1)
open(p,'w',encoding='utf-8',newline='').write(s)"
expect_fail "6. removal condition deleted from the shim"

# 7. Primary handler in compatibility mode. Deleting the shim would then NOT
#    leave a modern-only server, which is the shim's whole justification.
python3 -c "
p='src/mcp-handler.ts'; s=open(p,encoding='utf-8').read()
s=s.replace('MCP_ROUTE, legacy: \"reject\"','MCP_ROUTE, legacy: \"stateless\"',1)
open(p,'w',encoding='utf-8',newline='').write(s)"
expect_fail "7. primary handler switched to legacy: stateless"

# 8. A non-allowlisted outbound host.
python3 -c "
p='src/tools.ts'; s=open(p,encoding='utf-8').read()
s=s.replace('async function run(','const u = \"https://evil.example.com/exfil\";\n\nasync function run(',1)
open(p,'w',encoding='utf-8',newline='').write(s)"
expect_fail "8. non-allowlisted outbound host"

# 9. Re-implementing one of the app's gates.
python3 -c "
p='src/tools.ts'; s=open(p,encoding='utf-8').read()
s=s.replace('async function run(','const g = publiclyVisible;\n\nasync function run(',1)
open(p,'w',encoding='utf-8',newline='').write(s)"
expect_fail "9. app gate re-implemented (publiclyVisible)"

# 10. The shim gaining a second call site stops it being a seam.
python3 -c "
p='src/mcp-handler.ts'; s=open(p,encoding='utf-8').read()
s=s.replace('  const factory = buildServer(env);','  const factory = buildServer(env);\n  if (false) { createLegacyEraHandler(factory, MCP_ROUTE); }',1)
open(p,'w',encoding='utf-8',newline='').write(s)"
expect_fail "10. second call site for the legacy shim"

# 11. Removing the policy statement from the tool descriptions. This is the
#     asymmetric one: describing the policy is REQUIRED, enforcing it is banned.
python3 -c "
p='src/tools.ts'; s=open(p,encoding='utf-8').read()
s=s.replace('first-publish-requires-admin','(policy name removed)')
open(p,'w',encoding='utf-8',newline='').write(s)"
expect_fail "11. first-publish policy dropped from tool descriptions"

echo
echo "planted 11: $pass caught, $missed missed, $contaminated contaminated"
final=$(gate)
echo "final baseline: exit $final"
if [ "$missed" != "0" ] || [ "$contaminated" != "0" ] || [ "$final" != "0" ]; then
  exit 1
fi
echo "check:wrapper is verified: every planted violation produced a real exit 1."
