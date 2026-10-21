# dsh-privacy-shield

**Official-seam, toggleable privacy masking for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

Sensitive values are replaced with vault tokens **before they become model-visible messages and tool results**. The model sees `{{PHONE_ab12cd}}`; the local vault keeps the real value; `secure_run` / `secure_write` / `secure_read` / `secure_edit` / `secure_request` resolve it inside the tool and mask their output again.

> **Important log caveat:** DSH writes the raw user input to an `agent/inbox/spliced` audit event *before* `agent/pre-step` runs. The `user/message` event and the model request are masked, but that earlier inbox event still contains the original text. Do not export or share a raw session file if this matters. See [Known gaps](#known-gaps).

The plugin deliberately uses only documented DSH extension points:

| Seam | What it does here |
|---|---|
| `agent/pre-step` | Masks admitted user messages before `user/message` is appended. |
| `tools/post-execute` | Masks tool results (canonical `value` and rendered `content`) before they are logged/model-visible. |
| `tools/pre-execute` | Denies a normal tool that received a vault token; the model must use a `secure_*` tool. |
| `session-telemetry/record` | Redacts the outbound telemetry copy one-way. |

It does **not** wrap `llm/stream`, does not re-dispatch requests, and does not need a proxy or a fork. That keeps DSH's "model-visible ⇔ logged" invariant: the log and the model see the same masked text.

> **Status:** MVP, 33 unit tests, DSH `0.2.x` seams. Not yet published to npm.

---

## Why official seams instead of `llm/stream`?

DSH builds each request from the append-only session log and deep-freezes it. An `llm/stream` listener receives the frozen request and a `next()` that forwards the *original*; it cannot replace the request. The community workaround (`dsh-llmasking`) re-dispatches a masked copy through the waterfall, which works but bypasses the prepared call, re-enters every listener, and depends on private dispatch behavior.

This plugin takes the other official route: **mask earlier, before the event is committed**. The cost is that the log/UI also show tokens; the benefit is that the model and the log agree, and no private API is involved. A future model-only projection (`SessionMessageProjection`) can restore the original transcript view without changing this safety model.

---

## Install

### From this repository

```sh
git clone https://github.com/MARYCOMPLEX/dsh-privacy-shield.git
cd dsh-privacy-shield
npm install
npm run build
dsh plugin --profile my add link:$PWD
dsh --profile my
```

The package's `dsh.bundle.patch` adds the `privacy-shield` row automatically. A fresh profile gets the defaults below.

### From npm (when published)

```sh
dsh plugin --profile my add dsh-privacy-shield
```

### Minimal profile patch

```yaml
- insert:
    - id: privacy-shield
      name: dsh-privacy-shield
      config:
        enabled: true
        mode: vault
        vault:
          backend: file
```

A user-level `cordis.patch.yml` can replace the row's whole config:

```yaml
- id: privacy-shield
  name: dsh-privacy-shield
  config:
    enabled: true
    mode: vault
    maskUserMessages: true
    maskToolResults: true
    failMode: closed
    rules:
      secrets: true
      phone: true
      email: true
      idcard: true
      bankcard: false
      ipPrivate: false
      jwt: true
      privateKey: true
    allowlist: ["example.com"]
    vault:
      backend: file
      path: ""
      encryption: aes-256-gcm
    secureTools:
      enabled: true
      allowedHosts: ["api.example.com", "*.internal.example.com"]
      run:
        allowedCommands: ["printf", "git"]
        denyNetwork: true
        blockedPatterns: ["\\brm\\s+-rf\\b"]
```

---

## The toggle

`/privacy` is a normal DSH command. It is available as soon as the plugin is mounted.

| Command | Effect |
|---|---|
| `/privacy` or `/privacy status` | Show mode, vault backend/size, this-session ON/OFF, counters, known gaps. |
| `/privacy off` | Disable masking for the current session. New user messages/tool results pass through unmasked. |
| `/privacy on` | Re-enable for the current session. **Existing history is not retroactively masked**; only new content is. |
| `/privacy global on` / `off` | Change the process-wide default (in memory; session overrides still win). |
| `/privacy test` | Run the local sentinel through the detector; no network. |
| `/privacy demo` | Print a synthetic user-message → tool-call → decode chain. |

The config `enabled` is the startup default. `/privacy on|off` is a per-session override that lives until the process exits.

### Web composer chip

The package also ships a small browser half (`lib/client.js`, declared by `dsh.client`). It registers a **Privacy ON/OFF chip** in the composer's plan slot and calls the same `/privacy status`, `/privacy on`, and `/privacy off` commands over the existing Remote commands namespace. No Settings page, profile edit, or extra host service is required.

If the client bundle is removed or fails to load, the host command interface keeps working. The chip is deliberately display-only for the toggle: it does not resolve or reveal vault values.

### Turning it on late

DSH has no supported hook that can rewrite already-committed messages. If a session started with masking OFF, enabling it later only protects **new** user messages and tool results. Existing history may still contain real values and will be sent to the model. Start a new session if that matters. The command prints this warning.

---

## What gets masked

### User messages

`agent/pre-step` masks every text/reasoning block (and tool-result content, if a caller supplies one) before the `user/message` is appended. The `user/message` event stores tokens. The earlier `agent/inbox/spliced` audit event is outside this seam and may still contain the raw input.

### Tool results

`tools/post-execute` masks the canonical `value` (recursively, JSON strings only) and the rendered `content`. The model sees tokens; the log stores tokens. A downstream `block` decision is respected.

### Telemetry

`session-telemetry/record` masks the exported body one-way with `[REDACTED:LABEL]`. It never writes the vault. This is separate from the session log: telemetry may be disabled entirely, but if it is on, it should not carry secrets.

### What is **not** masked

- **Assistant text invented by the model.** If the model writes a real secret it already knows, no seam sees it before it is logged. The plugin masks the *inputs* it controls, not model prior knowledge.
- **System prompt / AGENTS.md / tool descriptions.** DSH exposes additive `systemPrompt.section`, not a prompt transform. Do not put secrets in those files.
- **The raw `agent/inbox/spliced` event.** DSH appends the user input to this audit event before `agent/pre-step` can rewrite it. The model-visible `user/message` is masked, but the raw inbox event remains in the session file. A future session-export sanitizer or an input-admission hook is needed to close this.
- **One-shot calls outside the agent loop** (some title/compaction/auxiliary calls) are not covered by `agent/pre-step` / `tools/post-execute`. If they carry masked session content, they carry tokens, which is safe; if they read an external source directly, they are outside this plugin.
- **Tool side effects.** A secret can still leave through a command or HTTP request. `secure_request` has a host allowlist; `secure_run` has a best-effort command policy (`denyNetwork`, `allowedCommands`, `blockedPatterns`), not a kernel firewall. Treat `secure_run` as "the agent can run code with the real value" — because it can.

---

## Vault and tokens

- Token shape: `{{LABEL_xxxxxx}}`; `LABEL` is 1–12 uppercase ASCII chars; `xxxxxx` is six base32 chars (`a–z`, `2–7`).
- The same value gets the same token within one vault; different labels for the same value still dedupe to the first token.
- `vault` mode is reversible: PII and secrets can be resolved by the secure tools.
- `mask` mode is irreversible: `[REDACTED:LABEL]` and the vault is not consulted.
- File backend: `$DSH_HOME/privacy-shield/vault.json` (or `~/.dsh/...`), directory `0700`, file `0600`, atomic rename.
- `encryption: aes-256-gcm` (default): the mapping is AES-256-GCM encrypted with a random 32-byte key at `vault.json.key` (`0600`). The vault file contains only `{version:2, alg, iv, tag, data}`. A v1 plaintext file is still readable and migrates on the next write/close.
- `encryption: none` is available for migration/debug only; it writes the v1 plaintext format.
- Memory backend: mapping dies with the process; tokens in a persisted log become unresolvable. Use file mode if you need restart survival.
- Encryption protects the file at rest; it does **not** protect against a same-UID process that can read both the vault and its key. Use memory mode or an OS keychain if that is not acceptable. Deleting the vault/key revokes all mappings.

---

## Capability tools

The model cannot pass a token to a normal tool: `tools/pre-execute` denies it with guidance. Five tools resolve tokens inside their own body.

### `secure_run`

```json
{ "command": "curl -H 'Authorization: Bearer {{API_KEY_ab12cd}}' https://api.example.com", "timeout_ms": 30000 }
```

- Resolves tokens in `command` (fail-closed on unknown token).
- Uses `ctx.shell` (the profile's shell executor), so it inherits the same sandbox/executor as the `bash` tool.
- Masks stdout/stderr again before returning them.
- Enforces `secureTools.run`: `denyNetwork` (default true) blocks common network clients, `allowedCommands` restricts the command prefix (and rejects shell chaining), and `blockedPatterns` adds case-insensitive regex denials. This is a guard, not a kernel sandbox: `bash -c`, aliases, or arbitrary interpreters can still make network calls.
- Returns `{ exitCode, signal, timedOut, stdout, stderr }` or `{ error }`.

### `secure_write`

```json
{ "path": "config/.env", "content": "API_KEY={{API_KEY_ab12cd}}\n" }
```

- Resolves tokens in `content`.
- Uses `ctx.fs` (the profile's filesystem backend), so it respects the same workspace/sandbox policy as `write`.
- Returns only `{ path, bytes }`; the real content is never echoed.

### `secure_read`

```json
{ "path": "config/.env" }
```

- Reads through `ctx.fs` and masks every detected value before returning the content.
- Useful for reading a `.env` or config that contains secrets without putting the real values into the model context.
- Returns `{ path, content }` with tokens, or `{ error }`.

### `secure_edit`

```json
{
  "path": "config/.env",
  "old_string": "API_KEY=old-value",
  "new_string": "API_KEY={{API_KEY_ab12cd}}",
  "replace_all": false
}
```

- Resolves tokens in both `old_string` and `new_string`.
- Edits through `ctx.fs.editText`, so the same workspace/sandbox policy as `edit` applies.
- Returns only `{ path, bytes }`; the real values are never echoed.

### `secure_request`

```json
{
  "url": "https://api.example.com/v1/items",
  "method": "POST",
  "headers_json": "{\"Authorization\":\"Bearer {{API_KEY_ab12cd}}\",\"Content-Type\":\"application/json\"}",
  "body": "{\"phone\":\"{{PHONE_ab12cd}}\"}"
}
```

- Resolves tokens in URL, header values, and body.
- Enforces `secureTools.allowedHosts` (empty = any host; exact or `*.suffix`).
- `redirect: "manual"` so a 3xx cannot silently move the request to another host.
- Masks the response body again before returning it.
- Returns `{ status, body }` or `{ error }`.

The tools are mounted only when `secureTools.enabled` is true and `ctx.tools` is available. If `ctx.shell` / `ctx.fs` is absent in a profile, the tool returns a clear error instead of falling back to an unsandboxed Node call.

---

## Detection rules

Built in (all configurable):

- API keys: `sk-…`, GitHub `gh*_`/`github_pat_`, AWS `AKIA`/`ASIA`, Google `AIza…`, Slack `xox…`, Stripe `sk_live_`/`rk_test_`, npm, PyPI, GitLab, Hugging Face.
- JWT, PEM private-key blocks, `Bearer …`, `password=`/`token=`/`api_key=` assignments, database URL passwords.
- PII: email, mainland-China mobile, 18-digit resident ID (ISO 7064 check), bank card (Luhn), private IPv4 (off by default).
- Custom regex rules via `customRules: [{ label, pattern }]`.

Validators reject malformed candidates so the plugin does not mask every 16-digit number or every `user:pass@` lookalike. `allowlist` entries are substring matches (case-insensitive) and are skipped.

---

## Failure behavior

- **Masking failure** (`failMode: closed`, default): the hook throws; the turn fails rather than sending unmasked text. `open` falls back to `[REDACTED:LABEL]` for that value.
- **Vault read failure at startup**: the plugin fails to load. A corrupt vault is never treated as empty.
- **Unknown token at execution**: `secure_*` refuses to run (fail closed); it never substitutes the token literally.
- **Restore is not part of this design**: there is no response restoration, so a token in the model's answer stays a token. A future client-side display layer can resolve it for the human without changing the logged/model-visible text.

---

## Known gaps

1. **`agent/inbox/spliced` keeps the raw user input.** The official pre-step seam runs after this audit event is appended. The model never sees the raw text (the `user/message` is masked), but a raw session export can. This is the same gap documented by `dsh-secret-scrub`.
2. **Assistant text invented by the model** is not masked; only inputs are.
3. **System prompt / AGENTS.md / tool descriptions** are not transformed; do not put secrets there.
4. **The human UI shows tokens.** There is no display-restore plugin in this release.
5. **`secure_run` can execute code with the real value.** `denyNetwork` / `allowedCommands` / `blockedPatterns` raise the bar, but they are not an egress firewall; interpreters can bypass a command-name scan.
6. **The encryption key sits next to the vault (`0600`).** It protects backups/casual reads, not a same-UID attacker who can read both files.

## Relationship to other DSH privacy plugins

- `dsh-redact` / `dsh-secret-scrub`: admission-time masking with a vault/capability tools. This plugin adds a per-session toggle, a token-argument guard, and a host-allowlisted `secure_request`; it does not restore assistant display either.
- `dsh-llmasking`: masks only the wire at `llm/stream`, re-dispatching a masked copy; session log/UI keep real values. That is a different tradeoff and relies on the re-dispatch workaround. This plugin keeps model and log identical (both masked).
- `dsh-privacy-gateway`: HMAC-stable placeholders and a local UI resolve path; PII-focused, no tool-argument capability layer.
- `dsh-honey-guard`: structural fake values and canaries; deliberately no auto-restore.

There is no single existing plugin that combines **official-only seams**, **a runtime toggle**, **arbitrary tool execution via capability tools**, and **a token guard**. This is an attempt at that combination.

---

## The chain, with actual examples

See [CHAIN.md](./CHAIN.md) for a real DSH `0.2.1-rc.2` run: the exact `agent/inbox/spliced` caveat, the `user/message` token, the `assistant/message` tool call, `tool/call`, vault resolution, `tool/result`, and the next request — with the raw phone number absent from every provider request.

## Verification

- `npm test`: 33 unit tests (detection, validators, encrypted vault/migration, hooks, toggle, command, secure tools, entry wiring, browser chip).
- DSH `0.2.1-rc.2` headless smoke test with a local OpenAI-compatible endpoint: the captured `/v1/chat/completions` body contained `{{PHONE_...}}` and **not** the raw number; `secure_run`, `secure_write`, `secure_read`, `secure_edit`, and `secure_request` appeared in the request's tool list. The same test exposed the `agent/inbox/spliced` raw-input caveat above.

## Development

```sh
npm install
npm run build
npm test          # builds, then 33 unit tests
npm run typecheck
```

Layout:

```text
src/
  index.ts        plugin entry + mounts
  config.ts       schemastery config + normalization
  detect.ts       rules, validators, overlap merge
  tokens.ts       token format/random suffix
  vault.ts        memory/file vault
  mask.ts         text/JSON/content/message masking
  state.ts        toggle + counters
  hooks.ts        official seam listeners
  command.ts      /privacy
  tools.ts        secure_run / secure_write / secure_read / secure_edit / secure_request
  types.ts        minimal structural DSH types
lib/client.js     browser composer chip (Privacy ON/OFF)
```

---

## Roadmap

Completed in this release:

- Web composer chip toggle (`lib/client.js`)
- AES-256-GCM file vault with a 0600 key and v1 migration
- `secure_read` / `secure_edit`
- best-effort `secure_run` egress guard (`denyNetwork`, `allowedCommands`, `blockedPatterns`)

Still missing, with the reason:

1. **Model-only projection** ("logs real, model masked"). `SessionMessageProjection` is the official mechanism, but a general masking projection needs a supported append point **after** the step's messages are committed and **before** `buildRequest`. `agent/pre-step` is before the commit; `agent/request` is before it; `session/event` refuses reentrant appends; `session/flush` runs after the request is assembled. A naive per-message projection event can also make out-of-tree session logs unresumable. This needs a core seam, not a plugin hack.
2. **Client display restore**. The browser would need a host RPC that resolves a token without writing the value into a session event. A template-literal command such as `/privacy reveal` logs its result in `command/done`, so it is not a safe display path.
3. **OS-keychain vault backend**. The AES key currently sits next to the vault (`0600`); a keychain would move it out of the same directory.
4. **Stronger egress control**. `secure_run` is a command-name guard; a network namespace/proxy or making `secure_request` the only egress path is the real boundary.
5. **More validators**: cloud-provider-specific checks, IBAN, national IDs, and user-defined validation hooks.

---

## License

MIT. See [LICENSE](./LICENSE).
