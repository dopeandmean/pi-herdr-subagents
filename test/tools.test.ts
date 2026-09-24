import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { createMockExtensionApi, testApi, withIsolatedAgentEnv, writeAgentFile } from "./helpers.ts";

describe("commands", () => {
  it("/iterate always emits a full-context fork tool call", () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    const iterate = registeredCommands.find((command) => command.name === "iterate");
    assert.ok(iterate, "expected /iterate to be registered");

    iterate.handler("Fix the bug", {});

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /fork: true/);
    assert.match(sentUserMessages[0], /interactive: true/);
    assert.match(sentUserMessages[0], /name: "Iterate"/);
  });
});

describe("tool registration", () => {
  it("advertises named agents and tells callers to preserve their runtime defaults", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "researcher",
        [
          "name: researcher",
          "description: Researches external topics using authoritative sources",
          "model: fake/research",
          "thinking: max",
        ].join("\n"),
      );

      const { api, registeredTools, eventHandlers } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const subagent = registeredTools.find((tool) => tool.name === "subagent");
      assert.ok(subagent);
      const sessionStart = eventHandlers.get("session_start")?.[0];
      assert.ok(sessionStart);
      sessionStart({}, {
        hasUI: false,
        modelRegistry: {
          find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
          getAvailable: () => [{
            provider: "fake",
            id: "parent",
            reasoning: true,
            input: ["text"],
            contextWindow: 128_000,
            maxTokens: 16_000,
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          }],
          hasConfiguredAuth: () => true,
        },
      });

      const guidance = subagent.promptGuidelines.join("\n");
      assert.match(guidance, /Available named subagents/);
      assert.match(
        guidance,
        /researcher.*Researches external topics using authoritative sources/,
      );
      assert.match(guidance, /omit.*model.*thinking.*named agent.*defaults/i);
      assert.match(
        subagent.parameters.properties.thinking.description,
        /named agent's thinking default/i,
      );
    });
  });

  it("refreshes subagent routing guidance from the live authenticated model registry", () => {
    const { api, registeredTools, eventHandlers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagent = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagent);
    const sessionStart = eventHandlers.get("session_start")?.[0];
    assert.ok(sessionStart);
    sessionStart({}, {
      hasUI: false,
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
        getAvailable: () => [{
          provider: "fake",
          id: "fast",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 16_000,
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        }],
        hasConfiguredAuth: () => true,
      },
    });

    assert.match(subagent.promptGuidelines.join("\n"), /fake\/fast/);
    assert.match(subagent.promptGuidelines.join("\n"), /inherit the parent runtime/);
  });

  it("ignores an inherited deny list in a parent process", () => {
    delete process.env.PI_SUBAGENT_ID;
    process.env.PI_DENY_TOOLS = "subagent,subagent_interrupt,subagent_resume,subagents_list";
    try {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      assert.equal(registeredTools.some((tool) => tool.name === "subagent"), true);
      assert.equal(registeredTools.some((tool) => tool.name === "subagent_interrupt"), true);
    } finally {
      delete process.env.PI_DENY_TOOLS;
    }
  });

  it("applies the deny list inside a child subagent process", () => {
    process.env.PI_SUBAGENT_ID = "child-test";
    process.env.PI_DENY_TOOLS = "subagent,subagent_interrupt";
    try {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      assert.equal(registeredTools.some((tool) => tool.name === "subagent"), false);
      assert.equal(registeredTools.some((tool) => tool.name === "subagent_interrupt"), false);
      assert.equal(registeredTools.some((tool) => tool.name === "subagents_list"), true);
    } finally {
      delete process.env.PI_SUBAGENT_ID;
      delete process.env.PI_DENY_TOOLS;
    }
  });

  it("defaults resumed subagents to auto-exit and non-interactive tracking", () => {

    assert.deepEqual(testApi.resolveResumeLaunchBehavior({}), {
      autoExit: true,
      interactive: false,
    });
    assert.deepEqual(testApi.resolveResumeLaunchBehavior({ autoExit: false }), {
      autoExit: false,
      interactive: true,
    });
  });

  it("expands spawning false to deny subagent interruption", () => {
    const denied = testApi.resolveDenyTools({ spawning: false });

    assert.equal(denied.has("subagent"), true);
    assert.equal(denied.has("subagent_interrupt"), true);
    assert.equal(denied.has("subagent_resume"), true);
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_resume with an autoExit override", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const resumeTool = registeredTools.find((tool) => tool.name === "subagent_resume");
    assert.ok(resumeTool, "expected subagent_resume tool to be registered");

    const autoExitSchema = resumeTool.parameters.properties.autoExit;
    assert.equal(autoExitSchema.type, "boolean");
    assert.match(autoExitSchema.description, /Defaults to true/);
  });
});
