# Design

## Goal

Let a DSH agent work with secrets and PII without the model provider, the session log, or telemetry receiving the real values, while keeping the agent able to execute commands, write files, and call APIs that need those values.

The first release is intentionally narrow:

- Official extension points only.
- Reversible tokens for values the agent must use.
- A runtime on/off switch.
- No proxy, no fork, no `llm/stream` request rewrite.

## Why not rewrite the request at `llm/stream`?

DSH's request is derived from the append-only session log and deep-frozen before the `llm/stream` waterfall. A listener receives:

```ts
(options, next) => AsyncIterable<StreamChunk>
```

`options` and its messages are frozen; `next()` takes no arguments and closes over the original request. The only way to change the request from that seam is to build a new one and re-enter the waterfall (`ctx.llm.stream(masked)`), which:

- bypasses the original prepared call and re-runs preparation;
- makes other `llm/stream` listeners observe two requests;
- depends on private dispatch behavior rather than the documented contract;
- can duplicate auxiliary side effects (title/compaction/telemetry observers).

The community plugin `dsh-llmasking` does exactly this and is useful prior art, but it is not the architecture this project chooses.

## Invariant: model-visible = logged

This release keeps DSH's invariant. The model and the durable log see the same text — both masked. That has a real cost: the human UI also shows tokens, and a user who wants the original transcript needs a separate display/projection layer.

The alternative ("log real, model masked") needs an earlier projection seam. `SessionMessageProjection` exists and is the official mechanism, but a general masking projection still needs a supported place to append the projection event before the request is built, and it must cover every message appended in the step. This release does not fake that with a request rewrite.

## Data flow

```text
user input
   │
   ▼
agent/pre-step ── mask text/tool-result blocks ──► user/message (tokens)
   │
   ▼
model request (tokens)
   │
   ▼
model output (tokens; assistant/message tokens)
   │
   ├─ normal tool call containing a token ──► tools/pre-execute denies
   │
   └─ secure_run / secure_write / secure_request
          │ resolve tokens from the local vault
          ▼
       execute with real value
          │
          ▼
tools/post-execute ── mask result ──► tool/result (tokens)
```

### Seams

| Seam | Direction | Why here |
|---|---|---|
| `agent/pre-step` | user → log/model | The decision's `messages` are what the loop appends. Masking here protects the `user/message` and the request. The earlier `agent/inbox/spliced` audit event is already committed and is not rewritten. |
| `tools/post-execute` | tool → log/model | The accept decision can replace canonical `value` or rendered `content` before materialization. |
| `tools/pre-execute` | guard | The seam cannot rewrite arguments, but it can deny. Denying a token-bearing normal tool prevents silent placeholder execution and points the model at the capability tools. |
| `session-telemetry/record` | telemetry | Independent outbound copy; one-way redaction is enough and avoids vault writes. |

### Why capability tools instead of argument rewriting

`tools/pre-execute` is explicitly decision-only: arguments are already logged/presented and frozen. Rather than pretend a rewrite happened, the model is taught to call a tool that *owns* the resolution:

- `secure_run` resolves the command and executes through `ctx.shell`.
- `secure_write` resolves the content and writes through `ctx.fs`.
- `secure_request` resolves URL/headers/body and fetches with a host allowlist.

This is the same design family as `dsh-redact` and other vault plugins, with two additions: the pre-execute denial/guidance and the host-allowlisted HTTP path.

## Toggle semantics

`enabled` is the startup default. `/privacy on|off` sets a per-session override in memory. A process-wide `global on|off` changes the default for sessions without an override.

The toggle is deliberately not a "retroactive scrub":

- Turning **off** stops masking new content. Existing tokens stay; `secure_*` can still resolve them; normal tools carrying tokens stay denied.
- Turning **on** masks new user messages and tool results. Already-committed messages are not rewritten because no supported seam can rewrite the append-only log. The command warns about this.

A future projection layer could make "on" cover the model view of history without rewriting the log. It would not change the logged values.

## Threat model

### In scope

- A model provider that receives prompts.
- Session logs, session export, and telemetry that leave the process through supported paths.
- A model that echoes a token into a normal tool call.
- Accidental leakage of common credential/PII shapes in user text and tool output.

### Out of scope

- **The raw `agent/inbox/spliced` audit event.** DSH appends the user input before `agent/pre-step`; the `user/message` and request are masked, but the raw inbox event remains in the session file. This is a known official-seam gap.
- A local attacker with the same UID: the file vault is plaintext `0600`; the process memory is readable.
- Model prior knowledge or hallucinated secrets.
- A tool's own side effects: `secure_run` can run `curl`; `secure_request` can POST a resolved value to an allowlisted host. Masking input is not an egress firewall.
- Metadata: token shapes, counts, timing, and which label was used still leak.
- Secrets in the system prompt, AGENTS.md, skill files, or tool descriptions.
- A compromised DSH runtime or a malicious plugin in the same process.

### Failure semantics

- Masking failure: fail closed by default; the turn errors instead of sending the value.
- Vault load failure: plugin load fails; a corrupt vault is not treated as empty.
- Unknown token in `secure_*`: refuse to execute.
- `failMode: open`: fall back to `[REDACTED:LABEL]` for the affected value, never to plaintext.

## Token format

`{{LABEL_xxxxxx}}`

- `LABEL`: 1–12 uppercase ASCII chars, normalized from the rule label.
- `xxxxxx`: six base32 chars from `abcdefghijklmnopqrstuvwxyz234567` (32^6 ≈ 1.07e9).
- Same value → same token within a vault (dedup by value).
- Existing tokens are skipped by the detector, so re-masking is idempotent.
- Tokens are references, not authenticators. A malicious model can guess a suffix; it cannot resolve a guessed token because resolution is local and unknown tokens fail closed.

## Future work

### 1. Model-only projection (official)

Desired: append-only transcript keeps real values; model sees masks. Candidate implementation:

- A durable plugin event (e.g. `privacy-shield/mask`) carrying the token→value mapping or a digest.
- A `SessionMessageProjection` that returns masked replacements for the model-visible surface only.
- A supported way to append the projection before `buildRequest` for the current step's messages. If that requires a new core seam, propose it rather than re-dispatching at `llm/stream`.

Until then, this plugin does not claim "logs keep truth".

### 2. Client display restore

A web client plugin can resolve tokens only in the rendered UI, leaving the log/model text masked. This is display-only and must not write the resolved value back into session events.

### 3. Encrypted vault

AES-256-GCM with a key file `0600`, or an OS keychain. The current file vault is permission-only; encryption protects backups/casual reads, not same-UID access.

### 4. Egress policy

Command/URL allowlists for `secure_run`, or making `secure_request` the only network path. This is the difference between "the model cannot see the secret" and "the secret cannot leave".

## Alternatives considered

| Alternative | Why not now |
|---|---|
| `llm/stream` re-dispatch | Works (see `dsh-llmasking`) but private behavior, double listeners, bypassed prepared call; the user explicitly chose the official route. |
| Proxy / gateway | Strongest coverage, but a separate process and the exact thing this project is trying to avoid. |
| `SessionMessageProjection` only | Official and the right long-term direction, but needs a supported pre-request append point and durable mapping; not an MVP. |
| Irreversible-only scrub | Simpler, but cannot support "write the real key to .env" or "call the API with the real token", which is the point of the vault. |
| Argument rewriting at `tools/pre-execute` | Not possible: args are already logged/presented and frozen; denying is the supported behavior. |
