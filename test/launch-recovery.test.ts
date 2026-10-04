import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getDefaultSessionDirFor } from "../pi-extension/subagents/discovery.ts";
import { cleanupSubagentsForShutdown, getArtifactDir, launchSubagent, runningSubagents, stopTracking, watchSubagent, watchSubagentRun } from "../pi-extension/subagents/run.ts";
import { registerHarnessDriver } from "../pi-extension/subagents/harness/index.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { createTool as createResumeTool } from "../pi-extension/subagents/tools/resume.ts";
import { listLanes } from "../pi-extension/subagents/worktree.ts";
import { writeCompletionSidecar } from "../pi-extension/subagents/handoff.ts";
import { createMockExtensionApi, createSessionFile, SESSION_HEADER, USER_MSG, writeAgentFile } from "./helpers.ts";

/**
 * A herdr stand-in on PATH: every command is logged, nothing touches a terminal.
 * `pane run` fails when FAKE_HERDR_FAIL_ON asks for it — that injects a launch
 * failure after a lane was already allocated.
 */
const FAKE_HERDR = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_HERDR_LOG"
case "$1 $2" in
  "tab create") printf '%s\\n' '{"result":{"tab":{"tab_id":"t1"},"root_pane":{"pane_id":"fx:1"}}}' ;;
  "tab list") printf '%s\\n' '{"result":{"tabs":[]}}' ;;
  "pane list") printf '%s\\n' '{"result":{"panes":[]}}' ;;
  "pane split") printf '%s\\n' '{"result":{"pane":{"pane_id":"fx:2"}}}' ;;
  "pane get") printf '{"result":{"pane":{"pane_id":"%s","agent":"pi","agent_status":"done"}}}\\n' "$3" ;;
  "pane read")
    # A test can hold a resumed child "running" while it stages follow-up work.
    if [ "$FAKE_HERDR_DONE" = "0" ]; then printf '\\n'; else printf '%s\\n' '__SUBAGENT_DONE_0__'; fi ;;
  *)
    if [ "$1 $2" = "pane run" ] && [ "$FAKE_HERDR_FAIL_ON" = "pane run" ]; then
      printf '%s\\n' 'fake herdr: pane run refused' >&2
      exit 1
    fi
    printf '%s\\n' '{}' ;;
esac
`;

const sandbox = mkdtempSync(join(tmpdir(), "pi-launch-test-"));
const binDir = join(sandbox, "bin");
const lanesRoot = join(sandbox, "lanes");
const agentDir = join(sandbox, "agent-home");
const logFile = join(sandbox, "herdr.log");
const savedEnv = new Map<string, string | undefined>();

const ENV_NAMES = [
  "PATH",
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "PI_CODING_AGENT_DIR",
  "PI_SUBAGENTS_WORKTREE_DIR",
  "PI_SUBAGENT_SHELL_READY_DELAY_MS",
  "FAKE_HERDR_LOG",
  "FAKE_HERDR_FAIL_ON",
  "FAKE_HERDR_DONE",
];

function parentSession(name: string, entries: object[]): string {
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  return createSessionFile(dir, entries);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(["init", "-q", "-b", "main"], path);
  git(["config", "user.email", "test@example.com"], path);
  git(["config", "user.name", "Test"], path);
  writeFileSync(join(path, "app.txt"), "base\n");
  git(["add", "-A"], path);
  git(["commit", "-q", "-m", "base"], path);
}

function launchContext(options: { sessionDir: string; parentSessionFile: string; cwd: string }): any {
  const model = {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
  return {
    sessionManager: {
      getSessionFile: () => options.parentSessionFile,
      getSessionId: () => "sess-launch",
      getSessionDir: () => options.sessionDir,
    },
    cwd: options.cwd,
    model: { provider: model.provider, id: model.id },
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        provider === model.provider && modelId === model.id ? model : undefined,
      getAll: () => [model],
      hasConfiguredAuth: () => true,
    },
  };
}

/** Stand in for the session file a real child Pi writes once it starts. */
function childSessionFile(sessionFile: string, cwd: string): void {
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", id: "child-session", version: 3, cwd })}\n`,
  );
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function singleLane(lanes: string): { lanePath: string; laneId: string } {
  const entries = readdirSync(lanes).filter((entry) => entry.startsWith("pi-worktree-"));
  assert.equal(entries.length, 1, `expected exactly one lane, got ${entries.join(", ")}`);
  return {
    lanePath: join(lanes, entries[0]),
    laneId: entries[0].replace("pi-worktree-", ""),
  };
}

