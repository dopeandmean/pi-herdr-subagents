import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { interpretExitSidecar, waitForCompletion } from "../pi-extension/subagents/completion.ts";

describe("completion.ts", () => {

  it("decodes ping payloads", () => {
    assert.deepEqual(
      interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" }),
      {
        reason: "ping",
        exitCode: 0,
        ping: { name: "Worker", message: "need help" },
      },
    );
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("rejects unknown completion sidecar payloads", () => {
    for (const payload of [{}, null]) {
      const result = interpretExitSidecar(payload);
      assert.equal(result.reason, "error");
      assert.equal(result.exitCode, 1);
      assert.match(result.errorMessage ?? "", /Invalid subagent completion sidecar/);
    }
  });

  it("consumes a sidecar and removes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-sidecar-"));
    const sessionFile = join(dir, "session.jsonl");
    const exitFile = `${sessionFile}.exit`;
    writeFileSync(exitFile, JSON.stringify({ type: "ping", name: "Scout", message: "ready" }));
    try {
      const result = await waitForCompletion(new AbortController().signal, {
        intervalMs: 1,
        sessionFile,
        readTerminalTail: async () => "",
      });
      assert.deepEqual(result, {
        reason: "ping",
        exitCode: 0,
        ping: { name: "Scout", message: "ready" },
      });
      assert.equal(existsSync(exitFile), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the terminal sentinel exit code", async () => {
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => "output\n__SUBAGENT_DONE_17__\n",
    });
    assert.deepEqual(result, { reason: "sentinel", exitCode: 17 });
  });

  it("returns when an external sentinel file appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-sentinel-"));
    const sentinelFile = join(dir, "done");
    writeFileSync(sentinelFile, "complete");
    try {
      const result = await waitForCompletion(new AbortController().signal, {
        intervalMs: 1,
        sentinelFile,
        readTerminalTail: async () => "",
      });
      assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries transient terminal read failures and reports ticks", async () => {
    let reads = 0;
    let ticks = 0;
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => {
        reads += 1;
        if (reads === 1) throw new Error("pane temporarily unavailable");
        return "__SUBAGENT_DONE_0__";
      },
      onTick: () => {
        ticks += 1;
      },
    });
    assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
    assert.equal(reads, 2);
    assert.equal(ticks, 1);
  });

  it("returns a failure when the pane explicitly disappears", async () => {
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => { throw new Error("pane read failed"); },
      inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
      paneDisappearanceGraceMs: 0,
    });
    assert.deepEqual(result, {
      reason: "error",
      exitCode: 1,
      errorMessage: "Subagent pane disappeared before completion evidence was recorded.",
    });
  });

  it("lets a sidecar win the pane-disappearance race", async () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-race-"));
    const sessionFile = join(dir, "child.jsonl");
    try {
      const result = await waitForCompletion(new AbortController().signal, {
        intervalMs: 1,
        sessionFile,
        readTerminalTail: async () => "",
        inspectPane: async () => {
          writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
          return { kind: "missing", error: "pane_not_found" };
        },
      });
      assert.deepEqual(result, { reason: "done", exitCode: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits briefly for delayed sidecar publication after pane disappearance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-delayed-race-"));
    const sessionFile = join(dir, "child.jsonl");
    const timer = setTimeout(() => {
      writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
    }, 30);
    try {
      const result = await waitForCompletion(new AbortController().signal, {
        intervalMs: 1,
        sessionFile,
        readTerminalTail: async () => "",
        inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
        paneDisappearanceGraceMs: 150,
      });
      assert.deepEqual(result, { reason: "done", exitCode: 0 });
    } finally {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an ambiguous pane read failure retryable while the pane exists", async () => {
    let reads = 0;
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => {
        reads += 1;
        if (reads === 1) throw new Error("socket unavailable");
        return "__SUBAGENT_DONE_0__";
      },
      inspectPane: async () => ({ kind: "present", observedAt: 0, agentStatus: "working" }),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(reads, 2);
  });

  it("treats presence-check throws as unknown and keeps polling", async () => {
    let reads = 0;
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => {
        reads += 1;
        if (reads === 1) throw new Error("pane read failed");
        return "__SUBAGENT_DONE_0__";
      },
      inspectPane: async () => { throw new Error("herdr list failed"); },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(reads, 2);
  });

  it("inspects herdr status even when terminal reads succeed", async () => {
    let reads = 0;
    const inspections: string[] = [];
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => {
        reads += 1;
        return reads === 1 ? "shell output" : "__SUBAGENT_DONE_0__";
      },
      inspectPane: async () => ({ kind: "present", observedAt: 2_000, agentStatus: "blocked" }),
      onPaneInspection: (inspection) => inspections.push(inspection.kind === "present" ? inspection.agentStatus : inspection.kind),
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(inspections, ["blocked"]);
  });

  it("rejects promptly when aborted", async () => {
    const controller = new AbortController();
    const completion = waitForCompletion(controller.signal, {
      intervalMs: 10_000,
      readTerminalTail: async () => "",
    });
    controller.abort();
    await assert.rejects(completion, /Aborted while waiting for subagent to finish/);
  });
});
