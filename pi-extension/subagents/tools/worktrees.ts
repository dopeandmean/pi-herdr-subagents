import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getArtifactDir } from "../run.ts";
import { type LaneInspection, inspectLane, listLanes, recordLaneEvidence, removeLane } from "../worktree.ts";
import { Text } from "@earendil-works/pi-tui";

const DOC =
  "Inspect and maintain the Git worktree lanes created by isolated subagent spawns (worktree: true). " +
  "action=\"status\" (default) is read-only: it lists each lane's branch, worktree, captured patch, review/merge evidence, and whether it can be removed. " +
  "action=\"cleanup\" removes a lane's worktree and branch, revalidating ownership, checked-out branch, head commit, and a clean tree immediately before removal. " +
  "A lane with work also needs a current-head OK or OK with notes review plus integration proof covering every lane commit; unexempted ignored files, a BLOCK/stale/missing review, unverifiable lineage, or any other failed check preserve the lane. " +
  "action=\"record\" writes a reviewer verdict or merge attestation into a lane's manifest. " +
  "Merging is never automatic: apply the lane branch or patch yourself, then record the merge commit.";

const WorktreesParams = Type.Object({
  action: Type.Optional(
    Type.Union([Type.Literal("status"), Type.Literal("cleanup"), Type.Literal("record")], {
      description: "status (default), cleanup, or record",
    }),
  ),
  lane: Type.Optional(
    Type.String({
      description:
        "Lane id, manifest path, or \"eligible\" (cleanup: every lane that passes all checks). Omit for status to list all lanes in this session.",
    }),
  ),
  verdict: Type.Optional(
    Type.Union([Type.Literal("BLOCK"), Type.Literal("OK"), Type.Literal("OK with notes")], {
      description: "record: reviewer verdict for the lane's captured head",
    }),
  ),
  reviewer: Type.Optional(Type.String({ description: "record: who reviewed" })),
  notes: Type.Optional(Type.String({ description: "record: review notes" })),
  mergeCommit: Type.Optional(
    Type.String({ description: "record: commit that merged the lane branch" }),
  ),
  attestor: Type.Optional(
    Type.String({ description: "record: who applied the merge and confirmed the evidence" }),
  ),
  postMergeChecks: Type.Optional(
    Type.String({ description: "record: checks run after the merge" }),
  ),
});

