import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadModelConfig, parseModelConfig, resolveModelDefault } from "../pi-extension/subagents/model-config.ts";
import { createTestDir } from "./helpers.ts";

describe("model configuration", () => {
  it("parses global and per-agent model defaults", () => {
    assert.deepEqual(
      parseModelConfig({
        models: {
          default: " anthropic/claude-sonnet-4-6 ",
          agents: { scout: " openai/gpt-5-mini " },
        },
      }),
      {
        default: "anthropic/claude-sonnet-4-6",
        agents: { scout: "openai/gpt-5-mini" },
      },
    );
  });

  it("loads no model overrides when config.json is absent", () => {
    const config = loadModelConfig(join(createTestDir(), "missing-config.json"));
    assert.deepEqual(config, { agents: {} });
  });

  it("resolves frontmatter, per-agent, global, and parent fallback precedence", () => {
    const config = parseModelConfig({
      models: {
        default: "fake/global",
        agents: { scout: "fake/scout" },
      },
    });

    assert.equal(resolveModelDefault("scout", "fake/frontmatter", config), "fake/frontmatter");
    assert.equal(resolveModelDefault("scout", undefined, config), "fake/scout");
    assert.equal(resolveModelDefault("reviewer", undefined, config), "fake/global");
    assert.equal(resolveModelDefault(undefined, undefined, { agents: {} }), undefined);
  });

  it("does not read inherited object properties as agent model defaults", () => {
    const config = parseModelConfig({ models: { agents: {} } });
    for (const agent of ["constructor", "toString", "__proto__"]) {
      assert.equal(resolveModelDefault(agent, undefined, config), undefined);
    }
  });

  it("supports reserved property names when explicitly configured", () => {
    const config = parseModelConfig(
      JSON.parse(
        '{"models":{"agents":{"constructor":"fake/constructor","__proto__":"fake/proto"}}}',
      ),
    );
    assert.equal(resolveModelDefault("constructor", undefined, config), "fake/constructor");
    assert.equal(resolveModelDefault("__proto__", undefined, config), "fake/proto");
  });

  it("rejects invalid model configuration", () => {
    assert.throws(() => parseModelConfig({ models: { default: "" } }), /non-empty string/);
    assert.throws(() => parseModelConfig({ models: { agents: [] } }), /must be an object/);
  });
});
