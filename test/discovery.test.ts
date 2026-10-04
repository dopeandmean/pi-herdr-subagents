import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { createMockExtensionApi, testApi, withIsolatedAgentEnv, writeAgentFile } from "./helpers.ts";

describe("subagent discovery", () => {

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolves auto-exit and interactive behavior for named and bare spawns", () => {
    // Autonomous named agents are not interactive, so the parent gets status pings.
    assert.equal(
      testApi.resolveEffectiveAutoExit({ name: "A", task: "T" }, { autoExit: true }),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }),
      false,
    );

    // Named agents without auto-exit preserve their interactive behavior.
    assert.equal(
      testApi.resolveEffectiveAutoExit({ name: "A", task: "T" }, { autoExit: false }),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }),
      true,
    );

    // Bare task spawns are autonomous by default. Otherwise a normal final
    // answer leaves the child open and no completion is delivered to the parent.
    assert.equal(testApi.resolveEffectiveAutoExit({ name: "A", task: "T" }, null), true);
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null), false);

    // A bare full-context fork invoked directly through the tool is still an
    // autonomous task. Forking only controls inherited conversation context.
    assert.equal(
      testApi.resolveEffectiveAutoExit({ name: "A", task: "T", fork: true }, null),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T", fork: true }, null),
      false,
    );

    // Interactive fork workflows such as /iterate opt out explicitly.
    assert.equal(
      testApi.resolveEffectiveAutoExit(
        { name: "A", task: "T", fork: true, interactive: true },
        null,
      ),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", fork: true, interactive: true },
        null,
      ),
      true,
    );
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { interactive: false },
      ),
      false,
    );
  });

  it("resolveEffectiveInteractive honors the explicit tool parameter over all else", () => {
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: false },
        { autoExit: false, interactive: true },
      ),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: true },
        { autoExit: true, interactive: false },
      ),
      true,
    );
  });

  it("bundled role profiles preserve their runtime and interaction defaults", async () => {
    await withIsolatedAgentEnv(() => {
      const expectedInteraction = {
        orchestrator: false,
        "subagent-explorer": false,
        "subagent-worker": false,
        "subagent-reviewer": false,
        "subagent-tester": false,
        "subagent-quality": false,
        planner: true,
        "visual-tester": false,
      } as const;

      for (const [name, interactive] of Object.entries(expectedInteraction)) {
        const defs = testApi.loadAgentDefaults(name);
        assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
        if (name === "planner" || name === "visual-tester") {
          assert.equal(defs.model, undefined);
          assert.equal(defs.thinking, undefined);
        } else {
          assert.match(defs.model!, /^deepseek\/deepseek-(flash|v4-pro)$/);
          assert.ok(defs.thinking);
          assert.equal(defs.sessionMode, "lineage-only");
          assert.equal(defs.ponytail, name === "orchestrator" || name === "subagent-worker" ? "full" : "off");
        }
        assert.equal(
          testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
          interactive,
          `${name} should preserve its interaction mode`,
        );
      }
    });
  });

  it("bundled role profiles keep codemode's underlying tools available", async () => {
    await withIsolatedAgentEnv(() => {
      const required: Record<string, string[]> = {
        orchestrator: ["read", "bash", "write", "fffind", "ffgrep"],
        "subagent-explorer": ["read", "fffind", "ffgrep"],
        "subagent-worker": ["read", "bash", "edit", "write", "fffind", "ffgrep"],
        "subagent-reviewer": ["read", "bash", "fffind", "ffgrep"],
        "subagent-tester": ["read", "bash", "fffind", "ffgrep"],
        "subagent-quality": ["read", "bash", "fffind", "ffgrep"],
        "visual-tester": ["read", "bash", "write"],
      };
      const forbidden: Record<string, string[]> = {
        "subagent-explorer": ["edit", "write"],
        "subagent-reviewer": ["edit", "write"],
        "subagent-tester": ["edit", "write"],
        "subagent-quality": ["edit", "write"],
      };
      for (const [name, tools] of Object.entries(required)) {
        const defs = testApi.loadAgentDefaults(name);
        assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
        const active = (defs.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
        assert.ok(active.includes("codemode"), `${name} must keep codemode active`);
        for (const tool of forbidden[name] ?? []) {
          assert.ok(!active.includes(tool), `${name} must stay no-authoring (no ${tool})`);
        }
        for (const tool of tools) {
          assert.ok(active.includes(tool), `${name} must keep ${tool} active for codemode scripts`);
        }
      }
    });
  });

  it("treats a blank frontmatter value as absent instead of reading the next line", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "blank-value-agent",
        [
          "name: blank-value-agent",
          "model: deepseek/deepseek-flash",
          "skills:",
          "ponytail: off",
        ].join("\n"),
      );
      const loaded = testApi.loadAgentDefaults("blank-value-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.skills, undefined);
      assert.equal(loaded.ponytail, "off");
      const orchestrator = testApi.loadAgentDefaults("orchestrator");
      assert.ok(orchestrator, "expected bundled orchestrator to be discoverable");
      assert.ok(
        orchestrator.skills === undefined || orchestrator.skills === "none",
        `orchestrator skills must be absent or none, got ${JSON.stringify(orchestrator.skills)}`,
      );
    });
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode with fork override precedence", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,caller_ping,subagent_done",
    );
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("resolves loadAgentDefaults by the frontmatter name the catalog advertises, not the filename", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "renamed-file-test-agent",
        [
          "name: aliased-test-agent",
          "description: Frontmatter name differs from filename",
          "model: anthropic/test-aliased",
        ].join("\n"),
        "You are the aliased agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      const result = await tool.execute();
      const agents = result.details?.agents ?? [];
      assert.ok(
        agents.some((agent: any) => agent.name === "aliased-test-agent"),
        "catalog should advertise the frontmatter name",
      );

      const loadedByFrontmatterName = testApi.loadAgentDefaults("aliased-test-agent");
      assert.ok(
        loadedByFrontmatterName,
        "loadAgentDefaults must resolve the same name the catalog advertises",
      );
      assert.equal(loadedByFrontmatterName.model, "anthropic/test-aliased");

      const loadedByFilename = testApi.loadAgentDefaults("renamed-file-test-agent");
      assert.equal(
        loadedByFilename,
        null,
        "the filename alone should not resolve once frontmatter overrides the name",
      );
    });
  });

  it("discoverAgentDefinitions skips an unreadable entry instead of aborting discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "readable-sibling-test-agent",
        ["name: readable-sibling-test-agent", "description: Should still be discovered"].join("\n"),
      );
      // A directory ending in .md passes the file filter but throws EISDIR on
      // read — previously this aborted discoverAgentDefinitions() entirely.
      mkdirSync(join(projectAgentsDir, "broken-entry-test-agent.md"));

      const agents = testApi.discoverAgentDefinitions();
      assert.ok(
        agents.some((agent: any) => agent.name === "readable-sibling-test-agent"),
        "a broken sibling entry should not prevent discovery of valid agents",
      );
    });
  });

  it("strips surrounding quotes from a quoted command: frontmatter value", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "quoted-command-test-agent",
        [
          "name: quoted-command-test-agent",
          `command: "aider --model {model} --message {task}"`,
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("quoted-command-test-agent");
      assert.equal(loaded?.commandTemplate, "aider --model {model} --message {task}");
    });
  });

  it("leaves an unquoted command: frontmatter value untouched", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "unquoted-command-test-agent",
        ["name: unquoted-command-test-agent", "command: aider --model {model} --message {task}"].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("unquoted-command-test-agent");
      assert.equal(loaded?.commandTemplate, "aider --model {model} --message {task}");
    });
  });

  it("buildAvailableAgentCatalog reflects a config.json model override, not just frontmatter", () => {
    const agents = [
      {
        name: "config-override-test-agent",
        source: "project" as const,
        description: "Agent without a frontmatter model",
        disableModelInvocation: false,
      },
    ];

    const withoutOverride = testApi.buildAvailableAgentCatalog(agents, 24, { agents: {} });
    assert.doesNotMatch(withoutOverride, /model /);

    const withOverride = testApi.buildAvailableAgentCatalog(agents, 24, {
      agents: { "config-override-test-agent": "anthropic/test-config-model" },
    });
    assert.match(withOverride, /model anthropic\/test-config-model/);
  });
});