before(() => {
  for (const name of ENV_NAMES) savedEnv.set(name, process.env[name]);
  mkdirSync(binDir, { recursive: true });
  mkdirSync(lanesRoot, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(binDir, "herdr"), FAKE_HERDR, { mode: 0o755 });
  writeFileSync(logFile, "");

  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p0";
  process.env.HERDR_TAB_ID = "t0";
  process.env.HERDR_WORKSPACE_ID = "w1";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENTS_WORKTREE_DIR = lanesRoot;
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
  process.env.FAKE_HERDR_LOG = logFile;
  process.env.FAKE_HERDR_DONE = "1";
});

after(() => {
  cleanupSubagentsForShutdown("quit", runningSubagents);
  stopTracking();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe("launch failure after allocation", () => {
  it("keeps a recoverable lane receipt, closes its own pane, and preserves the worktree", async () => {
    const repo = join(sandbox, "fail-repo");
    makeRepo(repo);
    const lanes = join(sandbox, "fail-lanes");
    const sessionDir = join(sandbox, "fail-sessions");
    const parentSessionFile = parentSession("fail-parent", [SESSION_HEADER, USER_MSG]);
    const artifactDir = getArtifactDir(sessionDir, "sess-launch");
    const lanesBefore = process.env.PI_SUBAGENTS_WORKTREE_DIR;
    process.env.PI_SUBAGENTS_WORKTREE_DIR = lanes;
    process.env.FAKE_HERDR_FAIL_ON = "pane run";
    writeFileSync(logFile, "");

    let message = "";
    try {
      await assert.rejects(
        () =>
          launchSubagent(
            { name: "Lane Worker", task: "do the work", worktree: true, cwd: repo },
            launchContext({ sessionDir, parentSessionFile, cwd: repo }),
            "medium",
          ),
        (error: Error) => {
          message = error.message;
          return true;
        },
      );
    } finally {
      delete process.env.FAKE_HERDR_FAIL_ON;
      process.env.PI_SUBAGENTS_WORKTREE_DIR = lanesBefore;
    }

    const { lanePath, laneId } = singleLane(lanes);

    assert.match(message, /failed to launch/);
    assert.match(message, /pane run refused/);
    assert.match(message, new RegExp(`pi-subagents/lane-worker-${laneId}`));
    assert.ok(message.includes(lanePath), `expected the lane path in: ${message}`);

    // The failure is recoverable: subagent_worktrees can find and inspect the lane.
    const recorded = listLanes(artifactDir, laneId);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].manifest.terminalState.status, "failed");
    assert.equal(recorded[0].manifest.name, "Lane Worker");
    assert.equal(recorded[0].manifest.worktree, lanePath);
    assert.ok(existsSync(lanePath), "a lane that may hold work is never unwound");

    // The pane this launch created is dropped; the caller's pane is not ours.
    assert.match(readFileSync(logFile, "utf8"), /pane close fx:1/);
  });

  it("leaves a caller-provided pane open when the launch fails", async () => {
    const repo = join(sandbox, "precreated-repo");
    makeRepo(repo);
    const lanes = join(sandbox, "precreated-lanes");
    const sessionDir = join(sandbox, "precreated-sessions");
    const parentSessionFile = parentSession("precreated-parent", [SESSION_HEADER, USER_MSG]);
    const lanesBefore = process.env.PI_SUBAGENTS_WORKTREE_DIR;
    process.env.PI_SUBAGENTS_WORKTREE_DIR = lanes;
    process.env.FAKE_HERDR_FAIL_ON = "pane run";
    writeFileSync(logFile, "");

    try {
      await assert.rejects(
        () =>
          launchSubagent(
            { name: "Attached Worker", task: "do the work", worktree: true, cwd: repo },
            launchContext({ sessionDir, parentSessionFile, cwd: repo }),
            "medium",
            { surface: "fx:9" },
          ),
        /failed to launch/,
      );
    } finally {
      delete process.env.FAKE_HERDR_FAIL_ON;
      process.env.PI_SUBAGENTS_WORKTREE_DIR = lanesBefore;
    }

    const log = readFileSync(logFile, "utf8");
    assert.match(log, /pane run fx:9/);
    assert.doesNotMatch(log, /pane close/, "the pane belonged to the caller");
    assert.equal(listLanes(getArtifactDir(sessionDir, "sess-launch")).length, 1);
  });
});

