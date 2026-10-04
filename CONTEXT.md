# pi-herdr-subagents

A Pi extension that spawns subagents as separate Pi sessions in herdr panes, and reports their results back to the session that spawned them.

## Language

### Sessions and runs

**Parent session**:
The Pi session that spawned one or more subagents and receives their results.
_Avoid_: orchestrator, caller, main session.

**Subagent**:
A Pi session spawned by a parent session to complete one task in its own pane.
_Avoid_: child process, worker, agent (a subagent is a session; an agent definition is a reusable role).

**Run**:
One subagent execution, from launch until its result is delivered to the parent.
_Avoid_: job, invocation, task (task is what the run is asked to do).

**Launch**:
Starting a run: creating its pane and sending the command that starts the session.
_Avoid_: spawn (spawn covers launch plus everything the parent does around it).

**Steer**:
A message injected into a parent session that wakes it and starts a new turn.
_Avoid_: notification, event, ping.

**Result delivery**:
The one steer message that carries a finished run's summary to the parent.
_Avoid_: callback, return value.

**Interactive subagent**:
A run the user drives inside its own pane; its status transitions never wake the parent.
_Avoid_: long-running agent, manual subagent.

**caller_ping**:
A run's request for help from its parent, delivered as a steer.
_Avoid_: question, escalation.

### Completion evidence

**Completion**:
The evidence that a run's session stopped, taken from artifacts rather than from polling the session.
_Avoid_: exit, termination, finish.

**Sidecar**:
The file a session writes when its agent loop ends, stating how it ended: done, error, or a caller_ping.
_Avoid_: exit file, result file, status file.

**Sentinel**:
The marker a launch command writes into pane output when the run's command line finishes.
_Avoid_: trailer, marker.

**Activity snapshot**:
The file a running session keeps up to date describing whether it is working, waiting, or blocked, and in which activity.
_Avoid_: heartbeat, progress file, liveness file.

**Lifecycle**:
The parent's model of a run, combining its process state, its turn state, and the health of the activity snapshots it reads.
_Avoid_: status, state machine.

**Status projection**:
The single word the lifecycle projects at a moment in time, which the widget and the parent's steers both read.
_Avoid_: status kind, phase, state.

**Stalled**:
A lifecycle projection meaning the snapshot evidence went quiet or unavailable long enough to be a concern.
_Avoid_: hung, dead, timeout.

### Terminal

**Herdr**:
The terminal multiplexer that hosts panes, tabs, and workspaces; the only terminal backend this extension supports.
_Avoid_: mux, tmux, terminal manager.

**Pane**:
The herdr pane that hosts one subagent session.
_Avoid_: surface, window, tab (a tab holds panes; a workspace holds tabs).

**Agents tab**:
The single herdr tab labelled `agents` in a workspace, holding every subagent pane.
_Avoid_: subagent tabs, one tab per subagent.

**Widget**:
The live in-session listing of running subagents and their status projections.
_Avoid_: sidebar, status bar, HUD.

### Isolation and handoff

**Lane**:
An isolated git worktree, on its own branch, that one session owns across resumes.
_Avoid_: sandbox, worktree, checkout.

**Handoff**:
What a lane presents when its run finishes: the captured changes, and the manifest that ties them to the lane's head commit.
_Avoid_: patch, diff, deliverable.

**Manifest**:
The record of a lane's identity, captured changes, and review and merge evidence.
_Avoid_: metadata file, lane state.

**Handoff capture**:
The step that records a lane's changes without touching the working tree of the source checkout.
_Avoid_: commit, snapshot, export.

### Agents and capability

**Agent definition**:
A reusable role declared as a markdown file with frontmatter, resolved by name.
_Avoid_: agent config, template, persona.

**Agent source**:
Where an agent definition was found: bundled with the package, global to the user, or local to the project. Project wins over global wins over package.
_Avoid_: scope, origin, tier.

**Harness driver**:
The adapter for one harness CLI, owning how a run is launched, resumed, and read for results.
_Avoid_: backend, integration, provider.

**Runtime plan**:
The resolved model, provider, and thinking level for a run, with where each value came from.
_Avoid_: model config, settings, options.

**Session mode**:
How much of the parent's conversation a subagent inherits: standalone, lineage-only, or fork.
_Avoid_: context mode, inheritance.

**Auto-exit**:
Whether a subagent session ends when its agent loop ends, or stays open for the user.
_Avoid_: one-shot, ephemeral, detached.

**Tool allowlist**:
The tools a subagent may call, derived from its launch parameters and its agent definition's spawning and deny-tools declarations.
_Avoid_: permissions, access, sandbox policy.
