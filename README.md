# pi-herdr-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) running exclusively in [herdr](https://herdr.dev). Spawn, orchestrate, and manage sub-agent sessions in a shared herdr agents tab. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all tracked agents with their projected state — for example `starting`, `active`, `waiting`, `interrupted`, `stalled`, `running`, or `finalizing`. The header summarizes **active** (processing) vs **open** (not processing). When every tracked subagent is open, the border switches to amber. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────── 1 active · 1 open ─╮
│ 00:23  Scout: Auth (scout)        active · bash 7m │
│ 00:45  Scout: DB (scout)                waiting 2m │
╰────────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent` multiple times — they all run concurrently:

```typescript
subagent({ name: "Scout: Auth", agent: "subagent-explorer", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "subagent-explorer", task: "Map database schema" });
// Both return immediately, results steer back independently
```

## Development

Run unit tests and lint locally:

```bash
npm test
npm run lint
```

Run the real end-to-end suite from inside herdr with an explicit test model:

```bash
PI_TEST_MODEL="deepseek/deepseek-flash" PI_TEST_TIMEOUT=180000 npm run test:integration
```

The full suite launches real Pi sessions and can take several minutes. `PI_TEST_TIMEOUT` is the per-test timeout in milliseconds; use at least `180000` for the lifecycle suite.

`PI_TEST_MODEL` is applied to both the parent Pi sessions and the project-local test subagents created by the harness.

## Install

Install the package from npm:

```bash
pi install npm:pi-herdr-subagents
```

This project does not install or load `HazAT/pi-interactive-subagents` automatically.

Changing the `package.json` version on `main` automatically creates a matching Git tag and GitHub Release, generates release notes, and publishes the package to npm. For authentication, versioning, verification, and troubleshooting, see [RELEASING.md](RELEASING.md).

Start herdr, then run pi inside it:

```bash
herdr
pi
```

herdr is the only supported terminal environment. The extension requires `HERDR_ENV=1` and the `herdr` CLI to be available.

If your shell startup is slow and subagent commands sometimes get dropped before the prompt is ready, set `PI_SUBAGENT_SHELL_READY_DELAY_MS` to a higher value (defaults to `500`):

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500
```

Terminal runs keep their pane. A completed, failed or cancelled run leaves its pane open so the result stays inspectable in the shared agents tab; only a pane this process created and then failed to launch is closed, and there is no automatic retention cap yet — close panes manually when the tab gets crowded.

Subagent panes are created without stealing keyboard focus. Launch commands target child panes by explicit ID, so focus and command delivery are independent. Note: the `interactive` option controls parent status notifications, not terminal focus.

## What's Included

### Extensions

**Subagents** — 5 main-session tools + 3 commands, plus 1 subagent-only tool:

| Tool                  | Description                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `subagent`            | Spawn a sub-agent in a dedicated herdr pane (async — returns immediately)             |
| `subagent_interrupt`  | Interrupt a running Pi-backed subagent's current turn                                       |
| `subagents_list`      | List available agent definitions                                                            |
| `subagent_resume`     | Resume a previous sub-agent session (async)                                                 |
| `subagent_worktrees`  | Inspect, record evidence for, and clean up isolated worktree lanes                          |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly         |

### Bundled Agents

| Agent | Default runtime | Role / assigned skills |
| --- | --- | --- |
| **orchestrator** | deepseek/deepseek-flash, max | Conditional delegation, review and verification; Ponytail full |
| **subagent-explorer** | deepseek/deepseek-flash, low | Focused read-only discovery |
| **subagent-worker** | deepseek/deepseek-flash, max | Scoped implementation and checks; Ponytail full |
| **subagent-reviewer** | deepseek/deepseek-v4-pro, max | Independent review; code-review, code-quality-checklist |
| **subagent-tester** | deepseek/deepseek-flash, medium | Verification and failure classification |
| **subagent-quality** | deepseek/deepseek-v4-pro, max | Optional complexity review; ponytail-review |
| **planner** | Config, then parent | Interactive planning |
| **visual-tester** | Config, then parent | Visual QA via Chrome CDP |

