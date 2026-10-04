import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getDefaultSessionDirFor } from "../pi-extension/subagents/discovery.ts";
import { cleanupSubagentsForShutdown, getArtifactDir, launchSubagent, runningSubagents, stopTracking, watchSubagentRun } from "../pi-extension/subagents/run.ts";
import { registerHarnessDriver } from "../pi-extension/subagents/harness/index.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { createTool as createResumeTool } from "../pi-extension/subagents/tools/resume.ts";
import { listLanes } from "../pi-extension/subagents/worktree.ts";
import { createMockExtensionApi, createSessionFile, SESSION_HEADER, USER_MSG } from "./helpers.ts";

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
  "pane read") printf '%s\\n' '__SUBAGENT_DONE_0__' ;;
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
