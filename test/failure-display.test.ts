import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { deliverRunFailure } from "../pi-extension/subagents/run.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { createMockExtensionApi } from "./helpers.ts";

function createTheme() {
  return {
    fg(_color: string, text: string) {
      return text;
    },
    bg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };
}

describe("subagent failure display", () => {
  it("reports a rejected watcher as a failed result, not a completed one", () => {
    // The renderer's expand hint resolves keybindings through the real theme.
    initTheme("dark", false);
    const { api, registeredMessageRenderers, sentMessages } = createMockExtensionApi();
    // Loading the extension registers the real subagent_result renderer.
    (subagentsModule as any).default(api);

    const run = {
      id: "run-failure",
      name: "Watcher",
      task: "do the work",
      surface: "fx:1",
      startTime: Date.now(),
      sessionFile: "child.jsonl",
      interactive: false,
      runtimePlan: undefined,
      lifecycle: createLifecycle(Date.now()),
    };

    deliverRunFailure(api, run as any, new Error("watcher exploded"));

    assert.equal(sentMessages.length, 1);
    const message = sentMessages[0].message;
    assert.equal(message.details.exitCode, 1);
    assert.equal(message.details.errorMessage, "watcher exploded");

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_result");
    assert.ok(rendererEntry, "expected the subagent_result renderer to be registered");
    const rendered = rendererEntry.renderer(message, { expanded: false }, createTheme()).render(80).join("\n");

    assert.match(rendered, /failed \(provider\/agent error\)/);
    assert.match(rendered, /✗/);
    assert.doesNotMatch(rendered, /✓/);
  });
});
