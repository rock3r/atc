# atc workflow guide

Guides: `workflow` (this page) · `profiles` · `snapshots` · `multi-agent` · `traps` (`atc guide <topic>`).

`atc` coordinates devices and builds. You never hand it a shell command: you ask for a **typed operation** (`atc exec <system> <op>`, `atc batch`, or the `atc_*` MCP tools) and `atc` builds and runs the exact command itself. Run `atc exec --help` for the full catalog.

## 1. Check fleet capacity before claiming a device

Run `atc status` to inspect available RAM, free disk, used Android emulator slots (`emu slots`), used iOS Simulator slots (`sim slots`), used build slots (`build slots`), running devices, offline AVDs/Simulators, active leases, and active builds.

Never run raw `emulator -avd`, `android emulator start`, `adb emu kill`, `adb kill-server`, `xcrun simctl boot`, `xcrun simctl shutdown`, `xcrun simctl erase`, `xcrun simctl delete`, `./gradlew --stop`, or `bazel shutdown`. `atc` owns the virtual device lifecycle and the shared build daemons, and will not do these on request. To remove the simulator this session currently leases, run `atc exec ios delete <udid>`. It refuses any other UDID.

## 2. Claim, run typed operations, snapshot, and free

1. **Claim a device** matching the platform and profile your task needs (skip this for pure builds):
   ```bash
   # Android emulator (default outside iOS-only directories)
   atc claim --type phone --api ">=35" --play --wait 300

   # iOS Simulator on macOS
   atc claim --ios --type phone --os ">=18.0" --wait 300
   ```
   If your agent host does not export a session ID, pass `--session <id>` or set `ATC_SESSION_ID=<id>`.
2. **Run builds and device work as typed operations**:
   ```bash
   # Pure builds: build slot + per-workspace lock, no device held
   atc exec gradle tasks :app:assembleDebug :app:assembleDebugAndroidTest --brief
   atc exec bazel build //app:main --config ci
   # Graph inspection is coordinated too. Compare artifact sha256 values; a green build is not closure equivalence.
   atc exec bazel query "kind('source file|generated file', deps(//:main))" --output label_kind --output-file out/main-sources.txt
   atc exec bazel query "kind('rule', deps(//:main))" --output xml --output-file out/main-rules.xml
   atc exec xcode build-for-testing --scheme App --project App.xcodeproj

   # Device-coupled builds use your lease (or claim one for the run with --claim)
   atc exec gradle tasks :app:connectedDebugAndroidTest
   atc exec gradle tasks :app:connectedDebugAndroidTest --claim --type phone --api ">=35"
   atc exec xcode test-without-building --scheme App --project App.xcodeproj

   # Android device ops
   atc exec android install app/build/outputs/apk/debug/app-debug.apk --replace
   atc exec android launch --package com.example.app --activity .MainActivity
   atc exec android permission --package com.example.app --permission android.permission.CAMERA --action grant
   atc exec android prop get ro.product.model
   atc exec android logcat --lines 200 --filter "MyTag:D" --filter "*:S"
   atc exec android screenshot out/home.png

   # iOS Simulator ops (macOS)
   atc exec ios install build/App.app
   atc exec ios launch com.example.App
   atc exec ios privacy --bundle-id com.example.App --service photos --action grant
   ```
   `atc` validates every value first and lists **all** problems at once (exit `7`, nothing ran). It injects the leased serial/UDID, shapes worker/RAM flags (`-Dorg.gradle.workers.max`, `--jobs`, `-jobs`), serializes builds on the same workspace, tracks the worker process group, and renews your lease while the op runs. Add `--json` for structured results and `--brief` on builds for a condensed summary with the full log on disk.
3. **Use `atc batch` for multi-step workflows** (dependencies, per-step `cwd` or `env`, scoped claims, or timeouts). Validate first:
   ```bash
   atc batch --file plan.json --validate
   atc batch --file plan.json
   ```
   Put compilation in its own step with no claim, and claim the device only for the steps that need it (`"claim": {"platform": "android", ...}`, then `"claim": {"reuse": "<stepId>"}` downstream).
4. **Use dual leases for Kotlin Multiplatform (KMP) tasks**: one session can hold **1 Android lease + 1 iOS lease** at once. Each op uses the lease of its platform. Pass `--android` or `--ios` to target one leg in `atc renew`, `atc snapshot`, or `atc free`.
5. **Reset state with snapshots** when a test mutates device storage:
   ```bash
   atc snapshot save clean_login
   # run destructive test steps...
   atc snapshot load clean_login
   ```
6. **Renew during long interactive pauses** when nothing is running through `atc`:
   ```bash
   atc renew --ttl 600
   ```
7. **Free the lease when your task finishes**:
   ```bash
   atc free
   ```
   Leaving the virtual device warm lets the next queued agent claim it in under 20 ms (`Tier 0`). Pass `atc free --stop` only when shutting down a specialized device (such as `xr` or `watch`) that other tasks will not reuse.

## 3. Rules that keep concurrent agents safe

| Rule | Why it matters | Command pattern |
|---|---|---|
| Request device and build work through `atc` | Raw `adb`, `./gradlew`, `simctl` or `xcodebuild` are not coordinated: they collide once a second device boots or another agent builds the same repo. | `atc exec android install app.apk` |
| Split compile and device phases | Holding a device while compiling starves other agents. `atc` prints a notice when a request mixes them. | Batch: assemble step (no claim) → device step (`claim`) |
| Opt in to physical phones explicitly | Default claims set `--kind emulator` so charging USB phones are never touched. | `atc claim --serial <id>` or `atc claim --ios --udid <id>` |
| Treat `--force` as taking responsibility | It only overrides build-value patterns, needs `--reason`, and is recorded; later failures point back to it. | `atc exec gradle tasks odd+task --force --reason "vendor plugin task"` |
| Respect exit code `5` (`ERESOURCE_EXCEEDED`) | Starting an emulator or saving a snapshot below the RAM/disk reserve risks host OOM or disk exhaustion; builds below the RAM floor wait or fail. | Run `atc free --stop` on idle devices. Only device boots/snapshot saves can be forced (with user approval); builds cannot. |
| Ask for missing operations | Unsupported operations are refused with the closest alternative. | Request it at https://github.com/rock3r/atc/issues |

## 4. Done checklist

- [ ] Every build, test, and device interaction ran as an `atc` operation.
- [ ] Temporary app state was cleaned up or restored from a snapshot.
- [ ] `atc free` released all held leases.
- [ ] `atc status` shows zero active leases, builds, or queue tickets for your session.
