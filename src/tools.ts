import type { PluginContext, ContentBlock } from "./types.js";
import { maskText } from "./mask.js";
import type { ShieldState } from "./state.js";

type ToolOutput = { readonly schema: Record<string, unknown>; render(args: unknown, value: unknown): ContentBlock[] };

function output(description: string): ToolOutput {
  return {
    schema: { type: "object", additionalProperties: true, description },
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorValue(message: string): Record<string, unknown> {
  return { error: message };
}

function makeTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>,
): Record<string, unknown> {
  return {
    name,
    description,
    parameters,
    output: output(description),
    async execute(args: unknown, exec: { signal: AbortSignal }) {
      return execute(asRecord(args), exec);
    },
  };
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const lower = host.toLowerCase();
  return allowed.some((entry) => {
    const pattern = entry.toLowerCase().trim();
    if (pattern === "") return false;
    if (pattern.startsWith("*.")) return lower.endsWith(pattern.slice(1));
    return lower === pattern;
  });
}

function toolResult(value: unknown): unknown {
  return value !== null && typeof value === "object" ? value : { value };
}

/**
 * Register the three capability tools that can resolve vault tokens inside
 * their own execution. The model never receives the resolved value: outputs
 * are masked again before they become a tool result.
 */
export function registerSecureTools(ctx: PluginContext, state: ShieldState): () => void {
  if (ctx.tools === undefined || !state.config.secureTools.enabled) return () => undefined;
  const disposers: Array<() => void> = [];

  disposers.push(
    ctx.tools.register(
      makeTool(
        "secure_run",
        "Run a shell command with vault tokens resolved inside the command. " +
          "Use this instead of bash when the command needs a value the model sees as {{LABEL_xxxxxx}}. " +
          "stdout/stderr are masked again before they are returned.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            command: { type: "string", description: "Shell command; may contain double-brace vault tokens." },
            workdir: { type: "string", description: "Working directory override." },
            timeout_ms: { type: "integer", minimum: 1, maximum: 600000, description: "Timeout in milliseconds." },
          },
          required: ["command"],
        },
        async (args, exec) => {
          const command = asString(args.command);
          if (command === undefined || command.trim() === "") return errorValue("command is required");
          let resolved: string;
          try {
            resolved = state.vault.substitute(command);
          } catch (error) {
            return errorValue(String(error instanceof Error ? error.message : error));
          }
          const shell = ctx.get?.("shell");
          if (shell === undefined || typeof shell.resolve !== "function" || typeof shell.execute !== "function") {
            return errorValue("shell service is unavailable in this profile");
          }
          try {
            const request: Record<string, unknown> = { command: resolved, onExpiry: "kill" };
            if (typeof args.workdir === "string" && args.workdir !== "") request.workdir = args.workdir;
            if (typeof args.timeout_ms === "number") request.timeoutMs = args.timeout_ms;
            const spec = shell.resolve({ ...request, signal: exec.signal });
            const execution = await shell.execute(spec);
            const result = await execution.result();
            const stdout = await maskText(String(result?.stdout?.text ?? ""), state.config, state.vault);
            const stderr = await maskText(String(result?.stderr?.text ?? ""), state.config, state.vault);
            return toolResult({
              exitCode: result?.exitCode ?? null,
              signal: result?.signal ?? null,
              timedOut: result?.timedOut === true,
              stdout,
              stderr,
            });
          } catch (error) {
            return errorValue(`secure_run failed: ${String(error instanceof Error ? error.message : error)}`);
          }
        },
      ),
    ),
  );

  disposers.push(
    ctx.tools.register(
      makeTool(
        "secure_write",
        "Write a file with vault tokens resolved inside the content. " +
          "Use this instead of write when the content needs a value the model sees as a double-brace LABEL token. " +
          "The tool returns only the path and byte count.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "Destination path in the active filesystem." },
            content: { type: "string", description: "File content; may contain double-brace vault tokens." },
          },
          required: ["path", "content"],
        },
        async (args) => {
          const path = asString(args.path);
          const content = asString(args.content);
          if (path === undefined || path === "") return errorValue("path is required");
          if (content === undefined) return errorValue("content is required");
          let resolved: string;
          try {
            resolved = state.vault.substitute(content);
          } catch (error) {
            return errorValue(String(error instanceof Error ? error.message : error));
          }
          const fs = ctx.get?.("fs");
          if (fs === undefined || typeof fs.resolve !== "function" || typeof fs.writeText !== "function") {
            return errorValue("filesystem service is unavailable in this profile");
          }
          try {
            const target = await fs.resolve(path);
            await fs.writeText(target, resolved);
            return toolResult({ path, bytes: Buffer.byteLength(resolved, "utf8") });
          } catch (error) {
            return errorValue(`secure_write failed: ${String(error instanceof Error ? error.message : error)}`);
          }
        },
      ),
    ),
  );

  disposers.push(
    ctx.tools.register(
      makeTool(
        "secure_request",
        "Perform one HTTP request with vault tokens resolved inside the URL, headers, and body. " +
          "Use this instead of a generic HTTP tool when a header or body needs a value the model sees as a double-brace LABEL token. " +
          "The response body is masked again before it is returned.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", description: "Absolute http(s) URL; may contain tokens." },
            method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method." },
            headers_json: { type: "string", description: "Optional JSON object of header name/value strings." },
            body: { type: "string", description: "Optional request body; may contain tokens." },
          },
          required: ["url"],
        },
        async (args, exec) => {
          const rawUrl = asString(args.url);
          if (rawUrl === undefined || rawUrl === "") return errorValue("url is required");
          let url: string;
          try {
            url = state.vault.substitute(rawUrl);
          } catch (error) {
            return errorValue(String(error instanceof Error ? error.message : error));
          }
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            return errorValue("url must be an absolute http(s) URL");
          }
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return errorValue("only http(s) is supported");
          if (!hostAllowed(parsed.hostname, state.config.secureTools.allowedHosts)) {
            return errorValue(`host ${parsed.hostname} is not in secureTools.allowedHosts`);
          }
          let headers: Record<string, string> = {};
          const rawHeaders = asString(args.headers_json);
          if (rawHeaders !== undefined && rawHeaders.trim() !== "") {
            try {
              const parsedHeaders = asRecord(JSON.parse(rawHeaders));
              for (const [key, value] of Object.entries(parsedHeaders)) {
                if (typeof value === "string") headers[key] = state.vault.substitute(value);
              }
            } catch (error) {
              return errorValue(`headers_json must be a JSON object: ${String(error instanceof Error ? error.message : error)}`);
            }
          }
          let body: string | undefined;
          const rawBody = asString(args.body);
          if (rawBody !== undefined) {
            try {
              body = state.vault.substitute(rawBody);
            } catch (error) {
              return errorValue(String(error instanceof Error ? error.message : error));
            }
          }
          const method = asString(args.method) ?? "GET";
          const timeout = AbortSignal.timeout(30000);
          const signal = typeof AbortSignal.any === "function" ? AbortSignal.any([exec.signal, timeout]) : timeout;
          try {
            const response = await fetch(url, {
              method,
              headers,
              ...(body === undefined || method === "GET" || method === "HEAD" ? {} : { body }),
              redirect: "manual",
              signal,
            });
            const text = await response.text();
            const masked = await maskText(text, state.config, state.vault);
            return toolResult({ status: response.status, body: masked });
          } catch (error) {
            return errorValue(`secure_request failed: ${String(error instanceof Error ? error.message : error)}`);
          }
        },
      ),
    ),
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}
