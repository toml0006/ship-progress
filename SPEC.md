# ship-progress: specification

`ship-progress` is a Claude Code mod that shows, above the prompt, where each pull request stands on its way to production:

```
#608 ■■■■□  deploying (web)  4m   c0607dcb
#602 ■■■■■  live  checks ✓        89dc4f07
```

It exists because watching PRs by hand costs a lot of agent turns and attention: polling `gh run list`, finding the right deploy run, reading its log to see which commit actually shipped, checking that workers drained. The mod does that polling itself, at no token cost, and wakes the agent only when something changes.

Status: **spec only.** No code yet. This document is the brief for the implementing agent.

## 1. Goals and non-goals

**Goals**

- A live, accurate view of every tracked PR: PR CI → merged → main CI → deploy → custom checks.
- A general task list that the agent declares itself (like savvy-progress), shown in the same bar.
- Alerts when a step finishes or fails: wake the agent, show a macOS notification, post to Slack.
- Pipeline definitions per repo, committed to that repo, so teammates who install the mod see the same thing.
- Tracked state survives restarting Claude Code.

**Non-goals**

- **Watch only.** The mod never merges, reruns, retargets, cancels, approves or pushes. It reports, and the agent or the user acts under their existing approval rules.
- Not a CI dashboard for the whole repo. It tracks only the PRs it was told about (§4).
- No GitHub API token handling of its own. It shells out to the user's `gh`, which already picks the right account.

## 2. Concepts

| Term | Meaning |
|---|---|
| **Track** | One PR being followed through the pipeline. Key: `owner/repo#number`. |
| **Stage** | A fixed phase of the PR pipeline: `pr-ci`, `merged`, `main-ci`, `deploy:<name>`, `check:<name>`. |
| **Stage state** | `pending` · `running` · `passed` · `failed` · `skipped` · `superseded` · `warning`. |
| **Task list** | A free-form list of steps the agent declares through a tool, with no GitHub knowledge. |
| **Repo config** | `.claude/ship-progress.json` in the repo root (§6). |

## 3. The PR pipeline

For each track, stages are evaluated in order. A stage only starts once the one before it has passed.

1. **pr-ci**: the newest run of the configured CI workflow for the PR's head SHA.
   - A push that replaces the run means following the new run id. Always re-resolve by head SHA; never pin to the first run id seen.
   - **Draft PRs:** many repos skip the full suite on drafts. When the PR is a draft, show `pr-ci` as `warning` with "draft: full suite not run", even if it is green.
2. **merged**: `gh pr view --json state,mergedAt,mergeCommit`. Record the merge commit SHA, which is the SHA that every later stage looks for.
   - **Stacked PRs:** if the PR's base branch is not the default branch and that base PR has merged, show `warning` with "base merged; retarget to <default>". GitHub does not retarget automatically when the base branch is not deleted. The mod only reports this; it never runs `gh pr edit --base`.
   - A closed, unmerged PR ends the track with `failed` ("closed without merge").
3. **main-ci**: the CI workflow run on the default branch whose `headSha` equals the merge SHA.
4. **deploy:\<name\>**: one stage per configured deploy (§6).
   - **Do not trust `headSha` on `workflow_run`-triggered deploys.** These runs carry the default-branch tip as `headSha`, not the commit that was deployed. Get the deployed SHA from the run log with the configured regex, for example `HEAD is now at (\w+)`.
   - **Concurrency drops runs.** With a `concurrency` group, intermediate deploy runs end as `cancelled` or `skipped`. Treat those as `superseded`, not `failed`, and keep waiting for a later successful run whose deployed SHA **contains** the merge SHA (`git merge-base --is-ancestor <merge> <deployed>`, run in the local clone, or the GitHub compare API: `status` is `ahead` or `identical`).
   - Only a run that completes with `failure` and whose deployed SHA contains the merge SHA fails the stage.
5. **check:\<name\>**: custom shell checks that run after every deploy has passed (§6). Each check is polled until it exits 0 or reaches its timeout.

A track is **done** when every stage has passed. Done tracks stay visible for `doneLingerMinutes` (default 10), then leave the bar but stay in history.

## 4. Starting a track

