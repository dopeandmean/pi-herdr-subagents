import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { terminalSetupHint, createSubagentPane, runScriptInPane, closePane, interruptPane, shellQuote, readPane, readPaneAsync, inspectPane, setPaneTask } from "./herdr.ts";
import { waitForCompletion } from "./completion.ts";
import { renderSubagentWidgetLines } from "./widget.ts";
import { type SubagentLaunchParams } from "./params.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

import { getDefaultSessionDirFor, loadAgentDefaults, resolveDenyTools, resolveEffectiveAutoExit, resolveEffectiveInteractive, resolveLaunchBehavior, resolveSubagentPaths } from "./discovery.ts";
import { resolveRuntimePlan, wrapPiModelRegistry, type ResolvedRuntimePlan, type ThinkingLevel } from "./runtime-routing.ts";
import { getHarnessDriver } from "./harness/index.ts";
import { loadModelConfig, resolveModelDefault } from "./model-config.ts";
import { findLastAssistantMessage, findObservedSessionRuntime, getNewEntries, seedSubagentSessionFile } from "./session.ts";
import { capStatusLines, formatElapsedDuration, formatStatusAggregate, normalizeStatusName, loadStatusConfig } from "./status.ts";
import { allocateWorktree, captureHandoff, removeLane, type LaneEntry, type WorktreeAllocation } from "./worktree.ts";
import { getSubagentActivityFile, readSubagentActivityFile, type ActivityReadResult, type SubagentActivityState } from "./activity.ts";
import { createLifecycle, formatLifecycleTransitionLine, lifecycleTransition, markCompleted, markCompletionDetected, markDelivery, markFailed, markInterruptRequested, markProcessRunning, observeActivity, observePaneInspection, projectLifecycle, type LifecycleProjection, type SubagentLifecycle, type PaneInspection } from "./lifecycle.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
/**
 * The run pipeline: launching a subagent into its own pane, observing it, and
 * delivering its result to the parent session exactly once.
 *
 * Runtime state lives here — not in the extension that registers the tools —
 * so it survives a /reload and so a tool's job is limited to describing its
 * parameters and rendering its own output.
 */

const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const RUNTIME_KEY = Symbol.for("pi-subagents/runtime");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
}




export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
export function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

