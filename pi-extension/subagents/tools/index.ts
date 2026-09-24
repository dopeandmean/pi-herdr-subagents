import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createTool as createSubagentTool } from "./subagent.ts";
import { tool as interruptTool } from "./interrupt.ts";
import { tool as worktreesTool } from "./worktrees.ts";
import { tool as listTool } from "./list.ts";
import { createTool as createResumeTool } from "./resume.ts";

/** Register every tool except the ones this child process is denied. */
export function registerSubagentTools(pi: ExtensionAPI, deniedTools: Set<string> = new Set()): void {
  const tools: ToolDefinition[] = [
    createSubagentTool(pi),
    interruptTool,
    worktreesTool,
    listTool,
    createResumeTool(pi),
  ];
  for (const tool of tools) {
    if (!deniedTools.has(tool.name)) pi.registerTool(tool);
  }
}