describe("worktree child cwd", () => {
  it("starts the child in the lane copy of the requested repository subdirectory", async () => {
    const repo = join(sandbox, "nested-repo");
    makeRepo(repo);
    const subdir = join(repo, "packages", "app");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, "index.js"), "module.exports = {};\n");
    // The source subdirectory has a cwd-local agent config that is not tracked,
    // so the lane cannot contain it.
    writeFileSync(join(repo, ".gitignore"), ".pi/\n");
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "nested app"], repo);
    mkdirSync(join(subdir, ".pi", "agent"), { recursive: true });

    const lanes = join(sandbox, "nested-lanes");
    const sessionDir = join(sandbox, "nested-sessions");
    const parentSessionFile = parentSession("nested-parent", [SESSION_HEADER, USER_MSG]);
    const lanesBefore = process.env.PI_SUBAGENTS_WORKTREE_DIR;
    process.env.PI_SUBAGENTS_WORKTREE_DIR = lanes;

    try {
      const running = await launchSubagent(
        { name: "Nested", task: "work in the package", worktree: true, cwd: subdir, fork: true },
        launchContext({ sessionDir, parentSessionFile, cwd: repo }),
        "medium",
      );

      const { lanePath } = singleLane(lanes);
      const childCwd = join(lanePath, "packages", "app");
      const script = readFileSync(running.launchScriptFile!, "utf8");

      assert.equal(running.worktree?.allocation.path, lanePath);
      // Session base, seeded session header, launch profile and shell agree.
      assert.equal(
        dirname(running.sessionFile),
        getDefaultSessionDirFor(childCwd, join(subdir, ".pi", "agent")),
      );
      assert.equal(JSON.parse(readFileSync(running.sessionFile, "utf8").split("\n")[0]).cwd, childCwd);
      const profile = JSON.parse(readFileSync(`${running.sessionFile}.launch.json`, "utf8"));
      assert.equal(profile.cwd, childCwd);
      assert.ok(script.includes(`cd '${childCwd}'`), script);
      // The lane has no local agent config, so the child keeps the parent's
      // agent dir instead of being pointed back at the source checkout.
      assert.equal(profile.env.PI_CODING_AGENT_DIR, agentDir);
    } finally {
      cleanupSubagentsForShutdown("quit", runningSubagents);
      process.env.PI_SUBAGENTS_WORKTREE_DIR = lanesBefore;
    }
  });

  it("starts at the lane root when the requested cwd is not in the lane", async () => {
    const repo = join(sandbox, "ignored-repo");
    makeRepo(repo);
    // dist/ exists in the source checkout but is ignored, so no lane has it.
    writeFileSync(join(repo, ".gitignore"), "dist/\n");
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "ignore dist"], repo);
    const ignored = join(repo, "dist");
    mkdirSync(ignored, { recursive: true });
    writeFileSync(join(ignored, "bundle.js"), "built\n");

    const lanes = join(sandbox, "ignored-lanes");
    const sessionDir = join(sandbox, "ignored-sessions");
    const parentSessionFile = parentSession("ignored-parent", [SESSION_HEADER, USER_MSG]);
    const lanesBefore = process.env.PI_SUBAGENTS_WORKTREE_DIR;
    process.env.PI_SUBAGENTS_WORKTREE_DIR = lanes;

    try {
      const running = await launchSubagent(
        { name: "Ignored", task: "work from the ignored dir", worktree: true, cwd: ignored, fork: true },
        launchContext({ sessionDir, parentSessionFile, cwd: repo }),
        "medium",
      );

      const { lanePath } = singleLane(lanes);
      assert.equal(running.worktree?.allocation.path, lanePath);
      assert.equal(JSON.parse(readFileSync(running.sessionFile, "utf8").split("\n")[0]).cwd, lanePath);
      const profile = JSON.parse(readFileSync(`${running.sessionFile}.launch.json`, "utf8"));
      assert.equal(profile.cwd, lanePath);
      assert.ok(readFileSync(running.launchScriptFile!, "utf8").includes(`cd '${lanePath}'`));
    } finally {
      cleanupSubagentsForShutdown("quit", runningSubagents);
      process.env.PI_SUBAGENTS_WORKTREE_DIR = lanesBefore;
    }
  });
});

