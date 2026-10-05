import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SubagentActivityPhase = "starting" | "active" | "waiting" | "done";
export type SubagentActivityScope = "agent" | "turn" | "provider" | "streaming" | "tool";

export type SubagentActivityEvent =
  | "session_start"
  | "input"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "before_provider_request"
  | "after_provider_response"
  | "message_update"
  | "tool_execution_start"
  | "tool_call"
  | "tool_execution_update"
  | "tool_result"
  | "tool_execution_end"
  | "caller_ping"
  | "subagent_done"
  | "session_shutdown";

export interface SubagentActivityState {
  version: 1;
  runningChildId: string;
  createdAt: number;
  updatedAt: number;
  sequence: number;
  latestEvent: SubagentActivityEvent;
  phase: SubagentActivityPhase;
  agentActive: boolean;
  turnActive: boolean;
  providerActive: boolean;
  toolActive: boolean;
  activeScope?: SubagentActivityScope;
  activeSince?: number;
  waitingSince?: number;
  turnIndex?: number;
  messageEventType?: string;
  toolCallId?: string;
  toolName?: string;
  toolStartedAt?: number;
  toolEndedAt?: number;
}

export type ActivityReadResult =
  | { ok: true; activity: SubagentActivityState }
  | { ok: false; reason: "missing" | "invalid" | "wrong-id"; error?: string };

export type SubagentShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface SubagentActivityRecorder {
  sessionStart(): void;
  input(): void;
  beforeAgentStart(): void;
  agentStart(): void;
  agentEndWaiting(): void;
  agentEndDone(): void;
  turnStart(turnIndex?: number): void;
  turnEnd(turnIndex?: number): void;
  beforeProviderRequest(): void;
  afterProviderResponse(): void;
  messageUpdate(messageEventType?: string): void;
  toolExecutionStart(toolCallId?: string, toolName?: string): void;
  toolCall(toolCallId?: string, toolName?: string): void;
  toolExecutionUpdate(toolCallId?: string, toolName?: string): void;
  toolResult(toolCallId?: string, toolName?: string): void;
  toolExecutionEnd(toolCallId?: string, toolName?: string): void;
  callerPing(): void;
  subagentDone(): void;
  sessionShutdown(reason: SubagentShutdownReason): void;
}

const ACTIVITY_UPDATE_THROTTLE_MS = 500;
const MAX_WRITE_FAILURES = 3;
const KNOWN_PHASES = new Set<SubagentActivityPhase>(["starting", "active", "waiting", "done"]);
const KNOWN_SCOPES = new Set<SubagentActivityScope>(["agent", "turn", "provider", "streaming", "tool"]);
const KNOWN_EVENTS = new Set<SubagentActivityEvent>([
  "session_start",
  "input",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "before_provider_request",
  "after_provider_response",
  "message_update",
  "tool_execution_start",
  "tool_call",
  "tool_execution_update",
  "tool_result",
  "tool_execution_end",
  "caller_ping",
  "subagent_done",
  "session_shutdown",
]);
const MAX_ACTIVITY_STRING_LENGTH = 200;

// ── Live Activity events ──

/**
 * Channel of the Activity extension's event contract. The name is repeated here
 * instead of imported: the subagents extension must work unchanged when Activity
 * is not installed, so the envelope is built locally and published best-effort.
 */
export const ACTIVITY_EVENT_CHANNEL = "pi-activity:event";

/** Envelope summary cap enforced by the Activity consumer's validator. */
const ACTIVITY_SUMMARY_LIMIT = 200;
/** Details byte cap enforced by the Activity consumer's validator (8 KiB). */
const ACTIVITY_DETAILS_LIMIT_BYTES = 8 * 1024;
const ACTIVITY_TRUNCATION_MARKER = "… [truncated]";

// ANSI escape sequences (CSI, OSC, DCS and the two/three byte escapes) plus C0/C1
// controls, keeping newline and tab. Mirrors the Activity consumer's cleaner so a
// provider excerpt reaches the feed with its shape intact.
// eslint-disable-next-line no-control-regex
const ACTIVITY_ANSI_ESCAPE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
// eslint-disable-next-line no-control-regex
const ACTIVITY_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Credential-shaped text is masked before an event leaves the process: the
 * Activity consumer bounds size, not secrets, and a provider error can quote
 * response material, so a token that reaches the feed has already leaked.
 */
