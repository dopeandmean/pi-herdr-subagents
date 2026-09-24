import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SENTINEL_PATTERN,
  SENTINEL_TRAILER,
  consumeCompletionSidecar,
  sidecarFileFor,
  stripSentinel,
  writeCompletionSidecar,
} from "../pi-extension/subagents/handoff.ts";

describe("handoff protocol", () => {
  it("reads a sidecar once and leaves nothing behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-handoff-"));
    try {
      const sessionFile = join(dir, "child.jsonl");
      writeCompletionSidecar(sessionFile, {
        type: "error",
        errorMessage: "provider overloaded",
        stopReason: "error",
      });

      assert.deepEqual(consumeCompletionSidecar(sessionFile), {
        type: "error",
        errorMessage: "provider overloaded",
        stopReason: "error",
      });
      assert.equal(consumeCompletionSidecar(sessionFile), null);
      assert.equal(existsSync(sidecarFileFor(sessionFile)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a half-written sidecar for the next poll", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-handoff-"));
    try {
      const sessionFile = join(dir, "child.jsonl");
      writeFileSync(sidecarFileFor(sessionFile), '{"type":"do');
      assert.equal(consumeCompletionSidecar(sessionFile), null);
      assert.ok(existsSync(sidecarFileFor(sessionFile)), "unparsed sidecar must survive");

      writeFileSync(sidecarFileFor(sessionFile), JSON.stringify({ type: "ping", name: "worker", message: "help" }));
      assert.deepEqual(consumeCompletionSidecar(sessionFile), { type: "ping", name: "worker", message: "help" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips the sentinel the launch trailer leaves in pane output", () => {
    // The trailer echoes the sentinel text around the command's exit code, so a
    // pane shows the literal marker with that code spliced in.
    assert.equal(stripSentinel("Finished the refactor\n__SUBAGENT_DONE_0__\n"), "Finished the refactor");
    assert.ok(SENTINEL_TRAILER.includes("__SUBAGENT_DONE_"));
    assert.equal("__SUBAGENT_DONE_17__".match(SENTINEL_PATTERN)?.[1], "17");
  });
});
