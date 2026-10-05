import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVITY_ENV_KEYS,
  PiHarnessDriver,
  activityReporterArgs,
  formatPiLaunch,
  readActivityEnv,
  readPiLaunchProfile,
  resumeActivityLaunch,
} from "../pi-extension/subagents/harness/drivers/pi.ts";
import { publishActivityEvent } from "../pi-extension/subagents/activity.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { runtime, runningSubagents, trackRunningSubagent, watchSubagentRun } from "../pi-extension/subagents/run.ts";
import { shellQuote } from "../pi-extension/subagents/herdr.ts";
import { writeCompletionSidecar } from "../pi-extension/subagents/handoff.ts";
import subagentDone from "../pi-extension/subagents/subagent-done.ts";
import { createMockExtensionApi, createTestDir, restoreEnvVar, withTempDir } from "./helpers.ts";

const ACTIVITY_ENV_NAMES = [...ACTIVITY_ENV_KEYS];
const savedActivityEnv = new Map<string, string | undefined>();

before(() => {
  for (const name of ACTIVITY_ENV_NAMES) {
    savedActivityEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});

after(() => {
  for (const [name, value] of savedActivityEnv) restoreEnvVar(name, value);
});

/** Set the Activity transport exactly as the main process advertises it. */
function setActivityEnv(values: Partial<Record<(typeof ACTIVITY_ENV_KEYS)[number], string>>): void {
  for (const name of ACTIVITY_ENV_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function buildTestCommand(dir: string, sessionFile: string) {
  return new PiHarnessDriver().buildCommand({
    params: { id: "run-1", name: "Reporter", agent: "worker", task: "do the work" },
    runtimePlan: {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      model: "anthropic/claude-sonnet-4-5",
      thinking: "medium",
      modelSource: "request",
      thinkingSource: "request",
    },
    effectiveModel: "anthropic/claude-sonnet-4-5",
    effectiveThinking: "medium",
    parentThinking: "medium",
    surface: "fx:1",
    artifactDir: dir,
    sessionDir: dir,
    subagentSessionFile: sessionFile,
    effectiveCwd: dir,
    effectiveAutoExit: true,
    effectiveInteractive: false,
    inheritsConversationContext: false,
    taskDelivery: "artifact",
    denySet: new Set(),
    identity: null,
    identityInSystemPrompt: false,
    subagentsDir: dir,
    shellQuote,
  });
}

function childFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-7",
    name: "Worker",
    task: "do the work",
    surface: "fx:2",
    startTime: Date.now(),
    sessionFile: "/nonexistent/child.jsonl",
    interactive: false,
    lifecycle: createLifecycle(Date.now()),
    ...overrides,
  } as any;
}

type CollectedEvent = { channel: string; data: any };

/** Stand in for the Activity consumer listening in this process. */
function collectActivityEvents(): CollectedEvent[] {
  const events: CollectedEvent[] = [];
  runtime.pi = {
    events: { emit: (channel: string, data: unknown) => events.push({ channel, data: data as any }) },
  } as any;
  return events;
}

describe("Activity transport in the child environment", () => {
  it("injects the four values into spawned children without persisting them in the launch profile", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const reporter = join(dir, "reporter.ts");
      setActivityEnv({
        PI_ACTIVITY_ENDPOINT: "/tmp/pi-activity.sock",
        PI_ACTIVITY_ROOT: "root-1",
        PI_ACTIVITY_GENERATION: "7",
        PI_ACTIVITY_REPORTER: reporter,
      });

      const built = buildTestCommand(dir, sessionFile);
      assert.ok(built.command.includes(`PI_ACTIVITY_ENDPOINT=${shellQuote("/tmp/pi-activity.sock")}`));
      assert.ok(built.command.includes(`PI_ACTIVITY_ROOT=${shellQuote("root-1")}`));
      assert.ok(built.command.includes(`PI_ACTIVITY_GENERATION=${shellQuote("7")}`));
      assert.ok(built.command.includes(`PI_ACTIVITY_REPORTER=${shellQuote(reporter)}`));
      assert.equal(countOccurrences(built.command, `-e ${shellQuote(reporter)}`), 1);

      // The durable profile is written before the transient values are added.
      assert.doesNotMatch(readFileSync(`${sessionFile}.launch.json`, "utf8"), /PI_ACTIVITY_/);
      const profile = readPiLaunchProfile(sessionFile)!;
      for (const name of ACTIVITY_ENV_NAMES) assert.equal(profile.env[name], undefined);
      assert.equal(profile.env.PI_SUBAGENT_AGENT, "worker");
    });
  });

  it("adds neither the environment nor the reporter flag when the main process has no collector", () => {
    setActivityEnv({});
    withTempDir((dir) => {
      const built = buildTestCommand(dir, join(dir, "child.jsonl"));

      assert.doesNotMatch(built.command, /PI_ACTIVITY_/);
      assert.equal(countOccurrences(built.command, "-e "), 1, "only subagent-done.ts is loaded");
      assert.deepEqual(readActivityEnv({}), {});
      assert.deepEqual(readActivityEnv({ PI_ACTIVITY_ENDPOINT: "" }), {});
    });
  });

  it("loads the reporter once and only once, even when the args already name it", () => {
    const reporter = "/opt/pi-activity/reporter.ts";
    assert.deepEqual(activityReporterArgs(["pi", "--session", "s.jsonl"], reporter), ["-e", reporter]);
    assert.deepEqual(activityReporterArgs(["pi", "-e", reporter], reporter), []);
    assert.deepEqual(activityReporterArgs(["pi"], undefined), []);
    assert.deepEqual(activityReporterArgs(["pi"], ""), []);
  });

  it("refreshes the transport from the current parent on resume instead of the saved profile", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "resumed.jsonl");
      const staleReporter = join(dir, "old-reporter.ts");
      const reporter = join(dir, "reporter.ts");
      writeFileSync(
        `${sessionFile}.launch.json`,
        JSON.stringify({
          args: ["pi", "--session", sessionFile, "-e", join(dir, "subagent-done.ts")],
          env: {
            PI_SUBAGENT_AGENT: "worker",
            PI_ACTIVITY_ENDPOINT: "/tmp/stale.sock",
            PI_ACTIVITY_ROOT: "root-stale",
            PI_ACTIVITY_GENERATION: "1",
            PI_ACTIVITY_REPORTER: staleReporter,
          },
          cwd: null,
        }),
      );

      const profile = readPiLaunchProfile(sessionFile)!;
      for (const name of ACTIVITY_ENV_NAMES) {
        assert.equal(profile.env[name], undefined, `${name} is never restored from the profile`);
      }

      setActivityEnv({
        PI_ACTIVITY_ENDPOINT: "/tmp/fresh.sock",
        PI_ACTIVITY_ROOT: "root-fresh",
        PI_ACTIVITY_GENERATION: "9",
        PI_ACTIVITY_REPORTER: reporter,
      });

      const activity = resumeActivityLaunch(profile.args);
      const command = formatPiLaunch(
        { args: [...profile.args, ...activity.args], env: { ...profile.env, ...activity.env }, cwd: profile.cwd },
        shellQuote,
      );
      assert.ok(command.includes(`PI_ACTIVITY_ENDPOINT=${shellQuote("/tmp/fresh.sock")}`));
      assert.ok(command.includes(`PI_ACTIVITY_ROOT=${shellQuote("root-fresh")}`));
      assert.ok(command.includes(`PI_ACTIVITY_GENERATION=${shellQuote("9")}`));
      assert.equal(countOccurrences(command, `-e ${shellQuote(reporter)}`), 1);
      assert.doesNotMatch(command, /stale/);
      assert.equal(profile.env.PI_SUBAGENT_AGENT, "worker", "durable role settings still resume");

      // A profile that already loads a reporter gets no second copy.
      assert.deepEqual(activityReporterArgs([...profile.args, "-e", reporter], reporter), []);
    });
  });
});

