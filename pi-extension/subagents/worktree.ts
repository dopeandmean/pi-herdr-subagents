import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Git worktree isolation for subagent lanes: allocation, durable handoff
 * capture, and fail-closed cleanup.
 *
 * Layout:
 *   worktree  <worktreeRoot>/pi-worktree-<laneId>   (outside the source checkout)
 *   branch    pi-subagents/<label>-<laneId>
 *   evidence  <session artifact dir>/subagent-worktrees/<laneId>/{patch.diff,manifest.json}
 *
 * Cleanup never trusts the manifest alone: every removal re-runs fresh Git
 * checks (ownership, checked-out branch, head commit, clean tree) first.
 */

export const WORKTREE_MANIFEST_VERSION = 1;

const BRANCH_PREFIX = "pi-subagents/";
const LANES_DIR_NAME = "subagent-worktrees";
const PATCH_FILE_NAME = "patch.diff";
const MANIFEST_FILE_NAME = "manifest.json";

/**
 * Cwd-local runtime metadata written by pi tooling. A child pi process writes
 * these into whatever directory it starts in, so they land in every lane; they
 * are never part of the child's work and must not reach the patch, the change
 * list, or the clean-tree gate. Override with PI_SUBAGENTS_WORKTREE_EXCLUDE
 * (comma-separated, replaces the defaults; set it empty to exclude nothing).
 */
const DEFAULT_RUNTIME_EXCLUDES = [".pi-lens-probe-home"];

export function runtimeExcludePrefixes(): string[] {
  const configured = process.env.PI_SUBAGENTS_WORKTREE_EXCLUDE;
  const entries = configured === undefined ? DEFAULT_RUNTIME_EXCLUDES : configured.split(",");
  return entries
    .map((entry) => entry.trim().replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(Boolean);
}

function isRuntimeNoise(path: string): boolean {
  return runtimeExcludePrefixes().some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

export interface WorktreeAllocation {
  repoRoot: string;
  branch: string;
  path: string;
  baseRef: string;
  baseCommit: string;
}

export interface LaneChange {
  status: string;
  path: string;
}

/** Parse `git status --porcelain -z` output into status/path pairs. */
function parsePorcelainZ(raw: string): LaneChange[] {
  const fields = raw.split("\0");
  const entries: LaneChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record.length < 4) continue;
    entries.push({ status: record.slice(0, 2), path: record.slice(3) });
    if (record[0] === "R" || record[0] === "C") index += 1;
  }
  return entries;
}

export interface LaneTerminalState {
  status: "completed" | "failed" | "cancelled";
  exitCode: number;
}

export interface LaneReview {
  verdict: "BLOCK" | "OK" | "OK with notes";
  reviewer: string;
  headCommit: string;
  notes?: string;
  at: string;
}

export interface LaneMerge {
  commit: string;
  reviewedHead: string;
  attestor: string;
  postMergeChecks?: string;
  at: string;
}

export interface HandoffManifest {
  version: number;
  laneId: string;
  name: string;
  agent?: string;
  repoRoot: string;
  branch: string;
  worktree: string;
  baseRef: string;
  baseCommit: string;
  headCommit: string;
  childCommits: number;
  changedPaths: LaneChange[];
  /** Cwd-local runtime metadata ignored during capture, for auditability. */
  excludedRuntimePaths: string[];
  patchFile: string;
  patchBytes: number;
  capture: { ok: boolean; error?: string; at: string };
  terminalState: LaneTerminalState;
  cleanup: {
    status: "pending" | "removed" | "preserved";
    reason?: string;
    at?: string;
    by?: string;
  };
  review?: LaneReview;
  merge?: LaneMerge;
  createdAt: string;
}

export interface LaneInspection {
  laneId: string;
  manifestFile: string;
  repoRoot: string;
  branch: string;
  worktree: string;
  worktreeExists: boolean;
  headCommit: string;
  changedPaths: LaneChange[];
  review?: LaneReview;
  merge?: LaneMerge;
  cleanupStatus: HandoffManifest["cleanup"]["status"];
  removable: boolean;
  blockers: string[];
}

interface GitOptions {
  cwd?: string;
  env?: Record<string, string>;
}

function git(args: string[], options: GitOptions = {}): string {
  return execFileSync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
}

