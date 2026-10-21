/**
 * dsh-privacy-shield — official-seam privacy masking for DeepSeek Harness.
 *
 * The plugin deliberately stays on documented pre-commit seams:
 *
 *   agent/pre-step            user messages, before they become user/message
 *   tools/post-execute        tool results, before they become tool/result
 *   tools/pre-execute         deny normal tools that received a vault token
 *   session-telemetry/record  redact the exported telemetry copy
 *
 * It does not wrap `llm/stream` or re-dispatch requests. The model and the
 * session log therefore see the same masked text (DSH's "model-visible ⇔
 * logged" invariant), while the local vault and the secure_* tools let the
 * agent use a value without ever receiving it.
 */
import { createRequire } from "node:module";
import { Config, normalizeConfig } from "./config.js";
import { handlePrivacyCommand } from "./command.js";
import { registerHooks } from "./hooks.js";
import { ShieldState } from "./state.js";
import { registerSecureTools } from "./tools.js";
import { defaultVaultPath, openVault } from "./vault.js";
import type { PluginContext } from "./types.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };
export const VERSION = pkg.version;

export { Config, normalizeConfig } from "./config.js";
export { Vault, defaultVaultPath, openVault } from "./vault.js";
export { ShieldState } from "./state.js";
export { detectMatches, validators } from "./detect.js";
export { registerHooks, SECURE_TOOL_NAMES } from "./hooks.js";
export { registerSecureTools } from "./tools.js";
export { handlePrivacyCommand } from "./command.js";

export const name = "privacy-shield";

const GUIDANCE = [
  "Privacy Shield is active for this conversation.",
  "Sensitive values are replaced with tokens such as {{PHONE_ab12cd}} before they reach you or the session log.",
  "Tokens are opaque references to real local values. Reproduce them verbatim: never invent, guess, split, complete, or decode a token.",
  "When a shell command, file, or HTTP request needs the underlying value, use secure_run, secure_write, or secure_request.",
  "Those tools resolve tokens inside the tool and mask their output again. Normal tools that receive a token are denied.",
  "Do not claim a token is a real value, and do not compute properties (length, hash, IP math) from a token.",
].join(" ");

/**
 * Mount the plugin. `apply` is async only because file-backed vaults load
 * their mapping at startup; a corrupt vault fails load instead of silently
 * starting with an empty mapping.
 */
export async function apply(ctx: PluginContext, rawConfig?: unknown): Promise<void> {
  const config = normalizeConfig(rawConfig);
  for (const rule of config.customRules) {
    try {
      new RegExp(rule.pattern, "g");
    } catch (error) {
      throw new Error(
        `privacy-shield: invalid custom rule ${JSON.stringify(rule.label)}: ${String(error instanceof Error ? error.message : error)}`,
      );
    }
  }
  const vault = await openVault(config.vault.backend, config.vault.path || defaultVaultPath());
  const state = new ShieldState(config, vault);

  const disposeHooks = registerHooks(ctx, state);
  if (typeof ctx.effect === "function") {
    ctx.effect(() => disposeHooks, "privacy-shield:hooks");
    ctx.effect(() => () => void vault.close(), "privacy-shield:vault");
  }

  const mount = (callback: (child: PluginContext) => void) => {
    if (typeof ctx.inject === "function") ctx.inject(["commands"], (child: PluginContext) => callback(child));
    else callback(ctx);
  };

  mount((child) => {
    if (child.commands?.register === undefined) return;
    child.commands.register({
      name: "privacy",
      description: "Privacy Shield status and per-session masking toggle",
      handler: (invocation: any) =>
        handlePrivacyCommand(String(invocation?.rawInput ?? ""), invocation?.agent?.session?.id, {
          version: VERSION,
          state,
        }),
    });
  });

  const mountTools = (callback: (child: PluginContext) => void) => {
    if (typeof ctx.inject === "function") ctx.inject(["tools"], (child: PluginContext) => callback(child));
    else callback(ctx);
  };
  mountTools((child) => {
    const disposeTools = registerSecureTools(child, state);
    if (typeof child.effect === "function") child.effect(() => disposeTools, "privacy-shield:secure-tools");
  });

  const mountPrompt = (callback: (child: PluginContext) => void) => {
    if (typeof ctx.inject === "function") ctx.inject(["systemPrompt"], (child: PluginContext) => callback(child));
    else callback(ctx);
  };
  mountPrompt((child) => {
    if (child.systemPrompt?.section === undefined) return;
    child.systemPrompt.section({
      name: "privacy-shield",
      order: 120,
      text: GUIDANCE,
    });
  });

  ctx.logger?.info?.(
    `privacy-shield v${VERSION} loaded (mode=${config.mode}, vault=${config.vault.backend}, enabled=${config.enabled})`,
  );
}
