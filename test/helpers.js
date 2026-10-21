import { ShieldState } from "../dist/state.js";
import { Vault } from "../dist/vault.js";
import { normalizeConfig } from "../dist/config.js";

export function makeCtx(services = {}) {
  const listeners = new Map();
  const registeredTools = new Map();
  const registeredCommands = [];
  const promptSections = [];
  const effects = [];
  const ctx = {
    listeners,
    registeredTools,
    registeredCommands,
    promptSections,
    effects,
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    inject(_deps, callback) {
      callback(ctx);
    },
    get(name) {
      return services[name];
    },
    effect(callback) {
      effects.push(callback);
      return () => {};
    },
    commands: {
      register(definition) {
        registeredCommands.push(definition);
        return () => {};
      },
    },
    tools: {
      register(definition) {
        registeredTools.set(definition.name, definition);
        return () => registeredTools.delete(definition.name);
      },
    },
    systemPrompt: {
      section(definition) {
        promptSections.push(definition);
        return () => {};
      },
    },
    async dispatch(event, args, final) {
      const list = listeners.get(event) ?? [];
      let run = final;
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const listener = list[index];
        const deeper = run;
        run = () => listener(...args, deeper);
      }
      return run();
    },
  };
  return ctx;
}

export async function makeState(overrides = {}) {
  const config = normalizeConfig({ mode: "vault", vault: { backend: "memory" }, ...overrides });
  const vault = new Vault("memory");
  await vault.init();
  return { state: new ShieldState(config, vault), vault, config };
}

export function userMessage(text) {
  return {
    id: "m1",
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text }],
  };
}

export function textOf(message) {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}
