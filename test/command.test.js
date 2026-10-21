import assert from "node:assert/strict";
import test from "node:test";
import { makeState } from "./helpers.js";
import { handlePrivacyCommand } from "../dist/command.js";

test("status reports the toggle, vault, and counters", async () => {
  const { state } = await makeState();
  const result = handlePrivacyCommand("status", "s1", { version: "0.1.0", state });
  assert.equal(result.kind, "success");
  assert.match(result.text, /session s1: ON/);
  assert.match(result.text, /vault: memory/);
});

test("on/off toggles the current session and warns about history", async () => {
  const { state } = await makeState();
  const off = handlePrivacyCommand("off", "s1", { version: "0.1.0", state });
  assert.match(off.text, /now OFF/);
  assert.equal(state.isEnabled("s1"), false);
  const on = handlePrivacyCommand("on", "s1", { version: "0.1.0", state });
  assert.match(on.text, /NOT retroactively masked/);
  assert.equal(state.isEnabled("s1"), true);
});

test("global on/off changes the default", async () => {
  const { state } = await makeState();
  handlePrivacyCommand("global off", undefined, { version: "0.1.0", state });
  assert.equal(state.isEnabled("other"), false);
  handlePrivacyCommand("global on", undefined, { version: "0.1.0", state });
  assert.equal(state.isEnabled("other"), true);
});

test("test runs the local sentinel", async () => {
  const { state } = await makeState();
  const result = handlePrivacyCommand("test", "s1", { version: "0.1.0", state });
  assert.equal(result.kind, "success");
  assert.match(result.text, /PASS/);
  assert.match(result.text, /PHONE/);
  assert.match(result.text, /EMAIL/);
});

test("demo prints the synthetic chain without touching the vault", async () => {
  const { state } = await makeState();
  const before = state.vault.size;
  const result = handlePrivacyCommand("demo", "s1", { version: "0.1.0", state });
  assert.equal(result.kind, "success");
  assert.match(result.text, /secure_run/);
  assert.match(result.text, /vault\.substitute/);
  assert.equal(state.vault.size, before);
});

test("unknown subcommand returns usage", async () => {
  const { state } = await makeState();
  const result = handlePrivacyCommand("nope", "s1", { version: "0.1.0", state });
  assert.equal(result.kind, "error");
  assert.match(result.text, /usage/);
});
