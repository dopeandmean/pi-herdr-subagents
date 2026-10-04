import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  allocateWorktree,
  captureHandoff,
  inspectLane,
  lanesContaining,
  listLanes,
  recordLaneEvidence,
  removeLane,
  validateLaneResume,
  type LaneEntry,
  type LaneReference,
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

function lane(id: string, label = "worker"): LaneEntry {
  const allocation = allocateWorktree({ cwd: repo, label, laneId: id });
  return captureHandoff({
    allocation,
    laneId: id,
    artifactDir,
    name: label,
    terminalState: { status: "completed", exitCode: 0 },
  });
}

function changedLane(id: string): LaneEntry {
  const allocation = allocateWorktree({ cwd: repo, label: "worker", laneId: id });
  writeFileSync(join(allocation.path, "app.txt"), `lane change ${id}\n`);
  git(["add", "-A"], allocation.path);
  git(["commit", "-q", "-m", "lane change"], allocation.path);
  return captureHandoff({
    allocation,
    laneId: id,
    artifactDir,
    name: "worker",
    terminalState: { status: "completed", exitCode: 0 },
  });
}

function laneEntry(id: string): LaneEntry {
  const entry = listLanes(artifactDir, id)[0];
  assert.ok(entry, `expected lane ${id} to be recorded`);
  return entry;
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
  it("refuses a cwd that is not a Git repository", () => {
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

    assert.throws(
      () => allocateWorktree({ cwd: repo, label: "worker", laneId: "dirty1" }),
      /refused: source checkout is not clean/,
    );
    assert.equal(readFileSync(join(repo, "app.txt"), "utf8"), before);
    assert.equal(git(["status", "--porcelain"], repo), statusBefore);

    // Once the user's work is dealt with, isolation is possible again.
    git(["checkout", "--", "app.txt"], repo);
    rmSync(join(repo, "untracked.txt"));
    assert.equal(allocateWorktree({ cwd: repo, label: "worker", laneId: "clean001" }).branch, "pi-subagents/worker-clean001");
  });

  it("treats cwd-local runtime metadata as noise, not user work", () => {
    const noisy = join(sandbox, "noisy");
    makeRepo(noisy);
    const laneId = "noise001";
    try {
      mkdirSync(join(noisy, ".pi-lens-probe-home"), { recursive: true });
      writeFileSync(join(noisy, ".pi-lens-probe-home", "extension.log"), "probe output\n");
      // The source gate ignores runtime noise, so isolation is still possible.
      const allocation = allocateWorktree({ cwd: noisy, label: "worker", laneId });
      mkdirSync(join(allocation.path, ".pi-lens-probe-home"), { recursive: true });
      writeFileSync(join(allocation.path, ".pi-lens-probe-home", "bus-events.log"), "noise\n");

      const entry = captureHandoff({
        allocation,
        laneId,
        artifactDir,
        name: "worker",
        terminalState: { status: "completed", exitCode: 0 },
      });
      assert.deepEqual(entry.manifest.changedPaths, []);
      assert.deepEqual(entry.manifest.excludedRuntimePaths, [".pi-lens-probe-home/bus-events.log"]);
      assert.doesNotMatch(readFileSync(entry.manifest.patchFile, "utf8"), /pi-lens-probe-home/);

      // Noise left behind by tooling must not block cleanup either.
      const removed = removeLane(entry);
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

    const { manifest } = captureHandoff({
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

    const { manifest } = captureHandoff({
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
    const entry = captureHandoff({
      allocation: { ...allocation, path: join(sandbox, "missing-worktree") },
      laneId: id,
      artifactDir,
      name: "worker",
      terminalState: { status: "failed", exitCode: 1 },
    });

    assert.equal(entry.manifest.capture.ok, false);
    assert.equal(entry.manifest.cleanup.status, "preserved");
    const inspection = inspectLane(entry);
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
    const entry = lane(id);
    assert.equal(entry.manifest.changedPaths.length, 0);

    const result = removeLane(entry, { by: "test" });
    assert.equal(result.removed, true, result.reason);
    assert.equal(existsSync(entry.manifest.worktree), false);
    assert.equal(
      execFileSync("git", ["branch", "--list", entry.manifest.branch], { cwd: repo, encoding: "utf8" }).trim(),
      "",
    );
    assert.equal(laneEntry(id).manifest.cleanup.status, "removed");
  });

  it("preserves a dirty lane", () => {
    const entry = lane(id);
    writeFileSync(join(entry.manifest.worktree, "manual.txt"), "left behind\n");

    const result = removeLane(entry, { by: "test" });
    assert.equal(result.removed, false);
    assert.match(result.reason ?? "", /dirty/);
    assert.equal(existsSync(entry.manifest.worktree), true);
    assert.equal(laneEntry(id).manifest.cleanup.status, "pending");
  });

  it("preserves a lane whose head moved after capture", () => {
    const entry = lane(id);
    writeFileSync(join(entry.manifest.worktree, "later.txt"), "after capture\n");
    git(["add", "-A"], entry.manifest.worktree);
    git(["commit", "-q", "-m", "after capture"], entry.manifest.worktree);

    const inspection = inspectLane(laneEntry(id));
    assert.equal(inspection.removable, false);
    assert.match(inspection.blockers.join(" "), /head moved since capture/);
  });

  it("preserves a lane with a malformed manifest and reports it in status", () => {
    const entry = lane(id);
    writeFileSync(entry.manifestFile, "{ not json");

    const result = removeLane(entry);
    assert.equal(result.removed, false);
    assert.match(result.reason ?? "", /malformed/);
    assert.equal(existsSync(entry.manifest.worktree), true);
    assert.equal(listLanes(artifactDir).some((lane) => lane.manifest.laneId === id), false);
  });

  it("preserves a clean changed lane without review or integration evidence", () => {
    const entry = changedLane(id);

    const inspection = inspectLane(entry);
    assert.equal(inspection.removable, false);
    assert.match(inspection.blockers.join(" "), /review/);

    const result = removeLane(entry);
    assert.equal(result.removed, false);
    assert.match(result.reason ?? "", /review/);
    assert.equal(existsSync(entry.manifest.worktree), true);
    assert.equal(
      git(["show-ref", "--verify", `refs/heads/${entry.manifest.branch}`], repo).includes(
        entry.manifest.branch,
      ),
      true,
    );
  });

  it("rejects BLOCK and unrelated commits as changed-lane cleanup evidence", () => {
    const entry = changedLane(id);

    const blocked = recordLaneEvidence(entry, {
      review: { verdict: "BLOCK", reviewer: "reviewer", notes: "unsafe retry loop" },
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error ?? "", /BLOCK/);
    assert.equal(laneEntry(id).manifest.review, undefined);

    const reviewed = recordLaneEvidence(entry, {
      review: { verdict: "OK", reviewer: "reviewer" },
    });
    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.manifest?.review?.headCommit, entry.manifest.headCommit);

    git(["commit", "-q", "--allow-empty", "-m", "unrelated commit"], repo);
    const unrelatedCommit = git(["rev-parse", "HEAD"], repo).trim();
    const unrelated = recordLaneEvidence(entry, {
      merge: { commit: unrelatedCommit, attestor: "parent" },
    });
    assert.equal(unrelated.ok, false);
    assert.match(unrelated.error ?? "", /lane commits/);
    assert.equal(inspectLane(laneEntry(id)).removable, false);
  });

  it("rejects stale reviews after the captured lane head moves", () => {
    const entry = changedLane(id);
    assert.equal(
      recordLaneEvidence(entry, {
        review: { verdict: "OK", reviewer: "reviewer" },
      }).ok,
      true,
    );

    writeFileSync(join(entry.manifest.worktree, "later.txt"), "later lane work\n");
    git(["add", "-A"], entry.manifest.worktree);
    git(["commit", "-q", "-m", "later lane work"], entry.manifest.worktree);
    git(["merge", "--no-ff", "-q", entry.manifest.branch, "-m", "integrate lane"], repo);
    const integrationCommit = git(["rev-parse", "HEAD"], repo).trim();

    const stale = recordLaneEvidence(laneEntry(id), {
      merge: { commit: integrationCommit, attestor: "parent" },
    });
    assert.equal(stale.ok, false);
    assert.match(stale.error ?? "", /head moved/);
    assert.equal(inspectLane(laneEntry(id)).removable, false);
  });

  it("preserves patch-only changes without verifiable commit lineage", () => {
    const allocation = allocateWorktree({ cwd: repo, label: "worker", laneId: id });
    writeFileSync(join(allocation.path, "app.txt"), "patch-only change\n");
    const entry = captureHandoff({
      allocation,
      laneId: id,
      artifactDir,
      name: "worker",
      terminalState: { status: "completed", exitCode: 0 },
    });
    assert.equal(entry.manifest.childCommits, 0);
    assert.ok(entry.manifest.changedPaths.length > 0);

    git(["checkout", "--", "."], allocation.path);
    assert.equal(
      recordLaneEvidence(entry, {
        review: { verdict: "OK with notes", reviewer: "reviewer" },
      }).ok,
      true,
    );
    git(["commit", "-q", "--allow-empty", "-m", "unrelated patch commit"], repo);
    const unrelatedCommit = git(["rev-parse", "HEAD"], repo).trim();

    const integration = recordLaneEvidence(entry, {
      merge: { commit: unrelatedCommit, attestor: "parent" },
    });
    assert.equal(integration.ok, false);
    assert.match(integration.error ?? "", /child commits/);
    const inspection = inspectLane(laneEntry(id));
    assert.equal(inspection.removable, false);
    assert.ok(existsSync(entry.manifest.patchFile));
  });

  it("does not let an altered empty manifest clear a patch-only lane", () => {
    const allocation = allocateWorktree({ cwd: repo, label: "worker", laneId: id });
    writeFileSync(join(allocation.path, "app.txt"), `patch-only ${id}\n`);
    const entry = captureHandoff({
      allocation,
      laneId: id,
      artifactDir,
      name: "worker",
      terminalState: { status: "completed", exitCode: 0 },
    });
    assert.ok(entry.manifest.patchBytes > 0);
    git(["checkout", "--", "app.txt"], allocation.path);
    const persisted = JSON.parse(readFileSync(entry.manifestFile, "utf8"));
    persisted.childCommits = 0;
    persisted.changedPaths = [];
    writeFileSync(entry.manifestFile, `${JSON.stringify(persisted, null, 2)}\n`);

    const inspection = inspectLane(laneEntry(id));
    assert.equal(inspection.removable, false);
    assert.match(inspection.blockers.join(" "), /review evidence missing for changed lane/);

    const removed = removeLane(laneEntry(id));
    assert.equal(removed.removed, false);
    assert.equal(existsSync(entry.manifest.worktree), true);
    assert.equal(existsSync(entry.manifest.patchFile), true);
  });

  it("preserves captured changes not represented by the lane commit history", () => {
    const allocation = allocateWorktree({ cwd: repo, label: "worker", laneId: id });
    writeFileSync(join(allocation.path, "app.txt"), `committed ${id}\n`);
    git(["add", "-A"], allocation.path);
    git(["commit", "-q", "-m", "lane commit"], allocation.path);
    writeFileSync(join(allocation.path, "app.txt"), `captured but uncommitted ${id}\n`);
    const entry = captureHandoff({
      allocation,
      laneId: id,
      artifactDir,
      name: "worker",
      terminalState: { status: "completed", exitCode: 0 },
    });
    git(["checkout", "--", "app.txt"], allocation.path);
    assert.equal(
      recordLaneEvidence(entry, {
        review: { verdict: "OK", reviewer: "reviewer" },
      }).ok,
      true,
    );

    git(["merge", "--no-ff", "-q", entry.manifest.branch, "-m", "integrate lane"], repo);
    const mergeCommit = git(["rev-parse", "HEAD"], repo).trim();
    const merged = recordLaneEvidence(entry, {
      merge: { commit: mergeCommit, attestor: "parent" },
    });
    assert.equal(merged.ok, false);
    assert.match(merged.error ?? "", /captured patch/);
    assert.equal(inspectLane(laneEntry(id)).removable, false);
    assert.equal(existsSync(entry.manifest.patchFile), true);
    assert.equal(existsSync(entry.manifest.worktree), true);
  });

  it("preserves ignored data in a changed lane even after integration", () => {
    const entry = changedLane(id);
    assert.equal(
      recordLaneEvidence(entry, {
        review: { verdict: "OK", reviewer: "reviewer" },
      }).ok,
      true,
    );

    git(["merge", "--no-ff", "-q", entry.manifest.branch, "-m", "integrate lane"], repo);
    const mergeCommit = git(["rev-parse", "HEAD"], repo).trim();
    assert.equal(
      recordLaneEvidence(entry, {
        merge: { commit: mergeCommit, attestor: "parent" },
      }).ok,
      true,
    );

    writeFileSync(join(repo, ".git", "info", "exclude"), "retained-ignored.txt\n");
    writeFileSync(join(entry.manifest.worktree, "retained-ignored.txt"), "untracked data\n");
    const inspection = inspectLane(laneEntry(id));
    assert.equal(inspection.removable, false);
    assert.match(inspection.blockers.join(" "), /ignored files/);

    const removed = removeLane(laneEntry(id));
    assert.equal(removed.removed, false);
    assert.equal(existsSync(entry.manifest.worktree), true);
    assert.equal(existsSync(join(entry.manifest.worktree, "retained-ignored.txt")), true);
  });

  it("preserves a lane captured as empty whose worktree holds only ignored files", () => {
    const allocation = allocateWorktree({ cwd: repo, label: "worker", laneId: id });
    writeFileSync(join(repo, ".git", "info", "exclude"), `${id}-ignored.txt\n`);
    writeFileSync(join(allocation.path, `${id}-ignored.txt`), "ignored build output\n");
    const entry = captureHandoff({
      allocation,
      laneId: id,
      artifactDir,
      name: "worker",
      terminalState: { status: "completed", exitCode: 0 },
    });
    assert.deepEqual(entry.manifest.changedPaths, []);
    assert.equal(entry.manifest.childCommits, 0);

    const inspection = inspectLane(laneEntry(id));
    assert.equal(inspection.removable, false);
    assert.match(inspection.blockers.join(" "), /ignored files/);

    const removed = removeLane(laneEntry(id));
    assert.equal(removed.removed, false);
    assert.equal(existsSync(entry.manifest.worktree), true);
    assert.equal(existsSync(join(entry.manifest.worktree, `${id}-ignored.txt`)), true);
    assert.equal(
      git(["show-ref", "--verify", `refs/heads/${entry.manifest.branch}`], repo).includes(
        entry.manifest.branch,
      ),
      true,
    );
  });

  it("blocks an altered empty manifest while fresh lineage shows lane commits", () => {
    const entry = changedLane(id);
    const persisted = JSON.parse(readFileSync(entry.manifestFile, "utf8"));
    persisted.childCommits = 0;
    persisted.changedPaths = [];
    writeFileSync(entry.manifestFile, `${JSON.stringify(persisted, null, 2)}\n`);

    const inspection = inspectLane(laneEntry(id));
    assert.equal(inspection.removable, false);
    assert.match(inspection.blockers.join(" "), /child commit count does not match its lineage/);

    const removed = removeLane(laneEntry(id));
    assert.equal(removed.removed, false);
    assert.equal(existsSync(entry.manifest.worktree), true);
    assert.equal(
      git(["show-ref", "--verify", `refs/heads/${entry.manifest.branch}`], repo).includes(
        entry.manifest.branch,
      ),
      true,
    );
  });

  it("preserves a changed lane whose persisted review verdict is BLOCK", () => {
    const entry = changedLane(id);
    const persisted = JSON.parse(readFileSync(entry.manifestFile, "utf8"));
    persisted.review = {
      verdict: "BLOCK",
      reviewer: "reviewer",
      headCommit: entry.manifest.headCommit,
      at: new Date().toISOString(),
    };
    writeFileSync(entry.manifestFile, `${JSON.stringify(persisted, null, 2)}\n`);

    const inspection = inspectLane(laneEntry(id));
    assert.equal(inspection.removable, false);
    assert.match(inspection.blockers.join(" "), /review verdict BLOCK does not authorize cleanup/);

    const removed = removeLane(laneEntry(id));
    assert.equal(removed.removed, false);
    assert.equal(existsSync(entry.manifest.worktree), true);
    assert.equal(
      git(["show-ref", "--verify", `refs/heads/${entry.manifest.branch}`], repo).includes(
        entry.manifest.branch,
      ),
      true,
    );
  });

  it("removes a reviewed lane only after its child commits are integrated", () => {
    const entry = changedLane(id);
    const review = recordLaneEvidence(entry, {
      review: { verdict: "OK with notes", reviewer: "reviewer" },
    });
    assert.equal(review.ok, true);

    git(["merge", "--no-ff", "-q", entry.manifest.branch, "-m", "integrate lane"], repo);
    const mergeCommit = git(["rev-parse", "HEAD"], repo).trim();
    const merged = recordLaneEvidence(entry, {
      merge: { commit: mergeCommit, attestor: "parent", postMergeChecks: "npm test" },
    });
    assert.equal(merged.ok, true);
    assert.equal(merged.manifest?.merge?.commit, mergeCommit);
    assert.equal(merged.manifest?.merge?.reviewedHead, entry.manifest.headCommit);
    assert.equal(inspectLane(laneEntry(id)).removable, true);

    const removed = removeLane(laneEntry(id), { by: "test" });
    assert.equal(removed.removed, true, removed.reason);
    assert.equal(existsSync(entry.manifest.worktree), false);
    assert.equal(git(["branch", "--list", entry.manifest.branch], repo).trim(), "");
  });

  it("preserves a re-captured lane's identity and its recorded evidence", () => {
    const entry = changedLane(id);
    const original = laneEntry(id).manifest;
    assert.equal(
      recordLaneEvidence(entry, { review: { verdict: "OK", reviewer: "reviewer" } }).ok,
      true,
    );
    git(["merge", "--no-ff", "-q", entry.manifest.branch, "-m", "integrate lane"], repo);
    const mergeCommit = git(["rev-parse", "HEAD"], repo).trim();
    assert.equal(
      recordLaneEvidence(entry, { merge: { commit: mergeCommit, attestor: "parent" } }).ok,
      true,
    );
    const reviewed = laneEntry(id).manifest;
    assert.equal(inspectLane(laneEntry(id)).removable, true);

    // A resumed run re-captures the lane under its own display name.
    const recaptured = captureHandoff({
      allocation: {
        repoRoot: reviewed.repoRoot,
        branch: reviewed.branch,
        path: reviewed.worktree,
        baseRef: reviewed.baseRef,
        baseCommit: reviewed.baseCommit,
      },
      laneId: id,
      artifactDir,
      name: "Resume",
      terminalState: { status: "completed", exitCode: 0 },
    });

    assert.equal(recaptured.manifest.capture.ok, true);
    assert.equal(recaptured.manifest.createdAt, original.createdAt);
    assert.equal(recaptured.manifest.name, original.name);
    assert.deepEqual(recaptured.manifest.review, reviewed.review);
    assert.deepEqual(recaptured.manifest.merge, reviewed.merge);
    // The head did not move, so the preserved evidence still authorizes cleanup.
    assert.equal(inspectLane(recaptured).removable, true);
  });

  it("keeps historical evidence after the head moves and refuses cleanup as stale", () => {
    const entry = changedLane(id);
    assert.equal(
      recordLaneEvidence(entry, { review: { verdict: "OK", reviewer: "reviewer" } }).ok,
      true,
    );
    git(["merge", "--no-ff", "-q", entry.manifest.branch, "-m", "integrate lane"], repo);
    const mergeCommit = git(["rev-parse", "HEAD"], repo).trim();
    assert.equal(
      recordLaneEvidence(entry, { merge: { commit: mergeCommit, attestor: "parent" } }).ok,
      true,
    );
    const reviewed = laneEntry(id).manifest;
    assert.equal(inspectLane(laneEntry(id)).removable, true);

    // Follow-up work lands after the reviewed head.
    writeFileSync(join(reviewed.worktree, "follow-up.txt"), "after review\n");
    git(["add", "-A"], reviewed.worktree);
    git(["commit", "-q", "-m", "follow-up work"], reviewed.worktree);

    const recaptured = captureHandoff({
      allocation: {
        repoRoot: reviewed.repoRoot,
        branch: reviewed.branch,
        path: reviewed.worktree,
        baseRef: reviewed.baseRef,
        baseCommit: reviewed.baseCommit,
      },
      laneId: id,
      artifactDir,
      name: "Resume",
      terminalState: { status: "completed", exitCode: 0 },
    });

    // The old evidence survives, still bound to the head it named.
    assert.deepEqual(recaptured.manifest.review, reviewed.review);
    assert.deepEqual(recaptured.manifest.merge, reviewed.merge);
    assert.notEqual(recaptured.manifest.headCommit, reviewed.headCommit);

    const inspection = inspectLane(recaptured);
    assert.equal(inspection.removable, false);
    assert.match(inspection.blockers.join(" "), /review is stale for the captured head/);
    assert.match(inspection.blockers.join(" "), /integration evidence does not match the reviewed head/);
    const removed = removeLane(recaptured);
    assert.equal(removed.removed, false);
    assert.equal(existsSync(reviewed.worktree), true);
    assert.ok(existsSync(reviewed.patchFile));
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
    assert.equal(failed.manifest.capture.ok, false);
    const result = recordLaneEvidence(laneEntry(failedId), {
      review: { verdict: "OK", reviewer: "reviewer" },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /capture failed/);
  });
});

describe("lane resume validation", () => {
  const completed = { status: "completed" as const, exitCode: 0 };

  function laneWithSession(id: string, sessionFile: string): { entry: LaneEntry; reference: LaneReference } {
    const allocation = allocateWorktree({ cwd: repo, label: "worker", laneId: id });
    const entry = captureHandoff({
      allocation,
      laneId: id,
      artifactDir,
      name: "worker",
      sessionFile,
      terminalState: completed,
    });
    return {
      entry,
      reference: {
        laneId: id,
        artifactDir,
        sessionFile,
        allocation: {
          repoRoot: entry.manifest.repoRoot,
          branch: entry.manifest.branch,
          path: entry.manifest.worktree,
          baseRef: entry.manifest.baseRef,
          baseCommit: entry.manifest.baseCommit,
        },
      },
    };
  }

  it("accepts a reference whose evidence and Git state still match", () => {
    const sessionFile = join(sandbox, "resume-ok.jsonl");
    const { reference, entry } = laneWithSession("resume001", sessionFile);

    const result = validateLaneResume({ reference, sessionPath: sessionFile, cwd: entry.manifest.worktree });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.allocation.branch, entry.manifest.branch);

    // A child started in a repository subdirectory is still inside its lane.
    assert.equal(
      validateLaneResume({ reference, sessionPath: sessionFile, cwd: join(entry.manifest.worktree, "packages", "app") }).ok,
      true,
    );
  });

  it("rejects missing, removed, foreign, duplicate, legacy and mismatched associations", () => {
    const sessionFile = join(sandbox, "resume-checks.jsonl");
    const otherSession = join(sandbox, "resume-other.jsonl");
    const { reference, entry } = laneWithSession("resume002", sessionFile);
    const manifestFile = entry.manifestFile;
    const worktree = entry.manifest.worktree;

    const rejected = (options: {
      reference?: LaneReference;
      sessionPath?: string;
      cwd?: string | null;
    }): string => {
      const result = validateLaneResume({
        reference,
        sessionPath: sessionFile,
        cwd: worktree,
        ...options,
      });
      assert.equal(result.ok, false, `expected a rejection for ${JSON.stringify(options)}`);
      return result.ok ? "" : result.error;
    };

    const original = readFileSync(manifestFile, "utf8");
    const editManifest = (update: (manifest: any) => void) => {
      const manifest = JSON.parse(original);
      update(manifest);
      writeFileSync(manifestFile, JSON.stringify(manifest));
    };

    // Foreign: the reference names another session.
    assert.match(rejected({ reference: { ...reference, sessionFile: otherSession } }), /resume-other\.jsonl/);
    // The recorded cwd must belong to the lane.
    assert.match(rejected({ cwd: repo }), /not inside the lane/);
    assert.match(rejected({ cwd: null }), /not inside the lane/);
    // Foreign: the evidence names another session.
    editManifest((manifest) => { manifest.sessionFile = otherSession; });
    assert.match(rejected({}), /resume-other\.jsonl/);
    // Legacy: evidence that never recorded a session cannot prove ownership.
    editManifest((manifest) => { delete manifest.sessionFile; });
    assert.match(rejected({}), /predates the session record/);
    // Removed: the lane is already cleaned up.
    editManifest((manifest) => { manifest.cleanup = { status: "removed" }; });
    assert.match(rejected({}), /already removed/);
    // Mismatched: the reference disagrees with the recorded identity.
    writeFileSync(manifestFile, original);
    assert.match(
      rejected({ reference: { ...reference, allocation: { ...reference.allocation, branch: "pi-subagents/other" } } }),
      /does not match the reference/,
    );

    // Missing: no evidence to verify the association at all.
    rmSync(manifestFile, { force: true });
    assert.match(rejected({}), /no lane manifest/);

    // Duplicate: two lanes claim one session, so neither can be resumed.
    writeFileSync(manifestFile, original);
    laneWithSession("resume003", sessionFile);
    assert.match(rejected({}), /ambiguous/);

    // Refusing never touches the lane it refused.
    assert.equal(existsSync(worktree), true);
    assert.equal(git(["symbolic-ref", "--short", "HEAD"], worktree).trim(), reference.allocation.branch);
    assert.equal(readFileSync(manifestFile, "utf8"), original);
  });

  it("rejects a lane whose worktree is gone or checked out on another branch", () => {
    const gone = laneWithSession("resume004", join(sandbox, "resume-gone.jsonl"));
    rmSync(gone.entry.manifest.worktree, { recursive: true, force: true });
    const goneResult = validateLaneResume({
      reference: gone.reference,
      sessionPath: gone.reference.sessionFile,
      cwd: gone.entry.manifest.worktree,
    });
    assert.equal(goneResult.ok, false);
    assert.match(goneResult.ok ? "" : goneResult.error, /worktree is gone/);

    const switched = laneWithSession("resume005", join(sandbox, "resume-switched.jsonl"));
    git(["checkout", "-q", "-b", "someone-elses-branch"], switched.entry.manifest.worktree);
    const switchedResult = validateLaneResume({
      reference: switched.reference,
      sessionPath: switched.reference.sessionFile,
      cwd: switched.entry.manifest.worktree,
    });
    assert.equal(switchedResult.ok, false);
    assert.match(switchedResult.ok ? "" : switchedResult.error, /registered on branch/);
  });

  it("ignores lane evidence whose recorded worktree is not absolute", () => {
    const { entry } = laneWithSession("resume006", join(sandbox, "resume-relative.jsonl"));
    const manifest: any = JSON.parse(readFileSync(entry.manifestFile, "utf8"));
    manifest.worktree = "pi-worktree-relative";
    writeFileSync(entry.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    // Without the absolute-path gate this relative value resolves against the
    // test runner's cwd and claims it as a lane worktree.
    const falseClaim = join(process.cwd(), "pi-worktree-relative", "packages", "app");
    assert.deepEqual(lanesContaining(artifactDir, falseClaim), []);

    // The gate rejects only the malformed entry: absolute evidence still matches.
    const absolute = laneWithSession("resume007", join(sandbox, "resume-absolute.jsonl"));
    const matched = lanesContaining(artifactDir, join(absolute.entry.manifest.worktree, "packages", "app"));
    assert.deepEqual(matched.map((lane) => lane.manifest.laneId), ["resume007"]);
  });
});
