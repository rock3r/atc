# Releasing

Releases publish one public npm CLI package (`android-traffic-control`) and the matching portable Agent Plugins (`plugin.json`), Claude Code (`.claude-plugin/`), Codex (`.codex-plugin/`), and skill (`skills/atc/`) payload from the same tagged source tree.

## Lockstep Version Locations

Every release keeps the following files at the exact same semantic version:

1. `package.json` (`"version"`)
2. `plugin.json` (`"version"`)
3. `.claude-plugin/plugin.json` (`"version"`)
4. `.codex-plugin/plugin.json` (`"version"`)
5. `skills/atc/SKILL.md` (`metadata.version`)
6. `skills/atc/skill-source.json` (`sources[0].version`, following [`rock3r/skill-provenance`](https://github.com/rock3r/skill-provenance))
7. `src/cli.mjs` (`ATC_VERSION`)
8. `src/mcp.mjs` (`serverInfo.version`)

Use `tools/check-versions.sh` to inspect or bump all 8 locations in one command:

```bash
# Verify all manifests match package.json (or an explicit version):
./tools/check-versions.sh
./tools/check-versions.sh 1.0.0

# Bump all 8 locations and update skill-source.json fetchedAt:
./tools/check-versions.sh --set 1.1.0
```

## One-time npm Trusted Publishing Setup

1. Publish the repository at `https://github.com/rock3r/atc` and set that URL as `origin`. npm provenance requires `repository.url` in `package.json` (`git+https://github.com/rock3r/atc.git`) to match.
2. Create a GitHub environment named `npm` on `rock3r/atc` (require reviewer approval if desired).
3. If `android-traffic-control` has not been published to npm yet, bootstrap the initial package creation once (or create the package entry on npmjs.com), then configure **npm Trusted Publishing** for:
   - GitHub owner/repository: `rock3r/atc`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
4. Set package publishing access on npmjs.com to require two-factor authentication and disallow traditional tokens so GitHub Actions publishes via OIDC with provenance (`id-token: write`, `npm@11`, `--access public`).

## Release Gates

For every `v*` tag, `.github/workflows/release.yml` independently requires:

- full syntax and test checks (`npm run check`) on Ubuntu, macOS, and Windows;
- exact git tag, `package.json`, portable plugin, Claude plugin, Codex plugin, `SKILL.md` frontmatter, `skill-source.json` provenance sidecar, CLI `ATC_VERSION`, and MCP server version agreement (`npm run release:verify -- vX.Y.Z`);
- one npm tarball built once (`npm pack`), then installed into a clean global prefix and smoke-tested (`atc --version`, `atc --help`, `atc guide`, `atc guide traps --json`, plus native OS shim execution) on Ubuntu, macOS, and Windows (`npm run package:smoke -- release`).

Only the tarball that passed the 3-OS verification matrix is published to npm and attached to the GitHub Release.

## Cutting a Release

1. Bump the version across all manifests, skill frontmatter/provenance, CLI, and MCP:
   ```bash
   ./tools/check-versions.sh --set 1.1.0
   ```
2. Run the full verification suite locally:
   ```bash
   npm run check
   npm run release:verify -- v1.1.0
   npm run package:smoke
   ./tools/check-versions.sh 1.1.0
   ```
3. Commit and push to `main`:
   ```bash
   git commit -am "Release 1.1.0"
   git push origin main
   ```
4. Create and push an annotated `v<version>` tag:
   ```bash
   git tag -a v1.1.0 -m "v1.1.0"
   git push origin v1.1.0
   ```
