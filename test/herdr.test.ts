import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTerminalAvailable, paneRunLabel, __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

describe("herdr.ts", () => {
  describe("isTerminalAvailable", () => {
    it("returns boolean based on HERDR_ENV", () => {
      const result = isTerminalAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("herdr command construction", () => {
    it("creates the shared agents tab in the current workspace", () => {
      assert.deepEqual(__herdrTest__.buildTabCreateArgs("/repo", "workspace-2"), [
        "tab",
        "create",
        "--workspace",
        "workspace-2",
        "--label",
        "agents",
        "--cwd",
        "/repo",
        "--no-focus",
      ]);
    });

    it("splits a pane inside the agents tab without stealing focus", () => {
      assert.deepEqual(__herdrTest__.buildPaneSplitArgs("pane-1", "down", "/repo"), [
        "pane",
        "split",
        "pane-1",
        "--direction",
        "down",
        "--cwd",
        "/repo",
        "--no-focus",
      ]);
    });

    it("splits the largest pane and picks direction from its shape", () => {
      const panes = [
        { pane_id: "small", rect: { width: 40, height: 20 } },
        { pane_id: "wide", rect: { width: 120, height: 20 } },
        { pane_id: "tall", rect: { width: 30, height: 60 } },
      ];
      assert.deepEqual(__herdrTest__.pickSplitTarget(panes, "fallback"), {
        paneId: "wide",
        direction: "right",
      });
      assert.deepEqual(
        __herdrTest__.pickSplitTarget([{ pane_id: "tall", rect: { width: 30, height: 60 } }], "fallback"),
        { paneId: "tall", direction: "down" },
      );
      assert.deepEqual(__herdrTest__.pickSplitTarget([], "fallback"), {
        paneId: "fallback",
        direction: "right",
      });
    });

    it("constructs report-metadata arguments with the bounded label token", () => {
      assert.deepEqual(
        __herdrTest__.buildPaneReportTaskArgs("pane-1", "meta-role/Meta Worker/ab12cd34", "pi"),
        [
          "pane",
          "report-metadata",
          "pane-1",
          "--source",
          "pi",
          "--token",
          "task=meta-role/Meta Worker/ab12cd34",
        ],
      );
    });

    it("flattens multi-line and tab-padded labels into a single line", () => {
      assert.deepEqual(
        __herdrTest__.buildPaneReportTaskArgs(
          "pane-2",
          "  Line 1\n\tLine 2\r\nLine 3  ",
          "pi",
        ),
        [
          "pane",
          "report-metadata",
          "pane-2",
          "--source",
          "pi",
          "--token",
          "task=Line 1 Line 2 Line 3",
        ],
      );
    });

    it("builds a bounded role/name/run label from existing identifiers", () => {
      assert.equal(
        paneRunLabel("meta-role", "Meta Worker", "ab12cd34"),
        "meta-role/Meta Worker/ab12cd34",
      );
      // A bare call has no distinct role; the display name still identifies the run.
      assert.equal(paneRunLabel(undefined, "Meta Worker", "ab12cd34"), "Meta Worker/ab12cd34");
      assert.equal(paneRunLabel("Meta Worker", "Meta Worker", "ab12cd34"), "Meta Worker/ab12cd34");
      // The label cannot grow pane metadata without bound.
      assert.ok(paneRunLabel(undefined, "x".repeat(200), "id").length <= 80);
    });
  });

  describe("herdr response parsing", () => {
    it("extracts the root pane id from a tab create response", () => {
      const output = JSON.stringify({
        result: {
          tab: { tab_id: "1:2" },
          root_pane: { pane_id: "1-2" },
        },
      });
      assert.equal(__herdrTest__.extractHerdrPaneId(output, "tab create", "root_pane"), "1-2");
    });

    it("extracts the new pane id from a pane split response", () => {
      const output = JSON.stringify({
        result: { pane: { pane_id: "1-3" }, type: "pane_info" },
      });
      assert.equal(__herdrTest__.extractHerdrPaneId(output, "pane split", "pane"), "1-3");
    });

    it("throws on malformed herdr JSON", () => {
      assert.throws(
        () => __herdrTest__.extractHerdrPaneId("not json", "tab create", "root_pane"),
        /Unexpected herdr tab create output/,
      );
    });

    it("parses pane-not-found JSON from stderr-shaped errors", () => {
      const result = __herdrTest__.parsePaneGetError({
        stderr: JSON.stringify({ error: { code: "pane_not_found", message: "pane gone" } }),
        stdout: "",
      });
      assert.deepEqual(result, { kind: "missing", error: "pane gone" });
    });

    it("continues from non-JSON stderr to structured stdout", () => {
      const result = __herdrTest__.parsePaneGetError({
        stderr: "warning: connection closed",
        stdout: JSON.stringify({ error: { code: "pane_not_found", message: "pane gone" } }),
      });
      assert.deepEqual(result, { kind: "missing", error: "pane gone" });
    });

    it("returns unavailable when both error streams are non-JSON", () => {
      const result = __herdrTest__.parsePaneGetError({
        message: "command failed",
        stderr: "warning: connection closed",
        stdout: "not json either",
      });
      assert.deepEqual(result, { kind: "unavailable", error: "command failed" });
    });

    it("recognizes plain-text pane_not_found on stderr", () => {
      const result = __herdrTest__.parsePaneGetError({
        stderr: "pane_not_found: pane w1:p1 not found",
        stdout: "unrelated output",
      });
      assert.deepEqual(result, {
        kind: "missing",
        error: "pane_not_found: pane w1:p1 not found",
      });
    });

    it("recognizes plain-text not_found on stdout after malformed stderr", () => {
      const result = __herdrTest__.parsePaneGetError({
        stderr: "{malformed json",
        stdout: "not_found: pane w1:p1",
      });
      assert.deepEqual(result, { kind: "missing", error: "not_found: pane w1:p1" });
    });

    it("normalizes unknown agent_status values", () => {
      const result = __herdrTest__.parsePaneGetOutput(JSON.stringify({
        result: { pane: { pane_id: "w1:p1", agent: "pi", agent_status: "paused" } },
      }), "w1:p1");
      assert.deepEqual(result, { kind: "present", agent: "pi", agentStatus: "unknown" });
    });
  });
});
