import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  HarnessDriver,
  SubagentLaunchContext,
  BuiltHarnessCommand,
} from "../types.ts";
import type { ResolvedRuntimePlan } from "../../runtime-routing.ts";
import { SENTINEL_TRAILER } from "../../handoff.ts";
import { getSubagentActivityFile } from "../../activity.ts";
import type { LaneReference } from "../../worktree.ts";

const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

export function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (requested.length === 0) return null;

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

/**
 * Transient Activity transport values. The main Pi process publishes them in its
 * own environment; Herdr copies them into every spawned and resumed child, and
 * they are never written to a launch profile — a saved endpoint names a
 * collector that only the process that created it can still reach.
 */
export const ACTIVITY_ENV_KEYS = [
  "PI_ACTIVITY_ENDPOINT",
  "PI_ACTIVITY_ROOT",
  "PI_ACTIVITY_GENERATION",
  "PI_ACTIVITY_REPORTER",
] as const;

/** The Activity values this process can hand to a child; absent means absent. */
export function readActivityEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of ACTIVITY_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) values[key] = value;
  }
  return values;
}

/**
 * `-e <reporter>` for the Activity reporter, at most once: a profile that already
 * carries the same path needs no second copy. The child's role-specific agent
 * directory may omit user extensions, so the reporter is loaded explicitly.
 */
export function activityReporterArgs(
  args: readonly string[],
  reporterPath: string | undefined,
): string[] {
  return reporterPath && !args.includes(reporterPath) ? ["-e", reporterPath] : [];
}

/**
 * Activity argv/environment for a resumed child, taken from the current parent
 * process rather than the saved profile, which may name an endpoint from a
 * earlier Pi process.
 */
export function resumeActivityLaunch(
  profileArgs: readonly string[],
  parentEnv: Record<string, string | undefined> = process.env,
): { args: string[]; env: Record<string, string> } {
  const env = readActivityEnv(parentEnv);
  return { args: activityReporterArgs(profileArgs, env.PI_ACTIVITY_REPORTER), env };
}

/** Reusable Pi settings, excluding a run's task and lifecycle identity. */
export interface PiLaunchProfile {
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  /** Durable lane reference, present when this session was launched into a lane. */
  lane?: LaneReference;
}

function isProfileString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidLaneReference(lane: any): boolean {
  const allocation = lane?.allocation;
  return (
    isProfileString(lane?.laneId) &&
    isProfileString(lane?.artifactDir) &&
    isProfileString(lane?.sessionFile) &&
    !!allocation &&
    typeof allocation === "object" &&
    !Array.isArray(allocation) &&
    (["repoRoot", "branch", "path", "baseRef", "baseCommit"] as const).every((field) =>
      isProfileString(allocation[field]),
    )
  );
}

