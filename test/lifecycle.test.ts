import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createLifecycle, lifecycleTransition, markCompleted, markCompletionDetected, markFailed, markInterruptRequested, observeActivity as observeLifecycleActivity, observePaneInspection, projectLifecycle } from "../pi-extension/subagents/lifecycle.ts";

describe("lifecycle.ts", () => {
  const activity = (overrides: Record<string, unknown> = {}) => ({
    version: 1 as const,
    runningChildId: "child",
    createdAt: 1_000,
    updatedAt: 2_000,
    sequence: 1,
    latestEvent: "agent_start" as const,
    phase: "active" as const,
    agentActive: true,
    turnActive: true,
    providerActive: false,
    toolActive: false,
    activeScope: "agent" as const,
    activeSince: 2_000,
    ...overrides,
  });

  it("interrupts only the turn and keeps process runtime open", () => {
    const running = observeLifecycleActivity(createLifecycle(1_000), { ok: true, activity: activity() }, 2_000);
    const interrupted = markInterruptRequested(running, 3_000);
    const projection = projectLifecycle(interrupted, 8_000);
    assert.equal(interrupted.process.kind, "running");
    assert.equal(interrupted.turn.kind, "interrupted");
    assert.equal(projection.runtimeEndedAt, undefined);
  });

  it("rejects stale activity after interrupt and accepts a newer sequence", () => {
    const running = observeLifecycleActivity(createLifecycle(1_000), { ok: true, activity: activity() }, 2_000);
    const interrupted = markInterruptRequested(running, 3_000);
    const stale = observeLifecycleActivity(interrupted, { ok: true, activity: activity({ updatedAt: 3_000 }) }, 3_100);
    assert.equal(stale.turn.kind, "interrupted");
    const resumed = observeLifecycleActivity(stale, {
      ok: true,
      activity: activity({ updatedAt: 3_000, sequence: 2, activeSince: 3_000 }),
    }, 3_100);
    assert.equal(resumed.turn.kind, "active");
  });

  it("makes finalizing and terminal process states irreversible", () => {
    const running = observeLifecycleActivity(createLifecycle(1_000), { ok: true, activity: activity() }, 2_000);
    const finalizing = markCompletionDetected(running, { reason: "done", exitCode: 0 }, 4_000);
    const ignored = observeLifecycleActivity(finalizing, {
      ok: true,
      activity: activity({ updatedAt: 5_000, sequence: 9 }),
    }, 5_000);
    assert.equal(ignored.process.kind, "finalizing");
    assert.deepEqual(projectLifecycle(ignored, 9_000), { kind: "finalizing", runtimeEndedAt: 4_000 });
    const completed = markCompleted(ignored, 6_000);
    assert.equal(markFailed(completed, "late failure", 7_000).process.kind, "completed");
  });

  it("projects confirmed running without turn detail as running, not starting", () => {
    const started = createLifecycle(1_000);
    const running = {
      ...started,
      process: { kind: "running" as const, startedAt: 1_000, confirmedAt: 1_500 },
    };
    assert.deepEqual(projectLifecycle(running, 3_000), { kind: "running" });
  });

  it("detects stalled and recovered transitions from lifecycle projections", () => {
    assert.equal(lifecycleTransition("active", "stalled"), "stalled");
    assert.equal(lifecycleTransition("stalled", "waiting"), "recovered");
    assert.equal(lifecycleTransition("stalled", "active"), "recovered");
    assert.equal(lifecycleTransition("stalled", "blocked"), "recovered");
    assert.equal(lifecycleTransition("stalled", "interrupted"), "recovered");
    assert.equal(lifecycleTransition("waiting", "active"), null);
  });

  it("does not interpret initial idle as completion", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "idle" }, 2_000);
    assert.equal(projectLifecycle(lifecycle, 3_000).kind, "starting");
    assert.equal(lifecycle.turn.kind, "starting");
  });

  it("treats working then idle as waiting", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    assert.equal(projectLifecycle(lifecycle, 2_500).kind, "active");
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "idle" }, 3_000);
    assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
  });

  it("preserves state entry time across repeated herdr observations", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "working" }, 3_000);
    assert.equal(projectLifecycle(lifecycle, 4_000).stateDurationSince, 2_000);

    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 5_000, agentStatus: "blocked" }, 5_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 6_000, agentStatus: "blocked" }, 6_000);
    assert.equal(projectLifecycle(lifecycle, 7_000).stateDurationSince, 5_000);

    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 8_000, agentStatus: "idle" }, 8_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 9_000, agentStatus: "done" }, 9_000);
    assert.equal(projectLifecycle(lifecycle, 10_000).stateDurationSince, 8_000);
  });

  it("does not enter finalizing from herdr idle/done", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "done" }, 3_000);
    assert.equal(lifecycle.process.kind, "running");
    assert.notEqual(projectLifecycle(lifecycle, 4_000).kind, "finalizing");
  });

  it("projects blocked when herdr reports blocked", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "blocked" }, 2_000);
    assert.equal(projectLifecycle(lifecycle, 3_000).kind, "blocked");
  });

  it("treats missing pane as pane observation but not immediate failure", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "missing", error: "pane_not_found" }, 3_000);
    assert.equal(lifecycle.pane.kind, "missing");
    assert.equal(lifecycle.process.kind, "running");
  });

  it("preserves local interrupt over stale herdr statuses", () => {
    for (const agentStatus of ["working", "blocked", "idle", "done"] as const) {
      let lifecycle = createLifecycle(1_000);
      lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
      lifecycle = markInterruptRequested(lifecycle, 3_000);
      lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_100, agentStatus }, 3_100);
      assert.equal(projectLifecycle(lifecycle, 4_000).kind, "interrupted", agentStatus);
    }
  });

  it("preserves hasWorked across unavailable observations", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "unavailable", error: "socket" }, 2_500);
    lifecycle = observePaneInspection(lifecycle, { kind: "unavailable", error: "socket" }, 2_600);
    assert.equal(lifecycle.pane.kind, "read-error");
    assert.equal(lifecycle.pane.kind === "read-error" ? lifecycle.pane.consecutiveFailures : 0, 2);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "idle" }, 3_000);
    assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
  });

  it("does not let missing activity detail stall healthy herdr working", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observeLifecycleActivity(lifecycle, { ok: false, reason: "missing" }, 3_000);
    assert.equal(projectLifecycle(lifecycle, 120_000).kind, "active");
  });

  it("uses activity only as detail and does not override herdr waiting", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "idle" }, 3_000);
    lifecycle = observeLifecycleActivity(lifecycle, { ok: true, activity: activity({ updatedAt: 3_100, sequence: 2 }) }, 3_100);
    assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
  });

  it("preserves activity detail duration across repeated updates", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observeLifecycleActivity(lifecycle, {
      ok: true,
      activity: activity({ updatedAt: 2_100, sequence: 1, activeSince: 2_000, activeScope: "tool", toolName: "bash", toolStartedAt: 2_000 }),
    }, 2_100);
    lifecycle = observeLifecycleActivity(lifecycle, {
      ok: true,
      activity: activity({ updatedAt: 3_000, sequence: 2, activeSince: 2_000, activeScope: "tool", toolName: "bash", toolStartedAt: 2_000 }),
    }, 3_000);
    const projection = projectLifecycle(lifecycle, 4_000);
    assert.equal(projection.kind, "active");
    assert.equal(projection.label, "bash");
    assert.equal(projection.stateDurationSince, 2_000);
  });
});