describe("terminal pane retention", () => {
  it("leaves a completed pane visible instead of closing it", async () => {
    const sessionDir = join(sandbox, "retain-sessions");
    const parentSessionFile = parentSession("retain-parent", [SESSION_HEADER, USER_MSG]);
    writeFileSync(logFile, "");

    const running = await launchSubagent(
      { name: "Retained", task: "report back" },
      launchContext({ sessionDir, parentSessionFile, cwd: sandbox }),
      "medium",
    );
    const result = await watchSubagentRun(running, new AbortController().signal);

    assert.equal(result.exitCode, 0);
    const log = readFileSync(logFile, "utf8");
    assert.match(log, /pane run/, "the run really launched into its own pane");
    assert.doesNotMatch(log, /pane close/, "a terminal pane stays visible for the parent");
  });

  it("carries a provider error from the completion sidecar through the external driver branch", async () => {
    registerHarnessDriver({
      id: "b15-test-driver",
      name: "B15 Test Driver",
      hasActivitySnapshots: false,
      supportsTurnInterrupt: false,
      formatModel: (plan: any) => plan.modelId,
      buildCommand: () => {
        throw new Error("not used by this test");
      },
      extractResult: () => ({ summary: "driver summary" }),
    } as any);

    const sessionDir = join(sandbox, "sidecar-sessions");
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "child.jsonl");
    writeFileSync(sessionFile, "");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({
      type: "error",
      errorMessage: "provider exploded",
      stopReason: "error",
    }));

    const running = {
      id: "sidecar-run",
      name: "Sidecar",
      task: "do the work",
      surface: "fx:7",
      startTime: Date.now(),
      sessionFile,
      cli: "b15-test-driver",
      interactive: false,
      lifecycle: createLifecycle(Date.now()),
    };
    const result = await watchSubagentRun(running as any, new AbortController().signal);

    assert.equal(result.exitCode, 1);
    assert.equal(result.errorMessage, "provider exploded");
    assert.equal(result.summary, "driver summary");
  });
});

describe("resume artifacts", () => {
  it("names the resume message after the resume run, so same-second resumes stay distinct", async () => {
    const sessionDir = join(sandbox, "resume-sessions");
    const sessionPath = parentSession("resume-parent", [SESSION_HEADER, USER_MSG]);
    const { api } = createMockExtensionApi();
    const resume = createResumeTool(api);
    const ctx = {
      sessionManager: { getSessionId: () => "sess-resume", getSessionDir: () => sessionDir },
    } as any;

    const launch = async (message: string) => {
      const result: any = await resume.execute(
        "call-1",
        { sessionPath, name: "Same Label", message },
        undefined,
        undefined,
        ctx,
      );
      const script = readFileSync(result.details.launchScriptFile, "utf8");
      const msgFile = script.match(/'@([^']+\.md)'/)?.[1] ?? "";
      assert.ok(msgFile, `expected a resume message file in: ${script}`);
      assert.match(msgFile, new RegExp(`-${result.details.id}\\.md$`));
      assert.equal(readFileSync(msgFile, "utf8"), message);
      return msgFile;
    };

    try {
      const first = await launch("First follow-up");
      const second = await launch("Second follow-up");
      assert.notEqual(first, second);
    } finally {
      // Let the aborted watchers settle while the fake herdr is still on PATH:
      // a resumed run must not deliver its result or touch the real CLI after teardown.
      cleanupSubagentsForShutdown("quit", runningSubagents);
      await new Promise((resolve) => setTimeout(resolve, 250));
      stopTracking();
    }
  });
});

