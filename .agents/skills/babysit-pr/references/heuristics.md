# CI / Review Heuristics

"The project quality gate" means the pre-push/pre-merge commands from AGENTS.md
(for example `make test` / `make lint`, or `./gradlew check`).

## CI classification checklist

Treat as **branch-related** when logs clearly indicate a regression caused by the PR branch:

- Compile/typecheck/vet/lint failures in files or packages touched by the branch
- Deterministic unit/integration test failures in changed areas
- Static analysis findings introduced by the latest push (Detekt, staticcheck, gosec, golangci-lint, …)
- Snapshot output changes caused by UI/text changes in the branch
- Build script/Makefile/Gradle/config changes in the PR causing a deterministic failure

Treat as **likely flaky or unrelated** when evidence points to transient or external issues:

- DNS/network/proxy/registry timeout errors while fetching dependencies
- Runner image provisioning or startup failures
- GitHub Actions infrastructure/service outages
- Non-deterministic failures in concurrency or timing-sensitive tests (E2E, Docker, Postgres, …)
- Cloud/service rate limits or transient API outages

If uncertain, inspect the failed logs once before choosing rerun.

## Decision tree (fix vs rerun vs stop)

1. If PR is merged/closed: stop.
2. If there are failed checks:
   - Diagnose first.
   - If branch-related: **start fixing locally right away** — do not wait for other
     checks or bots to finish. But **do not push yet**.
   - If likely flaky/unrelated and all checks for the current SHA are terminal: rerun
     failed jobs.
   - If checks are still pending: wait for them, but if you already know something is
     broken you can start fixing it now.
3. As Codex, PR-AF (when present), or human reviewers post comments while you are
   mid-fix, **incorporate their fixes into the same local batch**. Do not wait idle.
   Do not push until bots and checks have finished so you have collected everything.
4. **Push once** only when: all fixes are done AND present review bots are done AND
   the project quality gate is green.
5. After the push (and before merging), **resolve every review bot comment thread on
   GitHub**. The PR must have no open bot threads at merge time.
6. If flaky reruns for the same SHA reach the configured limit (default 3): stop and report.

> **Cost rule**: every push can trigger review-bot runs. Batch CI failures, bot comments,
> and human review comments into a single commit before pushing.

PR-AF is presence-conditional: if the PR has a PR-AF check, `pr-af` label, or marked
PR-AF comments, treat it as a blocking merge gate. If none of those appear, ignore it.
Do not add the `pr-af` label unless a project addendum says to. The workflow is not
fleet-wide (Compose Pi only, as of 2026-09).

## Review comment agreement criteria

Address the comment when:

- The comment is technically correct.
- The change is actionable in the current branch.
- The requested change does not conflict with the user's intent or recent guidance.
- The change can be made safely without unrelated refactors.
- After fixing, run the project quality gate to confirm no regressions.

Do not auto-fix when:

- The comment is ambiguous and needs clarification.
- The request conflicts with explicit user instructions.
- The proposed change requires product/design decisions the user has not made.
- The change would weaken a security invariant from AGENTS.md — surface it instead.
- The codebase is in a dirty/unrelated state that makes safe editing uncertain.

## Stop-and-ask conditions

Stop and ask the user instead of continuing automatically when:

- The local worktree has unrelated uncommitted changes.
- `gh` auth/permissions fail.
- The PR branch cannot be pushed.
- CI failures persist after the flaky retry budget.
- Reviewer feedback requires a product decision or cross-team coordination.
- The project quality gate fails after an attempted fix and the cause is not obvious.
