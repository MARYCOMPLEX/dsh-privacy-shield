import { applyMatches, detectMatches, SENTINEL_TEXT } from "./detect.js";
import type { ShieldState } from "./state.js";

export interface CommandDeps {
  readonly version: string;
  readonly state: ShieldState;
}

export type CommandResult = { kind: "success"; text: string } | { kind: "error"; text: string };

function usage(): string {
  return [
    "usage: /privacy [status|on|off|global on|global off|test|demo|help]",
    "  on/off       toggle masking for this session (new content only)",
    "  global on    toggle the process-wide default",
    "  test         run the local sentinel through the detector (no network)",
    "  demo         print a synthetic user-message -> tool-call -> decode chain",
  ].join("\n");
}

function renderStats(label: string, stats: { masked: number; byLabel: Readonly<Record<string, number>> }): string {
  const histogram = Object.entries(stats.byLabel)
    .map(([type, count]) => `${type} ${count}`)
    .join(", ");
  return `${label}: ${stats.masked} value(s)${histogram ? ` (${histogram})` : ""}`;
}

/** `/privacy` command: status, per-session toggle, and a local self-test. */
export function handlePrivacyCommand(rawInput: string, sessionId: string | undefined, deps: CommandDeps): CommandResult {
  const input = rawInput.trim().toLowerCase();
  const sub = input === "" ? "status" : input;
  const state = deps.state;

  if (sub === "help" || sub === "-h" || sub === "--help") return { kind: "success", text: usage() };

  if (sub === "on" || sub === "enable") {
    const previous = sessionId === undefined ? state.setGlobalEnabled(true) : state.setSessionEnabled(sessionId, true);
    return {
      kind: "success",
      text: [
        `privacy-shield: masking is now ON for ${sessionId === undefined ? "this process" : `session ${sessionId}`}.`,
        previous ? "It was already on." : "Existing history is NOT retroactively masked. Only new user messages and tool results are masked; start a new session if the current history contains secrets.",
        "Use /privacy status to inspect counters.",
      ].join("\n"),
    };
  }

  if (sub === "off" || sub === "disable") {
    const previous = sessionId === undefined ? state.setGlobalEnabled(false) : state.setSessionEnabled(sessionId, false);
    return {
      kind: "success",
      text: [
        `privacy-shield: masking is now OFF for ${sessionId === undefined ? "this process" : `session ${sessionId}`}.`,
        previous ? "New user messages and tool results will be sent unmasked." : "It was already off.",
        "Existing tokens remain in the log and can still be resolved by secure tools; normal tools that receive a token stay blocked.",
      ].join("\n"),
    };
  }

  if (sub === "global on" || sub === "global enable") {
    state.setGlobalEnabled(true);
    return { kind: "success", text: "privacy-shield: process-wide default is now ON (in-memory; session overrides still win)." };
  }

  if (sub === "global off" || sub === "global disable") {
    state.setGlobalEnabled(false);
    return { kind: "success", text: "privacy-shield: process-wide default is now OFF (in-memory; session overrides still win)." };
  }

  if (sub === "demo") {
    return {
      kind: "success",
      text: [
        "privacy-shield chain demo (synthetic values; no vault entries created)",
        "",
        '1. user input      : My phone is 13800138000.',
        '2. agent/pre-step  : maskText -> {{PHONE_abcdef}}',
        '3. user/message    : My phone is {{PHONE_abcdef}}.',
        '4. provider        : sees {{PHONE_abcdef}} only.',
        '5. model tool call : secure_run({ command: "printf \'phone={{PHONE_abcdef}}\\n\' > phone-demo.txt" })',
        '6. tools/pre-execute: secure_run allowed; bash/write with the same token would be denied.',
        '7. vault.substitute: {{PHONE_abcdef}} -> 13800138000 (inside secure_run only)',
        '8. effect          : phone-demo.txt contains phone=13800138000',
        '9. tools/post-execute: stdout/stderr masked again',
        '10. tool/result    : { exitCode: 0, ... } (no raw phone)',
        '11. next request   : assistant tool-call + tool result still carry {{PHONE_abcdef}}',
        "",
        "The model path never decodes. Decoding happens only inside secure_* tools; the raw value is used for the side effect and never returned to the model.",
        "See CHAIN.md for a real DSH 0.2.1-rc.2 run.",
      ].join("\n"),
    };
  }

  if (sub === "test" || sub === "verify") {
    const matches = detectMatches(SENTINEL_TEXT, state.config);
    const masked = applyMatches(SENTINEL_TEXT, matches, (match) => `[REDACTED:${match.label}]`);
    const labels = [...new Set(matches.map((match) => match.label))];
    return {
      kind: labels.length > 0 ? "success" : "error",
      text: [
        `privacy-shield self-test: ${labels.length > 0 ? "PASS" : "FAIL"}`,
        `  input : ${SENTINEL_TEXT}`,
        `  mask  : ${masked}`,
        `  types : ${labels.join(", ") || "(none)"}`,
        labels.length > 0
          ? "The detector is live. This test is local and makes no network call."
          : "No entity was detected — check rules/customRules in the plugin config.",
      ].join("\n"),
    };
  }

  if (sub !== "status") return { kind: "error", text: usage() };

  const enabled = state.isEnabled(sessionId);
  const sessionStats = state.statsFor(sessionId);
  const totals = state.totals();
  return {
    kind: "success",
    text: [
      `privacy-shield v${deps.version} — official-seam masking`,
      `mode: ${state.config.mode}; vault: ${state.config.vault.backend} (${state.vault.size} entries)`,
      `session ${sessionId ?? "(none)"}: ${enabled ? "ON" : "OFF"}`,
      renderStats("this session", sessionStats),
      renderStats("since load", totals),
      `sessions tracked: ${state.sessionsTracked}; overrides: ${state.overrideCount}`,
      "policy: user messages + tool results are masked before they become model-visible events; secure_run/secure_write/secure_read/secure_edit/secure_request resolve tokens.",
      "known gaps: raw agent/inbox/spliced keeps the original user input; assistant text invented by the model, system prompt/AGENTS.md content, and one-shot calls outside the agent loop are not masked.",
    ].join("\n"),
  };
}
