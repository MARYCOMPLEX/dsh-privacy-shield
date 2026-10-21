import assert from "node:assert/strict";
import test from "node:test";
import { makeCtx, makeState, userMessage, textOf } from "./helpers.js";
import { registerHooks } from "../dist/hooks.js";

const signal = new AbortController().signal;

function exec(name, args, sessionId = "s1") {
  return { callId: "c1", name, arguments: args, agent: { session: { id: sessionId } }, signal };
}

test("pre-step masks user messages and records counts", async () => {
  const ctx = makeCtx();
  const { state } = await makeState();
  registerHooks(ctx, state);
  const message = userMessage("call 13800138000 or email a@b.com");
  const decision = await ctx.dispatch(
    "agent/pre-step",
    [{ agent: { session: { id: "s1" } }, messages: [message], turn: 1, step: 1, signal }],
    async () => ({ kind: "enter", messages: [message] }),
  );
  assert.equal(decision.kind, "enter");
  const text = textOf(decision.messages[0]);
  assert.match(text, /\{\{PHONE_[a-z2-7]{6}\}\}/);
  assert.match(text, /\{\{EMAIL_[a-z2-7]{6}\}\}/);
  assert.equal(state.statsFor("s1").masked, 2);
});

test("pre-step honors the per-session off switch", async () => {
  const ctx = makeCtx();
  const { state } = await makeState();
  registerHooks(ctx, state);
  state.setSessionEnabled("s1", false);
  const message = userMessage("call 13800138000");
  const decision = await ctx.dispatch(
    "agent/pre-step",
    [{ agent: { session: { id: "s1" } }, messages: [message], turn: 1, step: 1, signal }],
    async () => ({ kind: "enter", messages: [message] }),
  );
  assert.equal(textOf(decision.messages[0]), "call 13800138000");
  assert.equal(state.statsFor("s1").masked, 0);
});

test("tool-post masks canonical value and rendered content", async () => {
  const ctx = makeCtx();
  const { state } = await makeState();
  registerHooks(ctx, state);

  const valueDecision = await ctx.dispatch(
    "tools/post-execute",
    [exec("bash", {}), { isError: false, value: { key: "sk-1234567890abcdefghijklmn" }, content: [] }],
    async () => ({ kind: "accept" }),
  );
  assert.match(valueDecision.value.key, /^\{\{API_KEY_[a-z2-7]{6}\}\}$/);

  const contentDecision = await ctx.dispatch(
    "tools/post-execute",
    [exec("bash", {}), { isError: false, value: undefined, content: [{ type: "text", text: "phone 13800138000" }] }],
    async () => ({ kind: "accept" }),
  );
  assert.match(contentDecision.content[0].text, /\{\{PHONE_[a-z2-7]{6}\}\}/);
});

test("tool-post respects a downstream block decision", async () => {
  const ctx = makeCtx();
  const { state } = await makeState();
  registerHooks(ctx, state);
  const decision = await ctx.dispatch(
    "tools/post-execute",
    [exec("bash", {}), { isError: false, value: "sk-1234567890abcdefghijklmn", content: [] }],
    async () => ({ kind: "block", feedback: [{ type: "text", text: "denied" }] }),
  );
  assert.equal(decision.kind, "block");
});

test("tool-pre denies normal tools carrying a token and allows secure tools", async () => {
  const ctx = makeCtx();
  const { state } = await makeState();
  registerHooks(ctx, state);

  const denied = await ctx.dispatch(
    "tools/pre-execute",
    [exec("bash", { command: "echo {{PHONE_abcdef}}" })],
    async () => ({ kind: "allow" }),
  );
  assert.equal(denied.kind, "deny");
  assert.match(denied.reason, /secure_run/);

  const allowed = await ctx.dispatch(
    "tools/pre-execute",
    [exec("secure_run", { command: "echo {{PHONE_abcdef}}" })],
    async () => ({ kind: "allow" }),
  );
  assert.equal(allowed.kind, "allow");
});

test("telemetry masks its body and can be switched off", async () => {
  const ctx = makeCtx();
  const { state } = await makeState();
  registerHooks(ctx, state);
  const record = {
    channel: "ledger",
    time: 1,
    severity: "info",
    attributes: { "session.id": "s1" },
    body: { prompt: "email a@b.com", n: 1 },
  };
  const masked = await ctx.dispatch("session-telemetry/record", [record], () => record);
  assert.match(masked.body.prompt, /\[REDACTED:EMAIL\]/);

  state.setSessionEnabled("s1", false);
  const untouched = await ctx.dispatch("session-telemetry/record", [record], () => record);
  assert.equal(untouched.body.prompt, "email a@b.com");
});
