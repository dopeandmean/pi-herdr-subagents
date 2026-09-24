import type { SubagentResultContext } from "./types.ts";
import { stripSentinel } from "../handoff.ts";

export function extractPaneSummary(context: SubagentResultContext, displayName: string): string {
  const { completionResult, surface, readPane } = context;
  const summary = stripSentinel(readPane(surface, 200));

  if (summary) return summary;

  return completionResult.exitCode !== 0
    ? `${displayName} exited with code ${completionResult.exitCode}`
    : `${displayName} exited without output`;
}
