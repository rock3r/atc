#!/bin/sh
# Check (or with --set, write) the release version across package.json, every plugin manifest,
# the skill frontmatter and provenance sidecar, the CLI constant, and the MCP server metadata.
#   tools/check-versions.sh                check against package.json version
#   tools/check-versions.sh 1.0.0          fail if any manifest differs from 1.0.0
#   tools/check-versions.sh --set 1.1.0    write the version everywhere in lockstep
set -eu
cd "$(dirname "$0")/.."

json_files="package.json plugin.json .claude-plugin/plugin.json .codex-plugin/plugin.json skills/atc/skill-source.json"

if [ "${1:-}" = "--set" ]; then
  v="${2:?version}"
  today="$(date -u +%Y-%m-%d)"
  for f in $json_files; do
    sed -i.bak -E "s/\"version\": \"[^\"]+\"/\"version\": \"$v\"/" "$f" && rm "$f.bak"
  done
  sed -i.bak -E "s/\"fetchedAt\": \"[^\"]+\"/\"fetchedAt\": \"$today\"/" skills/atc/skill-source.json && rm skills/atc/skill-source.json.bak
  sed -i.bak -E "s/^  version: \"[^\"]+\"/  version: \"$v\"/" skills/atc/SKILL.md && rm skills/atc/SKILL.md.bak
  sed -i.bak -E "s/^export const ATC_VERSION = \"[^\"]+\";/export const ATC_VERSION = \"$v\";/" src/cli.mjs && rm src/cli.mjs.bak
  sed -i.bak -E "s/^          version: \"[^\"]+\",/          version: \"$v\",/" src/mcp.mjs && rm src/mcp.mjs.bak
  echo "set version $v"
  exit 0
fi

want="${1:-$(sed -nE 's/.*"version": "([^"]+)".*/\1/p' package.json | head -1)}"
bad=0

for f in $json_files; do
  got="$(sed -nE 's/.*"version": "([^"]+)".*/\1/p' "$f" | head -1)"
  [ "$got" = "$want" ] || { echo "$f has version $got, want $want" >&2; bad=1; }
done

got="$(sed -nE 's/^  version: "([^"]+)"/\1/p' skills/atc/SKILL.md)"
[ "$got" = "$want" ] || { echo "skills/atc/SKILL.md has version $got, want $want" >&2; bad=1; }

got="$(sed -nE 's/^export const ATC_VERSION = "([^"]+)";/\1/p' src/cli.mjs)"
[ "$got" = "$want" ] || { echo "src/cli.mjs has version $got, want $want" >&2; bad=1; }

got="$(sed -nE 's/^          version: "([^"]+)",/\1/p' src/mcp.mjs)"
[ "$got" = "$want" ] || { echo "src/mcp.mjs has version $got, want $want" >&2; bad=1; }

exit $bad
