import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { observingHooks } from "../pi-extension/subagents/hooks.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { createMockExtensionApi } from "./helpers.ts";

type Handler = (event?: unknown, ctx?: unknown) => unknown;

/** A stand-in registrar that keeps handlers in registration order and collects emitted events. */
function mockRegistrar() {
  const handlers = new Map<string, Handler[]>();
  const events: Array<{ channel: string; data: any }> = [];
  const disposers: Array<() => void> = [];
  const pi = {
    on(hook: string, handler: Handler) {
      const list = handlers.get(hook) ?? [];
      list.push(handler);
      handlers.set(hook, list);
      const dispose = () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
      disposers.push(dispose);
      return dispose;
    },
    events: { emit: (channel: string, data: unknown) => events.push({ channel, data: data as any }) },
  };
  return { pi, handlers, events, disposers };
}

const ctx = { sessionManager: { getSessionId: () => "sess-1" } };

function fire(handlers: Map<string, Handler[]>, hook: string, event: unknown = {}): unknown {
  const list = handlers.get(hook);
  assert.ok(list && list.length > 0);
  let result: unknown;
  for (const handler of list) result = handler(event, ctx);
  return result;
}

/** Run fn with a clock that returns the given values in order, then repeats the last one. */
function withClock(values: number[], fn: () => void): void {
  const original = Date.now;
  let index = 0;
  Date.now = () => values[Math.min(index++, values.length - 1)];
  try {
    fn();
  } finally {
    Date.now = original;
  }
}

