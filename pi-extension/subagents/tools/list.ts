import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverAgentDefinitions } from "../discovery.ts";
import { Text } from "@earendil-works/pi-tui";

const DOC =
  "List all available subagent definitions. " +
  "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
  "Project-local agents override global ones with the same name.";

const ListParams = Type.Object({});

export const tool: ToolDefinition<typeof ListParams> = {
  name: "subagents_list",
  label: "List Subagents",
  description: DOC,
  promptSnippet: DOC,
  parameters: ListParams,
  async execute() {
    const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

    if (list.length === 0) {
      return {
        content: [{ type: "text", text: "No subagent definitions found." }],
        details: { agents: [] },
      };
    }

    const lines = list.map((a) => {
      const badge = a.source === "project" ? " (project)" : "";
      const desc = a.description ? ` — ${a.description}` : "";
      const model = a.model ? ` [${a.model}]` : "";
      return `• ${a.name}${badge}${model}${desc}`;
    });

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { agents: list },
    };
  },

  renderResult(result, _opts, theme) {
    const details = result.details as any;
    const agents = details?.agents ?? [];
    if (agents.length === 0) {
      return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
    }
    const lines = agents.map((a: any) => {
      const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
      const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
      const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
      return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
    });
    return new Text(lines.join("\n"), 0, 0);
  },
};
