import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * The child → parent handoff protocol (ADR-0002): the sidecar a child writes
 * when its agent loop ends, and the sentinel a launch command leaves in pane
 * output. Both ends go through this module, so the payload kinds, the sidecar
 * naming and the sentinel format have one owner.
 */

/** How a run's turn ended, as the child reports it. */
export type CompletionSidecar =
  | { type: "done" }
  | { type: "error"; errorMessage: string; stopReason: "error" }
  | { type: "ping"; name: string; message: string };

export const SENTINEL_PATTERN = /__SUBAGENT_DONE_(\d+)__/;

/** Appended to every launch command so the pane reports the command's exit code. */
export const SENTINEL_TRAILER = "; echo '__SUBAGENT_DONE_'$?'__'";

/** Pane output without the sentinel, ready to read as a summary. */
export function stripSentinel(text: string): string {
  return text.replace(SENTINEL_PATTERN, "").trimEnd();
}

export function sidecarFileFor(sessionFile: string): string {
  return `${sessionFile}.exit`;
}

export function writeCompletionSidecar(sessionFile: string, payload: CompletionSidecar): void {
  writeFileSync(sidecarFileFor(sessionFile), JSON.stringify(payload));
}

/**
 * Read a sidecar once, removing it so a later poll cannot re-report the same
 * ending. A sidecar that is still being written stays in place for the next
 * polling cycle.
 */
export function consumeCompletionSidecar(sessionFile: string | undefined): CompletionSidecar | null {
  if (!sessionFile) return null;
  const file = sidecarFileFor(sessionFile);
  if (!existsSync(file)) return null;

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CompletionSidecar;
    if (typeof parsed?.type !== "string") return null;
    rmSync(file, { force: true });
    return parsed;
  } catch {
    return null;
  }
}
