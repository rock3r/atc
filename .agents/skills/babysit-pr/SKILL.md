---
name: babysit-pr
description: >
  Babysit a GitHub pull request after creation by continuously polling CI checks/workflow
  runs, new review comments, and mergeability state until the PR is ready to merge (or
  merged/closed). Diagnose failures, retry likely flaky failures up to 3 times, auto-fix
  and push branch-related issues when appropriate, and stop only when user help is required
  (e.g. CI infrastructure issues, exhausted flaky retries, or ambiguous/blocking review
  feedback). Use when the user asks to monitor a PR, watch CI, handle review comments, or
  keep an eye on failures and feedback on an open PR.
allowed-tools: Bash(python3 */skills/babysit-pr/scripts/*), Bash(gh pr *), Bash(gh run *), Bash(gh api *), Bash(git fetch *), Bash(git rebase *), Bash(git merge *), Bash(git checkout *), Bash(git switch *), Bash(git push *), Bash(git add *), Bash(git commit *), Bash(git remote *), Bash(git diff *), Bash(git log *), Bash(git status), Bash(git branch *), Bash(cd *), Bash(git worktree *), Bash(make *), Bash(./gradlew *), Read, Edit, Write
---

# PR Babysitter

Monitor a PR persistently until one of the terminal states is reached:

- PR merged or closed
- CI fully green, no unaddressed review comments, no merge conflicts
- A situation requiring user intervention

The watcher script is the **sole authority** on readiness. Do not manually poll or infer
readiness from raw `gh pr checks`, `gh pr view`, workflow-run, or flat-comment output;
those commands may be used only for targeted diagnosis after the watcher reports a
non-ready verdict, never to declare a PR green. If the script is unavailable, treat that
as a tooling defect, report it, and do not substitute ad-hoc polling.

"The project quality gate" means whatever AGENTS.md (or the repo's equivalent) requires
before push/merge — for example `make test` / `make lint`, or `./gradlew check`. Run that
gate locally on the PR head before every push and before merging.

If `references/addendum.md` exists next to this skill, follow it after resolving the PR
and **before** the first watcher `--once`. It is repo-specific overlay (not shared).

## Inputs

- No PR argument — infer from current branch (`--pr auto`)
- PR number — e.g. `123`
- PR URL — e.g. `https://github.com/OWNER/REPO/pull/123`

## Core workflow

0. **Before running any script**, output a single line so the user knows which PR this
   conversation is tracking — e.g. `Babysitting PR [#123](https://github.com/OWNER/REPO/pull/123)`.
   Resolve the PR from the user's input or the current branch first if needed. If invoked
   with an explicit PR number from `main` or an unrelated branch, check the PR branch out
   in an isolated worktree before touching anything.
1. Start with `--once` (default) — it blocks until something needs your attention, then returns.
2. Run the watcher to snapshot PR/CI/review state.
3. Inspect the `actions` list in the JSON output.
4. Diagnose CI failures — classify as branch-related (fix and push) vs. flaky (retry).
5. Process actionable review comments from trusted humans, Codex, and PR-AF (when present).
6. Verify mergeability on each loop.
7. After any push, relaunch the watcher in the same turn.
8. Continue until a terminal stop condition is reached.

## Key commands

```bash
python3 .agents/skills/babysit-pr/scripts/gh_pr_watch.py --pr auto --once
python3 .agents/skills/babysit-pr/scripts/gh_pr_watch.py --pr auto --snapshot
python3 .agents/skills/babysit-pr/scripts/gh_pr_watch.py --pr auto --watch
python3 .agents/skills/babysit-pr/scripts/gh_pr_watch.py --pr auto --retry-failed-now
python3 .agents/skills/babysit-pr/scripts/gh_pr_watch.py --pr 42 --once
```

## Stop conditions

| `actions` value | Meaning |
|---|---|
| `stop_pr_closed` | PR was merged or closed — done |
| `stop_ready_to_merge` | CI green, no blocking reviews, no conflicts — the only positive readiness verdict. Run the project quality gate locally on the PR head before merging |
| `stop_exhausted_retries` | Flaky reruns hit the retry limit — user must investigate |
| `stop_non_retryable_failure` | Terminal failure is not in retry-eligible workflows — diagnose/fix before continuing |
| `stop_pr_af_not_green` | PR-AF showed a sign of life and is not clean — do not merge |
| `stop_session_timeout` | `--max-session-minutes` elapsed (default 90 min) — stop and report |
| `diagnose_hung_check` | A pending check exceeded its hung threshold — stop and report |
| `diagnose_merge_conflict` | PR is merge-conflicted (`CONFLICTING` / `DIRTY`) — resolve before waiting on checks |
| `diagnose_branch_behind` | PR branch is behind its base — rebase onto the PR's base ref (batch with any pending fixes) |
| `diagnose_skipping_checks` | One or more checks completed with `neutral`/`skipping` — investigate why |
| `wait_codex` | Codex is still reviewing (👀 reaction present) — do not push or merge |
| `wait_pr_af` | PR-AF is present and still running (or labelled with no check yet) — do not push or merge |

Keep polling when CI is running (`idle`), when new review items arrive
(`process_review_comment`), when Codex or PR-AF is still running, or when CI is green
but the PR is awaiting approval.

Cursor Bugbot and CodeRabbit are gone. Leftover checks from either are ordinary CI
(neutral/skipping → `diagnose_skipping_checks`). Their comments are not actionable
review items.

## Post-merge cleanup (when `stop_pr_closed` and PR is merged)

1. If currently on the PR branch or inside its worktree, switch away first — check out
   `main`, or `cd` to the main checkout.
2. Remove the git worktree if the branch was checked out in one (`git worktree list`;
   worktrees live under `.worktrees/`). Do this before `git branch -D`.
3. Delete the local branch: `git branch -D <head_branch>` — but only if the local tip
   matches the watched PR's final head (or is an ancestor of it). If the branch carries
   commits that were never pushed, stop and report instead of deleting the only reference.

Never touch remote branches. Skip silently if the branch or worktree does not exist locally.

## Push discipline — batch all fixes before pushing (cost control)

Each push can trigger new review-bot runs. **Never push until all of the following are true:**

1. The project quality gate passes locally.
2. No review bot is still in progress — wait so their comments can be collected into the
   same push.
3. All currently visible actionable bot and human comments are in the pending local fix batch.

After pushing, resolve all bot threads on GitHub (or reply + resolve when no code change
is needed). No open bot threads should remain when the PR is merged.

If a bot finishes while you are mid-fix, incorporate those fixes into the same commit
before pushing.

## Conflict + behind batching (`CONFLICTING` / `DIRTY` / `diagnose_branch_behind`)

1. Do not push immediately. Wait until no review bot is in progress.
2. Snapshot latest status/comments.
3. Rebase onto the PR's actual base ref — `gh pr view <n> --json baseRefName`, fetch that
   base from the repository the PR *targets* (same-repo: `origin`; fork: the base repo's
   remote). Never assume `main`, and never rebase onto a stale or wrong-remote local ref.
4. Resolve conflicts and, in the same fix cycle, apply all actionable bot comments.
5. Run the project quality gate.
6. Push once with `--force-with-lease`.

## Review-bot merge gates

**Never merge while a present review bot is unclean.**

### Codex (always a gate)

Codex uses emoji reactions, not a CI check. A 👀 reaction from
`chatgpt-codex-connector[bot]` means it is reviewing (`codex_gate.reviewing` / `wait_codex`
— do not push or merge). Reaction removed with no new comments → satisfied. Reaction
removed with comments → fix them under push discipline.

### PR-AF (presence-conditional)

PR-AF is optional repo infrastructure, not a fleet default. As of 2026-09 it is
wired only in Compose Pi. **Do not add the `pr-af` label** unless a project
addendum says to; a stray label on a repo without the workflow is not a reason
to invent a gate.

PR-AF is **not** assumed present. It becomes a **blocking** merge gate only when the PR
shows a sign of life:

- a current-head PR-AF check/workflow (`AgentField PR Review` / `pr-af-review`)
- the `pr-af` label
- a github-actions comment/review whose body carries a known PR-AF marker

When dormant (none of those), ignore PR-AF: no `wait_pr_af`, no `stop_pr_af_not_green`.

When present:

- In progress, or labelled with no check yet (`missing_wait`) → `wait_pr_af`. Do not push.
- Completed not-success, or labelled with no check after the grace window →
  `stop_pr_af_not_green`. Do not merge.
- Success → gate clear. Unresolved PR-AF comments still block through the review-comment path.

PR-AF runs are excluded from the hard CI summary so a failed audit is `stop_pr_af_not_green`,
not `diagnose_ci_failure`. Comments from `github-actions[bot]` count as PR-AF only with a
known marker (or a parent review that has one).

## Decision rules

See `references/heuristics.md`.

- **Branch-related failure**: `HEAD` must match the watcher's `head_branch`/`head_sha`.
  Edit, collect other pending issues, fix everything, run the project quality gate, push once.
- **Likely flaky/unrelated**: `--retry-failed-now`; retry budget defaults to 3 per SHA.
  Only retry-eligible (currently E2E-style) workflows auto-rerun; ordinary CI is diagnose/fix-first.
- **Ambiguous or product decision**: stop and ask the user.

## Review bots

The watcher surfaces feedback from:

- **chatgpt-codex-connector[bot]** — OpenAI Codex (always a merge gate)
- **github-actions[bot] with PR-AF provenance** — only when PR-AF has a sign of life
- Trusted humans: `OWNER`, `MEMBER`, or `COLLABORATOR`

If additional review bots are enabled, add their login keyword to
`REVIEW_BOT_LOGIN_KEYWORDS` in `scripts/gh_pr_watch.py`. Do not add the shared
`github-actions[bot]` login there; match a workflow-specific body marker instead.

## Worktree gotchas

After a rebase, verify key changes survived. Always run the project quality gate before
pushing. In Gradle worktrees, watch ktfmt CLI vs plugin version mismatches.

## Choosing a mode

- **Harness streams tool stdout** (e.g. Claude Code subagents): `--watch`.
- **Harness returns output only after exit** (most tool-use loops): `--once` (default).
  Typical loop: `--once` → act on `actions` → if not terminal, `--once` again.
- **One-off inspection**: `--snapshot`.

## Output format

All modes emit newline-delimited JSON. `--watch` wraps snapshots in
`{"event":"snapshot"|"stop","payload":{...}}`.

`blocking_review_items` are unresolved inline comments on the current head; while
non-empty, `stop_ready_to_merge` is not emitted.

```json
{
  "pr": { "number": 42, "head_sha": "abc123", "mergeable": "MERGEABLE" },
  "checks": { "pending_count": 0, "failed_count": 1, "passed_count": 8, "skipping_count": 0, "all_terminal": true },
  "failed_runs": [{ "run_id": 123, "workflow_name": "CI", "conclusion": "failure", "retry_eligible": false }],
  "pr_af_gate": { "required": false, "present": false, "status": "missing", "is_success": false },
  "codex_gate": { "reviewing": false, "status": "idle" },
  "hung_checks": [],
  "new_review_items": [],
  "blocking_review_items": [],
  "actions": ["diagnose_ci_failure", "stop_non_retryable_failure"],
  "retry_state": { "current_sha_retries_used": 0, "max_flaky_retries": 3 }
}
```
