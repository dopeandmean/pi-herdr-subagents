import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  allocateWorktree,
  captureHandoff,
  checkSourceClean,
  inspectLane,
  listLanes,
  manifestFileFor,
  readManifest,
  recordLaneEvidence,
  removeLane,
  resolveRepoRoot,
  type HandoffManifest,
} from "../pi-extension/subagents/worktree.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let sandbox: string;
let repo: string;
let worktreeRoot: string;
let artifactDir: string;
let previousWorktreeDir: string | undefined;

function makeRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(["init", "-q", "-b", "main"], path);
  git(["config", "user.email", "test@example.com"], path);
  git(["config", "user.name", "Test"], path);
  writeFileSync(join(path, "app.txt"), "base\n");
  writeFileSync(join(path, "old-name.txt"), "renamed\n");
  git(["add", "-A"], path);
  git(["commit", "-q", "-m", "base"], path);
}

function lane(id: string, label = "worker"): HandoffManifest {
  const allocation = allocateWorktree({ cwd: repo, label, laneId: id });
  return captureHandoff({
    allocation,
    laneId: id,
    artifactDir,
    name: label,
    terminalState: { status: "completed", exitCode: 0 },
  });
}

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "pi-worktree-test-"));
  repo = join(sandbox, "repo");
  worktreeRoot = join(sandbox, "lanes");
  artifactDir = join(sandbox, "artifacts");
  makeRepo(repo);
  previousWorktreeDir = process.env.PI_SUBAGENTS_WORKTREE_DIR;
  process.env.PI_SUBAGENTS_WORKTREE_DIR = worktreeRoot;
});

