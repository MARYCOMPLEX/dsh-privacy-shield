import type { PluginContext, PostToolDecision, PreStepDecision, PreToolDecision, TelemetryRecord, ToolExecution, ToolExecutionResult } from "./types.js";
import { maskContentBlocks, maskJsonValue, maskJsonValueSync, maskMessage, containsKnownTokenDeep } from "./mask.js";
import type { ShieldState } from "./state.js";

/** Tools that are allowed to receive tokens because they resolve them internally. */
export const SECURE_TOOL_NAMES = new Set(["secure_run", "secure_write", "secure_request"]);

function sessionIdOfAgent(agent: { session?: { id?: string } } | undefined): string | undefined {
  const id = agent?.session?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * `agent/pre-step` — mask the user messages before the loop appends them as
 * `user/message` events. This is the official admission seam: whatever this
 * returns is what both the session log and the next request contain.
 */
export function registerPreStep(ctx: PluginContext, state: ShieldState): () => void {
  return ctx.on(
    "agent/pre-step",
    async (payload: { agent?: { session?: { id?: string } }; messages: any[] }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
      const decision = await next();
      if (decision.kind !== "enter") return decision;
      const sessionId = sessionIdOfAgent(payload.agent);
      if (!state.isEnabled(sessionId) || !state.config.maskUserMessages) return decision;
      const labels: string[] = [];
      const messages = [];
      for (const message of decision.messages) {
        messages.push(await maskMessage(message, state.config, state.vault, labels));
      }
      state.record(sessionId, labels);
      return { ...decision, messages };
    },
    { prepend: true },
  );
}

/**
 * `tools/post-execute` — mask a tool result before it becomes model-visible
 * and durable. Handles both the canonical `value` and the rendered `content`.
 * A downstream `block` decision is respected.
 */
export function registerToolPost(ctx: PluginContext, state: ShieldState): () => void {
  return ctx.on(
    "tools/post-execute",
    async (
      exec: ToolExecution,
      result: Readonly<ToolExecutionResult>,
      next: () => Promise<PostToolDecision>,
    ): Promise<PostToolDecision> => {
      const decision = await next();
      if (decision.kind === "block") return decision;
      const sessionId = sessionIdOfAgent(exec.agent);
      if (!state.isEnabled(sessionId) || !state.config.maskToolResults) return decision;

      const labels: string[] = [];
      const additional = decision.additionalContexts;
      const sourceValue = (decision.value !== undefined ? decision.value : result.value) as any;
      if (!result.isError && sourceValue !== undefined) {
        const value = await maskJsonValue(sourceValue, state.config, state.vault, labels);
        state.record(sessionId, labels);
        return {
          kind: "accept",
          value,
          ...(additional === undefined ? {} : { additionalContexts: additional }),
        };
      }

      const content = decision.content ?? result.content;
      const masked = await maskContentBlocks(content, state.config, state.vault, labels);
      state.record(sessionId, labels);
      return {
        kind: "accept",
        content: masked,
        ...(additional === undefined ? {} : { additionalContexts: additional }),
      };
    },
    { prepend: true },
  );
}

/**
 * `tools/pre-execute` — the official seam cannot rewrite arguments, but it can
 * deny. A normal tool that received a vault token is refused with guidance to
 * use one of the secure tools, which resolve tokens inside the tool body.
 */
export function registerToolPre(ctx: PluginContext, state: ShieldState): () => void {
  return ctx.on(
    "tools/pre-execute",
    async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
      if (SECURE_TOOL_NAMES.has(exec.name)) return next();
      if (!containsKnownTokenDeep(exec.arguments, state.vault)) return next();
      return {
        kind: "deny",
        reason:
          `privacy-shield: ${exec.name} received a vault token. ` +
          "Do not pass tokens to normal tools. Use secure_run for shell commands, " +
          "secure_write for files, or secure_request for HTTP; those resolve tokens " +
          "inside the tool and return masked output.",
      };
    },
    { prepend: true },
  );
}

/** `session-telemetry/record` — redact the outbound telemetry copy (one-way). */
export function registerTelemetry(ctx: PluginContext, state: ShieldState): () => void {
  return ctx.on(
    "session-telemetry/record",
    (record: TelemetryRecord, next: () => TelemetryRecord): TelemetryRecord => {
      const transformed = next();
      const attributes = transformed.attributes ?? {};
      const rawSession = attributes["session.id"] ?? attributes.sessionId ?? attributes.session_id;
      const sessionId = typeof rawSession === "string" ? rawSession : undefined;
      if (!state.isEnabled(sessionId)) return transformed;
      const labels: string[] = [];
      const body = maskJsonValueSync(transformed.body as any, state.config, labels);
      return { ...transformed, body };
    },
    { prepend: true },
  );
}

/** Register all official hooks; returns one disposer. */
export function registerHooks(ctx: PluginContext, state: ShieldState): () => void {
  const disposers = [
    registerPreStep(ctx, state),
    registerToolPost(ctx, state),
    registerToolPre(ctx, state),
    registerTelemetry(ctx, state),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
