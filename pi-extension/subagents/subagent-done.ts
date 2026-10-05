/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import { createSubagentActivityRecorder, publishActivityEvent } from "./activity.ts";
import { observingHooks } from "./hooks.ts";
import { writeCompletionSidecar, type CompletionSidecar } from "./handoff.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function buildCompletionSidecar(messages: any[] | undefined): CompletionSidecar {
  const errorInfo = findLatestAssistantError(messages);
  return errorInfo ? { type: "error", ...errorInfo } : { type: "done" };
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export interface AssignedSkillAttempt {
  name: string;
  loaded: boolean;
  /** Resolved skill file; absent when the skill is not available in this catalog. */
  path?: string;
  /** Why this skill is not loaded, when it is not. */
  error?: string;
}

/**
 * Read the assigned skills into one instruction block. A missing or unreadable
 * skill fails the whole load, so an attempt is reported as loaded only when its
 * own read succeeded and the load completed — a partial read loads nothing.
 * `onAttempt` observes every attempt, loaded or not.
 */
export function loadAssignedSkills(
  selection: string,
  commands: SlashCommandInfo[],
  onAttempt?: (attempt: AssignedSkillAttempt) => void,
): string {
  if (!selection.trim() || selection.trim() === "none") return "";
  if (selection.trim() === "all") throw new Error("Assign specific skill names; skills: all is not supported.");

  const attempts: AssignedSkillAttempt[] = [...new Set(selection.split(",").map((name) => name.trim()).filter(Boolean))]
    .map((name) => {
      const skill = commands.find((command) => command.source === "skill" && command.name === `skill:${name}`);
      return skill
        ? { name, path: skill.sourceInfo.path, loaded: false }
        : { name, loaded: false, error: `Assigned skill not available: ${name}` };
    });

  try {
    const unavailable = attempts.find((attempt) => attempt.error);
    if (unavailable) throw new Error(unavailable.error);

    return attempts.map((attempt) => {
      const path = attempt.path!;
      const block = `<skill name="${attempt.name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${stripFrontmatter(readFileSync(path, "utf8")).trim()}\n</skill>`;
      attempt.loaded = true;
      return block;
    }).join("\n\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const attempt of attempts) {
      attempt.loaded = false;
      attempt.error ??= message;
    }
    throw error;
  } finally {
    for (const attempt of attempts) onAttempt?.(attempt);
  }
}

/** The child's own session id for event attribution; '' when the host has none. */
function childSessionId(ctx: { sessionManager?: { getSessionId?(): string } }): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "";
  } catch {
    return "";
  }
}

/**
 * Report one assigned-skill load attempt, in the child process, on the ordinary
 * pi.events channel. A silent no-op without the Activity reporter: loading
 * skills must not fail because nobody is collecting.
 */
function publishSkillAttempt(pi: ExtensionAPI, attempt: AssignedSkillAttempt, sessionId: string): void {
  const childId = process.env.PI_SUBAGENT_ID;
  const details = [
    attempt.path ? `path: ${attempt.path}` : "",
    attempt.error ? `error: ${attempt.error}` : "",
  ].filter(Boolean).join("\n");

  publishActivityEvent(pi, {
    session: sessionId,
    actor: {
      kind: "child",
      name: process.env.PI_SUBAGENT_NAME || "subagent",
      ...(childId ? { id: childId } : {}),
    },
    source: "skills",
    kind: "skill_assigned",
    severity: attempt.loaded ? "info" : "warning",
    summary: attempt.loaded
      ? `Assigned skill "${attempt.name}" loaded`
      : `Assigned skill "${attempt.name}" not loaded`,
    ...(details ? { details } : {}),
    correlation: { skill: attempt.name, ...(attempt.path ? { path: attempt.path } : {}) },
  });
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const assignedSkills = process.env.PI_SUBAGENT_SKILLS ?? "";
  // The recorder is created before any UI context exists, so its one bounded
  // warning waits for session_start. Otherwise a broken activity file would
  // degrade the parent's status view with nothing said about it.
  let notify: ((message: string, type?: "info" | "warning" | "error") => void) | undefined;
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
    onDisabled: (error) => {
      notify?.(
        "Subagent activity reporting disabled after repeated write failures: " +
          `${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    },
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  let latestAgentMessages: any[] | undefined;

  const hooks = observingHooks(pi);

  // Show widget + status bar on session start
  hooks.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    notify = (message, type) => ctx.ui.notify(message, type);
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  hooks.on("input", (event, ctx) => {
    recorder.input();
    if (shouldMarkUserTookOver(agentStarted)) userTookOver = true;
    if (!assignedSkills || assignedSkills.trim() === "none") return;
    try {
      const instructions = loadAssignedSkills(assignedSkills, pi.getCommands(), (attempt) =>
        publishSkillAttempt(pi, attempt, childSessionId(ctx)),
      );
      return { action: "transform", text: `${instructions}\n\n${event.text}`, images: event.images };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) writeCompletionSidecar(sessionFile, { type: "error", errorMessage, stopReason: "error" });
      ctx.ui.notify(errorMessage, "error");
      ctx.shutdown();
      return { action: "handled" };
    }
  });

  hooks.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  hooks.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
  });

  hooks.on("agent_end", (event) => {
    // agent_end is not terminal: Pi may compact and automatically retry after
    // this event. Keep the latest result, but do not publish completion or
    // shut down until agent_settled confirms no continuation will run.
    latestAgentMessages = (event as any).messages as any[] | undefined;
    recorder.agentEndWaiting();
  });

  hooks.on("agent_settled", (_event, ctx) => {
    const shouldExit = autoExit
      && shouldAutoExitOnAgentEnd(userTookOver, latestAgentMessages);

    if (shouldExit) {
      // Surface stopReason: "error" turns (auto-retry exhausted, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) {
        try {
          writeCompletionSidecar(sessionFile, buildCompletionSidecar(latestAgentMessages));
        } catch {
          // Best effort — the watcher can still detect the terminal sentinel
          // after shutdown if the completion sidecar cannot be written.
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest settled agent run completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  hooks.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  hooks.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  hooks.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  hooks.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  hooks.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  hooks.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  hooks.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
    if (parseDeniedTools(deniedToolsValue).includes(event.toolName)) {
      return { block: true, reason: `Tool denied by this agent definition: ${event.toolName}` };
    }
  });

  hooks.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  hooks.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  hooks.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  hooks.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      writeCompletionSidecar(sessionFile, {
        type: "ping",
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      });

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.subagentDone();
      if (sessionFile) {
        writeCompletionSidecar(sessionFile, { type: "done" });
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
