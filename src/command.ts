import { applyMatches, detectMatches, SENTINEL_TEXT } from "./detect.js";
import type { ShieldState } from "./state.js";

export interface CommandDeps {
  readonly version: string;
  readonly state: ShieldState;
}

export type CommandResult = { kind: "success"; text: string } | { kind: "error"; text: string };

function usage(): string {
  return [
    "usage: /privacy [status|on|off|global on|global off|test|help]",
    "  on/off       toggle masking for this session (new content only)",
    "  global on    toggle the process-wide default",
    "  test         run the local sentinel through the detector (no network)",
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
      "policy: user messages + tool results are masked before they enter the log; secure_run/secure_write/secure_request resolve tokens.",
      "known gaps: assistant text invented by the model, system prompt/AGENTS.md content, and one-shot calls outside the agent loop are not masked.",
    ].join("\n"),
  };
}