function tryGit(args: string[], options: GitOptions = {}): string | null {
  try {
    return git(args, options);
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Absolute repository root for `cwd`, or null when it is not in a Git work tree. */
export function resolveRepoRoot(cwd: string): string | null {
  const out = tryGit(["rev-parse", "--show-toplevel"], { cwd });
  const root = out?.trim();
  return root ? root : null;
}

/**
 * Clean-source gate. Untracked files count as dirty: a managed worktree must
 * branch from a checkout whose contents are fully accounted for, and the
 * caller's work must never be stashed, reset, or silently absorbed.
 */
export function checkSourceClean(repoRoot: string): {
  ok: boolean;
  reason?: string;
  entries: string[];
} {
  if (!tryGit(["rev-parse", "--verify", "HEAD"], { cwd: repoRoot })) {
    return { ok: false, reason: "repository has no commits to branch from", entries: [] };
  }
  const status = tryGit(["status", "--porcelain", "-uall", "-z"], { cwd: repoRoot });
  if (status === null) {
    return { ok: false, reason: "git status failed", entries: [] };
  }
  const entries = parsePorcelainZ(status)
    .filter((entry) => !(entry.status === "??" && isRuntimeNoise(entry.path)))
    .map((entry) => `${entry.status} ${entry.path}`);
  if (entries.length > 0) {
    return { ok: false, reason: "source checkout is not clean", entries };
  }
  return { ok: true, entries: [] };
}

function sanitizeLabel(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return cleaned || "worker";
}

/** Dedicated worktree root: sibling of the checkout, never inside it. */
export function resolveWorktreeRoot(repoRoot: string): string {
  const configured = process.env.PI_SUBAGENTS_WORKTREE_DIR;
  const root = configured
    ? configured.startsWith("~/")
      ? join(homedir(), configured.slice(2))
      : resolve(configured)
    : join(dirname(repoRoot), "worktrees", basename(repoRoot));

  if (isInside(repoRoot, root)) {
    throw new Error(
      `Worktree root ${root} is inside the repository checkout. Set PI_SUBAGENTS_WORKTREE_DIR to a path outside ${repoRoot}.`,
    );
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  if (isInside(agentDir, root)) {
    throw new Error(`Worktree root ${root} is inside the pi extensions directory.`);
  }
  return root;
}

export function laneDirFor(artifactDir: string, laneId: string): string {
  return join(artifactDir, LANES_DIR_NAME, laneId);
}

/**
 * Preflight and allocate one isolated lane. Throws (launch nothing) when the
 * cwd is not a Git checkout, the source is dirty, or the target already exists.
 */
export function allocateWorktree(options: {
  cwd: string;
  label: string;
  laneId: string;
  baseRef?: string;
}): WorktreeAllocation {
  const repoRoot = resolveRepoRoot(options.cwd);
  if (!repoRoot) {
    throw new Error(
      `Worktree isolation requires a Git repository (cwd: ${options.cwd}). Commit or init first, or drop worktree: true.`,
    );
  }
  const baseRef = options.baseRef?.trim() || "HEAD";

  const preflight = checkSourceClean(repoRoot);
  if (!preflight.ok) {
    const detail = preflight.entries.slice(0, 20).join("\n");
    throw new Error(
      `Worktree isolation refused: ${preflight.reason} in ${repoRoot}. Commit or stash your changes first; nothing was launched and nothing was modified.${detail ? `\n${detail}` : ""}`,
    );
  }

  const baseCommit = tryGit(["rev-parse", "--verify", `${baseRef}^{commit}`], {
    cwd: repoRoot,
  })?.trim();
  if (!baseCommit) {
    throw new Error(`Unknown base ref "${baseRef}" in ${repoRoot}.`);
  }

  const root = resolveWorktreeRoot(repoRoot);
  mkdirSync(root, { recursive: true });

  const branch = `${BRANCH_PREFIX}${sanitizeLabel(options.label)}-${options.laneId}`;
  const path = join(root, `pi-worktree-${options.laneId}`);
  if (existsSync(path)) throw new Error(`Worktree path already exists: ${path}`);
  if (tryGit(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: repoRoot })) {
    throw new Error(`Branch already exists: ${branch}`);
  }

  // Re-check immediately before allocation: preflight and allocation are
  // separate moments, and a batch shares one source checkout.
  const recheck = checkSourceClean(repoRoot);
  if (!recheck.ok) {
    throw new Error(
      `Worktree isolation refused: ${recheck.reason} in ${repoRoot} (state changed during allocation).`,
    );
  }

  git(["worktree", "add", "-b", branch, path, baseCommit], { cwd: repoRoot });
  return { repoRoot, branch, path, baseRef, baseCommit };
}

function parseNameStatus(raw: string): LaneChange[] {
  const fields = raw.split("\0").filter((entry) => entry.length > 0);
  const changes: LaneChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (status[0] === "R" || status[0] === "C") {
      const from = fields[index + 1];
      const to = fields[index + 2];
      changes.push({ status, path: to ? `${from} -> ${to}` : String(from) });
      index += 2;
    } else {
      changes.push({ status, path: String(fields[index + 1]) });
      index += 1;
    }
  }
  return changes;
}

/**
 * Capture the complete change set against the recorded base — tracked,
 * untracked, renamed, and binary — without touching the lane's real index.
 *
 * A throwaway index is seeded from the base commit, `add -A` fills it from the
 * working tree, and the diff is taken index-vs-base. That way an agent that
 * committed its own work still yields one patch covering everything it did.
 *
 * Never throws: a failed capture is recorded in the manifest so the caller can
 * fail closed and preserve the lane.
 */
export function captureHandoff(options: {
  allocation: WorktreeAllocation;
  laneId: string;
  artifactDir: string;
  name: string;
  agent?: string;
  terminalState: LaneTerminalState;
}): HandoffManifest {
  const { allocation, laneId } = options;
  const laneDir = laneDirFor(options.artifactDir, laneId);
  mkdirSync(laneDir, { recursive: true });

  const patchFile = join(laneDir, PATCH_FILE_NAME);
  const manifestFile = join(laneDir, MANIFEST_FILE_NAME);
  const indexPath = join(laneDir, `.capture-index-${process.pid}-${Date.now()}`);
  const at = new Date().toISOString();

  const manifest: HandoffManifest = {
    version: WORKTREE_MANIFEST_VERSION,
    laneId,
    name: options.name,
    ...(options.agent ? { agent: options.agent } : {}),
    repoRoot: allocation.repoRoot,
    branch: allocation.branch,
    worktree: allocation.path,
    baseRef: allocation.baseRef,
    baseCommit: allocation.baseCommit,
    headCommit: allocation.baseCommit,
    childCommits: 0,
    changedPaths: [],
    excludedRuntimePaths: [],
    patchFile,
    patchBytes: 0,
    capture: { ok: false, at },
    terminalState: options.terminalState,
    cleanup: { status: "pending" },
    createdAt: at,
  };

  try {
    const env = { GIT_INDEX_FILE: indexPath };
    git(["read-tree", allocation.baseCommit], { cwd: allocation.path, env });
    const noise = parsePorcelainZ(
      git(["status", "--porcelain", "-uall", "-z"], { cwd: allocation.path }),
    )
      .filter((entry) => entry.status === "??" && isRuntimeNoise(entry.path))
      .map((entry) => entry.path);
    manifest.excludedRuntimePaths = noise;
    git(
      [
        "add",
        "-A",
        "--",
        ".",
        ...noise.map((path) => `:(exclude,literal)${path}`),
      ],
      { cwd: allocation.path, env },
    );
    const patch = git(
      [
        "-c",
        "diff.noprefix=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "diff",
        "--cached",
        "--binary",
        "--find-renames",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        allocation.baseCommit,
      ],
      { cwd: allocation.path, env },
    );
    writeFileSync(patchFile, patch);

    const nameStatus = git(
      ["diff", "--cached", "--name-status", "--find-renames", "-z", allocation.baseCommit],
      { cwd: allocation.path, env },
    );

    manifest.headCommit = git(["rev-parse", "HEAD"], { cwd: allocation.path }).trim();
    const count = git(["rev-list", "--count", `${allocation.baseCommit}..HEAD`], {
      cwd: allocation.path,
    }).trim();
    manifest.childCommits = Number.parseInt(count, 10) || 0;
    manifest.changedPaths = parseNameStatus(nameStatus);
    manifest.patchBytes = statSync(patchFile).size;
    manifest.capture = { ok: true, at: new Date().toISOString() };
  } catch (error: any) {
    manifest.capture = {
      ok: false,
      error: error?.message ?? String(error),
      at: new Date().toISOString(),
    };
    manifest.cleanup = { status: "preserved", reason: "handoff capture failed" };
  } finally {
    rmSync(indexPath, { force: true });
  }

  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function manifestFileFor(artifactDir: string, laneId: string): string {
  return join(laneDirFor(artifactDir, laneId), MANIFEST_FILE_NAME);
}

export function readManifest(manifestFile: string): HandoffManifest | null {
  if (!existsSync(manifestFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestFile, "utf8")) as HandoffManifest;
    return typeof parsed?.laneId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function listLanes(
  artifactDir: string,
): Array<{ manifest: HandoffManifest; manifestFile: string }> {
  const root = join(artifactDir, LANES_DIR_NAME);
  if (!existsSync(root)) return [];
  const lanes: Array<{ manifest: HandoffManifest; manifestFile: string }> = [];
  for (const entry of readdirSync(root)) {
    const manifestFile = join(root, entry, MANIFEST_FILE_NAME);
    const manifest = readManifest(manifestFile);
    if (manifest) lanes.push({ manifest, manifestFile });
  }
  return lanes.sort((a, b) => a.manifest.createdAt.localeCompare(b.manifest.createdAt));
}

function registeredWorktrees(repoRoot: string): Map<string, string> {
  const raw = tryGit(["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const map = new Map<string, string>();
  if (!raw) return map;
  let path: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ") && path) {
      map.set(path, line.slice("branch ".length).trim().replace(/^refs\/heads\//, ""));
    }
  }
  return map;
}

/**
 * Read-only verdict on whether a lane may be removed. Runs fresh Git checks
 * every time — the manifest is evidence, never authority.
 */
export function inspectLane(manifest: HandoffManifest, manifestFile: string): LaneInspection {
  const blockers: string[] = [];
  const inspection: LaneInspection = {
    laneId: manifest.laneId,
    manifestFile,
    repoRoot: manifest.repoRoot,
    branch: manifest.branch,
    worktree: manifest.worktree,
    worktreeExists: false,
    headCommit: manifest.headCommit,
    changedPaths: manifest.changedPaths,
    ...(manifest.review ? { review: manifest.review } : {}),
    ...(manifest.merge ? { merge: manifest.merge } : {}),
    cleanupStatus: manifest.cleanup?.status ?? "pending",
    removable: false,
    blockers,
  };

  if (manifest.version !== WORKTREE_MANIFEST_VERSION) {
    blockers.push(`unsupported manifest version ${manifest.version}`);
  }
  if (!manifest.capture?.ok) {
    blockers.push(`handoff capture failed: ${manifest.capture?.error ?? "unknown error"}`);
  }
  if (!manifest.patchFile || !existsSync(manifest.patchFile)) {
    blockers.push(`patch file missing: ${manifest.patchFile ?? "(unset)"}`);
  }
  if (!manifest.repoRoot || !manifest.worktree || !manifest.branch) {
    blockers.push("manifest is missing ownership fields");
    inspection.removable = false;
    return inspection;
  }

  const repoRootNow = tryGit(["rev-parse", "--show-toplevel"], { cwd: manifest.repoRoot })?.trim();
  if (repoRootNow !== manifest.repoRoot) {
    blockers.push(`repository root no longer resolves to ${manifest.repoRoot}`);
  }

  if (!existsSync(manifest.worktree)) {
    blockers.push(`worktree path is gone: ${manifest.worktree}`);
    inspection.removable = false;
    return inspection;
  }
  inspection.worktreeExists = true;

  const registered = registeredWorktrees(manifest.repoRoot);
  if (!registered.has(manifest.worktree)) {
    blockers.push("worktree is not registered in the repository");
  } else if (registered.get(manifest.worktree) !== manifest.branch) {
    blockers.push(
      `worktree is registered on branch ${registered.get(manifest.worktree)}, not ${manifest.branch}`,
    );
  }

  const worktreeRootNow = tryGit(["rev-parse", "--show-toplevel"], { cwd: manifest.worktree })?.trim();
  if (worktreeRootNow !== manifest.worktree) {
    blockers.push(`worktree root no longer resolves to ${manifest.worktree}`);
  }

  const branchNow = tryGit(["symbolic-ref", "--short", "HEAD"], {
    cwd: manifest.worktree,
  })?.trim();
  if (branchNow !== manifest.branch) {
    blockers.push(`worktree is checked out on ${branchNow ?? "(detached)"}, not ${manifest.branch}`);
  }

  const headNow = tryGit(["rev-parse", "HEAD"], { cwd: manifest.worktree })?.trim();
  inspection.headCommit = headNow ?? manifest.headCommit;
  if (headNow !== manifest.headCommit) {
    blockers.push(
      `head moved since capture: ${headNow ?? "(unknown)"} != ${manifest.headCommit}`,
    );
  }

  const status = tryGit(["status", "--porcelain", "-uall", "-z"], { cwd: manifest.worktree });
  if (status === null) {
    blockers.push("git status failed in the worktree");
  } else {
    const leftover = parsePorcelainZ(status).filter(
      (entry) => !(entry.status === "??" && isRuntimeNoise(entry.path)),
    );
    if (leftover.length > 0) blockers.push(`worktree is dirty (${leftover.length} entries)`);
  }

  inspection.removable = blockers.length === 0;
  return inspection;
}

/**
 * Explicit removal. Revalidates Git state immediately before removing, and
 * preserves the lane (branch, worktree, evidence) whenever anything is off.
 */
export function removeLane(
  manifestFile: string,
  options: { by?: string } = {},
): { removed: boolean; reason?: string; inspection: LaneInspection | null } {
  const manifest = readManifest(manifestFile);
  if (!manifest) {
    return { removed: false, reason: "manifest missing or malformed", inspection: null };
  }
  const inspection = inspectLane(manifest, manifestFile);
  if (!inspection.removable) {
    return { removed: false, reason: inspection.blockers.join("; "), inspection };
  }

  try {
    // --force only after every check above passed: the tree holds no
    // unaccounted changes, so what it drops is ignored build output and the
    // cwd-local runtime metadata already listed in the manifest.
    git(["worktree", "remove", "--force", manifest.worktree], { cwd: manifest.repoRoot });
  } catch (error: any) {
    return { removed: false, reason: error?.message ?? String(error), inspection };
  }

  let reason: string | undefined;
  try {
    git(["branch", "-D", manifest.branch], { cwd: manifest.repoRoot });
  } catch (error: any) {
    reason = `worktree removed, branch kept: ${error?.message ?? String(error)}`;
  }

  const at = new Date().toISOString();
  writeManifestFile(manifestFile, {
    ...manifest,
    cleanup: {
      status: "removed",
      at,
      by: options.by ?? "parent",
      ...(reason ? { reason } : {}),
    },
  });
  return { removed: true, ...(reason ? { reason } : {}), inspection };
}

function writeManifestFile(manifestFile: string, manifest: HandoffManifest): void {
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Record review or merge evidence against the lane's captured head. The
 * reviewed head is derived from the manifest, never supplied by the caller, so
 * merge evidence cannot be attached to work the reviewer never saw.
 */
export function recordLaneEvidence(
  manifestFile: string,
  evidence: {
    review?: { verdict: LaneReview["verdict"]; reviewer: string; notes?: string };
    merge?: { commit: string; attestor: string; postMergeChecks?: string };
  },
): { ok: boolean; error?: string; manifest?: HandoffManifest } {
  const manifest = readManifest(manifestFile);
  if (!manifest) return { ok: false, error: `manifest missing or malformed: ${manifestFile}` };
  if (!manifest.capture?.ok) {
    return { ok: false, error: "lane handoff capture failed; nothing can be attested" };
  }

  const updated: HandoffManifest = { ...manifest };
  if (evidence.review) {
    updated.review = {
      ...evidence.review,
      headCommit: manifest.headCommit,
      at: new Date().toISOString(),
    };
  }
  if (evidence.merge) {
    const reviewedHead = manifest.review?.headCommit ?? manifest.headCommit;
    if (manifest.review && manifest.review.headCommit !== manifest.headCommit) {
      return { ok: false, error: "lane head moved after review; re-review before recording a merge" };
    }
    const resolved = tryGit(["rev-parse", "--verify", `${evidence.merge.commit}^{commit}`], {
      cwd: manifest.repoRoot,
    })?.trim();
    if (!resolved) {
      return { ok: false, error: `merge commit does not resolve in ${manifest.repoRoot}` };
    }
    updated.merge = {
      commit: resolved,
      attestor: evidence.merge.attestor,
      reviewedHead,
      ...(evidence.merge.postMergeChecks ? { postMergeChecks: evidence.merge.postMergeChecks } : {}),
      at: new Date().toISOString(),
    };
  }

  writeManifestFile(manifestFile, updated);
  return { ok: true, manifest: updated };
}
