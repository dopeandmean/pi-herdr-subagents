/**
 * Roles are declared as markdown files with frontmatter. The same declaration
 * travels from discovery in the parent session to the harness driver that
 * builds a child's command line, so it has one shape for both.
 */

export type AgentSource = "package" | "global" | "project";

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefinition {
  name: string;
  description?: string;
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  commandTemplate?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

/** A role definition plus where discovery found it. */
export interface DiscoveredAgent extends AgentDefinition {
  source: AgentSource;
}
