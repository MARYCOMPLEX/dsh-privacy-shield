/**
 * Minimal structural types for the DeepSeek Harness seams this plugin uses.
 *
 * They intentionally mirror the public event payloads instead of importing a
 * specific DSH release: a masking plugin must keep working across patch
 * releases, and the fields it touches (messages, content blocks, tool
 * arguments) have been stable. Runtime validation lives in the hooks.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ReasoningBlock {
  type: "reasoning";
  text: string;
}

export interface ToolCallBlock {
  type: "tool-call";
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResultBlock {
  type: "tool-result";
  toolCallId: string;
  content: ContentBlock[];
  isError?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ToolCallBlock
  | ToolResultBlock
  | { type: string; [key: string]: unknown };

export interface Message {
  readonly id?: string;
  readonly role: string;
  readonly content: ContentBlock[];
  readonly source?: unknown;
  [key: string]: unknown;
}

export interface UserMessage extends Message {
  readonly role: "user";
}

export interface SessionLike {
  readonly id?: string;
}

export interface AgentLike {
  readonly session?: SessionLike;
}

export interface PreStepPayload {
  readonly agent?: AgentLike;
  readonly messages: UserMessage[];
  readonly turn: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

export type PreStepDecision =
  | { kind: "reject" }
  | { kind: "enter"; messages: UserMessage[]; startsRequestSeries?: true };

export interface ToolExecution {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly agent?: AgentLike;
  readonly signal: AbortSignal;
  [key: string]: unknown;
}

export interface ToolExecutionSuccess {
  readonly isError: false;
  readonly value?: JsonValue;
  readonly content: ContentBlock[];
  readonly additionalContexts?: UserMessage[];
  [key: string]: unknown;
}

export interface ToolExecutionFailure {
  readonly isError: true;
  readonly error: unknown;
  readonly content: ContentBlock[];
  [key: string]: unknown;
}

export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure;

export type PreToolDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason?: string };

export type PostToolDecision =
  | {
      kind: "accept";
      value?: JsonValue;
      content?: ContentBlock[];
      additionalContexts?: UserMessage[];
    }
  | { kind: "block"; feedback: ContentBlock[] };

export interface TelemetryRecord {
  readonly channel: string;
  readonly time: number;
  readonly severity: string;
  readonly attributes: Record<string, string | number>;
  readonly body: unknown;
}

/** The slice of the Cordis context this plugin needs; unknown services are optional. */
export interface PluginContext {
  readonly logger?: {
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
  };
  on(
    event: string,
    listener: (...args: any[]) => any,
    options?: { prepend?: boolean },
  ): () => void;
  inject?(deps: string[], callback: (ctx: any) => void): void;
  get?(name: string): any;
  effect?(callback: () => void | (() => void), label?: string): void;
  commands?: { register(definition: any): () => void };
  tools?: { register(definition: any): () => void };
  systemPrompt?: { section(definition: any): () => void };
  [key: string]: unknown;
}
