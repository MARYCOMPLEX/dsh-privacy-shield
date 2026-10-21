import assert from "node:assert/strict";
import test from "node:test";

test("browser client registers a composer chip and executes /privacy commands", async () => {
  let definition;
  let factory;
  globalThis.window = {
    __ModuleLoader__: {
      load: (value) => { factory = value.factory; },
    },
  };
  globalThis.document = {
    head: { appendChild() {} },
    createElement() {
      return { dataset: {}, textContent: "", remove() {} };
    },
  };

  await import("../lib/client.js");
  assert.ok(factory, "module loader factory captured");
  const fakeReact = {
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    createElement: (type, props, children) => ({ type, props, children }),
  };
  const exports = factory((name) => {
    assert.equal(name, "react");
    return fakeReact;
  });
  assert.equal(exports.name, "dsh-privacy-shield");
  assert.deepEqual(exports.inject, ["slots", "remote"]);

  const calls = [];
  const ctx = {
    effect(callback) { callback(); },
    slots: {
      inject(_key, callback) { callback(); },
      register(value) { definition = value; return () => {}; },
    },
    remote: {
      commands: {
        async execute(sessionId, line) {
          calls.push({ sessionId, line });
          return { ok: true, value: { result: { kind: "success", text: "session s1: ON" } } };
        },
      },
    },
  };
  exports.apply(ctx);
  assert.equal(definition.name, "conversation.input.plan");
  assert.equal(definition.id, "privacy-shield");

  const injected = definition.inject("s1");
  const status = await injected.privacy.status();
  assert.match(status.value.result.text, /ON/);
  await injected.privacy.run(false);
  assert.deepEqual(calls, [
    { sessionId: "s1", line: "/privacy status" },
    { sessionId: "s1", line: "/privacy off" },
  ]);
  delete globalThis.window;
  delete globalThis.document;
});
