import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { borderLine, renderSubagentWidgetLines } from "../pi-extension/subagents/widget.ts";
import { createLifecycle, markCompletionDetected, markInterruptRequested, observeActivity as observeLifecycleActivity } from "../pi-extension/subagents/lifecycle.ts";

describe("subagents widget rendering", () => {
  it("projects Claude agents as running and counts them as active", () => {
    const originalNow = Date.now;
    Date.now = () => 30_000;
    try {
      const lines = renderSubagentWidgetLines([{
        id: "c1",
        name: "Claude",
        task: "",
        surface: "s1",
        startTime: 5_000,
        sessionFile: "sess1",
        cli: "claude",
        lifecycle: { ...createLifecycle(5_000), process: { kind: "running", startedAt: 5_000, confirmedAt: 5_000 } },
        interactive: false,
      }], 64);

      assert.match(lines[0], /1 active/);
      assert.ok(lines[0].includes("\x1b[38;2;77;163;255m"));
      assert.match(lines[1], /running/);
    } finally {
      Date.now = originalNow;
    }
  });

  it("shows interrupted agents as open while process runtime continues", () => {
    const interruptedAt = 20_000;
    const lifecycle = markInterruptRequested(
      { ...createLifecycle(5_000), process: { kind: "running", startedAt: 5_000, confirmedAt: 5_000 } },
      interruptedAt,
    );

    const originalNow = Date.now;
    Date.now = () => 30_000;
    try {
      const lines = renderSubagentWidgetLines([{
        id: "a1",
        name: "Worker",
        task: "",
        surface: "s1",
        startTime: 5_000,
        sessionFile: "sess1",
        lifecycle,
        interactive: false,
      }], 64);

      assert.match(lines[0], /1 open/);
      assert.ok(lines[0].includes("\x1b[38;2;214;158;46m"));
      assert.match(lines[1], /00:25\s+Worker/);
      assert.match(lines[1], /interrupted 10s/);
      assert.doesNotMatch(lines.join("\n"), /running|active/);
    } finally {
      Date.now = originalNow;
    }
  });

  it("freezes runtime when the subagent reports done", () => {
    const doneAt = 20_000;
    const lifecycle = markCompletionDetected(createLifecycle(5_000), { reason: "done", exitCode: 0 }, doneAt);

    const originalNow = Date.now;
    Date.now = () => 30_000;
    try {
      const lines = renderSubagentWidgetLines([{
        id: "a1",
        name: "Reviewer",
        task: "",
        surface: "s1",
        startTime: 5_000,
        sessionFile: "sess1",
        lifecycle,
        interactive: false,
      }], 64);

      assert.match(lines[0], /1 open/);
      assert.match(lines[1], /00:15\s+Reviewer/);
      assert.match(lines[1], /finalizing…/);
      assert.doesNotMatch(lines[1], /00:25/);
    } finally {
      Date.now = originalNow;
    }
  });

  it("keeps a blue border and summarizes mixed active and open agents", () => {
    const now = 30_000;
    const active = observeLifecycleActivity(
      createLifecycle(5_000),
      {
        ok: true,
        activity: {
          version: 1,
          runningChildId: "a1",
          createdAt: 5_000,
          updatedAt: 29_000,
          sequence: 1,
          latestEvent: "agent_start",
          phase: "active",
          agentActive: true,
          turnActive: true,
          providerActive: false,
          toolActive: false,
          activeScope: "agent",
          activeSince: 29_000,
        },
      },
      29_000,
    );
    const interrupted = markInterruptRequested(
      { ...createLifecycle(10_000), process: { kind: "running", startedAt: 10_000, confirmedAt: 10_000 } },
      20_000,
    );

    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const lines = renderSubagentWidgetLines([
        { id: "a1", name: "Active", task: "", surface: "s1", startTime: 5_000, sessionFile: "s1", lifecycle: active, interactive: false },
        { id: "a2", name: "Open", task: "", surface: "s2", startTime: 10_000, sessionFile: "s2", lifecycle: interrupted, interactive: false },
      ], 72);

      assert.match(lines[0], /1 active · 1 open/);
      assert.ok(lines[0].includes("\x1b[38;2;77;163;255m"));
    } finally {
      Date.now = originalNow;
    }
  });

  it("keeps every rendered line within a very narrow width", () => {
    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          lifecycle: createLifecycle(1_000_000 - 13_000),
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          lifecycle: createLifecycle(1_000_000 - 21_000),
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          lifecycle: createLifecycle(1_000_000 - 27_000),
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const line = borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime,
          sessionFile: "sess1",
          lifecycle: createLifecycle(startTime),
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});