export const tool: ToolDefinition<typeof WorktreesParams> = {
  name: "subagent_worktrees",
  label: "Subagent Worktrees",
  description: DOC,
  promptSnippet: DOC,
  parameters: WorktreesParams,
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const artifactDir = getArtifactDir(
      ctx.sessionManager.getSessionDir(),
      ctx.sessionManager.getSessionId(),
    );
    const action = params.action ?? "status";
    // "eligible" means every lane; a lane id or manifest path narrows it.
    const scope = params.lane === "eligible" ? undefined : params.lane;

    if (action === "status") {
      const targets = listLanes(artifactDir, scope);
      if (targets.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: params.lane
                ? `No worktree lane matching "${params.lane}" in this session.`
                : "No isolated worktree lanes in this session.",
            },
          ],
          details: { lanes: [] },
        };
      }

      const inspections: LaneInspection[] = [];
      const lines: string[] = [];
      for (const target of targets) {
        const inspection = inspectLane(target);
        inspections.push(inspection);
        const evidence = [
          inspection.review ? `review ${inspection.review.verdict}` : undefined,
          inspection.merge ? `merged ${inspection.merge.commit.slice(0, 8)}` : undefined,
          `cleanup ${inspection.cleanupStatus}`,
        ]
          .filter(Boolean)
          .join(", ");
        lines.push(
          `• ${inspection.laneId} ${inspection.branch} — ${inspection.changedPaths.length} changed path(s)` +
            `${evidence ? ` — ${evidence}` : ""}`,
          `  worktree ${inspection.worktree}`,
          `  manifest ${inspection.manifestFile}`,
          inspection.removable
            ? "  removable yes"
            : `  removable no — ${inspection.blockers.join("; ")}`,
        );
      }
      const removable = inspections.filter((entry) => entry.removable).length;
      lines.push(
        `\n${inspections.length} lane(s), ${removable} removable. Removal is explicit: subagent_worktrees({ action: "cleanup", lane: "<id>" }).`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { lanes: inspections },
      };
    }

    if (action === "cleanup") {
      if (!params.lane) {
        return {
          content: [
            {
              type: "text",
              text: 'cleanup needs a lane: subagent_worktrees({ action: "cleanup", lane: "<id>" }) or lane: "eligible".',
            },
          ],
          details: { error: "lane required" },
        };
      }
      const targets = listLanes(artifactDir, scope);
      if (targets.length === 0) {
        return {
          content: [{ type: "text", text: `No worktree lane matching "${params.lane}".` }],
          details: { removed: [], preserved: [] },
        };
      }

      const removed: string[] = [];
      const preserved: Array<{ laneId: string; reason?: string }> = [];
      const skipped: string[] = [];
      for (const target of targets) {
        const outcome = removeLane(target, { by: "parent" });
        if (outcome.removed) {
          removed.push(target.manifest.laneId);
        } else if (params.lane === "eligible") {
          // Nothing is wrong with the others; they were simply not eligible.
          skipped.push(`${target.manifest.laneId} (${outcome.reason})`);
        } else {
          preserved.push({ laneId: target.manifest.laneId, reason: outcome.reason });
        }
      }

      const lines = [
        removed.length > 0 ? `Removed: ${removed.join(", ")}` : "Removed: none",
        ...preserved.map((entry) => `Preserved ${entry.laneId}: ${entry.reason}`),
        ...skipped.map((entry) => `Not eligible: ${entry}`),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { removed, preserved },
      };
    }

    // action === "record"
    if (!params.lane) {
      return {
        content: [
          { type: "text", text: 'record needs a lane and either verdict or mergeCommit.' },
        ],
        details: { error: "lane required" },
      };
    }
    const review = params.verdict
      ? {
          verdict: params.verdict,
          reviewer: params.reviewer ?? "parent",
          ...(params.notes ? { notes: params.notes } : {}),
        }
      : undefined;
    const merge = params.mergeCommit
      ? {
          commit: params.mergeCommit,
          attestor: params.attestor ?? "parent",
          ...(params.postMergeChecks ? { postMergeChecks: params.postMergeChecks } : {}),
        }
      : undefined;
    if (!review && !merge) {
      return {
        content: [
          {
            type: "text",
            text: "record needs a verdict (review) or a mergeCommit (merge attestation).",
          },
        ],
        details: { error: "nothing to record" },
      };
    }

    const targets = listLanes(artifactDir, scope);
    if (targets.length === 0) {
      return {
        content: [{ type: "text", text: `No worktree lane matching "${params.lane}".` }],
        details: { error: "lane not found" },
      };
    }

    const results = targets.map((target) => ({
      laneId: target.manifest.laneId,
      ...recordLaneEvidence(target, { review, merge }),
    }));
    const failures = results.filter((entry) => !entry.ok);
    return {
      content: [
        {
          type: "text",
          text: failures.length
            ? failures.map((entry) => `Failed ${entry.laneId}: ${entry.error}`).join("\n")
            : `Recorded evidence for ${results.map((entry) => entry.laneId).join(", ")}.`,
        },
      ],
      details: { results },
    };
  },

  renderCall(args, theme) {
    const action = typeof args.action === "string" ? args.action : "status";
    const lane = typeof args.lane === "string" && args.lane ? ` ${args.lane}` : "";
    return new Text(
      theme.fg("accent", "▸") +
        " " +
        theme.fg("toolTitle", theme.bold(`worktrees ${action}${lane}`)),
      0,
      0,
    );
  },

  renderResult(result, _opts, theme) {
    const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
    return new Text(theme.fg("toolOutput", text), 0, 0);
  },
};
