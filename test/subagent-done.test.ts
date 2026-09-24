import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import subagentDoneExtension, { shouldMarkUserTookOver, shouldAutoExitOnAgentEnd, findLatestAssistantError, buildCompletionSidecar } from "../pi-extension/subagents/subagent-done.ts";
import { createMockExtensionApi, restoreEnvVar, withTempDir } from "./helpers.ts";

describe("subagent-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });
  });

  describe("auto-exit lifecycle", () => {
    it("waits for agent_settled and uses the latest agent result", () => {
      withTempDir((dir) => {
        const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
        const previousSession = process.env.PI_SUBAGENT_SESSION;
        const sessionFile = join(dir, "child.jsonl");
        process.env.PI_SUBAGENT_AUTO_EXIT = "1";
        process.env.PI_SUBAGENT_SESSION = sessionFile;

        try {
          const { api, eventHandlers } = createMockExtensionApi();
          subagentDoneExtension(api);
          const agentEnd = eventHandlers.get("agent_end")![0];
          const agentSettled = eventHandlers.get("agent_settled")![0];
          let shutdowns = 0;
          const ctx = { shutdown: () => { shutdowns += 1; } };

          agentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
          assert.equal(shutdowns, 0, "agent_end must not shut down before Pi settles");
          assert.equal(existsSync(`${sessionFile}.exit`), false);

          agentEnd({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "latest failure" }] }, ctx);
          agentSettled({ type: "agent_settled" }, ctx);

          assert.equal(shutdowns, 1);
          assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
            type: "error",
            errorMessage: "latest failure",
            stopReason: "error",
          });
        } finally {
          restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
          restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
        }
      });
    });

    it("preserves an aborted worker after agent_settled", () => {
      const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      try {
        const { api, eventHandlers } = createMockExtensionApi();
        subagentDoneExtension(api);
        let shutdowns = 0;
        const ctx = { shutdown: () => { shutdowns += 1; } };
        eventHandlers.get("agent_end")![0]({
          messages: [{ role: "assistant", stopReason: "aborted" }],
        }, ctx);
        eventHandlers.get("agent_settled")![0]({ type: "agent_settled" }, ctx);
        assert.equal(shutdowns, 0);
      } finally {
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
      }
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });

  describe("buildCompletionSidecar", () => {
    it("emits done immediately for a normal auto-exit completion", () => {
      assert.deepEqual(buildCompletionSidecar([
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ]), { type: "done" });
    });

    it("preserves provider errors in the immediate completion sidecar", () => {
      assert.deepEqual(buildCompletionSidecar([
        { role: "assistant", stopReason: "error", errorMessage: "provider failed" },
      ]), {
        type: "error",
        errorMessage: "provider failed",
        stopReason: "error",
      });
    });
  });
});
