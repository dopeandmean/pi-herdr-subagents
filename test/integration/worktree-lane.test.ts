/**
 * Integration tests for isolated worktree lanes (`worktree: true`).
 *
 * These spawn real pi sessions with real LLM calls and verify the Git side
 * effects of an isolated spawn: the child works in its own checkout, the source
 * checkout stays untouched, and a patch + manifest handoff is captured.
 *
 * Run from inside herdr: `PI_TEST_MODEL="deepseek/deepseek-v4-flash" npm run test:integration`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
  waitForScreen,
  waitForFile,
  sleep,
  uniqueId,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";

const herdrAvailable = getAvailableBackends().length > 0;

if (!herdrAvailable) {
  console.log("⚠️  herdr is unavailable — skipping worktree lane integration tests");
  console.log("   Run inside herdr to enable these tests.");
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function laneWorktrees(repo: string): string[] {
  return git(["worktree", "list", "--porcelain"], repo)
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((path) => path !== repo);
}

/** Newest captured manifest under the agent session artifacts, if any. */
function agentRoot(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function findManifest(laneBranch: string): { path: string; manifest: any } | null {
  const sessionsRoot = join(agentRoot(), "sessions");
  if (!existsSync(sessionsRoot)) return null;
  let newest: { path: string; manifest: any } | null = null;
  for (const sessionDir of readdirSync(sessionsRoot)) {
    const artifacts = join(sessionsRoot, sessionDir, "artifacts");
    if (!existsSync(artifacts)) continue;
    for (const sessionId of readdirSync(artifacts)) {
      const lanes = join(artifacts, sessionId, "subagent-worktrees");
      if (!existsSync(lanes)) continue;
      for (const laneId of readdirSync(lanes)) {
        const manifestFile = join(lanes, laneId, "manifest.json");
        if (!existsSync(manifestFile)) continue;
        try {
          const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
          if (manifest.branch === laneBranch) newest = { path: manifestFile, manifest };
        } catch {}
      }
    }
  }
  return newest;
}

/** True once the parent session recorded the lane evidence it was steered with. */
function parentRecordedLane(cwd: string): boolean {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentRoot(), "sessions", safePath);
  if (!existsSync(sessionDir)) return false;
  return readdirSync(sessionDir)
    .filter((file) => file.endsWith(".jsonl"))
    .some((file) => readFileSync(join(sessionDir, file), "utf8").includes("worktreeLane"));
}

async function waitForLaneEvidence(
  branch: string,
  cwd: string,
  timeout: number,
): Promise<{ path: string; manifest: any }> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const captured = findManifest(branch);
    if (captured && parentRecordedLane(cwd)) return captured;
    await sleep(2000);
  }
  throw new Error(`Timeout (${timeout}ms) waiting for lane evidence for ${branch}`);
}

if (herdrAvailable) {
  describe(`worktree-lane`, { timeout: PI_TIMEOUT * 3 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
      git(["init", "-q", "-b", "main"], env.dir);
      git(["config", "user.email", "test@example.com"], env.dir);
      git(["config", "user.name", "Test"], env.dir);
      writeFileSync(join(env.dir, "app.txt"), "base\n");
      writeFileSync(join(env.dir, ".gitignore"), "test-launch-*.sh\n");
      git(["add", "-A"], env.dir);
      git(["commit", "-q", "-m", "base"], env.dir);
    });

    after(() => {
      for (const worktree of laneWorktrees(env.dir)) {
        try {
          rmSync(worktree, { recursive: true, force: true });
        } catch {
          // Already removed by the lane cleanup under test.
        }
      }
      try {
        git(["worktree", "prune"], env.dir);
        rmSync(join(dirname(env.dir), "worktrees", basename(env.dir)), { recursive: true, force: true });
      } catch {
        // Worktree bookkeeping cleanup is best effort.
      }
      cleanupTestEnv(env);
    });

    it("runs the child in its own worktree and captures the handoff", async () => {
      const id = uniqueId();
      const surface = createTrackedSurface(env, `lane-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Lane-${id}"`,
        `  agent: "test-echo"`,
        `  worktree: true`,
        `  task: "Run exactly this bash command: echo 'PASS_${id}' > lane-marker.txt && pwd > lane-cwd.txt, then stop."`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say INTEGRATION_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      let lane = "";
      const deadline = Date.now() + PI_TIMEOUT;
      while (Date.now() < deadline && !lane) {
        lane = laneWorktrees(env.dir)[0] ?? "";
        if (!lane) await sleep(3000);
      }
      assert.ok(lane, "Expected an isolated worktree for the subagent");
      assert.notEqual(lane, env.dir);

      const marker = await waitForFile(join(lane, "lane-marker.txt"), PI_TIMEOUT, /PASS_/);
      assert.ok(marker.includes(`PASS_${id}`), `Lane marker should contain PASS_${id}: ${marker}`);
      assert.equal(
        readFileSync(join(lane, "lane-cwd.txt"), "utf8").trim(),
        lane,
        "The child's cwd must be the worktree",
      );

      // The source checkout is untouched by the isolated child.
      assert.equal(existsSync(join(env.dir, "lane-marker.txt")), false);
      assert.equal(
        git(["status", "--porcelain"], env.dir)
          .split("\n")
          .filter((line) => line.trim() && !line.includes("pi-lens-probe-home"))
          .join("\n")
          .trim(),
        "",
        "isolated child must not dirty the source checkout",
      );

      // The parent is woken with the lane evidence once the handoff is captured.
      await waitForScreen(surface, /INTEGRATION_COMPLETE/i, PI_TIMEOUT);

      const branch = git(["symbolic-ref", "--short", "HEAD"], lane).trim();
      assert.match(branch, /^pi-subagents\//);
      const captured = await waitForLaneEvidence(branch, env.dir, PI_TIMEOUT);
      const manifest = captured.manifest;
      assert.equal(manifest.capture.ok, true);
      assert.equal(manifest.worktree, lane);
      assert.equal(manifest.headCommit, git(["rev-parse", "HEAD"], lane).trim());
      assert.deepEqual(
        manifest.changedPaths.map((change: any) => change.path).sort(),
        ["lane-cwd.txt", "lane-marker.txt"],
      );
      const patch = readFileSync(manifest.patchFile, "utf8");
      assert.match(patch, /^\+\+\+ b\/lane-marker\.txt$/m);
      assert.doesNotMatch(patch, /pi-lens-probe-home/, "runtime metadata must not reach the patch");
    });

    it("rejects an isolated spawn when the source checkout is dirty", async () => {
      const id = uniqueId();
      const lanesBefore = laneWorktrees(env.dir).length;
      const wip = join(env.dir, "user-wip.txt");
      writeFileSync(wip, "work in progress\n");
      const surface = createTrackedSurface(env, `dirty-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Dirty-${id}"`,
        `  agent: "test-echo"`,
        `  worktree: true`,
        `  task: "echo SHOULD_NOT_RUN"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After the tool returns, say DIRTY_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      await waitForScreen(surface, /Worktree isolation refused/i, PI_TIMEOUT);
      assert.equal(
        laneWorktrees(env.dir).length,
        lanesBefore,
        "No worktree may be created for a dirty source",
      );
      assert.equal(readFileSync(wip, "utf8"), "work in progress\n");
      assert.equal(git(["status", "--porcelain"], env.dir).includes("user-wip.txt"), true);
      rmSync(wip, { force: true });
    });
  });
}