const ACTIVITY_CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\b((?:api[_-]?key|apikey|secret|token|password|passwd|authorization|credential)s?\b\s*[:=]\s*)[^\s,;]*/gi, "$1[redacted]"],
  // Long opaque runs: base64/hex/url-safe blobs, without path separators.
  [/\b[A-Za-z0-9+_-]{32,}={0,2}\b/g, "[redacted]"],
];

const ACTIVITY_ENCODER = new TextEncoder();
const ACTIVITY_DECODER = new TextDecoder();
const ACTIVITY_MARKER_BYTES = ACTIVITY_ENCODER.encode(ACTIVITY_TRUNCATION_MARKER).length;

/** Strip terminal control sequences, then mask credential-shaped runs. */
function redactActivityText(text: string): string {
  let redacted = text.replace(ACTIVITY_ANSI_ESCAPE, "").replace(ACTIVITY_CONTROL_CHARS, "");
  for (const [pattern, replacement] of ACTIVITY_CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function boundActivitySummary(summary: string): string {
  return redactActivityText(summary).slice(0, ACTIVITY_SUMMARY_LIMIT);
}

/** Redact details, then cap them where the consumer would truncate anyway. */
function boundActivityDetails(details: string): string {
  const redacted = redactActivityText(details);
  const encoded = ACTIVITY_ENCODER.encode(redacted);
  if (encoded.length <= ACTIVITY_DETAILS_LIMIT_BYTES) return redacted;
  // Reserve three bytes beyond the marker so decoding a split multi-byte
  // character cannot push the result back over the consumer's cap.
  const kept = encoded.subarray(0, ACTIVITY_DETAILS_LIMIT_BYTES - ACTIVITY_MARKER_BYTES - 3);
  return ACTIVITY_DECODER.decode(kept) + ACTIVITY_TRUNCATION_MARKER;
}

export interface ActivityPublisherEvent {
  /** Emitting Pi session id, '' when unknown. */
  session: string;
  actor: { kind: "main" | "child"; name: string; id?: string; parent?: string };
  source: "skills" | "subagents" | "hooks";
  kind: string;
  severity: "info" | "warning" | "error";
  summary: string;
  details?: string;
  correlation?: { skill?: string; path?: string; extension?: string; hook?: string; durationMs?: number };
}

/** The part of Pi's extension API this publisher needs. */
export interface ActivityEventSink {
  events?: { emit(channel: string, data: unknown): void } | null;
}

let activitySequence = 0;

function activityGeneration(): number {
  const parsed = Number.parseInt(process.env.PI_ACTIVITY_GENERATION ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Publish one event on the in-process Activity channel. Never throws and stays a
 * silent no-op without a consumer: reporting must not break a launch, a skill
 * load or a completion delivery. Returns whether the consumer claimed it.
 */
export function publishActivityEvent(
  sink: ActivityEventSink | undefined,
  event: ActivityPublisherEvent,
): boolean {
  const seq = ++activitySequence;
  const summary = boundActivitySummary(event.summary);
  const details = event.details ? boundActivityDetails(event.details) : undefined;
  const envelope: Record<string, unknown> = {
    v: 1,
    // Producer-namespaced: every publisher starts its own sequence at 1, and the
    // consumer dedupes on actor/session + id, so a bare session:seq would let one
    // extension's event drop another's.
    id: `herdr:${event.session}:${seq}`,
    seq,
    at: Date.now(),
    root: process.env.PI_ACTIVITY_ROOT ?? "",
    session: event.session,
    generation: activityGeneration(),
    actor: event.actor,
    source: event.source,
    kind: event.kind,
    severity: event.severity,
    presentation: "routine",
    summary,
    ...(details ? { details } : {}),
    ...(event.correlation ? { correlation: event.correlation } : {}),
    claimed: false,
  };

  try {
    sink?.events?.emit(ACTIVITY_EVENT_CHANNEL, envelope);
  } catch {
    // A throwing consumer must not break the caller's real work.
    return false;
  }
  return envelope.claimed === true;
}

export function getSubagentActivityFile(artifactDir: string, runningChildId: string): string {
  return join(artifactDir, "subagent-activity", `${runningChildId}.json`);
}

function requireObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function validateFiniteNumber(object: Record<string, unknown>, fieldName: string): string | null {
  return Number.isFinite(object[fieldName]) ? null : `${fieldName} must be finite`;
}

function validateOptionalFiniteNumber(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  return value == null || Number.isFinite(value) ? null : `${fieldName} must be finite when present`;
}

function validateInteger(object: Record<string, unknown>, fieldName: string): string | null {
  return Number.isInteger(object[fieldName]) ? null : `${fieldName} must be an integer`;
}

function validateOptionalInteger(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  return value == null || Number.isInteger(value) ? null : `${fieldName} must be an integer when present`;
}

function validateBoolean(object: Record<string, unknown>, fieldName: string): string | null {
  return typeof object[fieldName] === "boolean" ? null : `${fieldName} must be a boolean`;
}

function validateOptionalActivityString(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  if (value == null) return null;
  if (typeof value !== "string") return `${fieldName} must be a string when present`;
  if (/\r|\n/.test(value)) return `${fieldName} must not contain newlines`;
  return value.length <= MAX_ACTIVITY_STRING_LENGTH ? null : `${fieldName} is too long`;
}

function invalidActivity(error: string): ActivityReadResult {
  return { ok: false, reason: "invalid", error };
}

function validateActivity(value: unknown, expectedRunningChildId: string): ActivityReadResult {
  const object = requireObject(value);
  if (!object) return invalidActivity("activity must be an object");
  if (object.version !== 1) return invalidActivity("unsupported activity version");
  if (typeof object.runningChildId !== "string") return invalidActivity("runningChildId must be a string");
  if (object.runningChildId !== expectedRunningChildId) return { ok: false, reason: "wrong-id" };
  if (typeof object.latestEvent !== "string" || !KNOWN_EVENTS.has(object.latestEvent as SubagentActivityEvent)) {
    return invalidActivity("unknown latestEvent");
  }
  if (typeof object.phase !== "string" || !KNOWN_PHASES.has(object.phase as SubagentActivityPhase)) {
    return invalidActivity("unknown activity phase");
  }
  if (
    object.activeScope != null &&
    (typeof object.activeScope !== "string" || !KNOWN_SCOPES.has(object.activeScope as SubagentActivityScope))
  ) {
    return invalidActivity("unknown activeScope");
  }

  const validationError = [
    validateFiniteNumber(object, "createdAt"),
    validateFiniteNumber(object, "updatedAt"),
    validateInteger(object, "sequence"),
    validateBoolean(object, "agentActive"),
    validateBoolean(object, "turnActive"),
    validateBoolean(object, "providerActive"),
    validateBoolean(object, "toolActive"),
    validateOptionalFiniteNumber(object, "activeSince"),
    validateOptionalFiniteNumber(object, "waitingSince"),
    validateOptionalInteger(object, "turnIndex"),
    validateOptionalFiniteNumber(object, "toolStartedAt"),
    validateOptionalFiniteNumber(object, "toolEndedAt"),
    validateOptionalActivityString(object, "messageEventType"),
    validateOptionalActivityString(object, "toolCallId"),
    validateOptionalActivityString(object, "toolName"),
  ].find((error) => error != null);
  if (validationError) return invalidActivity(validationError);

  // SAFETY: every field of SubagentActivityState was checked above; the cast only
  // erases the Record<string, unknown> shape the validator walks.
  return { ok: true, activity: object as unknown as SubagentActivityState };
}

export function readSubagentActivityFile(
  activityFile: string,
  expectedRunningChildId: string,
): ActivityReadResult {
  if (!existsSync(activityFile)) return { ok: false, reason: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(activityFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "invalid", error: message };
  }

  return validateActivity(parsed, expectedRunningChildId);
}

export function writeSubagentActivityFile(activityFile: string, activity: SubagentActivityState): void {
  const dir = dirname(activityFile);
  mkdirSync(dir, { recursive: true });
  const tempFile = join(dir, `${activity.runningChildId}.json.${process.pid}.${activity.sequence}.tmp`);

  try {
    writeFileSync(tempFile, `${JSON.stringify(activity)}\n`, "utf8");
    renameSync(tempFile, activityFile);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch (cleanupError) {
      // Temp cleanup is best effort; preserve the original write/rename failure
      void cleanupError;
    }
    throw error;
  }
}

function createNoopRecorder(): SubagentActivityRecorder {
  return {
    sessionStart() {},
    input() {},
    beforeAgentStart() {},
    agentStart() {},
    agentEndWaiting() {},
    agentEndDone() {},
    turnStart() {},
    turnEnd() {},
    beforeProviderRequest() {},
    afterProviderResponse() {},
    messageUpdate() {},
    toolExecutionStart() {},
    toolCall() {},
    toolExecutionUpdate() {},
    toolResult() {},
    toolExecutionEnd() {},
    callerPing() {},
    subagentDone() {},
    sessionShutdown() {},
  };
}

function clearActiveState(activity: SubagentActivityState): void {
  activity.agentActive = false;
  activity.turnActive = false;
  activity.providerActive = false;
  activity.toolActive = false;
  delete activity.activeScope;
  delete activity.activeSince;
}

function refreshActiveScope(activity: SubagentActivityState): void {
  if (activity.toolActive) {
    activity.phase = "active";
    activity.activeScope = "tool";
    return;
  }
  if (activity.providerActive) {
    activity.phase = "active";
    activity.activeScope = "provider";
    return;
  }
  if (activity.turnActive) {
    activity.phase = "active";
    activity.activeScope = "turn";
    return;
  }
  if (activity.agentActive) {
    activity.phase = "active";
    activity.activeScope = "agent";
    return;
  }
  delete activity.activeScope;
  delete activity.activeSince;
}

function markActive(
  activity: SubagentActivityState,
  scope: SubagentActivityScope,
  now: number,
  resetActiveSince = false,
): void {
  activity.phase = "active";
  activity.activeScope = scope;
  if (activity.activeSince == null || resetActiveSince) activity.activeSince = now;
  delete activity.waitingSince;
}

export function createSubagentActivityRecorder(params: {
  runningChildId?: string;
  activityFile?: string;
  now?: () => number;
  /**
   * Called once, with the last write error, when repeated write failures disable
   * this recorder for good. Reads of the activity file then go stale or missing,
   * so the parent needs one bounded diagnostic instead of silent degradation.
   */
  onDisabled?: (error: unknown) => void;
}): SubagentActivityRecorder {
  const runningChildId = params.runningChildId?.trim();
  const activityFile = params.activityFile?.trim();
  if (!runningChildId || !activityFile) return createNoopRecorder();

  const now = params.now ?? (() => Date.now());
  const createdAt = now();
  const activity: SubagentActivityState = {
    version: 1,
    runningChildId,
    createdAt,
    updatedAt: createdAt,
    sequence: 0,
    latestEvent: "session_start",
    phase: "starting",
    agentActive: false,
    turnActive: false,
    providerActive: false,
    toolActive: false,
  };

  let disabled = false;
  let failureCount = 0;
  let lastFlushAt = 0;
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;

  function clearPendingFlush(): void {
    if (!pendingFlush) return;
    clearTimeout(pendingFlush);
    pendingFlush = null;
  }

  function disable(): void {
    disabled = true;
    clearPendingFlush();
  }

  function flushNow(): void {
    if (disabled) return;
    try {
      writeSubagentActivityFile(activityFile, activity);
      lastFlushAt = now();
      failureCount = 0;
    } catch (error) {
      failureCount += 1;
      if (failureCount >= MAX_WRITE_FAILURES) {
        disable();
        params.onDisabled?.(error);
      }
    }
  }

  function scheduleFlush(): void {
    if (disabled || pendingFlush) return;

    const remainingMs = Math.max(0, ACTIVITY_UPDATE_THROTTLE_MS - (now() - lastFlushAt));
    if (remainingMs === 0) {
      flushNow();
      return;
    }

    pendingFlush = setTimeout(() => {
      pendingFlush = null;
      flushNow();
    }, remainingMs);
  }

  function record(
    latestEvent: SubagentActivityEvent,
    update: (current: SubagentActivityState, now: number) => void,
    flush: "immediate" | "throttled",
  ): void {
    if (disabled) return;
    if (flush === "immediate") clearPendingFlush();

    const observedAt = now();
    activity.latestEvent = latestEvent;
    activity.updatedAt = observedAt;
    activity.sequence += 1;
    update(activity, observedAt);

    if (flush === "immediate") flushNow();
    else scheduleFlush();
  }

  function markDone(latestEvent: SubagentActivityEvent): void {
    record(latestEvent, (current) => {
      current.phase = "done";
      clearActiveState(current);
      delete current.waitingSince;
    }, "immediate");
    disable();
  }

  return {
    sessionStart() {
      record("session_start", (current) => {
        current.phase = "starting";
        clearActiveState(current);
        delete current.waitingSince;
      }, "immediate");
    },
    input() {
      record("input", () => {}, "immediate");
    },
    beforeAgentStart() {
      record("before_agent_start", (current, observedAt) => {
        current.agentActive = true;
        markActive(current, "agent", observedAt);
      }, "immediate");
    },
    agentStart() {
      record("agent_start", (current, observedAt) => {
        current.agentActive = true;
        markActive(current, "agent", observedAt);
      }, "immediate");
    },
    agentEndWaiting() {
      record("agent_end", (current, observedAt) => {
        clearActiveState(current);
        current.phase = "waiting";
        current.waitingSince = observedAt;
      }, "immediate");
    },
    agentEndDone() {
      markDone("agent_end");
    },
    turnStart(turnIndex) {
      record("turn_start", (current, observedAt) => {
        current.agentActive = true;
        current.turnActive = true;
        if (turnIndex != null) current.turnIndex = turnIndex;
        markActive(current, current.toolActive || current.providerActive ? current.activeScope ?? "turn" : "turn", observedAt);
      }, "immediate");
    },
    turnEnd(turnIndex) {
      record("turn_end", (current) => {
        current.turnActive = false;
        current.providerActive = false;
        current.toolActive = false;
        if (turnIndex != null) current.turnIndex = turnIndex;
        refreshActiveScope(current);
      }, "immediate");
    },
    beforeProviderRequest() {
      record("before_provider_request", (current, observedAt) => {
        current.providerActive = true;
        markActive(current, "provider", observedAt, true);
      }, "immediate");
    },
    afterProviderResponse() {
      record("after_provider_response", (current) => {
        current.providerActive = false;
        refreshActiveScope(current);
      }, "immediate");
    },
    messageUpdate(messageEventType) {
      record("message_update", (current, observedAt) => {
        current.agentActive = true;
        current.turnActive = true;
        current.messageEventType = messageEventType;
        if (!current.toolActive) markActive(current, "streaming", observedAt);
      }, "throttled");
    },
    toolExecutionStart(toolCallId, toolName) {
      record("tool_execution_start", (current, observedAt) => {
        current.toolActive = true;
        current.toolCallId = toolCallId;
        current.toolName = toolName;
        current.toolStartedAt = observedAt;
        markActive(current, "tool", observedAt, true);
      }, "immediate");
    },
    toolCall(toolCallId, toolName) {
      record("tool_call", (current, observedAt) => {
        current.toolActive = true;
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        markActive(current, "tool", observedAt);
      }, "immediate");
    },
    toolExecutionUpdate(toolCallId, toolName) {
      record("tool_execution_update", (current, observedAt) => {
        current.toolActive = true;
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        markActive(current, "tool", observedAt);
      }, "throttled");
    },
    toolResult(toolCallId, toolName) {
      record("tool_result", (current) => {
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        refreshActiveScope(current);
      }, "immediate");
    },
    toolExecutionEnd(toolCallId, toolName) {
      record("tool_execution_end", (current, observedAt) => {
        current.toolActive = false;
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        current.toolEndedAt = observedAt;
        refreshActiveScope(current);
      }, "immediate");
    },
    callerPing() {
      markDone("caller_ping");
    },
    subagentDone() {
      markDone("subagent_done");
    },
    sessionShutdown(reason) {
      if (reason === "quit") markDone("session_shutdown");
      else disable();
    },
  };
}