The new subagent names replace bundled scout, worker and reviewer. Update explicit invocations accordingly. The specialist definitions require the named tools/skills to be installed in Pi. Global definitions with matching names override these package defaults. Use exact authenticated model IDs; omit per-call model/thinking to use the role defaults, or explicitly override them.

Normal work uses discovery when needed, worker with checks, then independent reviewer. Add tester or quality only when the change warrants it. For bugs assign `skills: "diagnosing-bugs"` to the worker. For an explicit repository audit assign `skills: "ponytail-audit, codebase-design"` to quality. Architecture improvement is a separate parent-led workflow.

`/subagent orchestrator <task>` runs the coordinator in its own pane. It deliberately uses `auto-exit: false` and `interactive: false`: it must stay alive across turns while its delegated runs finish, then call `subagent_done`. An agent definition does not automatically change the existing parent session's prompt. To use that guidance in the parent, start Pi with `--append-system-prompt <path-to-orchestrator.md>`; this loads prompt text, not frontmatter runtime settings.

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in the higher-priority location. The discovered names, descriptions, and runtime defaults are included in the subagent tool guidance so the orchestrator can select by role instead of treating one agent as a generic default.

### Supported Harness CLIs

Agents default to running with `pi`, but can run inside any supported harness CLI or custom CLI configured via agent frontmatter:

| Harness CLI | Frontmatter `cli:` | Model format | Notes |
| :--- | :--- | :--- | :--- |
| **Pi** (default) | `pi` (or omitted) | `provider/model` | Full support for thinking levels, turn interrupts, and live activity snapshots |
| **OpenCode** | `opencode` | `provider/model` | Runs `opencode run --model <model> <task>` |
| **Codex** | `codex` | bare model ID | Runs `codex --model <model>` with optional `--reasoning-effort` |
| **Claude Code** | `claude` | bare model ID | Runs `claude --model <model>` with autonomous completion hook |
| **Grok** | `grok` | bare model ID | Runs `grok --model <model> <task>` |
| **Custom / Generic** | any CLI name | bare model ID | Supports custom `command:` template (e.g. `command: "aider --model {model} --message {task}"`) |

---

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in herdr pane    → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks every agent still in flight:

