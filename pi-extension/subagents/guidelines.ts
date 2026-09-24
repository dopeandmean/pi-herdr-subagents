
/**
 * The routing guidance handed to the model with the subagent tool. It is
 * rebuilt once the session can see the live agent and model catalogs, so the
 * tool keeps a reference to the array and registration happens once.
 */
export function buildSubagentRoutingGuidelines(
  modelCatalog?: string,
  agentCatalog?: string,
): string[] {
  return [
    "Choose the named agent whose description most closely matches the task; do not use one agent as a generic default.",
    "Omit model and thinking when invoking a named agent so its configured defaults apply. Passing either field is an explicit one-off override and takes precedence over agent frontmatter.",
    "For a bare spawn, omit model and thinking to inherit the parent runtime.",
    "When an intentional runtime override is necessary, prefer changing thinking before changing models: minimal/low for bounded mechanical work, medium for ordinary implementation or review, and high+ for architecture, concurrency, security, or hard diagnosis.",
    "When overriding a subagent model, use an exact authenticated provider/model-id from the live catalog below. Do not invent aliases or fuzzy names.",
    "When parallel children may edit overlapping files, spawn them with worktree: true so each writer gets its own Git worktree and branch instead of sharing one checkout. Isolated lanes are rejected up front unless the checkout is clean, and each returns a captured patch plus manifest for review before merge.",
    agentCatalog ?? "Available named subagent catalog becomes available after session start.",
    modelCatalog ?? "Authenticated subagent model catalog becomes available after session start.",
  ];
}

export const routingGuidelines: string[] = buildSubagentRoutingGuidelines();

/** Replace the guidance text in place so already-registered tools see it. */
export function setRoutingGuidelines(lines: string[]): void {
  routingGuidelines.splice(0, routingGuidelines.length, ...lines);
}