after(() => {
  if (previousWorktreeDir === undefined) delete process.env.PI_SUBAGENTS_WORKTREE_DIR;
  else process.env.PI_SUBAGENTS_WORKTREE_DIR = previousWorktreeDir;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("worktree preflight", () => {
  it("resolves the repository root and rejects non-git cwd", () => {
    assert.equal(resolveRepoRoot(repo), repo);
    assert.equal(resolveRepoRoot(tmpdir()), null);
    assert.throws(
      () => allocateWorktree({ cwd: tmpdir(), label: "worker", laneId: "nongit" }),
      /requires a Git repository/,
    );
  });

  it("refuses a dirty source checkout without touching it", () => {
    writeFileSync(join(repo, "app.txt"), "user work in progress\n");
    writeFileSync(join(repo, "untracked.txt"), "user file\n");
    const before = readFileSync(join(repo, "app.txt"), "utf8");
    const statusBefore = git(["status", "--porcelain"], repo);

    assert.equal(checkSourceClean(repo).ok, false);
    assert.throws(
      () => allocateWorktree({ cwd: repo, label: "worker", laneId: "dirty1" }),
      /refused: source checkout is not clean/,
    );
    assert.equal(readFileSync(join(repo, "app.txt"), "utf8"), before);
    assert.equal(git(["status", "--porcelain"], repo), statusBefore);

    git(["checkout", "--", "app.txt"], repo);
    rmSync(join(repo, "untracked.txt"));
    assert.equal(checkSourceClean(repo).ok, true);
  });

  it("treats cwd-local runtime metadata as noise, not user work", () => {
    const noisy = join(sandbox, "noisy");
    makeRepo(noisy);
    const laneId = "noise001";
    try {
      mkdirSync(join(noisy, ".pi-lens-probe-home"), { recursive: true });
      writeFileSync(join(noisy, ".pi-lens-probe-home", "extension.log"), "probe output\n");
      // The source gate ignores runtime noise, so isolation is still possible.
      assert.equal(checkSourceClean(noisy).ok, true);

      const allocation = allocateWorktree({ cwd: noisy, label: "worker", laneId });
      mkdirSync(join(allocation.path, ".pi-lens-probe-home"), { recursive: true });
      writeFileSync(join(allocation.path, ".pi-lens-probe-home", "bus-events.log"), "noise\n");
      writeFileSync(join(allocation.path, "real-work.txt"), "work\n");

      const manifest = captureHandoff({
        allocation,
        laneId,
        artifactDir,
        name: "worker",
        terminalState: { status: "completed", exitCode: 0 },
      });
      assert.deepEqual(manifest.changedPaths.map((change) => change.path), ["real-work.txt"]);
      assert.deepEqual(manifest.excludedRuntimePaths, [".pi-lens-probe-home/bus-events.log"]);
      assert.doesNotMatch(readFileSync(manifest.patchFile, "utf8"), /pi-lens-probe-home/);

      // Noise left behind by tooling must not block cleanup either.
      rmSync(join(allocation.path, "real-work.txt"), { force: true });
      const removed = removeLane(manifestFileFor(artifactDir, laneId));
      assert.equal(removed.removed, true, removed.reason);
    } finally {
      rmSync(noisy, { recursive: true, force: true });
      rmSync(join(dirname(worktreeRoot), "noisy"), { recursive: true, force: true });
    }
  });

  it("refuses a repository without commits", () => {
    const empty = join(sandbox, "empty");
    mkdirSync(empty, { recursive: true });
    git(["init", "-q"], empty);
    assert.throws(
      () => allocateWorktree({ cwd: empty, label: "worker", laneId: "empty1" }),
      /no commits/,
    );
  });
});

describe("parallel lanes", () => {
  it("gives each writer its own worktree and branch outside the checkout", () => {
    const first = allocateWorktree({ cwd: repo, label: "alpha", laneId: "lane0001" });
    const second = allocateWorktree({ cwd: repo, label: "beta", laneId: "lane0002" });

    assert.notEqual(first.path, second.path);
    assert.notEqual(first.branch, second.branch);
    assert.equal(first.branch, "pi-subagents/alpha-lane0001");
    assert.ok(!first.path.startsWith(repo));
    assert.equal(git(["rev-parse", "--show-toplevel"], first.path).trim(), first.path);

    writeFileSync(join(first.path, "app.txt"), "alpha edit\n");
    writeFileSync(join(first.path, "alpha-only.txt"), "alpha\n");

    assert.equal(readFileSync(join(second.path, "app.txt"), "utf8"), "base\n");
    assert.equal(existsSync(join(second.path, "alpha-only.txt")), false);
    assert.equal(readFileSync(join(repo, "app.txt"), "utf8"), "base\n");
    assert.equal(git(["status", "--porcelain"], repo), "");
  });
});

describe("handoff capture", () => {
  it("captures tracked, untracked, renamed, and binary changes without staging", () => {
    const id = "cap00001";
    const allocation = allocateWorktree({ cwd: repo, label: "worker", laneId: id });
    writeFileSync(join(allocation.path, "app.txt"), "changed\n");
    writeFileSync(join(allocation.path, "fresh.txt"), "new file\n");
    renameSync(join(allocation.path, "old-name.txt"), join(allocation.path, "renamed.txt"));
    writeFileSync(join(allocation.path, "blob.bin"), Buffer.from([0, 1, 2, 255, 0, 7]));
    const statusBefore = git(["status", "--porcelain"], allocation.path);

    const manifest = captureHandoff({
      allocation,
      laneId: id,
      artifactDir,
      name: "worker",
      terminalState: { status: "completed", exitCode: 0 },
    });

    assert.equal(manifest.capture.ok, true);
    assert.equal(manifest.baseCommit, git(["rev-parse", "HEAD"], repo).trim());
    assert.equal(manifest.headCommit, manifest.baseCommit);
    assert.deepEqual(
      manifest.changedPaths.map((change) => `${change.status} ${change.path}`).sort(),
      ["A blob.bin", "A fresh.txt", "M app.txt", "R100 old-name.txt -> renamed.txt"],
    );

    const patch = readFileSync(manifest.patchFile, "utf8");
    assert.match(patch, /^\+\+\+ b\/app\.txt$/m);
    assert.match(patch, /^diff --git a\/old-name\.txt b\/renamed\.txt$/m);
    assert.match(patch, /^GIT binary patch$/m);
    assert.ok(manifest.patchBytes > 0);

    // Capture must not touch the lane's real index or the source checkout.
    assert.equal(git(["status", "--porcelain"], allocation.path), statusBefore);
    assert.equal(git(["diff", "--cached", "--name-only"], allocation.path).trim(), "");
    assert.equal(git(["status", "--porcelain"], repo), "");
  });

  it("counts child commits and diffs them against the base", () => {
    const id = "cap00002";
    const allocation = allocateWorktree({ cwd: repo, label: "worker", laneId: id });
    writeFileSync(join(allocation.path, "committed.txt"), "committed\n");
    git(["add", "-A"], allocation.path);
    git(["commit", "-q", "-m", "child work"], allocation.path);

    const manifest = captureHandoff({
      allocation,
      laneId: id,
      artifactDir,
      name: "worker",
      terminalState: { status: "completed", exitCode: 0 },
    });
    assert.equal(manifest.capture.ok, true);
    assert.equal(manifest.childCommits, 1);
    assert.deepEqual(manifest.changedPaths.map((change) => change.path), ["committed.txt"]);
    assert.match(readFileSync(manifest.patchFile, "utf8"), /^\+committed$/m);
  });

  it("records a failed capture instead of throwing", () => {
    const id = "cap00003";
    const allocation = allocateWorktree({ cwd: repo, label: "worker", laneId: id });
    const manifest = captureHandoff({
      allocation: { ...allocation, path: join(sandbox, "missing-worktree") },
      laneId: id,
      artifactDir,
      name: "worker",
      terminalState: { status: "failed", exitCode: 1 },
    });

    assert.equal(manifest.capture.ok, false);
    assert.equal(manifest.cleanup.status, "preserved");
    const inspection = inspectLane(manifest, manifestFileFor(artifactDir, id));
    assert.equal(inspection.removable, false);
    assert.match(inspection.blockers.join(" "), /capture failed/);
  });
});

describe("cleanup and evidence", () => {
  let id = "clean000";
  beforeEach(() => {
    id = `clean${Math.random().toString(16).slice(2, 8)}`;
  });

  it("removes a clean, captured lane and its branch", () => {
    const manifest = lane(id);
    const manifestFile = manifestFileFor(artifactDir, id);
    assert.equal(manifest.changedPaths.length, 0);

    const result = removeLane(manifestFile, { by: "test" });
    assert.equal(result.removed, true, result.reason);
    assert.equal(existsSync(manifest.worktree), false);
    assert.equal(
      execFileSync("git", ["branch", "--list", manifest.branch], { cwd: repo, encoding: "utf8" }).trim(),
      "",
    );
    assert.equal(readManifest(manifestFile)?.cleanup.status, "removed");
  });

  it("preserves a dirty lane", () => {
    const manifest = lane(id);
    const manifestFile = manifestFileFor(artifactDir, id);
    writeFileSync(join(manifest.worktree, "manual.txt"), "left behind\n");

    const result = removeLane(manifestFile, { by: "test" });
    assert.equal(result.removed, false);
    assert.match(result.reason ?? "", /dirty/);
    assert.equal(existsSync(manifest.worktree), true);
    assert.equal(readManifest(manifestFile)?.cleanup.status, "pending");
  });

  it("preserves a lane whose head moved after capture", () => {
    const manifest = lane(id);
    writeFileSync(join(manifest.worktree, "later.txt"), "after capture\n");
    git(["add", "-A"], manifest.worktree);
    git(["commit", "-q", "-m", "after capture"], manifest.worktree);

    const inspection = inspectLane(manifest, manifestFileFor(artifactDir, id));
    assert.equal(inspection.removable, false);
    assert.match(inspection.blockers.join(" "), /head moved since capture/);
  });

  it("preserves a lane with a malformed manifest and reports it in status", () => {
    const manifest = lane(id);
    const manifestFile = manifestFileFor(artifactDir, id);
    writeFileSync(manifestFile, "{ not json");

    const result = removeLane(manifestFile);
    assert.equal(result.removed, false);
    assert.match(result.reason ?? "", /malformed/);
    assert.equal(existsSync(manifest.worktree), true);
    assert.equal(listLanes(artifactDir).some((entry) => entry.manifest.laneId === id), false);
  });

  it("ties review and merge evidence to the captured head", () => {
    const manifest = lane(id);
    const manifestFile = manifestFileFor(artifactDir, id);

    const blocked = recordLaneEvidence(manifestFile, {
      review: { verdict: "BLOCK", reviewer: "reviewer", notes: "unsafe retry loop" },
    });
    assert.equal(blocked.ok, true);
    const reviewed = readManifest(manifestFile) as HandoffManifest;
    assert.equal(reviewed.review?.verdict, "BLOCK");
    assert.equal(reviewed.review?.headCommit, manifest.headCommit);

    const bogus = recordLaneEvidence(manifestFile, {
      merge: { commit: "cafe1234", attestor: "parent" },
    });
    assert.equal(bogus.ok, false);
    assert.match(bogus.error ?? "", /does not resolve/);

    git(["commit", "-q", "--allow-empty", "-m", "merge lane"], repo);
    const mergeCommit = git(["rev-parse", "HEAD"], repo).trim();
    const merged = recordLaneEvidence(manifestFile, {
      merge: { commit: mergeCommit, attestor: "parent", postMergeChecks: "npm test" },
    });
    assert.equal(merged.ok, true);

    const final = readManifest(manifestFile) as HandoffManifest;
    assert.equal(final.merge?.commit, mergeCommit);
    assert.equal(final.merge?.reviewedHead, final.review?.headCommit);
    assert.equal(final.merge?.reviewedHead, final.headCommit);
  });

  it("refuses evidence for a lane whose capture failed", () => {
    const failedId = `${id}f`;
    const failed = captureHandoff({
      allocation: {
        repoRoot: repo,
        branch: "pi-subagents/worker-gone",
        path: join(sandbox, "gone"),
        baseRef: "HEAD",
        baseCommit: git(["rev-parse", "HEAD"], repo).trim(),
      },
      laneId: failedId,
      artifactDir,
      name: "worker",
      terminalState: { status: "failed", exitCode: 1 },
    });
    assert.equal(failed.capture.ok, false);
    const result = recordLaneEvidence(manifestFileFor(artifactDir, failedId), {
      review: { verdict: "OK", reviewer: "reviewer" },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /capture failed/);
  });
});