```
╭─ Subagents ──────────────────── 1 active · 2 open ─╮
│ 01:23  Scout: Auth (scout)            active · write 7m │
│ 00:45  Researcher (researcher)               stalled 4m │
│ 00:12  Scout: DB (scout)                      starting… │
╰─────────────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path. Completed rows are removed from the widget as soon as their result is delivered or suppressed.

### In-progress status updates

The widget projects each sub-agent from a **process + turn lifecycle**:

- **Herdr pane inspection** is the coarse authority for whether the child process is present and whether Herdr reports it as idle, working, blocked, or done.
- **Child activity snapshots** enrich the label with Pi-only detail (tool name, streaming, etc.) when available.
- Session JSONL is still used for transcript, resume, lineage, and result extraction — not for liveness.

Projected labels include:

- `starting` — launched; pane/activity confirmation is still settling
- `active` — processing work (agent turn, provider request, streaming, or tool execution)
- `blocked` — Herdr reports the child as blocked
- `waiting` — turn finished; the process is intentionally open for more input or another stage
- `interrupted` — the current turn was cancelled (Escape / `subagent_interrupt`); the process stays open and is **not** treated as active processing
- `stalled` — pane inspection is unhealthy long enough that the parent can no longer trust the run
- `running` — fallback when only coarse process presence is known (e.g. non-Pi backends)
- `finalizing` — completion was observed and delivery is in progress; the process elapsed timer freezes here

The widget header counts **active** vs **open**:

- **active** — `active`, `starting`, `running`, or `blocked`
- **open** — everything else still tracked (`waiting`, `interrupted`, `stalled`, `finalizing`, …)

When `activeCount === 0` (every tracked row is open), the border uses an amber accent. Process elapsed time (`MM:SS` on the left) freezes when the process reaches finalizing/completed/failed. Interrupt does **not** freeze that process clock; the interrupted state shows its own duration on the right while the process remains open.

A fixed internal watchdog marks a run as `stalled` when pane inspection fails or the pane disappears without a completion sidecar; valid long-running `active` or `waiting` states do not become `stalled` just because time passes. When a run enters `stalled` or recovers from it, the parent agent receives a steer message so it can react. All other status transitions stay in the widget only.

**Interactive subagents stay silent.** Long-running user-driven subagents (e.g. `planner`, or any `/iterate` fork) do not wake the parent session on `stalled`/`recovered` transitions — the user is working directly in the subagent's pane, and a steer message there would just burn an orchestrator turn on a no-op "still waiting" ping. The widget still updates normally, and activity snapshots are still recorded/classified regardless of the `interactive` setting. By default, agents with `auto-exit: true` are treated as autonomous and get stall pings; agents without it are treated as interactive and stay quiet. Override per-agent with `interactive: true|false` in frontmatter, or per-spawn with `interactive: true|false` on the tool call.

#### Configuration

Status display is controlled by `config.json` in the extension directory. Copy `config.json.example` to get started:

```bash
cp config.json.example config.json
```

```json
{
  "status": {
    "enabled": true
  },
  "models": {
    "agents": {}
  }
}
```

The copyable config example is model-neutral; the new bundled role profiles themselves specify DeepSeek models. Remove/override a role's frontmatter model to use the fallback config below. To configure models, replace the empty section with exact IDs from your authenticated model catalog:

```json
{
  "models": {
    "default": "your-provider/your-default-model",
    "agents": {
      "subagent-explorer": "your-provider/your-fast-model",
      "subagent-reviewer": "your-provider/your-review-model"
    }
  }
}
```

`models.default` sets the model for subagents that do not specify a model. `models.agents` sets per-agent defaults, keyed by the agent name passed to `subagent({ agent: ... })`. Explicit `model` tool arguments take precedence, followed by agent frontmatter, per-agent config, the global default, and finally the parent model. Model values must be exact authenticated `provider/model-id` references.

`config.json` is gitignored so local overrides don't get committed.

---

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition or config.json
subagent({ name: "Scout", agent: "subagent-explorer", task: "Analyze the codebase..." });

// Force a full-context fork for this spawn
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Agent defaults can choose a different session-mode via frontmatter
subagent({ name: "Planner", agent: "planner", task: "Work through the design with me" });

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

| Parameter              | Type    | Default        | Description                                                                                       |
| ---------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | string  | required       | Display name (shown in widget and pane title)                                                     |
| `task`                 | string  | required       | Task prompt for the sub-agent                                                                     |
| `agent`                | string  | —              | Load defaults from agent definition                                                               |
| `fork`                 | boolean | `false`        | Force the full-context fork mode for this spawn, overriding any agent `session-mode` frontmatter  |
| `interactive`          | boolean | derived        | Mark this spawn as interactive (don't wake the parent on stall/recovery). Defaults to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`. |
| `model`                | string  | agent, configured, or parent | Exact authenticated `provider/model-id`; resolution is tool argument → agent frontmatter → per-agent config → global config → parent |
| `thinking`             | string  | agent or parent | Pi thinking level (`off` through `max`); resolution is tool argument → agent frontmatter → parent |
| `systemPrompt`         | string  | —              | Append to system prompt                                                                           |
| `skills`               | string  | —              | Comma-separated skill names                                                                       |
| `tools`                | string  | —              | Comma-separated tool names                                                                        |
| `cwd`                  | string  | —              | Working directory for the sub-agent (see [Role Folders](#role-folders))                           |
| `worktree`             | boolean | `false`        | Run the child in its own Git worktree and branch (see [Isolated Worktree Lanes](#isolated-worktree-lanes)) |
| `baseRef`              | string  | `HEAD`         | Git ref the isolated worktree branches from (only with `worktree: true`)                          |

---

## Isolated Worktree Lanes

Parallel writers normally share one checkout. With `worktree: true` the child gets its own Git worktree and branch, so two workers cannot see or clobber each other's edits:

```typescript
subagent({ name: "Parser", agent: "subagent-worker", worktree: true, task: "Rewrite the parser..." });
subagent({ name: "Tests", agent: "subagent-worker", worktree: true, task: "Add parser tests..." });
```

Launch is fail-closed. The extension resolves the repository root for the child's `cwd`, requires a clean source checkout, then creates the lane before any pane exists: a dirty or non-Git checkout rejects the spawn with the repository untouched — nothing is stashed, reset, or silently absorbed into the lane. Each lane gets a unique branch (`pi-subagents/<label>-<id>`) and a worktree outside the checkout at `<parent-of-repo>/worktrees/<repo>/pi-worktree-<id>`; set `PI_SUBAGENTS_WORKTREE_DIR` to relocate that root. Cwd-local runtime metadata written by pi tooling (default `.pi-lens-probe-home`, override with `PI_SUBAGENTS_WORKTREE_EXCLUDE`) is ignored by the clean-tree gate and excluded from capture, so it never reaches a patch.

When the child exits, its complete change set against the recorded base is captured — tracked, untracked, renamed, and binary files — into the session's artifact directory without touching the lane's index:

```
artifacts/<session-id>/subagent-worktrees/<lane-id>/
  patch.diff      applyable patch (git apply -p1)
  manifest.json   base/head commits, branch, worktree, changed paths, terminal state, review/merge evidence
```

The manifest path, branch, and patch summary arrive with the completion message. Lanes that changed nothing are removed automatically; lanes with work are preserved so you can review and merge them:

```typescript
subagent_worktrees({ action: "status" });                                   // read-only plan
subagent_worktrees({ action: "record", lane: "1a2b3c4d", verdict: "OK", reviewer: "reviewer" });
subagent_worktrees({ action: "cleanup", lane: "1a2b3c4d" });                // or lane: "eligible"
```

Cleanup revalidates repository ownership, checked-out branch, head commit, and a clean tree immediately before removing anything, and preserves the lane on any mismatch. Merging is never automatic: apply the branch or patch yourself (`git merge pi-subagents/worker-1a2b3c4d`), then record the merge commit with `action: "record"`. Reviewers read the captured patch read-only; the recorded verdict is bound to the lane's exact captured head.

---

## Interrupting a running subagent

Use `subagent_interrupt` to cancel the active turn of a running Pi-backed subagent:

```typescript
subagent_interrupt({ id: "abcd1234" });
// or
subagent_interrupt({ name: "Scout" });
```

This sends Escape to the child pane, cancelling the in-progress model turn. The subagent session stays alive — the pane, session file, and background polling all remain intact. After the interrupt, the widget immediately labels the child as `interrupted` (counted as **open**, not active processing). Stale pre-interrupt activity snapshots are ignored so a lagging Herdr/`active` reading cannot overwrite the interrupt. The process elapsed timer keeps running because the pane is still open; only the interrupted-state duration freezes relative to the interrupt request. If the child starts work later, newer observations return it to `active`; completion, failure, and `caller_ping` still flow through normally.

This is a turn-level interrupt, not a method for forcibly terminating a subagent session.

> **Note:** Only Pi-backed subagents are supported. Claude-backed runs will return an error.

---

## caller_ping — Child-to-Parent Help Request

The `caller_ping` tool lets a subagent request help from its parent agent. When called, the child session **exits** and the parent receives a notification with the help message. The parent can then **resume** the child session with a response using `subagent_resume`.

**`caller_ping` parameters:**
- `message` (required): What you need help with

**`subagent_resume` parameters:**
- `sessionPath` (required): Path to the child session `.jsonl` file
- `name` (optional): Display name for the resumed pane (defaults to `Resume`)
- `message` (optional): Follow-up prompt to send after resuming
- `autoExit` (optional): Whether the resumed session should auto-exit after its next response. Defaults to `true` for autonomous follow-up work; set `false` when resuming for an interactive handoff.

**Interaction flow:**
1. Child calls `caller_ping({ message: "Not sure which schema to use" })`
2. Child session exits (like `subagent_done`)
3. Parent receives a steer notification: *"Sub-agent Worker needs help: Not sure which schema to use"*
4. Parent resumes the child session via `subagent_resume` with the response
5. Child picks up where it left off with the parent's guidance

**Example:**
```typescript
// Inside a worker subagent
await caller_ping({
  message: "Found two conflicting migration files — should I use v1 or v2?"
});
// Session exits here. Parent receives the ping, then resumes this session
// with guidance like "Use v2, v1 is deprecated"
```

> **Note:** `caller_ping` is only available inside subagent contexts. Calling it from a standalone pi session returns an error.

---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm todos, adjust if needed
Phase 4: Execute          → Scout + sequential workers implement todos
Phase 5: Review           → Reviewer subagent checks all changes
```

The parent workspace and tab names stay unchanged. Subagents are created as named panes in the shared `agents` tab, one pane per phase.

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This always forks the current session into a subagent with full conversation context. It does not inherit an agent default `session-mode`. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Keep the filename and frontmatter `name` aligned (for example, `researcher.md` must declare `name: researcher`) so discovery and direct invocation agree:

```markdown
---
name: my-agent
description: Does something specific
model: anthropic/claude-sonnet-4-6
thinking: minimal
tools: read, bash, edit, write
session-mode: lineage-only
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Agent name (used in `agent: "my-agent"`)                                                                                                                                                                                                                                    |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Optional exact authenticated model default; omit to inherit the parent                                                                                                                                                                                                      |
| `thinking`    | string  | Optional Pi thinking default (`off` through `max`); omit to inherit the parent                                                                                                                                                                                                                                 |
| `tools`       | string  | Comma-separated registered Pi tools, including built-in and extension tools; replaces the default selection. A shell command such as `jq` is not a tool name                                                                                                                                                                             |
| `skills`      | string  | Comma-separated skill names loaded with the task in one turn; `none` skips assignments; omitted uses the role default                                                                                                                                                                                                                                    |
| `ponytail` | string | Pi-only `off`, `lite`, `full`, or `ultra`; requires the installed Ponytail extension; independent of skill assignment |
| `session-mode` | string | Default child-session mode: `standalone`, `lineage-only`, or `fork` |
| `spawning`    | boolean | Set `false` to deny all subagent-spawning tools                                                                                                                                                                                                                             |
| `deny-tools`  | string  | Comma-separated extension tool names to deny                                                                                                                                                                                                                                |
| `auto-exit`   | boolean | Auto-shutdown when the agent finishes its turn — no `subagent_done` call needed. If the user sends any input, auto-exit is permanently disabled and the user takes over the session. Recommended for autonomous agents (scout, worker); not for interactive ones (planner). Also determines the default value of `interactive` (see below). |
| `interactive` | boolean | derived        | Override whether stall/recovery transitions wake the parent session. Defaults to the inverse of `auto-exit`: autonomous agents (`auto-exit: true`) are non-interactive and get stall pings; agents without `auto-exit` are interactive and stay quiet. Explicit values take precedence. |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide this agent from discovery surfaces like `subagents_list`. The agent still remains directly invokable by explicit name via `subagent({ agent: "name", ... })`. |

---

Discovery still resolves precedence before visibility filtering. If a project-local hidden agent has the same name as a visible global or bundled agent, the hidden project agent wins and the lower-precedence agent does not appear in `subagents_list`.

### Assigned skills and Ponytail

```yaml
skills: code-review, code-quality-checklist
ponytail: off
```

Per-call `skills` and `ponytail` override the agent defaults. Skill lists are comma-separated strings, not YAML arrays. Omitted skills inherit the role's assignments. `none` means no assigned skills; it does not disable normal skill discovery or the Ponytail extension. `all` is unsupported: select the relevant skills explicitly.

The subagent resolves assignments from its own enabled Pi skill catalog (including package skills) and receives their full instructions with the task. Missing or unreadable assignments fail the run before task execution. No separate skill-only turns are started. References retain each skill's source directory.

Pi launches save a `.launch.json` beside the session. `subagent_resume` reuses the role prompt, tools, skill assignments, mode defaults and cwd while assigning a fresh run identity. Sessions predating this profile keep the legacy resume behavior. Keep the generated prompt files and launch profile with the session when resuming it.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call always forces the `fork` mode for that specific spawn. `/iterate` uses this explicit override on purpose.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### `auto-exit`

When set to `true`, the agent session shuts down automatically as soon as the agent finishes its turn — no explicit `subagent_done` call is needed.

**Behavior:**

- The session closes after the agent's final message (on the `agent_end` event)
- If the user sends **any input** before the agent finishes, auto-exit is permanently disabled for that session — the user takes over interactively
- The modeHint injected into the agent's task is adjusted accordingly: autonomous agents see "Complete your task autonomously." rather than instructions to call `subagent_done`

**When to use:**

- ✅ Autonomous agents (scout, worker, reviewer) that run to completion
- ❌ Interactive agents (planner, iterate) where the user drives the session

```yaml
---
name: subagent-explorer
auto-exit: true
---
```

### `interactive`

Controls whether status transitions (`stalled`, `recovered`) wake the parent session with a steer message.

**Default:** the inverse of `auto-exit`. Autonomous agents (`auto-exit: true`) are non-interactive and ping the parent on stall/recovery; agents without `auto-exit` are interactive and stay quiet. Bare spawns with no agent defs (e.g. `/iterate` with `fork: true`) are treated as interactive.

**Why it exists:** Interactive agents can run for minutes or hours while the user thinks, types, and reads in the subagent's pane. Child snapshots still update the widget, but stalled/recovered supervision messages rarely need to wake the parent for user-driven sessions. Skipping the steer keeps the parent quiet until the child actually finishes.

**When to override:**

- Set `interactive: false` on an agent that doesn't auto-exit but you still want stall pings for
- Set `interactive: true` on an autonomous agent you'd rather check on yourself

```yaml
---
name: planner
# interactive defaults to true because auto-exit is not set
---
```

Or per spawn:

```typescript
subagent({ name: "Scout", agent: "subagent-explorer", interactive: true, task: "..." });
```

---

## Tool Access Control

By default, every sub-agent can spawn further sub-agents. Control this with frontmatter:

### `spawning: false`

Denies all subagent lifecycle tools (`subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over individual extension tools:

```yaml
---
name: focused-agent
deny-tools: subagent
---
```

### Recommended Configuration

| Agent      | `spawning`  | Rationale                                    |
| ---------- | ----------- | -------------------------------------------- |
| planner    | _(default)_ | Legitimately spawns scouts for investigation |
| worker     | `false`     | Should implement tasks, not delegate         |
| researcher | `false`     | Should research, not spawn                   |
| reviewer   | `false`     | Should review, not spawn                     |
| scout      | `false`     | Should gather context, not spawn             |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J)              ← collapsed
[scout] — 12 available  (Ctrl+J to collapse)          ← expanded
  read, bash, edit, write, todo, ...
  denied: subagent, subagents_list, ...
```

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- [herdr](https://herdr.dev) — the required terminal workspace

```bash
herdr
pi
```

Other multiplexers and terminal backends are not supported.

---

## Acknowledgements

The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

---

## License

MIT
