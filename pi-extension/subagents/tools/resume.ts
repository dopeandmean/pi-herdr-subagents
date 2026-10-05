import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getSubagentActivityFile } from "../activity.ts";
import { contextArtifactName, formatPiLaunch, readPiLaunchProfile, resumeActivityLaunch, type PiLaunchProfile } from "../harness/drivers/pi.ts";
import { SENTINEL_TRAILER } from "../handoff.ts";
import { createSubagentPane, isTerminalAvailable, paneRunLabel, runScriptInPane, setPaneTaskLabel, shellQuote } from "../herdr.ts";
import { createLifecycle } from "../lifecycle.ts";
import { type RunningSubagent, getArtifactDir, getShellReadyDelayMs, muxUnavailableResult, resolveResumeLaunchBehavior, startStatusRefresh, startWidgetRefresh, superviseRun, trackRunningSubagent } from "../run.ts";
import { findLastAssistantMessage, getNewEntries } from "../session.ts";
import { lanesContaining, lanesForSession, validateLaneResume } from "../worktree.ts";
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

type LaneAttachment = NonNullable<RunningSubagent["worktree"]>;

/**
 * Re-attach a resumed session to the one lane it owns, or explain why the
 * resume must not proceed. The lane reference is durable session evidence —
 * never a guess from the session's label or cwd — and every failure keeps the
 * lane, its branch, its worktree and its manifest untouched.
 */
function resolveLaneAttachment(options: {
  profile: PiLaunchProfile | null;
  sessionPath: string;
  artifactDir: string;
}): { ok: true; lane?: LaneAttachment } | { ok: false; error: string } {
  const reference = options.profile?.lane;
  if (reference) {
    const validated = validateLaneResume({
      reference,
      sessionPath: options.sessionPath,
      cwd: options.profile?.cwd ?? null,
    });
    return validated.ok
      ? {
          ok: true,
          lane: {
            allocation: validated.allocation,
            artifactDir: reference.artifactDir,
            laneId: reference.laneId,
          },
        }
      : validated;
  }

  // Lane evidence without a usable reference — an older profile, or a resume
  // after the reference was lost — cannot be verified: guessing which lane the
  // session owns would let a follow-up edit a lane it does not own.
  const recorded = lanesForSession(options.artifactDir, options.sessionPath);
  if (recorded.length > 0) {
    return {
      ok: false,
      error:
        `lane ${recorded.map((entry) => entry.manifest.laneId).join(", ")} records this session but the launch profile carries no lane reference` +
        (recorded.length > 1 ? " (multiple lanes recorded for one session)" : ""),
    };
  }

  // No evidence names this session, but a pre-reference profile may still have
  // been launched inside a lane. Resuming there would edit a lane nothing
  // recaptures, so refuse instead of guessing ownership from the cwd.
  const cwd = options.profile?.cwd ?? null;
  const inside = lanesContaining(options.artifactDir, cwd);
  if (inside.length > 0) {
    return {
      ok: false,
      error:
        `the recorded cwd ${cwd} is inside lane worktree ${inside
          .map((entry) => entry.manifest.worktree)
          .join(", ")}, but the launch profile carries no lane reference proving this session owns it` +
        (inside.length > 1 ? " (multiple lanes contain it)" : ""),
    };
  }
  return { ok: true };
}

/** Rejecting a resume never creates side effects: no pane, no cleanup. */
function laneRejection(name: string, sessionPath: string, error: string) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Error: refusing to resume "${name}": ${error}. No pane was opened; the lane's ` +
          "worktree, branch, manifest and patch were left untouched.",
      },
    ],
    details: { error, name, sessionPath, status: "rejected" as const },
  };
}

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

    const sessionId = ctx.sessionManager.getSessionId();
    const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

    // Resolve lane ownership before anything is launched: a rejected
    // association must not open a pane or touch the lane's evidence.
    let profile: PiLaunchProfile | null = null;
    let lane: LaneAttachment | undefined;
    try {
      profile = readPiLaunchProfile(params.sessionPath);
      const attachment = resolveLaneAttachment({
        profile,
        sessionPath: params.sessionPath,
        artifactDir,
      });
      if (!attachment.ok) return laneRejection(name, params.sessionPath, attachment.error);
      lane = attachment.lane;
    } catch (error: any) {
      return laneRejection(name, params.sessionPath, error?.message ?? String(error));
    }

    const surface = createSubagentPane(name);
    if (params.message) {
      setPaneTaskLabel(surface, paneRunLabel(profile?.env?.PI_SUBAGENT_AGENT, name, id));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

    // Build pi resume command
    const parts = profile ? [...profile.args] : ["pi", "--session", params.sessionPath];

    // Load subagent-done extension so the agent can self-terminate if needed
    const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
    if (!profile) parts.push("-e", subagentDonePath);

    // Refresh the Activity transport from this process: the profile's copy, if
    // any, named a collector that may already be gone.
    const activity = resumeActivityLaunch(parts);
    parts.push(...activity.args);

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
    const env = { ...profile?.env, ...activity.env };
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

    // Register as a running subagent for widget tracking. The resumed run keeps
    // its own id; the lane it works in is the one the session already owns.
    const resumedAgent = profile?.env?.PI_SUBAGENT_AGENT?.trim() || undefined;
    const running: RunningSubagent = {
      id,
      name,
      task: params.message ?? "resumed session",
      ...(resumedAgent ? { agent: resumedAgent } : {}),
      surface,
      startTime,
      sessionFile: params.sessionPath,
      launchScriptFile,
      activityFile,
      interactive,
      runtimePlan: undefined,
      ...(lane ? { worktree: lane } : {}),
      lifecycle: createLifecycle(startTime),
    };
    trackRunningSubagent(running);
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