describe("child lifecycle reporting", () => {
  it("publishes started, completion-detected and completed transitions", async () => {
    const events = collectActivityEvents();
    runtime.latestCtx = { sessionManager: { getSessionId: () => "sess-main" } } as any;
    process.env.PI_ACTIVITY_ROOT = "root-1";
    process.env.PI_ACTIVITY_GENERATION = "3";

    const dir = createTestDir();
    try {
      const sentinelFile = join(dir, "done.sentinel");
      writeFileSync(sentinelFile, "");
      const running = childFixture({ sessionFile: join(dir, "child.jsonl"), sentinelFile });

      trackRunningSubagent(running);
      const result = await watchSubagentRun(running, new AbortController().signal);
      runningSubagents.delete(running.id);

      assert.equal(result.exitCode, 0);
      assert.deepEqual(
        events.map((event) => event.data.kind),
        ["child_started", "child_completion_detected", "child_completed"],
      );
      assert.equal(events.every((event) => event.channel === "pi-activity:event"), true);
      assert.deepEqual(events.map((event) => event.data.seq), [1, 2, 3]);

      const completed = events[2].data;
      assert.equal(completed.v, 1);
      assert.equal(completed.id, "herdr:sess-main:3");
      assert.equal(completed.root, "root-1");
      assert.equal(completed.generation, 3);
      assert.equal(completed.session, "sess-main");
      assert.deepEqual(completed.actor, {
        kind: "child",
        name: "Worker",
        id: "run-7",
        parent: "sess-main",
      });
      assert.equal(completed.source, "subagents");
      assert.equal(completed.severity, "info");
      assert.equal(completed.presentation, "routine");
      assert.equal(completed.claimed, false);
      assert.match(completed.summary, /"Worker" completed/);
      assert.match(events[0].data.details, /session: /);
      assert.equal("fallback" in completed, false, "herdr has no routine notice to hand over");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("masks a provider credential in a failed child and does not duplicate it into details", async () => {
    const events = collectActivityEvents();
    runtime.latestCtx = { sessionManager: { getSessionId: () => "sess-main" } } as any;

    const dir = createTestDir();
    try {
      const sessionFile = join(dir, "child.jsonl");
      const errorMessage = `provider rejected the request: api_key=sk-proj-${"A".repeat(40)}`;
      writeCompletionSidecar(sessionFile, { type: "error", errorMessage, stopReason: "error" });

      const result = await watchSubagentRun(childFixture({ sessionFile }), new AbortController().signal);

      assert.equal(result.exitCode, 1);
      assert.equal(result.errorMessage, errorMessage);
      const failed = events.find((event) => event.data.kind === "child_failed");
      assert.ok(failed, "expected a child_failed event");
      assert.equal(failed.data.severity, "warning");
      assert.match(failed.data.summary, /\[redacted\]/);
      assert.doesNotMatch(failed.data.summary, /sk-proj-A/);
      assert.ok(failed.data.summary.length <= 200, "summary stays inside the consumer's limit");
      assert.equal(
        "details" in failed.data,
        false,
        "the failure is already in the summary; details would duplicate raw text",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes a cancelled child and cannot throw when pi.events is unavailable", async () => {
    const events = collectActivityEvents();
    runtime.latestCtx = undefined;
    const running = childFixture();

    await watchSubagentRun(running, AbortSignal.abort());
    assert.equal(running.lifecycle.process.kind, "failed");
    assert.equal(events.length, 1);
    assert.equal(events[0].data.kind, "child_cancelled");
    assert.equal(events[0].data.severity, "warning");
    assert.equal(events[0].data.session, "");

    runtime.pi = undefined;
    const cancelled = await watchSubagentRun(childFixture(), AbortSignal.abort());
    assert.equal(cancelled.error, "cancelled");
    assert.equal(cancelled.exitCode, 1);
  });
});

describe("Activity publisher contract", () => {
  function publisherEvent(overrides: Record<string, unknown> = {}) {
    return {
      session: "child-session",
      actor: { kind: "child" as const, name: "Worker" },
      source: "subagents" as const,
      kind: "child_started",
      severity: "info" as const,
      summary: 'Sub-agent "Worker" started',
      ...overrides,
    };
  }

  it("reports the consumer claim and stays silent without a consumer", () => {
    assert.equal(publishActivityEvent(undefined, publisherEvent()), false);
    assert.equal(publishActivityEvent({}, publisherEvent()), false);
    assert.equal(
      publishActivityEvent({ events: { emit() { throw new Error("consumer exploded"); } } }, publisherEvent()),
      false,
    );
    assert.equal(
      publishActivityEvent({ events: { emit: (_channel, data: any) => { data.claimed = true; } } }, publisherEvent()),
      true,
    );
  });

  it("keeps the one-line summary inside the limit the consumer validates", () => {
    let envelope: any;
    publishActivityEvent(
      { events: { emit: (_channel: string, data: unknown) => { envelope = data; } } },
      publisherEvent({ summary: "long summary line ".repeat(40) }),
    );
    assert.equal(envelope.summary.length, 200);
  });

  it("masks credential-shaped runs in summary and details and bounds both", () => {
    let envelope: any;
    publishActivityEvent(
      { events: { emit: (_channel: string, data: unknown) => { envelope = data; } } },
      publisherEvent({
        kind: "child_failed",
        severity: "warning",
        summary: `Sub-agent "Worker" failed: ghp_${"a".repeat(36)}`,
        details: `token=${"b".repeat(64)}\n${"lorem ipsum dolor sit amet ".repeat(400)}`,
      }),
    );

    assert.match(envelope.summary, /\[redacted\]/);
    assert.doesNotMatch(envelope.summary, /ghp_/);
    assert.ok(envelope.summary.length <= 200);
    assert.match(envelope.details, /\[redacted\]/);
    assert.doesNotMatch(envelope.details, /b{40}/);
    assert.ok(Buffer.byteLength(envelope.details, "utf8") <= 8 * 1024, "details stay inside the byte cap");
    assert.match(envelope.details, /… \[truncated\]$/);
  });

  it("namespaces event ids with the herdr producer prefix", () => {
    const ids: string[] = [];
    const capture = () => ({
      events: {
        emit: (_channel: string, data: unknown) => { ids.push((data as { id: string }).id); },
      },
    });
    publishActivityEvent(capture(), publisherEvent({ session: "shared-session" }));
    publishActivityEvent(capture(), publisherEvent({ session: "shared-session" }));

    assert.match(ids[0], /^herdr:shared-session:\d+$/);
    assert.notEqual(ids[0], ids[1], "each event keeps its own sequence");
  });
});

describe("assigned skill reporting", () => {
  function skillCommand(dir: string, name: string) {
    return {
      name: `skill:${name}`,
      source: "skill" as const,
      sourceInfo: { path: join(dir, `${name}.md`), source: "test", scope: "user" as const, origin: "top-level" as const },
    };
  }

  function withChildEnv<T>(values: Record<string, string>, fn: () => T): T {
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    try {
      return fn();
    } finally {
      for (const name of Object.keys(values)) delete process.env[name];
    }
  }

  function runInput(events: CollectedEvent[] | null, commands: any[], session: string | null) {
    const mock = createMockExtensionApi();
    if (events) {
      mock.api.events = { emit: (channel: string, data: unknown) => events.push({ channel, data: data as any }) } as any;
    }
    mock.api.getCommands = () => commands;
    subagentDone(mock.api);
    let stopped = false;
    const result: any = mock.eventHandlers.get("input")![0]({ text: "Do the work", images: [] }, {
      ui: { notify() {} },
      shutdown() { stopped = true; },
      ...(session ? { sessionManager: { getSessionId: () => session } } : {}),
    });
    return { result, stopped };
  }

  it("reports a skill as loaded once its read and the whole load succeeded", () => {
    withTempDir((dir) => {
      for (const name of ["review", "quality"]) writeFileSync(join(dir, `${name}.md`), `${name} instructions`);
      const events: CollectedEvent[] = [];
      const commands = [skillCommand(dir, "review"), skillCommand(dir, "quality")];

      const { result } = withChildEnv(
        { PI_SUBAGENT_SKILLS: "review, quality", PI_SUBAGENT_NAME: "Worker", PI_SUBAGENT_ID: "run-7", PI_ACTIVITY_ROOT: "root-1" },
        () => runInput(events, commands, "child-session"),
      );

      assert.equal(result.action, "transform");
      assert.equal(events.length, 3, "the two skill rows plus the input hook row");
      const skills = events.filter((event) => event.data.source === "skills");
      assert.deepEqual(skills.map((event) => event.data.summary), [
        'Assigned skill "review" loaded',
        'Assigned skill "quality" loaded',
      ]);
      const review = skills[0].data;
      assert.equal(skills[0].channel, "pi-activity:event");
      assert.equal(review.source, "skills");
      assert.equal(review.kind, "skill_assigned");
      assert.equal(review.severity, "info");
      assert.deepEqual(review.actor, { kind: "child", name: "Worker", id: "run-7" });
      assert.equal(review.session, "child-session");
      assert.equal(review.root, "root-1");
      assert.equal(review.correlation.skill, "review");
      assert.equal(review.correlation.path, join(dir, "review.md"));
      assert.equal(review.details, `path: ${join(dir, "review.md")}`);
    });
  });

  it("labels nothing loaded when one assigned skill cannot be read", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "review.md"), "review instructions");
      const commands = [skillCommand(dir, "review"), skillCommand(dir, "ghost")];
      const events: CollectedEvent[] = [];

      const { result } = withChildEnv(
        { PI_SUBAGENT_SKILLS: "review, ghost", PI_SUBAGENT_NAME: "Worker", PI_SUBAGENT_ID: "run-7" },
        () => runInput(events, commands, "child-session"),
      );

      assert.equal(result.action, "handled", "a failed load still stops the child");
      const skills = events.filter((event) => event.data.source === "skills");
      assert.deepEqual(skills.map((event) => event.data.summary), [
        'Assigned skill "review" not loaded',
        'Assigned skill "ghost" not loaded',
      ]);
      assert.deepEqual(skills.map((event) => event.data.severity), ["warning", "warning"]);
      assert.match(skills[0].data.details, /^path: .*review\.md\nerror: /);
      assert.match(skills[1].data.details, /^path: .*ghost\.md\nerror: /);
    });
  });

  it("reports a missing assigned skill as its own explicit failure", () => {
    const events: CollectedEvent[] = [];
    const { result } = withChildEnv(
      { PI_SUBAGENT_SKILLS: "missing", PI_SUBAGENT_NAME: "Worker" },
      () => runInput(events, [], "child-session"),
    );

    assert.equal(result.action, "handled");
    assert.equal(events.length, 2, "the skill failure row plus the input hook row");
    const skills = events.filter((event) => event.data.source === "skills");
    assert.equal(skills.length, 1);
    assert.equal(skills[0].data.summary, 'Assigned skill "missing" not loaded');
    assert.equal(skills[0].data.severity, "warning");
    assert.equal(skills[0].data.details, "error: Assigned skill not available: missing");
    assert.deepEqual(skills[0].data.correlation, { skill: "missing" });
  });

  it("is a silent no-op when the child has no Activity reporter", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "review.md"), "review instructions");
      const { result } = withChildEnv(
        { PI_SUBAGENT_SKILLS: "review", PI_SUBAGENT_NAME: "Worker" },
        () => runInput(null, [skillCommand(dir, "review")], null),
      );
      assert.equal(result.action, "transform");
    });
  });
});
