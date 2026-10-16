# Releasing

Each release publishes the public npm CLI package (`@rock3r/atc`) from a tagged source tree. That tree also contains matching Agent Plugins (`plugin.json`), Claude Code (`.claude-plugin/`), Codex (`.codex-plugin/`), and skill (`skills/atc/`) files.

## Keep eight version values equal

Set the same semantic version in these locations for every release:

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

## Configure npm trusted publishing once

1. Publish the repository at `https://github.com/rock3r/atc` and use that URL for `origin`. Set `package.json`'s `repository.url` to `git+https://github.com/rock3r/atc.git` for npm provenance.
2. Create a GitHub environment named `npm` on `rock3r/atc` (require reviewer approval if desired).
3. If npm has no `@rock3r/atc` package, create it once with `npm login && npm publish --access public`. Configure npm Trusted Publishing with these values:
   - GitHub owner/repository: `rock3r/atc`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
   - Allowed actions: check **Allow `npm publish`**
4. On npmjs.com, require two-factor authentication for publishing and disable traditional tokens. GitHub Actions uses OpenID Connect (OIDC) with provenance (`id-token: write`, `npm@11`, `--access public`).

## The release workflow checks each tag

For each `v*` tag, `.github/workflows/release.yml` runs these checks:

1. Run syntax checks and tests (`npm run check`) on Ubuntu, macOS, and Windows.
2. Check version agreement with `npm run release:verify -- vX.Y.Z`. The git tag must match `package.json`, the portable, Claude, and Codex plugins, and `SKILL.md` frontmatter. It must also match `skill-source.json`, CLI `ATC_VERSION`, and the MCP server version.
3. Build one tarball with `npm pack`. Install that tarball into a clean global prefix on Ubuntu, macOS, and Windows. Run `npm run package:smoke -- release` on each OS. Checks include `atc --version`, `atc --help`, `atc guide`, `atc guide traps --json`, and native OS shim execution.

The workflow publishes the tarball to npm and attaches it to the GitHub Release only after all three operating systems pass verification.

## Create a release

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
