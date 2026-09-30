import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import subagentDone, { loadAssignedSkills } from "../pi-extension/subagents/subagent-done.ts";
import { PiHarnessDriver, readPiLaunchProfile, formatPiLaunch } from "../pi-extension/subagents/harness/drivers/pi.ts";
import { seedSubagentSessionFile, getNewEntries } from "../pi-extension/subagents/session.ts";
import { loadAgentDefaults } from "../pi-extension/subagents/discovery.ts";
import { createMockExtensionApi, restoreEnvVar, withTempDir, withIsolatedAgentEnv, writeAgentFile } from "./helpers.ts";

// Exercises the child catalog and input hook, without making model requests.
describe("assigned agent skills", () => {
  it("loads multiple instructions and the task in one input, preserving reference locations", () => {
    withTempDir((dir) => {
      const commands = ["review", "quality"].map((name) => {
        const path = join(dir, `${name}.md`);
        writeFileSync(path, `---\nname: ${name}\n---\n${name} instructions`);
        return { name: `skill:${name}`, source: "skill" as const, sourceInfo: { path, source: "test", scope: "user" as const, origin: "top-level" as const } };
      });
      const old = process.env.PI_SUBAGENT_SKILLS;
      process.env.PI_SUBAGENT_SKILLS = "review, quality, review";
      try {
        const mock = createMockExtensionApi();
        mock.api.getCommands = () => commands;
        subagentDone(mock.api);
        const result = mock.eventHandlers.get("input")![0]({ text: "Review the uncommitted fix", images: [] }, {});
        assert.equal(result.action, "transform");
        assert.equal(result.text.match(/review instructions/g).length, 1);
        assert.match(result.text, /quality instructions/);
        assert.ok(result.text.includes(`References are relative to ${dir}.`));
        assert.ok(result.text.endsWith("Review the uncommitted fix"));
        assert.doesNotMatch(result.text, /---/);
        assert.equal(loadAssignedSkills("none", commands), "");
        assert.throws(() => loadAssignedSkills("all", commands), /specific skill names/);
      } finally {
        restoreEnvVar("PI_SUBAGENT_SKILLS", old);
      }
    });
  });

  it("stops before task execution and records a failure when an assigned skill is missing", () => {
    withTempDir((dir) => {
      const previous = [process.env.PI_SUBAGENT_SKILLS, process.env.PI_SUBAGENT_SESSION];
      const session = join(dir, "session.jsonl");
      process.env.PI_SUBAGENT_SKILLS = "missing";
      process.env.PI_SUBAGENT_SESSION = session;
      try {
        const mock = createMockExtensionApi();
        mock.api.getCommands = () => [];
        subagentDone(mock.api);
        let stopped = false;
        const result = mock.eventHandlers.get("input")![0]({ text: "Do work" }, {
          ui: { notify() {} }, shutdown() { stopped = true; },
        });
        assert.equal(result.action, "handled");
        assert.equal(stopped, true);
        const sidecar = JSON.parse(readFileSync(`${session}.exit`, "utf8"));
        assert.equal(sidecar.type, "error");
        assert.match(sidecar.errorMessage, /missing/);
      } finally {
        restoreEnvVar("PI_SUBAGENT_SKILLS", previous[0]);
        restoreEnvVar("PI_SUBAGENT_SESSION", previous[1]);
      }
    });
  });

  it("parses role assignments and preserves the effective launch profile for resume", async () => {
    await withIsolatedAgentEnv(({ projectAgentsDir, projectDir }) => {
      writeAgentFile(projectAgentsDir, "profile-test", "name: profile-test\nskills: review, quality\nponytail: full\nspawning: false\nsystem-prompt: append");
      const defs = loadAgentDefaults("profile-test")!;
      assert.equal(defs.ponytail, "full");
      assert.equal(defs.skills, "review, quality");
      const session = join(projectDir, "session.jsonl");
      const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const built = new PiHarnessDriver().buildCommand({
        params: { id: "test", name: "Review", agent: "profile-test", task: "Review this fix", ponytail: "off" },
        agentDefs: defs,
        runtimePlan: { provider: "deepseek", modelId: "deepseek-pro", model: "deepseek/deepseek-pro", thinking: "high", modelSource: "request", thinkingSource: "request" },
        effectiveModel: "deepseek/deepseek-pro", effectiveThinking: "high", parentThinking: "high",
        surface: "pane-test", artifactDir: projectDir, sessionDir: projectDir, subagentSessionFile: session,
        effectiveCwd: projectDir, effectiveAutoExit: true, effectiveInteractive: false,
        inheritsConversationContext: false, taskDelivery: "artifact", subagentsDir: projectDir,
        identity: "Review only.", identityInSystemPrompt: true, systemPromptMode: "append",
        denySet: new Set(["subagent", "write"]), shellQuote: quote,
      });
      assert.doesNotMatch(built.command, /\/skill:/);
      assert.ok(built.command.includes("PI_SUBAGENT_SKILLS='review, quality'"));
      assert.ok(built.command.includes("PONYTAIL_DEFAULT_MODE='off'"));
      const profile = readPiLaunchProfile(session)!;
      assert.equal(profile.cwd, projectDir);
      assert.ok(profile.args.includes("--append-system-prompt"));
      assert.ok(profile.args.includes("--model"));
      assert.equal(profile.env.PI_DENY_TOOLS, "subagent,write");
      assert.equal(profile.env.PONYTAIL_DEFAULT_MODE, "off");
      assert.equal(profile.env.PI_SUBAGENT_SKILLS, "review, quality");
      assert.equal(profile.env.PI_SUBAGENT_ID, undefined);
      assert.ok(!profile.args.some((part) => part.startsWith("@")));
      assert.ok(formatPiLaunch({ ...profile, args: [...profile.args, "$(echo unsafe)"] }, quote).endsWith("'$(echo unsafe)'"));
      assert.equal(readPiLaunchProfile(join(projectDir, "legacy.jsonl")), null);
      writeFileSync(`${session}.launch.json`, '{"parts":false}');
      assert.throws(() => readPiLaunchProfile(session), /Invalid Pi launch profile/);
    });
  });

  it("overrides a fork's persisted Ponytail mode and blocks denied extension tools", () => {
    withTempDir((dir) => {
      const parent = join(dir, "parent.jsonl"), child = join(dir, "child.jsonl");
      writeFileSync(parent, [
        { type: "session", id: "parent", version: 3 },
        { type: "custom", id: "mode", parentId: null, customType: "ponytail-mode", data: { mode: "full" } },
        { type: "message", id: "task", parentId: "mode", message: { role: "user" } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      seedSubagentSessionFile({ mode: "fork", parentSessionFile: parent, childSessionFile: child, childCwd: dir, ponytail: "off" });
      const latest = getNewEntries(child, 0).at(-1)!;
      assert.equal(latest.customType, "ponytail-mode");
      assert.deepEqual(latest.data, { mode: "off" });
      assert.equal(latest.parentId, "mode");
      const old = process.env.PI_DENY_TOOLS;
      process.env.PI_DENY_TOOLS = "write";
      try {
        const mock = createMockExtensionApi();
        subagentDone(mock.api);
        const handler = mock.eventHandlers.get("tool_call")![0];
        assert.equal(handler({ toolName: "write" }).block, true);
        assert.equal(handler({ toolName: "read" }), undefined);
      } finally {
        restoreEnvVar("PI_DENY_TOOLS", old);
      }
    });
  });
});
