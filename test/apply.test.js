import assert from "node:assert/strict";
import test from "node:test";
import { makeCtx } from "./helpers.js";
import { apply, VERSION } from "../dist/index.js";

test("apply wires hooks, command, secure tools, and the guidance section", async () => {
  const ctx = makeCtx();
  await apply(ctx, { mode: "vault", vault: { backend: "memory" }, secureTools: { enabled: true } });
  assert.equal(ctx.registeredCommands.length, 1);
  assert.equal(ctx.registeredCommands[0].name, "privacy");
  assert.ok(ctx.registeredTools.has("secure_run"));
  assert.ok(ctx.registeredTools.has("secure_read"));
  assert.ok(ctx.registeredTools.has("secure_edit"));
  assert.ok(ctx.registeredTools.has("secure_write"));
  assert.ok(ctx.registeredTools.has("secure_request"));
  assert.equal(ctx.promptSections.length, 1);
  assert.match(ctx.promptSections[0].text, /secure_run/);
  assert.equal(ctx.effects.length, 3);

  const status = ctx.registeredCommands[0].handler({ rawInput: "", agent: { session: { id: "s1" } } });
  assert.equal(status.kind, "success");
  assert.match(status.text, new RegExp(`privacy-shield v${VERSION.replaceAll(".", "\\.")}`));

  const off = ctx.registeredCommands[0].handler({ rawInput: "off", agent: { session: { id: "s1" } } });
  assert.match(off.text, /now OFF/);
});
