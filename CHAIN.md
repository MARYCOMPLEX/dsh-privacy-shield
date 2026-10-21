# 用户消息 / 工具调用的打码与解码链路

> 以下内容来自 DSH `0.2.1-rc.2` headless + 本地假 OpenAI 端点的实际运行，不是纯示意。  
> 测试值：手机号 `13800138000`，token `{{PHONE_l5pnlh}}`。token 后缀每个会话随机。

## 总览

```text
用户输入
  │
  ├─ agent/inbox/spliced         ← DSH 先写审计事件：仍是原文（已知缺口）
  │
  ▼
agent/pre-step                   ← Privacy Shield 打码
  │
  ├─ user/message               ← token
  ├─ provider request           ← token
  │
  ▼
assistant/message                ← 模型发出的 tool-call；arguments 里是 token
  │
  ├─ tool/call (audit)          ← token
  │
  ▼
tools/pre-execute
  │
  ├─ 普通 bash/write + token    ← deny，提示改用 secure_*
  └─ secure_run/write/read/edit/request
        │
        ├─ vault.substitute(token) → 真值
        ├─ 执行（shell / fs / fetch）
        └─ 输出再 mask
  │
  ▼
tools/post-execute               ← 工具结果里的新敏感值再打码
  │
  ├─ tool/result                ← token（或已打码的纯文本）
  │
  ▼
下一轮 provider request          ← assistant tool-call + tool/result 都是 token
```

关键点：**模型路径上永远不解码**。解码只发生在 `secure_*` 工具内部，执行完立刻重新打码。

---

## 1. 用户消息：原文 → token

实际输入：

```text
My phone is 13800138000. Write it to phone-demo.txt using secure_run, then reply done.
```

DSH 先写入 `agent/inbox/spliced`（原文，已知缺口）：

```json
{
  "type": "agent/inbox/spliced",
  "data": {
    "inserted": [{
      "role": "user",
      "content": [{ "type": "text", "text": "headless My phone is 13800138000. Write it to phone-demo.txt using secure_run, then reply done." }]
    }]
  }
}
```

`agent/pre-step` 之后，`user/message` 变成：

```json
{
  "type": "user/message",
  "data": {
    "content": [{
      "type": "text",
      "text": "headless My phone is {{PHONE_l5pnlh}}. Write it to phone-demo.txt using secure_run, then reply done."
    }]
  }
}
```

实际 provider 请求里：

```json
{
  "role": "user",
  "content": "headless My phone is {{PHONE_l5pnlh}}. Write it to phone-demo.txt using secure_run, then reply done."
}
```

请求体检查：`has raw phone: false`。

---

## 2. 模型发起工具调用：arguments 里是 token

模型看到的是 token，所以它发出的 tool call 也只能引用 token：

`assistant/message`：

```json
{
  "role": "assistant",
  "content": [{
    "type": "tool-call",
    "id": "call_demo_1",
    "name": "secure_run",
    "arguments": "{\"command\":\"printf 'phone={{PHONE_l5pnlh}}\\\\n' > phone-demo.txt\"}"
  }]
}
```

`tool/call` 审计事件（同样是 token）：

```json
{
  "type": "tool/call",
  "data": {
    "callId": "call_demo_1",
    "name": "secure_run",
    "arguments": "{\"command\":\"printf 'phone={{PHONE_l5pnlh}}\\\\n' > phone-demo.txt\"}"
  }
}
```

此时**还没有解码**。模型和日志都只看到 token。

---

## 3. 执行时解码：只有 secure_* 内部发生

`tools/pre-execute` 看到的是 `secure_run`，因此放行。`secure_run` 做三件事：

1. `vault.substitute(command)`：把 `{{PHONE_l5pnlh}}` 换成 `13800138000`
2. 通过 `ctx.shell` 执行：
   ```sh
   printf 'phone=13800138000\n' > phone-demo.txt
   ```
3. 对 stdout/stderr 再跑 `maskText`，把新出现的敏感值重新 token 化

实际落盘：

```text
$ cat phone-demo.txt
phone=13800138000
```

也就是说：**真值只存在于 vault、工具执行内存、以及最终副作用（文件/命令/HTTP）里；不回到模型上下文。**