- **Automatically:** the mod watches the session's tool calls (a post-tool hook on Bash). When a command matches `gh pr create`, `gh pr merge <n>`, `git push` to a branch with an open PR, or `gh pr ready <n>`, it resolves the PR (from the command output, or `gh pr view --json number` for the current branch) and starts tracking it.
- **Manually:**
  - `/track <PR#|url>` adds a track.
  - `/untrack <PR#>` removes one.
  - `/track` with no argument lists the current tracks.
- **From the agent:** the `ship_progress` tool (§7) can also add tracks.

## 5. Polling and the 10 s hook budget

- `$.clock.every(intervalMs)` drives polling. Defaults:
  - 20 s while any stage is running;
  - 60 s while stages are pending;
  - stopped when nothing is in flight.
- Every `gh` call goes through `$.process.run(argv, { cwd, timeoutMs })` with an argv array (no shell) and a `timeoutMs` of 8 000 or less.
- **The hook budget is 10 s.**
  - Never await a full poll inside a hook or a render.
  - Hooks only change state and schedule work. The clock tick does the polling.
  - Renders read state only, and never call `gh`.
  - Spread work across ticks: at most N tracks per tick (default 4), round-robin.
- Reading deploy logs: `gh run view <id> --log` can be large. Run it once per completed deploy run, cache the extracted SHA by run id, and never fetch it again.
- Back off on `gh` errors (rate limit, network): double the interval up to 5 min, and show `⚠ gh: <short error>` on the bar.

## 6. Repo config: `.claude/ship-progress.json`

This file is committed in each repo. The mod reads it with `$.fs.read` from the session's repo root, and re-reads it when it changes (mtime from `$.fs.stat`). With no file, the defaults are:
- `ci` is the workflow that runs on `pull_request`, if exactly one does;
- there are no deploys and no checks.

### Schema

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/toml0006/ship-progress/main/schema/ship-progress.schema.json",
  "version": 1,

  // Workflow (name or file) whose run gates the PR and the default branch.
  "ci": { "workflow": "CI" },

  // Zero or more deploys, all of which must pass after main CI.
  "deploys": [
    {
      "name": "web",                              // stage label
      "workflow": "Deploy web (staging)",         // name or .yml file
      "branch": "main",                           // optional, defaults to the default branch
      // How to learn which commit this run actually deployed.
      // "headSha" trusts the run's headSha (fine for push-triggered deploys).
      // "log" applies `pattern` to `gh run view --log`; capture group 1 = SHA (short or full).
      "deployedSha": { "from": "log", "pattern": "HEAD is now at (\\w+)" },
      "timeoutMinutes": 45
    }
  ],

  // Custom checks that run after every deploy has passed. Exit 0 means green.
  "checks": [
    {
      "name": "workers drained",
      "argv": ["./scripts/check-workers-drained.sh", "{mergeSha}"],
      "intervalSeconds": 60,
      "timeoutMinutes": 20,
      "env": { "AWS_PROFILE": "staging" }          // optional; never put secrets here
    }
  ],

  "notify": {
    "macos": true,
    "slack": { "webhookEnv": "SHIP_PROGRESS_SLACK_WEBHOOK" },  // env var NAME, never the URL
    "wakeAgent": true,
    "on": ["failed", "warning", "done"]             // stage states that alert
  },

  "doneLingerMinutes": 10
}
```

**Placeholders in `argv`:** `{mergeSha}`, `{prNumber}`, `{repo}`, `{deployedSha:<deployName>}`. They are substituted as whole argv elements only. No shell is involved, so there is no injection surface.

**Trust:** checks run commands from a committed repo file. On first use in a repo, and whenever `checks` changes, the mod asks the user once (`/ship-progress trust`) before running them. The approval is stored per repo by the content hash of the `checks` array.

### Worked example

A repo has three workflows:
- `CI` runs on PRs and on `main`.
- `Deploy web (staging)` and `Deploy infra (staging)` both run on `workflow_run` after `CI`, each with its own concurrency group.
- The services run on ECS, so after the deploy you also want an **ECS drain check**: every service has a single primary deployment with rollout completed, and the job queues are empty.

```json
{
  "version": 1,
  "ci": { "workflow": "CI" },
  "deploys": [
    { "name": "web",   "workflow": "Deploy web (staging)",
      "deployedSha": { "from": "log", "pattern": "HEAD is now at (\\w+)" } },
    { "name": "infra", "workflow": "Deploy infra (staging)",
      "deployedSha": { "from": "log", "pattern": "HEAD is now at (\\w+)" } }
  ],
  "checks": [
    { "name": "ECS drained", "argv": ["./scripts/ecs-drained.sh"], "intervalSeconds": 60, "timeoutMinutes": 20 }
  ],
  "notify": { "macos": true, "slack": { "webhookEnv": "SHIP_PROGRESS_SLACK_WEBHOOK" }, "wakeAgent": true }
}
```

PR #42 merges as `abc1234`, and the sequence then runs like this:
1. Main CI goes green on `abc1234`.
2. The first `Deploy web` run is cancelled because a newer CI completed. It shows as `superseded`.
3. The next run succeeds, and its log says `HEAD is now at def5678`. `def5678` contains `abc1234`, so `deploy:web` passes.
4. `deploy:infra` passes the same way.
5. `ecs-drained.sh` exits 1 twice, then 0, so `check:ECS drained` passes and the track is done.
6. That triggers a single "#42 live (def5678)" notification.

## 7. Agent tool: `ship_progress`

Registered with `$.tool.register`. It takes one `action`:

| action | input | effect |
|---|---|---|
| `track` | `{ pr }` | Add a PR track. |
| `untrack` | `{ pr }` | Remove it. |
| `annotate` | `{ pr, stage?, note }` | Attach a short note to a track or stage (for example "4b failed: spec bug, fixed in #608"). |
| `add_step` | `{ pr, name, after? }` | Add an agent-owned step to a PR track. The agent marks it done or failed with `set_step`. |
| `set_step` | `{ pr?, list?, name, state, note? }` | Set the state of an agent-owned step. |
| `list_set` | `{ list, title, steps: [{ name, state?, after? }] }` | Declare or replace a general task list, with no GitHub involvement. |
| `status` | `{}` | Return every track and list as JSON, so the agent doesn't have to poll `gh` itself. |

Every tool input is validated against a closed schema, and an unknown field is rejected with a clear error. Expect some models to send nested objects as JSON strings, so accept those, parse them and validate.

## 8. Display: the bar above the prompt

- Rendered with `on('ui.render', { component: 'AbovePrompt' }, …)`.
- One line per in-flight track or list, sorted by most recent activity. At most 5 lines, then a "+N more" line.
- Line format: `#<n> <stage pips> <current stage label> <elapsed> <short SHA>`, with a ` ⚠ <warning>` suffix when present.
  - Pips are one per stage: ■ passed, ▣ running, □ pending, ✕ failed, ↷ superseded or skipped.
