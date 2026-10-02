import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_AGENT_SELECTION_PROMPT, DEFAULT_SELECTED_AGENT_PROMPT, loadAgentContext } from "./agent-context.js";

const directory = (): string => mkdtempSync(join(tmpdir(), "finleet-agent-"));

test("AGENT.md context appends the working-folder instructions after the default file", () => {
  const root = directory();
  const working = join(root, "workspace");
  const defaultFile = join(root, "default.md");
  mkdirSync(working);
  writeFileSync(defaultFile, "default instructions", "utf8");
  writeFileSync(join(working, "AGENT.md"), "working instructions", "utf8");
  const result = loadAgentContext({ get: (name) => name === "FINLEET_AGENT_FILE" ? defaultFile : undefined }, working);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.indexOf(DEFAULT_AGENT_SELECTION_PROMPT) < result.value.indexOf(DEFAULT_SELECTED_AGENT_PROMPT), true);
    assert.equal(result.value.indexOf(DEFAULT_SELECTED_AGENT_PROMPT) < result.value.indexOf("default instructions"), true);
    assert.equal(result.value.indexOf("default instructions") < result.value.indexOf("working instructions"), true);
  }
});

test("custom agent selector instructions replace the built-in first layer", () => {
  const root = directory();
  const selectorFile = join(root, "selector.md");
  writeFileSync(selectorFile, "Select the configured default specialist.", "utf8");
  const result = loadAgentContext({ get: (name) => name === "FINLEET_AGENT_SELECTOR_FILE" ? selectorFile : name === "HOME" ? root : undefined }, join(root, "missing"));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.startsWith("<agent_selection>\nSelect the configured default specialist.\n</agent_selection>"), true);
    assert.equal(result.value.includes(DEFAULT_AGENT_SELECTION_PROMPT), false);
    assert.equal(result.value.includes(DEFAULT_SELECTED_AGENT_PROMPT), true);
  }
});

test("credential-shaped content in the selector layer is redacted", () => {
  const root = directory();
  const selectorFile = join(root, "selector.md");
  writeFileSync(selectorFile, "Select default with apiKey=private-selector-secret", "utf8");
  const result = loadAgentContext({ get: (name) => name === "FINLEET_AGENT_SELECTOR_FILE" ? selectorFile : name === "HOME" ? root : undefined }, join(root, "missing"));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.includes("private-selector-secret"), false);
    assert.equal(result.value.includes("[REDACTED]"), true);
  }
});

test("missing instruction files still provide both built-in layers", () => {
  const root = directory();
  const result = loadAgentContext({ get: (name) => name === "HOME" ? root : undefined }, join(root, "missing"));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.includes(`<agent_selection>\n${DEFAULT_AGENT_SELECTION_PROMPT}\n</agent_selection>`), true);
    assert.equal(result.value.includes(`<selected_agent>\n${DEFAULT_SELECTED_AGENT_PROMPT}\n</selected_agent>`), true);
  }
});

test("missing AGENT.md files are optional and credential-shaped content is redacted", () => {
  const root = directory();
  const file = join(root, "AGENT.md");
  writeFileSync(file, "Use apiKey=private-agent-secret", "utf8");
  const result = loadAgentContext({ get: (name) => name === "FINLEET_AGENT_FILE" ? file : undefined }, join(root, "missing"));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.includes("private-agent-secret"), false);
    assert.equal(result.value.includes("[REDACTED]"), true);
  }
});

test("oversized AGENT.md fails before provider execution", () => {
  const root = directory();
  const file = join(root, "AGENT.md");
  writeFileSync(file, "x".repeat(16 * 1024 + 1), "utf8");
  const result = loadAgentContext({ get: (name) => name === "FINLEET_AGENT_FILE" ? file : undefined }, root);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "AGENT_FILE_TOO_LARGE");
});

test("oversized agent selector file fails before provider execution", () => {
  const root = directory();
  const file = join(root, "selector.md");
  writeFileSync(file, "x".repeat(16 * 1024 + 1), "utf8");
  const result = loadAgentContext({ get: (name) => name === "FINLEET_AGENT_SELECTOR_FILE" ? file : name === "HOME" ? root : undefined }, root);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "AGENT_FILE_TOO_LARGE");
});