export function readPiLaunchProfile(sessionFile: string): PiLaunchProfile | null {
  const path = `${sessionFile}.launch.json`;
  if (!existsSync(path)) return null; // Sessions created before launch profiles still resume.
  let profile: any;
  try {
    profile = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Invalid Pi launch profile: ${path} (unreadable JSON)`);
  }
  if (!Array.isArray(profile?.args) || profile.args[0] !== "pi" ||
      !profile.args.every((v: unknown) => typeof v === "string") ||
      !profile.env || typeof profile.env !== "object" || Array.isArray(profile.env) ||
      !Object.entries(profile.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string") ||
      !(profile.cwd === null || typeof profile.cwd === "string")) {
    throw new Error(`Invalid Pi launch profile: ${path}`);
  }
  if (profile.lane !== undefined && !isValidLaneReference(profile.lane)) {
    throw new Error(`Invalid Pi launch profile: ${path} (lane reference)`);
  }
  // Transient Activity values are refreshed from the live parent on resume.
  for (const key of ACTIVITY_ENV_KEYS) delete profile.env[key];
  return profile;
}

/**
 * Context artifact filename for one run — the task, role prompt or resume
 * message the child reads. The run id keeps two same-label launches in the
 * same second from overwriting each other's file.
 */
export function contextArtifactName(label: string, runId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName = label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${safeName || "subagent"}-${timestamp}-${runId}.md`;
}

export function formatPiLaunch(profile: PiLaunchProfile, shellQuote: (value: string) => string): string {
  const env = Object.entries(profile.env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
  const args = profile.args.map((arg) => /^(pi|--[a-z-]+|-e)$/.test(arg) ? arg : shellQuote(arg)).join(" ");
  return `${profile.cwd ? `cd ${shellQuote(profile.cwd)} && ` : ""}${env ? `${env} ` : ""}${args}`;
}

export class PiHarnessDriver implements HarnessDriver {
  readonly id = "pi";
  readonly name = "Pi";
  readonly hasActivitySnapshots = true;
  readonly supportsTurnInterrupt = true;

  formatModel(runtimePlan: Pick<ResolvedRuntimePlan, "model" | "modelId">): string {
    return runtimePlan.model;
  }

  buildCommand(context: SubagentLaunchContext): BuiltHarnessCommand {
    const {
      params,
      agentDefs,
      runtimePlan,
      effectiveModel,
      effectiveThinking,
      surface,
      artifactDir,
      subagentSessionFile,
      effectiveCwd,
      localAgentDir,
      effectiveAutoExit,
      taskDelivery,
      denySet,
      identity,
      identityInSystemPrompt,
      systemPromptMode,
      roleBlock,
      modeHint,
      summaryInstruction,
      subagentsDir,
      shellQuote,
    } = context;

    const parts: string[] = ["pi"];
    parts.push("--session", subagentSessionFile);

    const subagentDonePath = join(subagentsDir, "subagent-done.ts");
    parts.push("-e", subagentDonePath);

    if (effectiveModel) {
      parts.push("--model", effectiveModel);
    }
    if (effectiveThinking) {
      parts.push("--thinking", effectiveThinking);
    }

    if (identityInSystemPrompt && identity) {
      const flag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
      const syspromptPath = join(
        artifactDir,
        "context",
        contextArtifactName(`${params.name}-sysprompt`, params.id),
      );
      mkdirSync(dirname(syspromptPath), { recursive: true });
      writeFileSync(syspromptPath, identity, "utf8");
      parts.push(flag, syspromptPath);
    }

    const effectiveTools = params.tools ?? agentDefs?.tools;
    const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
    if (toolAllowlist) {
      parts.push("--tools", toolAllowlist);
    }

    const env: Record<string, string> = {};
    if (localAgentDir && existsSync(localAgentDir)) {
      env.PI_CODING_AGENT_DIR = localAgentDir;
    } else if (process.env.PI_CODING_AGENT_DIR) {
      env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    }

    // Clear inherited assignments when this role has no assigned skills or denials.
    env.PI_DENY_TOOLS = [...(denySet ?? [])].join(",");
    env.PI_SUBAGENT_SKILLS = params.skills ?? agentDefs?.skills ?? "";
    const ponytail = params.ponytail ?? agentDefs?.ponytail;
    if (ponytail) env.PONYTAIL_DEFAULT_MODE = ponytail;
    env.PI_SUBAGENT_AGENT = params.agent ?? "";

    // Preserve the role, tools, skills, mode, cwd and lane ownership on subagent_resume.
    const profile: PiLaunchProfile = {
      args: parts,
      env,
      cwd: effectiveCwd ?? process.cwd(),
      ...(context.lane ? { lane: context.lane } : {}),
    };
    mkdirSync(dirname(subagentSessionFile), { recursive: true });
    writeFileSync(`${subagentSessionFile}.launch.json`, JSON.stringify(profile), "utf8");

    // The Activity transport is transient: it is written into the child command
    // only now, so the durable profile stays free of collector endpoints.
    const activityEnv = readActivityEnv();
    parts.push(...activityReporterArgs(parts, activityEnv.PI_ACTIVITY_REPORTER));
    Object.assign(env, activityEnv);

    env.PI_SUBAGENT_NAME = params.name;
    env.PI_SUBAGENT_AUTO_EXIT = effectiveAutoExit ? "1" : "0";
    env.PI_SUBAGENT_SESSION = subagentSessionFile;
    env.PI_SUBAGENT_ID = params.id;
    env.PI_SUBAGENT_ACTIVITY_FILE = getSubagentActivityFile(artifactDir, params.id);
    env.PI_SUBAGENT_SURFACE = surface;

    const fullTask = taskDelivery === "direct"
      ? params.task
      : `${roleBlock ?? ""}\n\n${modeHint ?? ""}\n\n${params.task}\n\n${summaryInstruction ?? ""}`;

    let taskArg: string;
    if (taskDelivery === "direct") {
      taskArg = fullTask;
    } else {
      const artifactPath = join(artifactDir, "context", contextArtifactName(params.name, params.id));
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, fullTask, "utf8");
      taskArg = `@${artifactPath}`;
    }

    // One task prompt: skills are expanded by the child using its own skill catalog.
    parts.push(taskArg);

    const command = `${formatPiLaunch(profile, shellQuote)}${SENTINEL_TRAILER}`;

    return {
      command,
      sessionFile: subagentSessionFile,
      cli: "pi",
      launchScriptPreamble: [
        `# Subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Session: ${subagentSessionFile}`,
        `# Surface: ${surface}`,
        `# Runtime: ${runtimePlan.model} (thinking: ${runtimePlan.thinking})`,
      ],
    };
  }
}