describe("observingHooks", () => {
  it("forwards the handler result unchanged and reports one row per execution", () => {
    const { pi, handlers, events } = mockRegistrar();
    const hooks = observingHooks(pi);
    const result = { action: "transform", text: "hi", images: [] };
    let calls = 0;
    hooks.on("input", () => {
      calls += 1;
      return result;
    });

    const returned = fire(handlers, "input", { text: "hi", images: [] });

    assert.equal(returned, result, "the exact object identity crosses the wrapper");
    assert.equal(calls, 1, "the handler runs exactly once per event");
    assert.equal(events.length, 1, "one row per execution");
    assert.equal(events[0].channel, "pi-activity:event");
    const row = events[0].data;
    assert.equal(row.source, "hooks");
    assert.equal(row.kind, "hook");
    assert.equal(row.severity, "info");
    assert.equal(row.summary, "herdr-subagents hook input ok");
    assert.equal(row.presentation, "routine");
    assert.equal(row.claimed, false);
    assert.equal("fallback" in row, false, "a hook row has no notice to restore");
    assert.equal(row.session, "sess-1");
    assert.equal(row.correlation.extension, "herdr-subagents");
    assert.equal(row.correlation.hook, "input");
    assert.ok(Number.isFinite(row.correlation.durationMs));
  });

  it("measures the handler duration into the correlation", () => {
    const { pi, handlers, events } = mockRegistrar();
    const hooks = observingHooks(pi);
    hooks.on("turn_end", () => {});

    withClock([100, 1_000, 2_000], () => fire(handlers, "turn_end"));

    assert.equal(events[0].data.correlation.durationMs, 900);
  });

  it("keeps a returned thenable a thenable and reports after it settles", async () => {
    const { pi, handlers, events } = mockRegistrar();
    const hooks = observingHooks(pi);
    const value = { action: "handled" };
    const pending = Promise.resolve(value);
    hooks.on("turn_end", () => pending);

    const returned = fire(handlers, "turn_end");
    assert.equal(returned, pending, "the original thenable is returned, not an awaited copy");
    assert.equal(events.length, 0, "nothing is published before settlement");

    assert.equal(await returned, value);
    await Promise.resolve();
    assert.equal(events.length, 1);
    assert.equal(events[0].data.severity, "info");
  });

  it("reports a rejected result and leaves the same rejection in place", async () => {
    const { pi, handlers, events } = mockRegistrar();
    const hooks = observingHooks(pi);
    const boom = new Error("boom");
    hooks.on("turn_end", () => Promise.reject(boom));

    const returned = fire(handlers, "turn_end");
    await assert.rejects(returned, (error) => error === boom);
    await Promise.resolve();
    assert.equal(events.length, 1);
    assert.equal(events[0].data.severity, "error");
    assert.equal(events[0].data.summary, "herdr-subagents hook turn_end error");
  });

  it("rethrows the same error object and reports severity error", () => {
    const { pi, handlers, events } = mockRegistrar();
    const hooks = observingHooks(pi);
    const boom = new Error("kaboom");
    hooks.on("tool_call", () => {
      throw boom;
    });

    assert.throws(() => fire(handlers, "tool_call", { toolName: "bash" }), (error) => error === boom);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.severity, "error");
    assert.equal(events[0].data.summary, "herdr-subagents hook tool_call error");
  });

  it("reports an undefined return as ok, never as skipped", () => {
    const { pi, handlers, events } = mockRegistrar();
    const hooks = observingHooks(pi);
    hooks.on("agent_start", () => {});

    assert.equal(fire(handlers, "agent_start"), undefined);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.severity, "info");
    assert.equal(events[0].data.summary, "herdr-subagents hook agent_start ok");
    assert.doesNotMatch(events[0].data.summary, /skip/i);
    assert.equal("details" in events[0].data, false, "nothing claims a skip");
  });

  it("returns the dispose function from the registration", () => {
    const { pi, handlers, disposers } = mockRegistrar();
    const hooks = observingHooks(pi);
    const dispose = hooks.on("turn_end", () => {}) as unknown as () => void;

    assert.equal(dispose, disposers[0]);
    assert.equal(handlers.get("turn_end")!.length, 1);
    dispose();
    assert.equal(handlers.get("turn_end")!.length, 0);
  });

  it("keeps registration order and runs each handler once", () => {
    const { pi, handlers, events } = mockRegistrar();
    const hooks = observingHooks(pi);
    const order: number[] = [];
    hooks.on("turn_end", () => { order.push(1); });
    hooks.on("turn_end", () => { order.push(2); });

    fire(handlers, "turn_end");
    assert.deepEqual(order, [1, 2]);
    assert.equal(events.length, 2);
  });

  it("counts streaming hooks and publishes one aggregated row at the next ordinary hook", () => {
    const { pi, handlers, events } = mockRegistrar();
    const hooks = observingHooks(pi);
    hooks.on("message_update", () => {});
    hooks.on("tool_execution_update", () => {});
    hooks.on("turn_end", () => {});

    const messageUpdate = handlers.get("message_update")![0];
    const toolUpdate = handlers.get("tool_execution_update")![0];
    for (let call = 0; call < 3; call++) messageUpdate({ secret: "PAYLOAD" }, ctx);
    toolUpdate({ secret: "PAYLOAD" }, ctx);
    toolUpdate({ secret: "PAYLOAD" }, ctx);
    assert.equal(events.length, 0, "a streaming hook publishes no per-call row");

    fire(handlers, "turn_end");
    assert.deepEqual(events.map((event) => event.data.summary), [
      "herdr-subagents hook message_update ok",
      "herdr-subagents hook tool_execution_update ok",
      "herdr-subagents hook turn_end ok",
    ]);
    assert.equal(events[0].data.details, "calls: 3, errors: 0");
    assert.equal(events[1].data.details, "calls: 2, errors: 0");
    assert.equal(events[0].data.correlation.hook, "message_update");
    assert.doesNotMatch(JSON.stringify(events), /PAYLOAD/, "no payload is retained");
  });

  it("folds streaming failures into one aggregated error row", () => {
    const { pi, handlers, events } = mockRegistrar();
    const hooks = observingHooks(pi);
    hooks.on("message_update", () => { throw new Error("stream failed"); });
    hooks.on("turn_end", () => {});

    const messageUpdate = handlers.get("message_update")![0];
    assert.throws(() => messageUpdate());
    assert.throws(() => messageUpdate());
    assert.equal(events.length, 0, "still no per-call row while only counters fired");

    fire(handlers, "turn_end");
    assert.deepEqual(events.map((event) => event.data.severity), ["error", "info"]);
    assert.equal(events[0].data.details, "calls: 2, errors: 2");
    assert.equal(events[0].data.summary, "herdr-subagents hook message_update error");
  });

  it("leaves the handler identical without a consumer, without pi.events, and with a throwing listener", () => {
    const result = { action: "handled" };
    const variants: Array<Record<string, unknown>> = [
      {},
      { events: null },
      { events: { emit() { throw new Error("listener exploded"); } } },
    ];
    for (const variant of variants) {
      let calls = 0;
      const registered: Handler[] = [];
      const pi = {
        on(_hook: string, handler: Handler) { registered.push(handler); },
        ...variant,
      };
      const hooks = observingHooks(pi as never);
      hooks.on("input", () => { calls += 1; return result; });
      assert.equal(registered[0]({}, ctx), result, "behavior survives a broken transport");
      assert.equal(calls, 1);
    }
  });

  it("instruments the real child registration and publishes a hook row", () => {
    const { api, eventHandlers } = createMockExtensionApi();
    const events: Array<{ channel: string; data: any }> = [];
    (api as any).events = { emit: (channel: string, data: unknown) => events.push({ channel, data: data as any }) };
    subagentDoneExtension(api);

    eventHandlers.get("turn_end")![0]({ turnIndex: 2 }, {});

    assert.equal(events.length, 1);
    assert.equal(events[0].channel, "pi-activity:event");
    assert.equal(events[0].data.source, "hooks");
    assert.equal(events[0].data.summary, "herdr-subagents hook turn_end ok");
  });
});
