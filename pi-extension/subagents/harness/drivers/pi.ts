import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  HarnessDriver,
  SubagentLaunchContext,
  BuiltHarnessCommand,
} from "../types.ts";
import type { ResolvedRuntimePlan } from "../../runtime-routing.ts";
import { SENTINEL_TRAILER } from "../../handoff.ts";

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

/** Reusable Pi settings, excluding a run's task and lifecycle identity. */
export interface PiLaunchProfile {
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
}

export function readPiLaunchProfile(sessionFile: string): PiLaunchProfile | null {
  const path = `${sessionFile}.launch.json`;
  if (!existsSync(path)) return null; // Sessions created before launch profiles still resume.
  const profile = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(profile?.args) || profile.args[0] !== "pi" ||
      !profile.args.every((v: unknown) => typeof v === "string") ||
      !profile.env || typeof profile.env !== "object" || Array.isArray(profile.env) ||
      !Object.entries(profile.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string") ||
      !(profile.cwd === null || typeof profile.cwd === "string")) {
    throw new Error(`Invalid Pi launch profile: ${path}`);
  }
  return profile;
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
      const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const spSafeName = params.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      const syspromptPath = join(artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
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

    // Preserve the role, tools, skills, mode and cwd on subagent_resume.
    const profile: PiLaunchProfile = { args: parts, env, cwd: effectiveCwd ?? process.cwd() };
    mkdirSync(dirname(subagentSessionFile), { recursive: true });
    writeFileSync(`${subagentSessionFile}.launch.json`, JSON.stringify(profile), "utf8");

    env.PI_SUBAGENT_NAME = params.name;
    env.PI_SUBAGENT_AUTO_EXIT = effectiveAutoExit ? "1" : "0";
    env.PI_SUBAGENT_SESSION = subagentSessionFile;
    env.PI_SUBAGENT_ID = params.id;
    env.PI_SUBAGENT_ACTIVITY_FILE = join(artifactDir, `subagent-activity-${params.id}.json`);
    env.PI_SUBAGENT_SURFACE = surface;

    const fullTask = taskDelivery === "direct"
      ? params.task
      : `${roleBlock ?? ""}\n\n${modeHint ?? ""}\n\n${params.task}\n\n${summaryInstruction ?? ""}`;

    let taskArg: string;
    if (taskDelivery === "direct") {
      taskArg = fullTask;
    } else {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const safeName = params.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
      const artifactPath = join(artifactDir, artifactName);
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
