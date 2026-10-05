import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { publishActivityEvent, type ActivityEventSink } from "./activity.ts";

/** Name every hook row is stamped with, in its summary and its correlation. */
export const HOOK_EXTENSION = "herdr-subagents";

/**
 * Hooks that fire at stream rate: one row per call would drown the Activity
 * feed, so their calls are counted and folded into a single aggregated row at
 * the next ordinary hook. This package registers `message_update` and
 * `tool_execution_update`; `provider_stream_event` is named here too, so a later
 * registration cannot quietly turn it into one event per token.
 */
const COUNTER_ONLY_HOOKS = new Set<string>(["message_update", "tool_execution_update", "provider_stream_event"]);

/** A handler that has not finished yet; a synchronous handler already returned its value. */
function isPending(value: unknown): value is PromiseLike<unknown> {
  return value != null && typeof (value as { then?: unknown }).then === "function";
}

/** A subagent process reports itself as that child; anything else is the main session. */
function hookActor(): { kind: "main" | "child"; name: string; id?: string } {
  const child = process.env.PI_SUBAGENT_ID;
  return child
    ? { kind: "child", name: process.env.PI_SUBAGENT_NAME || child, id: child }
    : { kind: "main", name: "main" };
}

/** The emitting session id, '' when the host has none; a broken context never breaks a hook. */
function hookSession(ctx: unknown): string {
  try {
    const manager = (ctx as { sessionManager?: { getSessionId?(): string } } | undefined)?.sessionManager;
    return manager?.getSessionId?.() ?? "";
  } catch {
    return "";
  }
}

interface CountedCalls {
  calls: number;
  errors: number;
  ms: number;
}

/**
 * Pi's registrar for this package's own hooks, observed. `pi.on` itself is never
 * mutated and no other extension's registration goes through here, so coverage
 * is exactly what this package registers and no more: every other installed
 * extension keeps its hooks uninstrumented.
 *
 * Every handler is called once, at the moment Pi calls it, with its own
 * arguments: the observer adds no await in front of it and registration order is
 * unchanged. Its exact result comes back untouched, an `undefined` return
 * included — a handler that acts through side effects is not skipped, so no row
 * claims a skip. A thrown error is reported and then rethrown as the same
 * object, and a rejected result is returned as the same rejection: identity,
 * message and stack are Pi's, not the observer's. With no consumer, no
 * `pi.events`, or a listener that throws, the handler's own path is identical.
 *
 * One routine row per execution names the extension, the hook, its duration and
 * whether it threw; it carries no hook payload, tool argument, tool result or
 * model text. The `COUNTER_ONLY_HOOKS` above are totals instead: their calls are
 * counted and published as one aggregated row at the next ordinary hook, so a
 * stream cannot flood the feed. A hook row offers no fallback: there is no
 * per-hook notice to restore. The observer only publishes on the ordinary event
 * channel, so it never observes its own publication.
 */
export function observingHooks(
  pi: Pick<ExtensionAPI, "on"> & ActivityEventSink,
  extension: string = HOOK_EXTENSION,
): Pick<ExtensionAPI, "on"> {
  // SAFETY: Pi declares one overload per hook name; this is the one place that
  // has to take any of them by name. The cast only widens `on` to that shape and
  // `register` forwards every argument unchanged.
  const register = pi.on as unknown as (
    hook: string,
    handler: (event: unknown, ctx: unknown) => unknown,
  ) => unknown;
  /** Calls of a counter-only hook since the last ordinary one, folded into a row when that row is published. */
  const counts = new Map<string, CountedCalls>();

  /** One row, published best-effort: a dropped row is worth less than a hook that behaves differently. */
  const emitRow = (
    hook: string,
    durationMs: number,
    failed: boolean,
    ctx: unknown,
    counted?: CountedCalls,
  ): void => {
    try {
      publishActivityEvent(pi, {
        session: hookSession(ctx),
        actor: hookActor(),
        source: "hooks",
        kind: "hook",
        severity: failed ? "error" : "info",
        summary: `${extension} hook ${hook} ${failed ? "error" : "ok"}`,
        ...(counted ? { details: `calls: ${counted.calls}, errors: ${counted.errors}` } : {}),
        correlation: { extension, hook, durationMs },
      });
    } catch {
      // Telemetry must never change a hook's own behavior.
    }
  };

  /** The streaming hooks' calls, as the one row per hook they earn; an ordinary hook is the moment to flush them. */
  const flush = (ctx: unknown): void => {
    for (const [hook, counted] of counts) {
      counts.delete(hook);
      emitRow(hook, counted.ms, counted.errors > 0, ctx, counted);
    }
  };

  const observe = (hook: string, started: number, failed: boolean, ctx: unknown): void => {
    const ms = Date.now() - started;
    if (COUNTER_ONLY_HOOKS.has(hook)) {
      const counted = counts.get(hook) ?? { calls: 0, errors: 0, ms: 0 };
      counts.set(hook, {
        calls: counted.calls + 1,
        errors: counted.errors + (failed ? 1 : 0),
        ms: counted.ms + ms,
      });
      return;
    }
    flush(ctx);
    emitRow(hook, ms, failed, ctx);
  };

  // SAFETY: the returned object has the one member of Pi's registrar and
  // forwards every handler's exact result, so the per-hook overloads (the only
  // thing the cast restores) describe call sites correctly again.
  return {
    on: ((hook: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      register(hook, (event, ctx) => {
        const started = Date.now();
        let outcome: unknown;
        try {
          outcome = handler(event, ctx);
        } catch (error) {
          observe(hook, started, true, ctx);
          throw error;
        }
        if (isPending(outcome)) {
          outcome.then(
            () => observe(hook, started, false, ctx),
            () => observe(hook, started, true, ctx),
          );
          return outcome;
        }
        observe(hook, started, false, ctx);
        return outcome;
      })) as unknown as ExtensionAPI["on"],
  };
}
