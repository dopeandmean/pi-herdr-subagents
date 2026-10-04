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
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

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

function runtimeExcludePrefixes(): string[] {
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

/**
 * Durable pointer to the one lane a session owns, written into its launch
 * profile at allocation time so a resumed session cannot guess an association
 * from a label or a cwd.
 */
export interface LaneReference {
  laneId: string;
  artifactDir: string;
  sessionFile: string;
  allocation: WorktreeAllocation;
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
  /** Session this lane was allocated for; resume validates it before re-attaching. */
  sessionFile?: string;
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

/** One lane's manifest, with the path it was read from. */
export interface LaneEntry {
  manifest: HandoffManifest;
  manifestFile: string;
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
function resolveRepoRoot(cwd: string): string | null {
  const out = tryGit(["rev-parse", "--show-toplevel"], { cwd });
  const root = out?.trim();
  return root ? root : null;
}

/**
 * Clean-source gate. Untracked files count as dirty: a managed worktree must
 * branch from a checkout whose contents are fully accounted for, and the
 * caller's work must never be stashed, reset, or silently absorbed.
 */
function checkSourceClean(repoRoot: string): {
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
function resolveWorktreeRoot(repoRoot: string): string {
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

function laneDirFor(artifactDir: string, laneId: string): string {
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
  sessionFile?: string;
  terminalState: LaneTerminalState;
}): LaneEntry {
  const { allocation, laneId } = options;
  const laneDir = laneDirFor(options.artifactDir, laneId);
  mkdirSync(laneDir, { recursive: true });

  const patchFile = join(laneDir, PATCH_FILE_NAME);
  const manifestFile = join(laneDir, MANIFEST_FILE_NAME);
  const indexPath = join(laneDir, `.capture-index-${process.pid}-${Date.now()}`);
  const at = new Date().toISOString();

  // A recapture is the same lane, not a new one: keep its original identity and
  // the review/merge evidence already recorded. That evidence stays bound to the
  // head it names, so the cleanup gate rejects it once the head moves.
  const previous = readManifest(manifestFile);
  const lane =
    previous && previous.laneId === laneId && previous.worktree === allocation.path
      ? previous
      : null;
  const agent = options.agent ?? lane?.agent;
  const sessionFile = options.sessionFile ?? lane?.sessionFile;

  const manifest: HandoffManifest = {
    version: WORKTREE_MANIFEST_VERSION,
    laneId,
    name: lane?.name ?? options.name,
    ...(agent ? { agent } : {}),
    ...(sessionFile ? { sessionFile } : {}),
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
    ...(lane?.review ? { review: lane.review } : {}),
    ...(lane?.merge ? { merge: lane.merge } : {}),
    cleanup: { status: "pending" },
    createdAt: lane?.createdAt ?? at,
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
  return { manifest, manifestFile };
}

function manifestFileFor(artifactDir: string, laneId: string): string {
  return join(laneDirFor(artifactDir, laneId), MANIFEST_FILE_NAME);
}

function readManifest(manifestFile: string): HandoffManifest | null {
  if (!existsSync(manifestFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestFile, "utf8")) as HandoffManifest;
    return typeof parsed?.laneId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function readLaneEntries(artifactDir: string): LaneEntry[] {
  const root = join(artifactDir, LANES_DIR_NAME);
  if (!existsSync(root)) return [];
  const lanes: LaneEntry[] = [];
  for (const entry of readdirSync(root)) {
    const manifestFile = join(root, entry, MANIFEST_FILE_NAME);
    const manifest = readManifest(manifestFile);
    if (manifest) lanes.push({ manifest, manifestFile });
  }
  return lanes.sort((a, b) => a.manifest.createdAt.localeCompare(b.manifest.createdAt));
}

/**
 * Lanes recorded for this session, oldest first. `scope` narrows to one lane:
 * a lane id, or an absolute path to a manifest file.
 */
export function listLanes(artifactDir: string, scope?: string): LaneEntry[] {
  if (!scope) return readLaneEntries(artifactDir);
  if (isAbsolute(scope)) {
    const manifest = readManifest(scope);
    return manifest ? [{ manifest, manifestFile: scope }] : [];
  }
  return readLaneEntries(artifactDir).filter((entry) => entry.manifest.laneId === scope);
}

/** Lanes whose manifest records this session — the evidence a durable reference must match. */
export function lanesForSession(artifactDir: string, sessionPath: string): LaneEntry[] {
  return readLaneEntries(artifactDir).filter((entry) => entry.manifest.sessionFile === sessionPath);
}

/**
 * Lanes whose recorded worktree contains `cwd`. Ownership is never inferred
 * from this: a session with no durable lane reference must not resume into a
 * lane whose edits nothing would recapture. Only absolute recorded paths count:
 * a relative value would resolve against this process's cwd and could falsely
 * claim it as lane-owned.
 */
export function lanesContaining(artifactDir: string, cwd: string | null): LaneEntry[] {
  if (!cwd) return [];
  return readLaneEntries(artifactDir).filter(
    (entry) =>
      typeof entry.manifest.worktree === "string" &&
      isAbsolute(entry.manifest.worktree) &&
      isInside(entry.manifest.worktree, cwd),
  );
}

/**
 * Read-only verdict on whether a durable lane reference still describes the one
 * lane this session owns: the recorded manifest must record the session, agree
 * on the lane's identity, and still be registered on its own branch inside the
 * lane worktree. Every failure preserves the lane, the branch and the evidence.
 */
export function validateLaneResume(options: {
  reference: LaneReference;
  sessionPath: string;
  cwd: string | null;
}): { ok: true; allocation: WorktreeAllocation } | { ok: false; error: string } {
  const { reference, sessionPath } = options;
  const reject = (error: string) => ({ ok: false as const, error });

  if (reference.sessionFile !== sessionPath) {
    return reject(`the lane reference belongs to session ${reference.sessionFile}, not ${sessionPath}`);
  }

  const recorded = lanesForSession(reference.artifactDir, sessionPath);
  if (recorded.length > 1) {
    return reject(
      `lane evidence for this session is ambiguous: ${recorded
        .map((entry) => entry.manifest.laneId)
        .join(", ")}`,
    );
  }

  const manifestFile = manifestFileFor(reference.artifactDir, reference.laneId);
  const manifest = readManifest(manifestFile);
  if (!manifest) return reject(`no lane manifest at ${manifestFile}`);
  if (manifest.cleanup?.status === "removed") return reject(`lane ${manifest.laneId} was already removed`);

  const allocation = reference.allocation;
  const disagreement =
    manifest.laneId !== reference.laneId
      ? `lane id ${manifest.laneId} != ${reference.laneId}`
      : manifest.repoRoot !== allocation.repoRoot
        ? `repository ${manifest.repoRoot} != ${allocation.repoRoot}`
        : manifest.branch !== allocation.branch
          ? `branch ${manifest.branch} != ${allocation.branch}`
          : manifest.worktree !== allocation.path
            ? `worktree ${manifest.worktree} != ${allocation.path}`
            : manifest.baseRef !== allocation.baseRef
              ? `base ref ${manifest.baseRef} != ${allocation.baseRef}`
              : manifest.baseCommit !== allocation.baseCommit
                ? `base commit ${manifest.baseCommit} != ${allocation.baseCommit}`
                : null;
  if (disagreement) return reject(`lane evidence does not match the reference (${disagreement})`);
  if (manifest.sessionFile === undefined) {
    return reject("lane evidence predates the session record, so its ownership cannot be verified");
  }
  if (manifest.sessionFile !== sessionPath) {
    return reject(`lane evidence belongs to session ${manifest.sessionFile}, not ${sessionPath}`);
  }

  if (!existsSync(allocation.path)) return reject(`worktree is gone: ${allocation.path}`);
  if (resolveRepoRoot(allocation.repoRoot) !== allocation.repoRoot) {
    return reject(`repository root no longer resolves to ${allocation.repoRoot}`);
  }
  const registered = registeredWorktrees(allocation.repoRoot);
  if (!registered.has(allocation.path)) {
    return reject(`worktree is not registered in the repository: ${allocation.path}`);
  }
  if (registered.get(allocation.path) !== allocation.branch) {
    return reject(
      `worktree is registered on branch ${registered.get(allocation.path)}, not ${allocation.branch}`,
    );
  }
  const branchNow = tryGit(["symbolic-ref", "--short", "HEAD"], { cwd: allocation.path })?.trim();
  if (branchNow !== allocation.branch) {
    return reject(`worktree is checked out on ${branchNow ?? "(detached)"}, not ${allocation.branch}`);
  }
  if (!options.cwd || !isInside(allocation.path, options.cwd)) {
    return reject(`recorded cwd ${options.cwd ?? "(none)"} is not inside the lane ${allocation.path}`);
  }

  return { ok: true, allocation };
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

function changedLaneEvidenceBlockers(manifest: HandoffManifest): string[] {
  const blockers: string[] = [];

  // Fresh lineage first: manifest counters are evidence, not authority, so
  // stale or altered "empty" metadata cannot authorize removing a lane whose
  // recorded base..head range actually holds commits.
  const baseCommit = tryGit(
    ["rev-parse", "--verify", `${manifest.baseCommit}^{commit}`],
    { cwd: manifest.repoRoot },
  )?.trim();
  const headCommit = tryGit(
    ["rev-parse", "--verify", `${manifest.headCommit}^{commit}`],
    { cwd: manifest.repoRoot },
  )?.trim();
  if (!baseCommit || !headCommit ||
      tryGit(["merge-base", "--is-ancestor", baseCommit, headCommit], {
        cwd: manifest.repoRoot,
      }) === null) {
    blockers.push("lane base and captured head do not have verifiable lineage");
    return blockers;
  }
  const commits = tryGit(["rev-list", "--reverse", `${baseCommit}..${headCommit}`], {
    cwd: manifest.repoRoot,
  });
  if (commits === null) {
    blockers.push("lane child commits cannot be resolved");
    return blockers;
  }
  const laneCommits = commits.trim() ? commits.trim().split("\n") : [];
  if (laneCommits.length !== manifest.childCommits) {
    blockers.push("captured lane child commit count does not match its lineage");
  }
  // The patch file on disk is fresh evidence too: an altered "no changes"
  // manifest must not clear a patch-only lane.
  let capturedPatchBytes = 0;
  try {
    capturedPatchBytes = statSync(manifest.patchFile).size;
  } catch {
    capturedPatchBytes = -1;
  }
  if (laneCommits.length === 0 && manifest.changedPaths.length === 0 && capturedPatchBytes === 0) {
    return blockers;
  }

  const review = manifest.review;
  if (!review) {
    blockers.push("review evidence missing for changed lane");
  } else {
    if (review.verdict !== "OK" && review.verdict !== "OK with notes") {
      blockers.push(`review verdict ${review.verdict} does not authorize cleanup`);
    }
    if (review.headCommit !== manifest.headCommit) {
      blockers.push("review is stale for the captured head");
    }
  }

  const merge = manifest.merge;
  if (!merge) {
    blockers.push("integration evidence missing for changed lane");
    return blockers;
  }
  if (merge.reviewedHead !== manifest.headCommit) {
    blockers.push("integration evidence does not match the reviewed head");
  }

  const integrationCommit = tryGit(
    ["rev-parse", "--verify", `${merge.commit}^{commit}`],
    { cwd: manifest.repoRoot },
  )?.trim();
  if (!integrationCommit) {
    blockers.push("integration commit does not resolve");
    return blockers;
  }
  if (integrationCommit !== merge.commit) {
    blockers.push("integration evidence must name an immutable commit");
  }

  const repoHead = tryGit(["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: manifest.repoRoot,
  })?.trim();
  if (!repoHead || tryGit(["merge-base", "--is-ancestor", integrationCommit, repoHead], {
    cwd: manifest.repoRoot,
  }) === null) {
    blockers.push("integration commit is not in the repository HEAD history");
  }

  if (laneCommits.length === 0) {
    blockers.push("changed lane has no child commits; patch-only changes cannot prove integration");
    return blockers;
  }

  const integrationHistory = tryGit(["rev-list", integrationCommit], {
    cwd: manifest.repoRoot,
  });
  if (integrationHistory === null) {
    blockers.push("integration commit history cannot be resolved");
  } else {
    const integrated = new Set(integrationHistory.trim().split("\n"));
    if (laneCommits.some((commit) => !integrated.has(commit))) {
      blockers.push("integration commit does not contain lane commits");
    }
  }

  const committedPatch = tryGit(
    [
      "-c", "diff.noprefix=false",
      "-c", "diff.mnemonicPrefix=false",
      "diff", "--binary", "--find-renames", "--no-color", "--no-ext-diff", "--no-textconv",
      baseCommit, headCommit,
    ],
    { cwd: manifest.repoRoot },
  );
  let capturedPatch: string | undefined;
  try {
    capturedPatch = readFileSync(manifest.patchFile, "utf8");
  } catch {
    // The missing or unreadable patch is reported below.
  }
  if (committedPatch === null || capturedPatch === undefined || committedPatch !== capturedPatch) {
    blockers.push("captured patch contains changes without verifiable commit lineage");
  }

  return blockers;
}

/**
 * Read-only verdict on whether a lane may be removed. Runs fresh Git checks
 * every time — the manifest is evidence, never authority.
 */
export function inspectLane(entry: LaneEntry): LaneInspection {
  const { manifest, manifestFile } = entry;
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

  // Every lane is scanned, empty or not: an ignored file is uncaptured work
  // that a "no changes" manifest must not turn into force-removed data.
  const ignored = tryGit(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    { cwd: manifest.worktree },
  );
  if (ignored === null) {
    blockers.push("ignored files could not be inspected");
  } else if (ignored.split("\0").some((path) => path && !isRuntimeNoise(path))) {
    blockers.push("worktree contains ignored files not covered by the captured patch");
  }

  blockers.push(...changedLaneEvidenceBlockers(manifest));
  inspection.removable = blockers.length === 0;
  return inspection;
}

/**
 * Explicit removal. Revalidates Git state immediately before removing, and
 * preserves the lane (branch, worktree, evidence) whenever anything is off.
 */
export function removeLane(
  entry: LaneEntry,
  options: { by?: string } = {},
): { removed: boolean; reason?: string; inspection: LaneInspection | null } {
  const { manifestFile } = entry;
  const manifest = readManifest(manifestFile);
  if (!manifest) {
    return { removed: false, reason: "manifest missing or malformed", inspection: null };
  }
  const inspection = inspectLane({ manifest, manifestFile });
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
  entry: LaneEntry,
  evidence: {
    review?: { verdict: LaneReview["verdict"]; reviewer: string; notes?: string };
    merge?: { commit: string; attestor: string; postMergeChecks?: string };
  },
): { ok: boolean; error?: string; manifest?: HandoffManifest } {
  const { manifestFile } = entry;
  const manifest = readManifest(manifestFile);
  if (!manifest) return { ok: false, error: `manifest missing or malformed: ${manifestFile}` };
  if (!manifest.capture?.ok) {
    return { ok: false, error: "lane handoff capture failed; nothing can be attested" };
  }
  if (evidence.review &&
      evidence.review.verdict !== "OK" &&
      evidence.review.verdict !== "OK with notes") {
    return { ok: false, error: `review verdict ${evidence.review.verdict} does not authorize cleanup` };
  }
  if (evidence.review || evidence.merge) {
    const currentHead = tryGit(["rev-parse", "HEAD"], { cwd: manifest.worktree })?.trim();
    if (currentHead !== manifest.headCommit) {
      return { ok: false, error: "lane head moved since capture; fresh evidence is required" };
    }
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
    if (manifest.childCommits === 0) {
      return { ok: false, error: "lane has no child commits; integration cannot be verified" };
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
      reviewedHead: updated.review?.headCommit ?? manifest.headCommit,
      ...(evidence.merge.postMergeChecks ? { postMergeChecks: evidence.merge.postMergeChecks } : {}),
      at: new Date().toISOString(),
    };
    const blockers = changedLaneEvidenceBlockers(updated);
    if (blockers.length > 0) return { ok: false, error: blockers.join("; ") };
  }

  writeManifestFile(manifestFile, updated);
  return { ok: true, manifest: updated };
}