describe("lane re-attachment on resume", () => {
  it("re-captures the session's own lane while the resumed run gets fresh artifacts", async () => {
    const repo = join(sandbox, "resume-lane-repo");
    makeRepo(repo);
    const lanes = join(sandbox, "resume-lane-lanes");
    const sessionDir = join(sandbox, "resume-lane-sessions");
    const parentSessionFile = parentSession("resume-lane-parent", [SESSION_HEADER, USER_MSG]);
    const artifactDir = getArtifactDir(sessionDir, "sess-launch");
    writeAgentFile(join(agentDir, "agents"), "lane-role", "name: lane-role");
    const lanesBefore = process.env.PI_SUBAGENTS_WORKTREE_DIR;
    process.env.PI_SUBAGENTS_WORKTREE_DIR = lanes;

    try {
      const launched = await launchSubagent(
        { name: "Lane Worker", agent: "lane-role", task: "do the work", worktree: true, cwd: repo },
        launchContext({ sessionDir, parentSessionFile, cwd: repo }),
        "medium",
      );
      const laneId = launched.worktree!.laneId;
      const lanePath = launched.worktree!.allocation.path;
      const manifestFile = join(artifactDir, "subagent-worktrees", laneId, "manifest.json");
      childSessionFile(launched.sessionFile, lanePath);

      // The child did the first round of work, then pinged for help and ended.
      writeFileSync(join(lanePath, "first.txt"), "first round\n");
      writeCompletionSidecar(launched.sessionFile, {
        type: "ping",
        name: launched.name,
        message: "needs a hand",
      });
      const pinged = await watchSubagent(launched, new AbortController().signal);
      assert.equal(pinged.ping?.message, "needs a hand");

      const firstManifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      const firstPatch = readFileSync(firstManifest.patchFile, "utf8");
      assert.equal(firstManifest.laneId, laneId);
      assert.equal(firstManifest.sessionFile, launched.sessionFile);
      assert.deepEqual(firstManifest.changedPaths.map((change: any) => change.path), ["first.txt"]);

      // The launch profile is the durable lane reference resume reads back.
      const profile = JSON.parse(readFileSync(`${launched.sessionFile}.launch.json`, "utf8"));
      assert.equal(profile.lane.laneId, laneId);
      assert.equal(profile.lane.artifactDir, artifactDir);
      assert.equal(profile.lane.sessionFile, launched.sessionFile);
      assert.equal(profile.lane.allocation.path, lanePath);

      const { api } = createMockExtensionApi();
      const resume = createResumeTool(api);
      const ctx = {
        sessionManager: { getSessionId: () => "sess-launch", getSessionDir: () => sessionDir },
      } as any;

      // Keep the resumed child running until its follow-up work is staged.
      process.env.FAKE_HERDR_DONE = "0";
      const resumed: any = await resume.execute(
        "call-1",
        { sessionPath: launched.sessionFile, name: "Lane Follow-up", message: "keep going" },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(resumed.details.status, "started");

      const resumeId = resumed.details.id;
      assert.notEqual(resumeId, laneId, "the resumed run keeps its own run id");
      const resumedRunning = runningSubagents.get(resumeId);
      assert.ok(resumedRunning, "the resumed run is tracked");
      assert.equal(resumedRunning.worktree?.laneId, laneId);
      assert.equal(resumedRunning.worktree?.allocation.path, lanePath);
      assert.equal(resumedRunning.agent, "lane-role", "the lane's role provenance is restored");
      assert.equal(resumedRunning.sessionFile, launched.sessionFile);
      // Activity and context artifacts belong to the fresh run, not to the lane.
      assert.notEqual(resumedRunning.activityFile, launched.activityFile);
      assert.match(resumedRunning.activityFile!, new RegExp(`/${resumeId}\\.json$`));
      const resumeScript = readFileSync(resumed.details.launchScriptFile, "utf8");
      const resumeMsgFile = resumeScript.match(/'@([^']+\.md)'/)?.[1] ?? "";
      assert.ok(resumeMsgFile, `expected a resume message file in: ${resumeScript}`);
      assert.match(resumeMsgFile, new RegExp(`-${resumeId}\\.md$`));

      // Follow-up work happens in the same lane after the resume.
      writeFileSync(join(lanePath, "second.txt"), "follow-up round\n");
      process.env.FAKE_HERDR_DONE = "1";
      await waitFor(() => !runningSubagents.has(resumeId), "the resumed run to finish");

      const recaptured = JSON.parse(readFileSync(manifestFile, "utf8"));
      assert.equal(recaptured.laneId, laneId);
      assert.equal(recaptured.branch, firstManifest.branch);
      assert.equal(recaptured.worktree, lanePath);
      assert.equal(recaptured.sessionFile, launched.sessionFile);
      assert.equal(recaptured.agent, "lane-role");
      assert.equal(recaptured.name, firstManifest.name, "the lane keeps its original name");
      assert.equal(recaptured.createdAt, firstManifest.createdAt, "the lane keeps its original createdAt");
      assert.deepEqual(
        recaptured.changedPaths.map((change: any) => change.path).sort(),
        ["first.txt", "second.txt"],
      );
      const recapturedPatch = readFileSync(recaptured.patchFile, "utf8");
      assert.notEqual(recapturedPatch, firstPatch, "the patch now carries the follow-up work");
      assert.match(recapturedPatch, /first\.txt/);
      assert.match(recapturedPatch, /second\.txt/);
      // Follow-up work never spawns a second lane, and the lane itself is intact.
      assert.equal(readdirSync(lanes).length, 1);
      assert.equal(git(["symbolic-ref", "--short", "HEAD"], lanePath).trim(), firstManifest.branch);
      cleanupSubagentsForShutdown("quit", runningSubagents);
    } finally {
      process.env.FAKE_HERDR_DONE = "1";
      cleanupSubagentsForShutdown("quit", runningSubagents);
      process.env.PI_SUBAGENTS_WORKTREE_DIR = lanesBefore;
    }
  });

  it("refuses a mismatched or ambiguous lane association before opening a pane", async () => {
    const repo = join(sandbox, "resume-reject-repo");
    makeRepo(repo);
    const lanes = join(sandbox, "resume-reject-lanes");
    const sessionDir = join(sandbox, "resume-reject-sessions");
    const parentSessionFile = parentSession("resume-reject-parent", [SESSION_HEADER, USER_MSG]);
    const artifactDir = getArtifactDir(sessionDir, "sess-launch");
    const lanesBefore = process.env.PI_SUBAGENTS_WORKTREE_DIR;
    process.env.PI_SUBAGENTS_WORKTREE_DIR = lanes;

    try {
      const launched = await launchSubagent(
        { name: "Reject Worker", task: "do the work", worktree: true, cwd: repo },
        launchContext({ sessionDir, parentSessionFile, cwd: repo }),
        "medium",
      );
      const laneId = launched.worktree!.laneId;
      const lanePath = launched.worktree!.allocation.path;
      const manifestFile = join(artifactDir, "subagent-worktrees", laneId, "manifest.json");
      childSessionFile(launched.sessionFile, lanePath);

      writeFileSync(join(lanePath, "work.txt"), "work\n");
      writeCompletionSidecar(launched.sessionFile, { type: "done" });
      await watchSubagent(launched, new AbortController().signal);

      const manifestBefore = readFileSync(manifestFile, "utf8");
      const evidence = JSON.parse(manifestBefore);
      const patchBefore = readFileSync(evidence.patchFile, "utf8");
      const profileFile = `${launched.sessionFile}.launch.json`;

      const { api } = createMockExtensionApi();
      const resume = createResumeTool(api);
      const ctx = {
        sessionManager: { getSessionId: () => "sess-launch", getSessionDir: () => sessionDir },
      } as any;

      // The profile points at a worktree the lane does not own.
      const profile = JSON.parse(readFileSync(profileFile, "utf8"));
      profile.lane.allocation.path = join(lanes, "pi-worktree-somewhere-else");
      writeFileSync(profileFile, JSON.stringify(profile));
      writeFileSync(logFile, "");

      const mismatched: any = await resume.execute(
        "call-1",
        { sessionPath: launched.sessionFile, name: "Mismatch", message: "keep going" },
        undefined,
        undefined,
        ctx,
      );
      assert.notEqual(mismatched.details.status, "started");
      assert.match(mismatched.content[0].text, /refusing to resume/i);
      assert.match(mismatched.content[0].text, /does not match the reference/);

      // Lane evidence without a durable reference cannot be verified either.
      delete profile.lane;
      writeFileSync(profileFile, JSON.stringify(profile));
      writeFileSync(logFile, "");

      const ambiguous: any = await resume.execute(
        "call-2",
        { sessionPath: launched.sessionFile, name: "Ambiguous", message: "keep going" },
        undefined,
        undefined,
        ctx,
      );
      assert.notEqual(ambiguous.details.status, "started");
      assert.match(ambiguous.content[0].text, /refusing to resume/i);
      assert.match(ambiguous.content[0].text, /no lane reference/);
      assert.doesNotMatch(readFileSync(logFile, "utf8"), /tab create|pane split|pane run/, "no pane may be opened");

      // Every rejection preserves the lane: manifest, patch, branch and worktree.
      assert.equal(readFileSync(manifestFile, "utf8"), manifestBefore);
      assert.equal(readFileSync(evidence.patchFile, "utf8"), patchBefore);
      assert.equal(existsSync(lanePath), true);
      assert.equal(git(["symbolic-ref", "--short", "HEAD"], lanePath).trim(), evidence.branch);
      assert.equal(readdirSync(lanes).length, 1);
    } finally {
      cleanupSubagentsForShutdown("quit", runningSubagents);
      process.env.PI_SUBAGENTS_WORKTREE_DIR = lanesBefore;
    }
  });

  it("refuses a legacy lane session with no durable reference and preserves its evidence", async () => {
    const repo = join(sandbox, "legacy-lane-repo");
    makeRepo(repo);
    const lanes = join(sandbox, "legacy-lane-lanes");
    const sessionDir = join(sandbox, "legacy-lane-sessions");
    const parentSessionFile = parentSession("legacy-lane-parent", [SESSION_HEADER, USER_MSG]);
    const artifactDir = getArtifactDir(sessionDir, "sess-launch");
    const lanesBefore = process.env.PI_SUBAGENTS_WORKTREE_DIR;
    process.env.PI_SUBAGENTS_WORKTREE_DIR = lanes;

    try {
      const launched = await launchSubagent(
        { name: "Legacy Worker", task: "do the work", worktree: true, cwd: repo },
        launchContext({ sessionDir, parentSessionFile, cwd: repo }),
        "medium",
      );
      const laneId = launched.worktree!.laneId;
      const lanePath = launched.worktree!.allocation.path;
      const manifestFile = join(artifactDir, "subagent-worktrees", laneId, "manifest.json");
      childSessionFile(launched.sessionFile, lanePath);

      writeFileSync(join(lanePath, "legacy.txt"), "legacy work\n");
      writeCompletionSidecar(launched.sessionFile, { type: "done" });
      await watchSubagent(launched, new AbortController().signal);

      // Legacy evidence: the manifest never recorded a session, and the profile
      // predates the durable lane reference. Its cwd is still inside the lane.
      const legacy = JSON.parse(readFileSync(manifestFile, "utf8"));
      delete legacy.sessionFile;
      writeFileSync(manifestFile, `${JSON.stringify(legacy, null, 2)}\n`);
      const manifestBefore = readFileSync(manifestFile, "utf8");
      const patchBefore = readFileSync(legacy.patchFile, "utf8");
      const profileFile = `${launched.sessionFile}.launch.json`;
      const profile = JSON.parse(readFileSync(profileFile, "utf8"));
      assert.ok(profile.cwd.startsWith(lanePath), `expected a lane cwd, got ${profile.cwd}`);
      delete profile.lane;
      writeFileSync(profileFile, JSON.stringify(profile));

      const { api } = createMockExtensionApi();
      const resume = createResumeTool(api);
      const ctx = {
        sessionManager: { getSessionId: () => "sess-launch", getSessionDir: () => sessionDir },
      } as any;
      writeFileSync(logFile, "");

      const refused: any = await resume.execute(
        "call-1",
        { sessionPath: launched.sessionFile, name: "Legacy", message: "keep going" },
        undefined,
        undefined,
        ctx,
      );
      assert.notEqual(refused.details.status, "started");
      assert.match(refused.content[0].text, /refusing to resume/i);
      assert.match(refused.content[0].text, /inside lane worktree/i);
      assert.doesNotMatch(readFileSync(logFile, "utf8"), /tab create|pane split|pane run/, "no pane may be opened");

      // A second manifest claiming the same worktree makes it ambiguous, not allowed.
      const duplicateDir = join(artifactDir, "subagent-worktrees", "legacy-other");
      mkdirSync(duplicateDir, { recursive: true });
      writeFileSync(join(duplicateDir, "manifest.json"), JSON.stringify({ ...legacy, laneId: "legacy-other" }));
      const ambiguous: any = await resume.execute(
        "call-2",
        { sessionPath: launched.sessionFile, name: "Legacy", message: "keep going" },
        undefined,
        undefined,
        ctx,
      );
      assert.notEqual(ambiguous.details.status, "started");
      assert.match(ambiguous.content[0].text, /multiple lanes contain it/);

      // Every refusal preserves the lane: manifest, patch, worktree and branch.
      assert.equal(readFileSync(manifestFile, "utf8"), manifestBefore);
      assert.equal(readFileSync(legacy.patchFile, "utf8"), patchBefore);
      assert.equal(existsSync(lanePath), true);
      assert.equal(git(["symbolic-ref", "--short", "HEAD"], lanePath).trim(), legacy.branch);
      assert.equal(readdirSync(lanes).length, 1);
      assert.doesNotMatch(readFileSync(logFile, "utf8"), /tab create|pane split|pane run/, "no pane may be opened");
    } finally {
      cleanupSubagentsForShutdown("quit", runningSubagents);
      process.env.PI_SUBAGENTS_WORKTREE_DIR = lanesBefore;
    }
  });

  it("still resumes a legacy session whose cwd is outside every lane", async () => {
    const sessionDir = join(sandbox, "legacy-plain-sessions");
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = parentSession("legacy-plain-parent", [SESSION_HEADER, USER_MSG]);
    writeFileSync(
      `${sessionPath}.launch.json`,
      JSON.stringify({ args: ["pi", "--session", sessionPath], env: {}, cwd: sandbox }),
    );

    const { api } = createMockExtensionApi();
    const resume = createResumeTool(api);
    const ctx = {
      sessionManager: { getSessionId: () => "sess-legacy-plain", getSessionDir: () => sessionDir },
    } as any;

    try {
      writeFileSync(logFile, "");
      process.env.FAKE_HERDR_DONE = "0";
      const resumed: any = await resume.execute(
        "call-1",
        { sessionPath, name: "Plain Resume", message: "continue" },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(resumed.details.status, "started");
      assert.match(readFileSync(logFile, "utf8"), /pane run/);
    } finally {
      process.env.FAKE_HERDR_DONE = "1";
      cleanupSubagentsForShutdown("quit", runningSubagents);
      await new Promise((resolve) => setTimeout(resolve, 250));
      stopTracking();
    }
  });
});

describe("pane metadata", () => {
  it("reports a bounded role/name/run label instead of the task or resume message", async () => {
    const sessionDir = join(sandbox, "meta-sessions");
    const parentSessionFile = parentSession("meta-parent", [SESSION_HEADER, USER_MSG]);
    writeAgentFile(join(agentDir, "agents"), "meta-role", "name: meta-role");
    const secretTask = "SECRET-TASK-BODY plumb the private API keys";
    const secretMessage = "SECRET-RESUME-BODY rotate the token";

    try {
      writeFileSync(logFile, "");
      const launched = await launchSubagent(
        { name: "Meta Worker", agent: "meta-role", task: secretTask },
        launchContext({ sessionDir, parentSessionFile, cwd: sandbox }),
        "medium",
      );
      const launchLog = readFileSync(logFile, "utf8");
      assert.match(launchLog, /pane report-metadata/, "the pane metadata report is issued");
      assert.doesNotMatch(launchLog, /SECRET-TASK-BODY/, "the task prompt never reaches pane metadata");
      assert.match(
        launchLog,
        new RegExp(`task=meta-role/Meta Worker/${launched.id}(\\s|$)`),
        `expected a bounded role/name/run label in: ${launchLog}`,
      );
      // The launch script the pane executes is readable only by its owner.
      assert.equal(statSync(launched.launchScriptFile!).mode & 0o777, 0o700);

      // The resume path reports its own bounded label, never the follow-up message.
      const { api } = createMockExtensionApi();
      const resume = createResumeTool(api);
      const ctx = {
        sessionManager: { getSessionId: () => "sess-launch", getSessionDir: () => sessionDir },
      } as any;
      writeFileSync(logFile, "");
      const resumed: any = await resume.execute(
        "call-1",
        { sessionPath: parentSessionFile, name: "Meta Resume", message: secretMessage },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(resumed.details.status, "started");
      const resumeLog = readFileSync(logFile, "utf8");
      assert.doesNotMatch(resumeLog, /SECRET-RESUME-BODY/, "the resume message never reaches pane metadata");
      assert.match(
        resumeLog,
        new RegExp(`task=Meta Resume/${resumed.details.id}(\\s|$)`),
        `expected a bounded name/run label in: ${resumeLog}`,
      );
    } finally {
      cleanupSubagentsForShutdown("quit", runningSubagents);
      await new Promise((resolve) => setTimeout(resolve, 250));
      stopTracking();
    }
  });
});