export function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require herdr. ${terminalSetupHint()}`,
      },
    ],
    details: { error: "herdr not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
export function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const statusConfig = loadStatusConfig();
const modelConfig = loadModelConfig();

export function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage"
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_resume.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
export interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  ping?: { name: string; message: string };
  /** Isolated worktree lane evidence, when the spawn used `worktree: true`. */
  worktreeLane?: WorktreeLaneOutcome;
}

export interface WorktreeLaneOutcome {
  laneId: string;
  branch: string;
  worktree: string;
  manifestFile?: string;
  patchFile?: string;
  changedPaths: number;
  childCommits: number;
  captureError?: string;
  cleanup: "removed" | "preserved" | "pending";
  cleanupReason?: string;
}

/**
 * One-line-per-fact summary of a lane, steered to the parent on completion.
 */
export function formatWorktreeLane(outcome: WorktreeLaneOutcome): string {
  const changed = `${outcome.changedPaths} changed path${outcome.changedPaths === 1 ? "" : "s"}` +
    (outcome.childCommits > 0 ? `, ${outcome.childCommits} child commit(s)` : "");
  const lines = [`Worktree lane ${outcome.branch} at ${outcome.worktree}`, `Changes: ${changed}`];
  if (outcome.patchFile) lines.push(`Patch: ${outcome.patchFile}`);
  if (outcome.manifestFile) lines.push(`Manifest: ${outcome.manifestFile}`);
  if (outcome.captureError) {
    lines.push(
      `Handoff capture FAILED: ${outcome.captureError}\nThe worktree, branch, and artifacts were preserved for recovery — do not assume the patch is complete.`,
    );
  } else if (outcome.cleanup === "removed") {
    lines.push("Lane removed: no changes were captured, so the worktree and branch were cleaned up.");
  } else {
    lines.push(
      `Lane preserved for review/merge: ${outcome.cleanupReason ?? "changes must be reviewed before cleanup"}. ` +
        `Review read-only from ${outcome.patchFile ?? "the manifest"}, merge it yourself (git merge ${outcome.branch} or git apply), then clean up with subagent_worktrees({ action: "cleanup", lane: "${outcome.laneId}" }).`,
    );
  }
  return lines.join("\n");
}

/**
 * State for a launched (but not yet completed) subagent.
 */
export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  lifecycle: SubagentLifecycle;
  /** Last projected kind used to detect stalled/recovered transitions. */
  lastProjectedKind?: LifecycleProjection["kind"];
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
  /** Parent-resolved model/thinking selection and provenance. */
  runtimePlan: ResolvedRuntimePlan | undefined;
  /** Isolated worktree lane for this run, when spawned with `worktree: true`. */
  worktree?: { allocation: WorktreeAllocation; artifactDir: string };
}

export interface SubagentRuntime {
  runningSubagents: Map<string, RunningSubagent>;
  pi?: ExtensionAPI;
  latestCtx?: ExtensionContext;
  modelCatalog?: string;
  agentCatalog?: string;
}

export function createSubagentRuntime(): SubagentRuntime {
  return { runningSubagents: new Map<string, RunningSubagent>() };
}

/** Runtime state preserved across /reload. */
export const runtime: SubagentRuntime =
  (globalThis as any)[RUNTIME_KEY] ??
  ((globalThis as any)[RUNTIME_KEY] = createSubagentRuntime());
export const runningSubagents = runtime.runningSubagents;

export function shouldPreserveSubagentsOnShutdown(reason: unknown): boolean {
  return reason === "reload";
}

export function cleanupSubagentsForShutdown(
  reason: unknown,
  agents: Map<string, Pick<RunningSubagent, "abortController" | "lifecycle">>,
): void {
  if (shouldPreserveSubagentsOnShutdown(reason)) return;

  for (const agent of agents.values()) {
    if (agent.lifecycle) {
      agent.lifecycle = markDelivery(agent.lifecycle, "suppressed");
    }
    agent.abortController?.abort();
  }
  agents.clear();
}

export function shouldDeliverSubagentCompletion(
  running: Pick<RunningSubagent, "lifecycle">,
): boolean {
  // Authoritative gate: only pending deliveries may be sent.
  // Missing lifecycle (pre-migration fixtures) defaults to pending/true.
  return (running.lifecycle?.delivery ?? "pending") === "pending";
}

export function selectCompletionApi<T>(previous: T, current: T | undefined): T {
  return current ?? previous;
}

// ── Widget management ──

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

export function updateWidget() {
  const latestCtx = runtime.latestCtx;
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(
            Array.from(runningSubagents.values(), (running) => ({
              ...running,
              lifecycle: ensureLifecycle(running),
            })),
            width,
            { statusEnabled: statusConfig.enabled },
          );
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */


export function ensureLifecycle(running: RunningSubagent): SubagentLifecycle {
  if (running.lifecycle) return running.lifecycle;
  // No lifecycle to hydrate: a runtime entry left over from an older release.
  // Start from a running process and let the next observation correct it.
  running.lifecycle = markProcessRunning(createLifecycle(running.startTime), running.startTime);
  return running.lifecycle;
}

export function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  ensureLifecycle(running);
  const driver = getHarnessDriver(running.cli);
  if (!driver.hasActivitySnapshots) return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) running.activity = read.activity;
  running.lifecycle = observeActivity(ensureLifecycle(running), read, observedAt);
}

export function resolveInterruptTarget(params: { id?: string; name?: string }):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

export function requestSubagentInterrupt(
  running: RunningSubagent,
  interruptPaneKey: (surface: string) => void = interruptPane,
): { ok: true } | { error: string } {
  try {
    interruptPaneKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via herdr: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

export function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  interruptPaneKey: (surface: string) => void = interruptPane,
) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const driver = getHarnessDriver(running.cli);
  if (!driver.supportsTurnInterrupt) {
    return {
      content: [{
        type: "text" as const,
        text:
          `Turn-only Escape interrupt is currently supported only for Pi-backed subagents. ${driver.name}-backed semantics have not been verified yet.`,
      }],
      details: {
        error: `${running.cli ?? "external"} interrupt unsupported`,
        id: running.id,
        name: running.name,
      },
    };
  }

  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, interruptPaneKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: { error: interruption.error, id: running.id, name: running.name },
    };
  }

  running.lifecycle = markInterruptRequested(ensureLifecycle(running), now);
  updateWidget();

  return {
    content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

export function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const projection = projectLifecycle(ensureLifecycle(running), now);
      const transition = lifecycleTransition(running.lastProjectedKind, projection.kind);
      if (running.lastProjectedKind !== projection.kind) {
        shouldRefreshWidget = true;
      }
      running.lastProjectedKind = projection.kind;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(
          formatLifecycleTransitionLine(
            normalizeStatusName(running.name),
            projection,
            transition,
            now,
            running.startTime,
            formatElapsedDuration,
          ),
        );
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

export function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): { autoExit: boolean; interactive: boolean } {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

export function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/** Stop the widget and status timers. Runtime state itself survives a /reload. */
export function stopTracking(): void {
  if (widgetInterval) {
    clearInterval(widgetInterval);
    widgetInterval = null;
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
}

/** Per-run delivery tweaks; everything else comes from the run record. */
export interface RunDelivery {
  /** Overrides the summary shown to the parent (resumed runs read the resumed session). */
  resolveSummary?: (result: SubagentResult) => string;
  /** Session the parent should resume, when it differs from the run's own session. */
  sessionFile?: string;
}

/**
 * Watch a run to completion and deliver its result to the parent session as
 * exactly one steer message: a ping the child asked for, the error that ended
 * it, or the summary it produced. Fire-and-forget — the tool returns as soon as
 * the run is launched.
 */
export function superviseRun(
  pi: ExtensionAPI,
  run: RunningSubagent,
  signal: AbortSignal,
  delivery: RunDelivery = {},
): void {
  watchSubagent(run, signal)
    .then((result) => deliverRunResult(pi, run, result, delivery))
    .catch((error: any) => deliverRunFailure(pi, run, error));
}

/** Untrack a finished run and report whether its result may still be delivered. */
function settleRun(pi: ExtensionAPI, run: RunningSubagent): ExtensionAPI | null {
  const deliver = shouldDeliverSubagentCompletion(run);
  run.lifecycle = markDelivery(run.lifecycle, deliver ? "delivered" : "suppressed");
  runningSubagents.delete(run.id);
  updateWidget();
  return deliver ? selectCompletionApi(pi, runtime.pi) : null;
}

function deliverRunResult(
  pi: ExtensionAPI,
  run: RunningSubagent,
  result: SubagentResult,
  delivery: RunDelivery,
): void {
  const completionApi = settleRun(pi, run);
  if (!completionApi) return;

  const sessionFile = delivery.sessionFile ?? result.sessionFile;
  if (result.ping) {
    const sessionRef = sessionFile
      ? `\n\nSession: ${sessionFile}\nResume: pi --session ${sessionFile}`
      : "";
    completionApi.sendMessage(
      {
        customType: "subagent_ping",
        content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
        display: true,
        details: {
          name: result.ping.name,
          message: result.ping.message,
          agent: run.agent,
          sessionFile,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    return;
  }

  const summary = delivery.resolveSummary?.(result) ?? result.summary;
  const presentation = [
    resolveResultPresentation({ ...result, summary, sessionFile }, run.name),
    result.worktreeLane ? formatWorktreeLane(result.worktreeLane) : "",
    run.runtimePlan?.runtimeMismatch ? `Runtime warning: ${run.runtimePlan.runtimeMismatch}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  completionApi.sendMessage(
    {
      customType: "subagent_result",
      content: presentation,
      display: true,
      details: {
        name: run.name,
        task: run.task,
        agent: run.agent,
        exitCode: result.exitCode,
        elapsed: result.elapsed,
        sessionFile,
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
        ...(run.runtimePlan ? { runtimePlan: run.runtimePlan } : {}),
        ...(result.worktreeLane ? { worktreeLane: result.worktreeLane } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

function deliverRunFailure(pi: ExtensionAPI, run: RunningSubagent, error: any): void {
  const completionApi = settleRun(pi, run);
  if (!completionApi) return;
  completionApi.sendMessage(
    {
      customType: "subagent_result",
      content: `Sub-agent "${run.name}" error: ${error?.message ?? String(error)}`,
      display: true,
      details: { name: run.name, task: run.task, error: error?.message },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/**
 * Launch a subagent: creates the herdr pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
export async function launchSubagent(
  params: SubagentLaunchParams,
  ctx: {
    sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string };
    cwd: string;
    model?: { provider: string; id: string };
    modelRegistry: {
      find(provider: string, modelId: string): any;
      getAvailable?: () => any[];
      getAll?: () => any[];
      hasConfiguredAuth?: (model: any) => boolean;
    };
  },
  parentThinking: ThinkingLevel,
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  if (!ctx.model) throw new Error("Subagent launch requires a resolved parent model");
  const runtimePlan = resolveRuntimePlan(
    { model: params.model, thinking: params.thinking },
    {
      model: resolveModelDefault(params.agent, agentDefs?.model, modelConfig),
      thinking: agentDefs?.thinking,
    },
    { provider: ctx.model.provider, modelId: ctx.model.id, thinking: parentThinking },
    wrapPiModelRegistry(ctx.modelRegistry),
  );
  const effectiveThinking = runtimePlan.thinking;
  const effectiveAutoExit = resolveEffectiveAutoExit(params, agentDefs);
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  const cliId = agentDefs?.cli ?? "pi";
  const driver = getHarnessDriver(cliId);
  driver.validateRuntimePlan?.(runtimePlan, parentThinking);

  // Preflight and allocate the isolated lane before anything is launched: a
  // dirty or non-Git source checkout rejects the spawn without side effects.
  let worktreeAllocation: WorktreeAllocation | undefined;
  if (params.worktree) {
    worktreeAllocation = allocateWorktree({
      cwd: effectiveCwd ?? ctx.cwd,
      label: params.name,
      laneId: id,
      baseRef: params.baseRef,
    });
  }
  const childCwd = worktreeAllocation?.path ?? effectiveCwd;

  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSubagentPane(params.name);
  if (params.task) {
    setPaneTask(surface, params.task);
  }
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  if (driver.hasActivitySnapshots) {
    mkdirSync(dirname(activityFile), { recursive: true });
  }
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = effectiveAutoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = effectiveAutoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const denySet = resolveDenyTools(agentDefs);
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const effectiveModel = driver.formatModel(runtimePlan);

  const built = driver.buildCommand({
    params: { ...params, id },
    agentDefs,
    runtimePlan,
    effectiveModel,
    effectiveThinking,
    parentThinking,
    surface,
    artifactDir,
    sessionDir,
    subagentSessionFile,
    effectiveCwd: childCwd,
    localAgentDir,
    effectiveAutoExit,
    effectiveInteractive,
    inheritsConversationContext,
    taskDelivery: launchBehavior.taskDelivery,
    denySet,
    identity,
    identityInSystemPrompt: Boolean(identityInSystemPrompt),
    systemPromptMode,
    roleBlock,
    modeHint,
    summaryInstruction,
    subagentsDir: SUBAGENTS_DIR,
    shellQuote,
  });

  const launchScriptName = `${(params.name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

  runScriptInPane(surface, built.command, {
    scriptPath: launchScriptFile,
    scriptPreamble: (built.launchScriptPreamble ?? [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Surface: ${surface}`,
    ]).join("\n"),
  });

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: built.sessionFile ?? subagentSessionFile,
    launchScriptFile,
    cli: built.cli,
    sentinelFile: built.sentinelFile,
    interactive: effectiveInteractive,
    runtimePlan,
    ...(worktreeAllocation ? { worktree: { allocation: worktreeAllocation, artifactDir } } : {}),
    activityFile: driver.hasActivitySnapshots ? activityFile : undefined,
    lifecycle: !driver.hasActivitySnapshots
      ? markProcessRunning(createLifecycle(startTime), Date.now())
      : createLifecycle(startTime),
  };

  runningSubagents.set(id, running);
  return running;
}

/**
 * Capture the lane handoff once the child is terminal, then clean up only the
 * lanes that produced no changes at all. Lanes with work are preserved so the
 * parent can review and merge them; removal stays an explicit action.
 */
export function finalizeWorktreeLane(
  running: RunningSubagent,
  result: SubagentResult,
): SubagentResult {
  const lane = running.worktree;
  if (!lane) return result;

  const terminalState = {
    status:
      result.error === "cancelled"
        ? ("cancelled" as const)
        : result.exitCode === 0
          ? ("completed" as const)
          : ("failed" as const),
    exitCode: result.exitCode,
  };

  let entry: LaneEntry | null = null;
  let captureError: string | undefined;
  try {
    entry = captureHandoff({
      allocation: lane.allocation,
      laneId: running.id,
      artifactDir: lane.artifactDir,
      name: running.name,
      agent: running.agent,
      terminalState,
    });
    if (!entry.manifest.capture.ok) captureError = entry.manifest.capture.error ?? "unknown error";
  } catch (error: any) {
    captureError = error?.message ?? String(error);
  }

  const manifest = entry?.manifest ?? null;
  let cleanup: WorktreeLaneOutcome["cleanup"] = "preserved";
  let cleanupReason: string | undefined = "changes await review before cleanup";

  if (captureError) {
    cleanupReason = "handoff capture failed";
  } else if (entry && manifest && manifest.changedPaths.length === 0 && manifest.childCommits === 0) {
    const removed = removeLane(entry, { by: `subagent:${running.name}` });
    cleanup = removed.removed ? "removed" : "preserved";
    cleanupReason = removed.removed ? undefined : removed.reason;
  }

  return {
    ...result,
    worktreeLane: {
      laneId: running.id,
      branch: lane.allocation.branch,
      worktree: lane.allocation.path,
      ...(entry ? { manifestFile: entry.manifestFile } : {}),
      ...(manifest && existsSync(manifest.patchFile) ? { patchFile: manifest.patchFile } : {}),
      changedPaths: manifest?.changedPaths.length ?? 0,
      childCommits: manifest?.childCommits ?? 0,
      ...(captureError ? { captureError } : {}),
      cleanup,
      ...(cleanupReason ? { cleanupReason } : {}),
    },
  };
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
export async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const result = await watchSubagentRun(running, signal);
  return finalizeWorktreeLane(running, result);
}

export async function watchSubagentRun(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await waitForCompletion(signal, {
      intervalMs: 1000,
      sessionFile,
      sentinelFile: running.sentinelFile,
      readTerminalTail: () => readPaneAsync(surface, 5),
      inspectPane: async () => inspectPane(surface),
      onPaneInspection: (inspection: PaneInspection, observedAt: number) => {
        ensureLifecycle(running);
        running.lifecycle = observePaneInspection(running.lifecycle, inspection, observedAt);
        updateWidget();
      },
      onTick() {
        observeRunningSubagent(running);
      },
    });

    const detectedAt = Date.now();
    running.lifecycle = markCompletionDetected(running.lifecycle, result, detectedAt);
    updateWidget();
    const elapsed = Math.floor((detectedAt - startTime) / 1000);

    const driver = getHarnessDriver(running.cli);
    if (driver.extractResult) {
      const extracted = await driver.extractResult({
        running,
        completionResult: result,
        surface,
        readPane,
        closePane,
        artifactDir: dirname(running.launchScriptFile ?? running.sessionFile),
      });

      if (extracted) {
        closePane(surface);
        running.lifecycle = result.exitCode === 0
          ? markCompleted(running.lifecycle, Date.now())
          : markFailed(running.lifecycle, result.errorMessage ?? extracted.summary, Date.now(), result.exitCode);

        return {
          name,
          task,
          summary: extracted.summary,
          exitCode: result.exitCode,
          elapsed,
          ...(extracted.sessionId ? { claudeSessionId: extracted.sessionId } : {}),
          ...extracted.details,
        };
      }
    }

    // Pi subagent result extraction
    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      const observed = findObservedSessionRuntime(allEntries);
      if (running.runtimePlan && observed.provider && observed.modelId) {
        const observedModel = `${observed.provider}/${observed.modelId}`;
        const observedThinking =
          observed.thinking === "off" ||
          observed.thinking === "minimal" ||
          observed.thinking === "low" ||
          observed.thinking === "medium" ||
          observed.thinking === "high" ||
          observed.thinking === "xhigh" ||
          observed.thinking === "max"
            ? observed.thinking
            : undefined;
        const mismatch = observedModel !== running.runtimePlan.model
          ? `Resolved model ${running.runtimePlan.model} but child reported ${observedModel}`
          : undefined;
        running.runtimePlan = {
          ...running.runtimePlan,
          ...(observedThinking ? { thinking: observedThinking } : {}),
          observed: {
            model: observedModel,
            ...(observedThinking ? { thinking: observedThinking } : {}),
          },
          ...(mismatch ? { runtimeMismatch: mismatch } : {}),
        };
      }
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    closePane(surface);
    running.lifecycle = result.exitCode === 0
      ? markCompleted(running.lifecycle, Date.now())
      : markFailed(running.lifecycle, result.errorMessage ?? summary, Date.now(), result.exitCode);

    return {
      name,
      task,
      summary,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      ping: result.ping,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  } catch (err: any) {
    try {
      closePane(surface);
    } catch {
      // Best effort: the pane may already be gone.
    }
    running.lifecycle = markFailed(
      running.lifecycle,
      signal.aborted ? "Subagent cancelled." : err?.message ?? String(err),
      Date.now(),
      1,
    );
    updateWidget();

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}
