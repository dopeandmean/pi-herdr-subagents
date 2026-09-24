import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { handleSubagentInterrupt } from "../run.ts";
import { Text } from "@earendil-works/pi-tui";

const DOC =
  "Send Escape to the active turn of a currently running Pi-backed subagent. " +
  "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
  "and does not emit a subagent_result solely because of this request.";

const InterruptParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
  name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
});

export const tool: ToolDefinition<typeof InterruptParams> = {
  name: "subagent_interrupt",
  label: "Interrupt Subagent",
  description: DOC,
  promptSnippet: DOC,
  parameters: InterruptParams,
  async execute(_toolCallId, params) {
    return handleSubagentInterrupt(params);
  },

  renderCall(args, theme) {
    const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
    return new Text(
      theme.fg("accent", "▸") +
        " " +
        theme.fg("toolTitle", theme.bold(target)) +
        theme.fg("dim", " — interrupt turn"),
      0,
      0,
    );
  },

  renderResult(result, _opts, theme) {
    const details = result.details as any;
    if (details?.status === "interrupt_requested") {
      return new Text(
        theme.fg("accent", "▸") +
          " " +
          theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
          theme.fg("dim", " — interrupt requested"),
        0,
        0,
      );
    }

    const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
    return new Text(theme.fg("dim", text), 0, 0);
  },
};
