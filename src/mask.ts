import type { ShieldConfig } from "./config.js";
import { applyMatches, detectMatches, type Match } from "./detect.js";
import type { ContentBlock, JsonValue, Message, ReasoningBlock, TextBlock, ToolCallBlock, ToolResultBlock } from "./types.js";
import { containsToken, TOKEN_RE } from "./tokens.js";
import type { Vault } from "./vault.js";

function maskedPlaceholder(label: string): string {
  return `[REDACTED:${label}]`;
}

/**
 * Mask one plain-text string. In `mask` mode the replacement is irreversible;
 * in `vault` mode every match is stored and replaced with a stable token.
 */
export async function maskText(
  text: string,
  config: ShieldConfig,
  vault: Vault | undefined,
  labels?: string[],
): Promise<string> {
  if (text.length === 0) return text;
  const matches = detectMatches(text, config);
  if (matches.length === 0) return text;

  const replacements = new Map<Match, string>();
  for (const match of matches) {
    if (config.mode === "mask") {
      replacements.set(match, maskedPlaceholder(match.label));
      labels?.push(match.label);
      continue;
    }
    if (vault === undefined) {
      if (config.failMode === "closed") throw new Error("privacy-shield: vault mode requires a vault");
      replacements.set(match, maskedPlaceholder(match.label));
      labels?.push(match.label);
      continue;
    }
    try {
      replacements.set(match, await vault.store(match.value, match.label));
      labels?.push(match.label);
    } catch (error) {
      if (config.failMode === "open") {
        replacements.set(match, maskedPlaceholder(match.label));
        labels?.push(match.label);
      } else {
        throw error;
      }
    }
  }
  return applyMatches(text, matches, (match) => replacements.get(match) ?? maskedPlaceholder(match.label));
}

/** Synchronous mask-only path for telemetry (never writes the vault). */
export function maskTextSync(text: string, config: ShieldConfig, labels?: string[]): string {
  if (text.length === 0) return text;
  const matches = detectMatches(text, config);
  if (matches.length === 0) return text;
  for (const match of matches) labels?.push(match.label);
  return applyMatches(text, matches, (match) => maskedPlaceholder(match.label));
}

export async function maskJsonValue(
  value: JsonValue,
  config: ShieldConfig,
  vault: Vault | undefined,
  labels?: string[],
): Promise<JsonValue> {
  if (typeof value === "string") return maskText(value, config, vault, labels);
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const item of value) out.push(await maskJsonValue(item, config, vault, labels));
    return out;
  }
  if (value !== null && typeof value === "object") {
    const entries: Array<[string, JsonValue]> = [];
    for (const [key, item] of Object.entries(value)) entries.push([key, await maskJsonValue(item, config, vault, labels)]);
    return Object.fromEntries(entries) as { [key: string]: JsonValue };
  }
  return value;
}

export function maskJsonValueSync(value: JsonValue, config: ShieldConfig, labels?: string[]): JsonValue {
  if (typeof value === "string") return maskTextSync(value, config, labels);
  if (Array.isArray(value)) return value.map((item) => maskJsonValueSync(item, config, labels));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskJsonValueSync(item, config, labels)]),
    ) as { [key: string]: JsonValue };
  }
  return value;
}

/** Mask every decoded string inside one raw JSON document. */
export async function maskJsonString(
  raw: string,
  config: ShieldConfig,
  vault: Vault | undefined,
  labels?: string[],
): Promise<string> {
  if (raw.length === 0) return raw;
  try {
    const parsed = JSON.parse(raw) as JsonValue;
    return JSON.stringify(await maskJsonValue(parsed, config, vault, labels));
  } catch {
    // The model emitted malformed JSON. Masking the raw text is safer than
    // passing it through untouched; the tool's own parser will still fail.
    return maskText(raw, config, vault, labels);
  }
}

export async function maskContentBlocks(
  blocks: readonly ContentBlock[],
  config: ShieldConfig,
  vault: Vault | undefined,
  labels?: string[],
): Promise<ContentBlock[]> {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
      case "reasoning": {
        const typed = block as TextBlock | ReasoningBlock;
        const text = await maskText(typed.text, config, vault, labels);
        out.push(text === typed.text ? block : { ...typed, text });
        break;
      }
      case "tool-call": {
        const typed = block as ToolCallBlock;
        const args = await maskJsonString(typed.arguments, config, vault, labels);
        out.push(args === typed.arguments ? block : { ...typed, arguments: args });
        break;
      }
      case "tool-result": {
        const typed = block as ToolResultBlock;
        const content = await maskContentBlocks(typed.content, config, vault, labels);
        out.push(content === typed.content ? block : { ...typed, content });
        break;
      }
      default:
        out.push(block);
        break;
    }
  }
  return out;
}

export function maskContentBlocksSync(
  blocks: readonly ContentBlock[],
  config: ShieldConfig,
  labels?: string[],
): ContentBlock[] {
  return blocks.map((block) => {
    switch (block.type) {
      case "text":
      case "reasoning": {
        const typed = block as TextBlock | ReasoningBlock;
        const text = maskTextSync(typed.text, config, labels);
        return text === typed.text ? block : { ...typed, text };
      }
      case "tool-call": {
        const typed = block as ToolCallBlock;
        let args = typed.arguments;
        try {
          const parsed = JSON.parse(typed.arguments) as JsonValue;
          args = JSON.stringify(maskJsonValueSync(parsed, config, labels));
        } catch {
          args = maskTextSync(typed.arguments, config, labels);
        }
        return args === typed.arguments ? block : { ...typed, arguments: args };
      }
      case "tool-result": {
        const typed = block as ToolResultBlock;
        const content = maskContentBlocksSync(typed.content, config, labels);
        return content === typed.content ? block : { ...typed, content };
      }
      default:
        return block;
    }
  });
}

export async function maskMessage<M extends Message>(
  message: M,
  config: ShieldConfig,
  vault: Vault | undefined,
  labels?: string[],
): Promise<M> {
  const content = await maskContentBlocks(message.content, config, vault, labels);
  return (content === message.content ? message : { ...message, content }) as M;
}

/** True when any string in the value contains a complete placeholder. */
export function containsTokenDeep(value: unknown): boolean {
  if (typeof value === "string") return containsToken(value);
  if (Array.isArray(value)) return value.some((item) => containsTokenDeep(item));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => containsTokenDeep(item));
  }
  return false;
}

/** True when any string contains a token this vault can resolve. */
export function containsKnownTokenDeep(value: unknown, vault: Vault): boolean {
  if (typeof value === "string") {
    for (const match of value.matchAll(TOKEN_RE)) {
      if (vault.has(match[0])) return true;
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((item) => containsKnownTokenDeep(item, vault));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => containsKnownTokenDeep(item, vault));
  }
  return false;
}

/** Restore every known token in one string; unknown tokens are kept verbatim. */
export function restoreText(text: string, vault: Vault): string {
  return vault.restore(text);
}
