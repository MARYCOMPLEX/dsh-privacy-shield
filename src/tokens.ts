import { randomBytes } from "node:crypto";

/** Model-facing token: `{{LABEL_xxxxxx}}`. */
export const TOKEN_RE = /\{\{([A-Z0-9_]{1,12})_([a-z2-7]{6})\}\}/g;
export const TOKEN_TEST_RE = /\{\{[A-Z0-9_]{1,12}_[a-z2-7]{6}\}\}/;
export const TOKEN_LABEL_RE = /^[A-Z0-9_]{1,12}$/;
export const TOKEN_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Normalize an arbitrary rule label into the 12-character ASCII token label. */
export function normalizeLabel(label: string): string {
  const normalized = String(label || "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 12);
  return TOKEN_LABEL_RE.test(normalized) ? normalized : "SECRET";
}

/** Six base32 characters: 32^6 = 1,073,741,824 possible suffixes. */
export function randomSuffix(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (const byte of bytes) out += TOKEN_SUFFIX_ALPHABET[byte % 32];
  return out;
}

export function makeToken(label: string, suffix: string): string {
  return `{{${normalizeLabel(label)}_${suffix}}}`;
}

export function parseToken(token: string): { label: string; suffix: string } | undefined {
  const match = /^\{\{([A-Z0-9_]{1,12})_([a-z2-7]{6})\}\}$/.exec(token);
  return match ? { label: match[1], suffix: match[2] } : undefined;
}

/** Whether a string contains at least one complete token. */
export function containsToken(text: string): boolean {
  return TOKEN_TEST_RE.test(text);
}

/** Token ranges in one string, used to avoid re-masking an existing placeholder. */
export function tokenRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    if (match.index === undefined) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}
