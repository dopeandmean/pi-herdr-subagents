import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { tool as subagentTool } from "./subagent.ts";
import { tool as interruptTool } from "./interrupt.ts";
import { tool as worktreesTool } from "./worktrees.ts";
import { tool as listTool } from "./list.ts";
import { tool as resumeTool } from "./resume.ts";

/** The subagent tools, in the order the model should read them. */
const tools: ToolDefinition[] = [subagentTool, interruptTool, worktreesTool, listTool, resumeTool];

/** Register every tool except the ones this child process is denied. */
export function registerSubagentTools(pi: ExtensionAPI, deniedTools: Set<string> = new Set()): void {
  for (const tool of tools) {
    if (!deniedTools.has(tool.name)) pi.registerTool(tool);
  }
}