如果模型错误地调用普通工具：

```json
{ "name": "bash", "arguments": { "command": "echo {{PHONE_l5pnlh}}" } }
```

`tools/pre-execute` 会返回：

```json
{
  "kind": "deny",
  "reason": "privacy-shield: bash received a vault token. Do not pass tokens to normal tools. Use secure_run for shell commands, secure_write for files, or secure_request for HTTP; those resolve tokens inside the tool and return masked output."
}
```

这是官方 seam 的硬限制：`tools/pre-execute` 只能 allow/deny/ask，不能改写 arguments。我们没有假装能改；我们把“解码”放进 capability tool。

---

## 4. 工具结果：执行后重新打码

`tool/result` 实际内容：

```json
{
  "type": "tool/result",
  "data": {
    "message": {
      "role": "tool",
      "toolCallId": "call_demo_1",
      "content": [{
        "type": "text",
        "text": "{\"exitCode\":0,\"signal\":null,\"timedOut\":false,\"stdout\":\"\",\"stderr\":\"...\"}"
      }]
    }
  }
}
```

如果工具输出里包含新的敏感值，`tools/post-execute` 会在进入日志/模型前再次打码。例如：

```text
stdout: "token=sk-1234567890abcdefghijklmn phone=13800138000"
```

会变成：

```text
stdout: "token={{API_KEY_ab12cd}} phone={{PHONE_l5pnlh}}"
```

已有 token 不会被重复打码；检测器会跳过 `{{...}}` 片段。

---

## 5. 下一轮请求：历史里仍然只有 token

第二次 provider 请求中，assistant tool-call 和 tool 结果分别是：

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [{
    "id": "call_demo_1",
    "type": "function",
    "function": {
      "name": "secure_run",
      "arguments": "{\"command\":\"printf 'phone={{PHONE_l5pnlh}}\\\\n' > phone-demo.txt\"}"
    }
  }]
}
```

```json
{
  "role": "tool",
  "tool_call_id": "call_demo_1",
  "content": "{\"exitCode\":0,\"signal\":null,\"timedOut\":false,\"stdout\":\"\",\"stderr\":\"...\"}"
}
```

检查请求体：`has raw phone: false`。

---

## 6. 5 个 secure 工具分别覆盖什么

| 工具 | 解码位置 | 执行 | 输出处理 |
|---|---|---|---|
| `secure_run` | `command` | `ctx.shell` | stdout/stderr 再打码 |
| `secure_write` | `content` | `ctx.fs.writeText` | 只返回 path/bytes |
| `secure_read` | 无 token 参数 | `ctx.fs.readText` | 读到的内容整体打码 |
| `secure_edit` | `old_string` / `new_string` | `ctx.fs.editText` | 只返回 path/bytes |
| `secure_request` | URL / headers / body | `fetch` | 响应 body 再打码 |

`secure_write` / `secure_read` / `secure_edit` 走的是同一套 `vault.substitute`，区别只是最终副作用是文件而不是 shell。

---

## 7. 开关时的链路变化

### `/privacy off`

- 新的用户消息不再经过 `agent/pre-step` 打码 → `user/message` 和 provider 请求都是原文
- 新的工具结果不再经过 `tools/post-execute` 打码
- 但**已存在的 token 仍然会被 `tools/pre-execute` 拦住**，不会把 `{{PHONE_...}}` 当普通字符串执行
- 已写入的 token 仍可由 `secure_*` 解码

### `/privacy on`（会话中途打开）

- 只保护**新**用户消息和新工具结果
- 已经写入的历史不会被改写
- 命令会明确警告：如果旧历史里有明文，模型仍然可能在下一轮看到它

---

## 8. 边界（务必知道）

1. `agent/inbox/spliced` 是 `agent/pre-step` 之前写的，保留原文；模型请求安全，但原始 session 文件可能含明文。
2. 模型自己“知道”并写出的真实秘密不会被回溯打码；插件只处理它能看到的输入/工具结果。
3. 系统提示、AGENTS.md、工具描述不经过这套打码。
4. Web UI / 日志显示的是 token，不是真值；当前没有 display restore。
5. `secure_run` 能用真值执行任意命令，它本身不是网络防火墙。
