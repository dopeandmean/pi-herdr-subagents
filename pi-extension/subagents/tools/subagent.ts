import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { routingGuidelines } from "../guidelines.ts";
import { isTerminalAvailable } from "../herdr.ts";
import { SubagentParams } from "../params.ts";
import { type RunningSubagent, launchSubagent, muxUnavailableResult, startStatusRefresh, startWidgetRefresh, superviseRun } from "../run.ts";
import { Text } from "@earendil-works/pi-tui";

const DOC =
  "Spawn a sub-agent in a dedicated terminal herdr pane. " +
  "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
  "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
  "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
  "DO NOT fabricate, assume, or summarize results after calling this tool. " +
  "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.";

export function createTool(pi: ExtensionAPI): ToolDefinition<typeof SubagentParams> {
  return {
  name: "subagent",
  label: "Subagent",
  description: DOC,
  promptSnippet: DOC,
  promptGuidelines: routingGuidelines,
  parameters: SubagentParams,

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    // Prevent self-spawning (e.g. planner spawning another planner)
    const currentAgent = process.env.PI_SUBAGENT_AGENT;
    if (params.agent && currentAgent && params.agent === currentAgent) {
      return {
        content: [
          {
            type: "text",
            text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
          },
        ],
        details: { error: "self-spawn blocked" },
      };
    }

    // Validate prerequisites
    if (!isTerminalAvailable()) {
      return muxUnavailableResult();
    }

    if (!ctx.sessionManager.getSessionFile()) {
      return {
        content: [
          {
            type: "text",
            text: "Error: no session file. Start pi with a persistent session to use subagents.",
          },
        ],
        details: { error: "no session file" },
      };
    }

    // Launch the subagent (creates pane, sends command)
    const parentThinking = pi.getThinkingLevel();
    if (
      parentThinking !== "off" &&
      parentThinking !== "minimal" &&
      parentThinking !== "low" &&
      parentThinking !== "medium" &&
      parentThinking !== "high" &&
      parentThinking !== "xhigh" &&
      parentThinking !== "max"
    ) {
      throw new Error(`Unsupported parent thinking level: ${parentThinking}`);
    }
    let running: RunningSubagent;
    try {
      running = await launchSubagent(params, ctx, parentThinking);
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error?.message ?? String(error)}` }],
        details: { error: error?.message ?? String(error), status: "rejected" },
      };
    }

    // Create a separate AbortController for the watcher
    // (the tool's signal completes when we return)
    const watcherAbort = new AbortController();
    running.abortController = watcherAbort;

    // Start widget refresh and status supervision when the first agent launches
    startWidgetRefresh();
    startStatusRefresh(pi);

    // Fire-and-forget: the run delivers its own result when it finishes.
    superviseRun(pi, running, watcherAbort.signal);

    // Return immediately
    return {
      content: [
        {
          type: "text",
          text:
            `Sub-agent "${params.name}" launched and is now running in the background. ` +
            `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
            `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
            `Until then, move on to other work or tell the user you're waiting.`,
        },
      ],
      details: {
        id: running.id,
        name: params.name,
        task: params.task,
        agent: params.agent,
        sessionFile: running.sessionFile,
        launchScriptFile: running.launchScriptFile,
        model: running.runtimePlan?.model,
        thinking: running.runtimePlan?.thinking,
        runtimePlan: running.runtimePlan,
        status: "started",
        ...(running.worktree
          ? {
              worktree: {
                branch: running.worktree.allocation.branch,
                path: running.worktree.allocation.path,
                baseCommit: running.worktree.allocation.baseCommit,
              },
            }
          : {}),
      },
    };
  },

  renderCall(args, theme) {
    const partialArgs = args as Record<string, unknown>;
    const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
    const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
    const agent = typeof partialArgs.agent === "string" && partialArgs.agent
      ? theme.fg("dim", ` (${partialArgs.agent})`)
      : "";
    const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
      ? theme.fg("dim", ` in ${partialArgs.cwd}`)
      : "";
    let text =
      "▸ " +
      theme.fg("toolTitle", theme.bold(name)) +
      agent +
      cwdHint;

    // Show a one-line task preview. renderCall is called repeatedly as the
    // LLM generates tool arguments, so args.task grows token by token.
    // We keep it compact here — Ctrl+O on renderResult expands the full content.
    if (task) {
      const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
      const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
      if (preview) {
        text += "\n" + theme.fg("toolOutput", preview);
      }
      const totalLines = task.split("\n").length;
      if (totalLines > 1) {
        text += theme.fg("muted", ` (${totalLines} lines)`);
      }
    }

    return new Text(text, 0, 0);
  },

  renderResult(result, _opts, theme) {
    const details = result.details as any;
    const name = details?.name ?? "(unnamed)";

    // "Started" result — tool returned immediately
    if (details?.status === "started") {
      const runtime = details?.model
        ? ` — ${details.model}${details.thinking ? ` · ${details.thinking}` : ""}`
        : " — started";
      return new Text(
        theme.fg("accent", "▸") +
          " " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", runtime),
        0,
        0,
      );
    }

    // Fallback (shouldn't happen)
    const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
    return new Text(theme.fg("dim", text), 0, 0);
  },
  };
}
