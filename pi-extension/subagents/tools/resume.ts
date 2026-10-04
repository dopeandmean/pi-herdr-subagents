import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getSubagentActivityFile } from "../activity.ts";
import { contextArtifactName, formatPiLaunch, readPiLaunchProfile } from "../harness/drivers/pi.ts";
import { SENTINEL_TRAILER } from "../handoff.ts";
import { createSubagentPane, isTerminalAvailable, runScriptInPane, setPaneTask, shellQuote } from "../herdr.ts";
import { createLifecycle } from "../lifecycle.ts";
import { type RunningSubagent, getArtifactDir, getShellReadyDelayMs, muxUnavailableResult, resolveResumeLaunchBehavior, runningSubagents, startStatusRefresh, startWidgetRefresh, superviseRun } from "../run.ts";
import { findLastAssistantMessage, getNewEntries } from "../session.ts";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOC =
  "Resume a previous sub-agent session in a new herdr pane. " +
  "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
  "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
  "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
  "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
  "Use when a sub-agent was cancelled or needs follow-up work.";

const ResumeParams = Type.Object({
  sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
  name: Type.Optional(
    Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" }),
  ),
  message: Type.Optional(
    Type.String({
      description: "Optional message to send after resuming (e.g. follow-up instructions)",
    }),
  ),
  autoExit: Type.Optional(
    Type.Boolean({
      description:
        "Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
    }),
  ),
});

/** Absolute path to `pi-extension/subagents`. */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/tools$/, "");

export function createTool(pi: ExtensionAPI): ToolDefinition<typeof ResumeParams> {
  return {
  name: "subagent_resume",
  label: "Resume Subagent",
  description: DOC,
  promptSnippet: DOC,
  parameters: ResumeParams,
  renderCall(args, theme) {
    const name = args.name ?? "Resume";
    const text =
      "▸ " +
      theme.fg("toolTitle", theme.bold(name)) +
      theme.fg("dim", " — resuming session");
    return new Text(text, 0, 0);
  },

  renderResult(result, _opts, theme) {
    const details = result.details as any;
    const name = details?.name ?? "Resume";

    if (details?.status === "started") {
      return new Text(
        theme.fg("accent", "▸") +
          " " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — resumed"),
        0,
        0,
      );
    }

    // Fallback
    const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
    return new Text(theme.fg("dim", text), 0, 0);
  },

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const name = params.name ?? "Resume";
    const { autoExit, interactive } = resolveResumeLaunchBehavior(params);
    const startTime = Date.now();
    const id = Math.random().toString(16).slice(2, 10);

    if (!isTerminalAvailable()) {
      return muxUnavailableResult();
    }

    if (!existsSync(params.sessionPath)) {
      return {
        content: [
          { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
        ],
        details: { error: "session not found" },
      };
    }

    // Record entry count before resuming so we can extract new messages
    const entryCountBefore = getNewEntries(params.sessionPath, 0).length;

    const profile = readPiLaunchProfile(params.sessionPath);
    const surface = createSubagentPane(name);
    if (params.message) {
      setPaneTask(surface, params.message);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

    // Build pi resume command
    const parts = profile ? [...profile.args] : ["pi", "--session", params.sessionPath];

    // Load subagent-done extension so the agent can self-terminate if needed
    const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
    if (!profile) parts.push("-e", subagentDonePath);

    const sessionId = ctx.sessionManager.getSessionId();
    const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
    const activityFile = getSubagentActivityFile(artifactDir, id);
    mkdirSync(dirname(activityFile), { recursive: true });

    let resumeMsgFile: string | undefined;
    if (params.message) {
      resumeMsgFile = join(artifactDir, "subagent-resume", contextArtifactName(name, id));
      mkdirSync(dirname(resumeMsgFile), { recursive: true });
      writeFileSync(resumeMsgFile, params.message, "utf8");
      parts.push(`@${resumeMsgFile}`);
    }

    // Preserve role settings while assigning this resumed run a fresh identity.
    const env = profile ? { ...profile.env } : {};
    if (!profile && process.env.PI_CODING_AGENT_DIR) env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    env.PI_SUBAGENT_NAME = name;
    env.PI_SUBAGENT_SESSION = params.sessionPath;
    env.PI_SUBAGENT_ID = id;
    env.PI_SUBAGENT_ACTIVITY_FILE = activityFile;
    env.PI_SUBAGENT_SURFACE = surface;
    env.PI_SUBAGENT_AUTO_EXIT = autoExit ? "1" : "0";
    const command = `${formatPiLaunch({ args: parts, env, cwd: profile?.cwd ?? null }, shellQuote)}${SENTINEL_TRAILER}`;
    const launchScriptFile = join(
      artifactDir,
      "subagent-scripts",
      `${name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "resume"}-resume-${Date.now()}.sh`,
    );
    runScriptInPane(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: [
        `# Subagent resume script for ${name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Session: ${params.sessionPath}`,
        `# Surface: ${surface}`,
        ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : []),
      ].join("\n"),
    });

    // Register as a running subagent for widget tracking
    const running: RunningSubagent = {
      id,
      name,
      task: params.message ?? "resumed session",
      surface,
      startTime,
      sessionFile: params.sessionPath,
      launchScriptFile,
      activityFile,
      interactive,
      runtimePlan: undefined,
      lifecycle: createLifecycle(startTime),
    };
    runningSubagents.set(id, running);
    startWidgetRefresh();
    startStatusRefresh(pi);

    // Fire-and-forget watcher
    const watcherAbort = new AbortController();
    running.abortController = watcherAbort;

    // Fire-and-forget: the run delivers its own result when it finishes.
    superviseRun(pi, running, watcherAbort.signal, {
      sessionFile: params.sessionPath,
      resolveSummary: (result) =>
        findLastAssistantMessage(getNewEntries(params.sessionPath, entryCountBefore)) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Resumed session exited with code ${result.exitCode}`
            : "Resumed session exited without new output"),
    });

    return {
      content: [{ type: "text", text: `Session "${name}" resumed.` }],
      details: {
        id,
        name,
        sessionPath: params.sessionPath,
        launchScriptFile,
        status: "started",
      },
    };
  },
  };
}