- Colors: green for passed, yellow for running or warning, red for failed, dim for pending.
- **Hidden entirely when nothing is in flight**, apart from done tracks still lingering.
- State changes call `$.ui.invalidate()`, which re-renders the bar, and the render reads `$.state` only.

## 9. Alerts

Alerts fire on each stage transition into a state listed in `notify.on` (defaults: `failed`, `warning`, `done`). They are deduplicated by `(track, stage, state)`, and each alert fires at most once.

- **Wake the agent:** inject a short notice into the session, for example "ship-progress: #608 deploy:web failed: run 123456, step 'cdk deploy'". This lets the agent react by reading the log without being asked. Use whatever channel the mods API provides for this, and check the docs (§11).
- **macOS:** `$.process.run(['osascript','-e', 'display notification "<msg>" with title "ship-progress"'])`. Escape `msg` for AppleScript string literals, and skip this on non-darwin platforms.
- **Slack:**
  - `$.http.fetch(url, { method:'POST', body: JSON.stringify({ text }) })`, where `url` is read **from the environment variable named in `notify.slack.webhookEnv`**.
  - The URL is never stored in config, `$.store`, state or logs, and is never echoed in errors. Error messages say "slack webhook POST failed (status N)" only.
  - If the variable isn't set, skip Slack silently, with a one-time debug note.

## 10. Persistence

- `$.store` holds the tracks, cached deploy-log SHAs, alert dedupe keys and trust approvals, **keyed by repo** (`owner/repo`).
- A new session in that repo restores its in-flight tracks and resumes polling.
- History for tracks that have left the bar is kept for 7 days, so `/track` with no argument can show what shipped recently.
- Store a schema `version` and migrate forward. On an unknown version, start empty rather than crash.

