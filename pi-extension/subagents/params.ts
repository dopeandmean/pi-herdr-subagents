import { Type, type Static } from "@sinclair/typebox";
import { THINKING_LEVELS } from "./runtime-routing.ts";

/** The `subagent` tool's parameters: one declaration for the schema and its type. */
const ThinkingLevelSchema = Type.Union(
  THINKING_LEVELS.map((level) => Type.Literal(level)),
  {
    description:
      "Pi thinking level. Omit to use a named agent's thinking default, then the parent level. Passing a value explicitly overrides agent frontmatter for this spawn.",
  },
);

export const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from the available named subagent catalog. Agent frontmatter can provide model, thinking, tools, skills, and role instructions.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Exact authenticated provider/model-id. Omit to use a named agent's model default, then the configured or parent model. Passing a value explicitly overrides agent frontmatter for this spawn.",
    }),
  ),
  thinking: Type.Optional(ThinkingLevelSchema),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills to load with the task (overrides agent default). Use none to skip assigned skills; this does not hide the normal skill catalog." }),
  ),
  ponytail: Type.Optional(Type.Union([
    Type.Literal("off"), Type.Literal("lite"), Type.Literal("full"), Type.Literal("ultra"),
  ], { description: "Ponytail mode for this Pi session; overrides the agent default. Requires the installed Ponytail extension." })),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
    }),
  ),
  worktree: Type.Optional(
    Type.Boolean({
      description:
        "Run this child in its own Git worktree on a new branch, so parallel writers cannot touch each other or the source checkout. Requires a clean Git checkout; the spawn is rejected (nothing launched, nothing modified) otherwise. Changes are captured as a patch + manifest when the child exits.",
    }),
  ),
  baseRef: Type.Optional(
    Type.String({
      description:
        "Git ref the isolated worktree branches from (only with worktree: true). Defaults to HEAD.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). When true, the main session is not woken by status transitions (stalled/recovered) for this subagent. If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit` (agents that auto-exit are autonomous and get stall pings; agents that don't are interactive and stay quiet).",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Resume a previous Claude Code session by its ID. Loads the conversation history and continues where it left off. The session ID is returned in details of every claude tool call. Use this to retry cancelled runs or ask follow-up questions.",
    }),
  ),
});

export type SubagentLaunchParams = Static<typeof SubagentParams>;
