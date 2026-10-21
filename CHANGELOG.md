# Changelog

## 0.1.0 — 2026-10-21

Initial release.

### Added

- Official-seam masking: `agent/pre-step`, `tools/post-execute`, `tools/pre-execute`, `session-telemetry/record`.
- Runtime per-session toggle: `/privacy status|on|off|global on|global off|test|demo`.
- Browser composer chip (Privacy ON/OFF) driven by the same `/privacy` commands.
- Reversible vault with stable `{{LABEL_xxxxxx}}` tokens.
- AES-256-GCM file vault with a `0600` key file and v1 plaintext migration.
- Capability tools: `secure_run`, `secure_write`, `secure_read`, `secure_edit`, `secure_request`.
- Token guard: normal tools carrying a known token are denied.
- Host allowlist and manual redirects for `secure_request`.
- Best-effort `secure_run` egress guard: `denyNetwork`, `allowedCommands`, `blockedPatterns`.
- Detection for common API keys, JWT/PEM/Bearer/assignments/connection strings, email, CN phone/ID, bank cards, private IPs, custom rules.
- Fail-closed masking/vault/unknown-token behavior.
- 33 unit tests and a real DSH 0.2.1-rc.2 headless tool-call chain captured in `CHAIN.md`.

### Known limitations

- `agent/inbox/spliced` keeps the raw user input; the model request is masked.
- Assistant text invented by the model, system prompt/AGENTS.md, and direct one-shot calls are not masked.
- The human UI/log show tokens; no display restore yet.
- Model-only projection ("logs real, model masked") is blocked on a core append-before-buildRequest seam.
- `secure_run` egress control is a command-name guard, not a kernel boundary.