## 11. Mods API notes (from research, 2026-10-18)

Docs: https://code.claude.com/docs/en/plugins/mods/overview (also `/reference`, `/api`, `/interface`). The `/create` and `/events` pages were not read, so check event names there. Reference mod: **savvy-progress**, which already does an AbovePrompt bar driven by an agent tool. It's a good template. The typings ship with Claude Code, so trust the copy Claude Code writes for your installed version over older copies.

- **Layout:**
  ```
  .claude-plugin/plugin.json
  hooks/hooks.json          → { "modules": ["./register.tsx"] }
  hooks/register.tsx        → export function register(on, options) { … }
  schema/ship-progress.schema.json
  ```
- **APIs used:**
  - `$.process.run(argv, { cwd, env, stdin, timeoutMs })` resolves to `{ exitCode, stdout, stderr }`.
    - There is no shell; pass an argv array.
    - The default timeout is 30 s and the maximum is 10 min.
    - It rejects if the process can't start or times out.
  - `$.http.fetch` posts to Slack.
  - `$.fs.read / write / list / exists / stat` read the repo config and its mtime.
  - `$.clock.every` drives the poll loop.
  - `$.ui.resolve(e)` and `$.ui.invalidate()` handle rendering.
  - `$.state` (atom / read / update) holds in-memory state. Exact signatures aren't in the typings, so follow savvy-progress.
  - `$.store` holds JSON persisted across sessions under `~/.claude/plugins/store/`.
  - `$.tool.register` exposes the `ship_progress` tool.
  - `$.command.register` adds `/track`, `/untrack` and `/ship-progress`.
- **Budget:** a hook gets 10 s of its own execution and 1 s of `.catch` grace.
- **Local development:** run `claude --plugin-dir /path/to/ship-progress`, and use `/reload-plugins` after edits.

## 12. Acceptance criteria

1. `/track <n>` on a merged PR whose deploy finished earlier shows every stage green within one poll.
2. A PR merged during the session is tracked automatically, with no `/track`.
3. A deploy run that ends `cancelled` because of concurrency shows `superseded`. The track then passes on the later run whose log SHA contains the merge SHA.
4. A `workflow_run` deploy whose `headSha` differs from the deployed commit is judged by the log SHA, not by `headSha`. There is a test fixture for this.
5. A draft PR with green CI shows the "full suite not run" warning.
6. A stacked PR whose base has merged shows the retarget warning, and the mod runs no `gh pr edit`.
7. Replacing a PR CI run with a push makes the bar follow the new run within one poll.
8. A failing custom check turns red after its timeout. Exit 0 turns it green. Checks don't run before the user trusts them.
9. Failure and done alerts fire once each: an agent notice, a macOS banner, and Slack if the env var is set. The webhook URL appears in no file, store entry or log.
10. Restarting Claude Code in the repo restores the in-flight tracks.
11. No hook or render takes more than 1 s in practice. `gh` runs only on clock ticks.
12. The mod never calls `gh pr merge`, `gh run rerun`, `gh pr edit` or `git push`, and a grep test in CI enforces this.
13. The bar is hidden when nothing is in flight.

## 13. Milestones

1. **M1: skeleton and task list.**
   - Plugin layout, `register`, the `ship_progress` tool with `list_set`, `set_step` and `status`.
   - The AbovePrompt bar.
   - `$.store` persistence.
   - Adapted from savvy-progress.
2. **M2: PR pipeline core.**
   - The `pr-ci`, `merged` and `main-ci` stages.
   - `/track` and `/untrack`.
   - Clock polling with backoff.
   - The draft and stacked-PR warnings.
3. **M3: deploys.**
   - Repo config loading and the JSON schema.
   - Deploy stages with log-SHA extraction, the containment check, superseded handling and the log cache.
4. **M4: custom checks and trust.**
   - argv placeholders, intervals and timeouts, the trust prompt and its hash.
5. **M5: alerts.**
   - Wake the agent, macOS, Slack from env, and deduplication.
6. **M6: auto-tracking.**
   - The post-tool hook on Bash `gh pr create`, `gh pr merge`, `git push` and `gh pr ready`.
7. **M7: polish and release.**
   - README with GIF, tests for each acceptance criterion, and the CI grep guard (§12.12).
   - A tagged v0.1.0, installable via `/plugin`.
