import { TOKEN_RE, tokenRanges } from "./tokens.js";

export interface RuleFlags {
  secrets: boolean;
  phone: boolean;
  email: boolean;
  idcard: boolean;
  bankcard: boolean;
  ipPrivate: boolean;
  jwt: boolean;
  privateKey: boolean;
}

export interface CustomRule {
  readonly label: string;
  readonly pattern: string;
}

export interface DetectConfig {
  readonly rules: RuleFlags;
  readonly allowlist: readonly string[];
  readonly customRules: readonly CustomRule[];
}

export interface Match {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly label: string;
  readonly priority: number;
}

interface Rule {
  readonly label: string;
  readonly regex: RegExp;
  readonly group?: number;
  readonly priority: number;
  readonly enabled: boolean;
  readonly validate?: (value: string, text: string) => boolean;
}

const SECRET_PRIORITY = 10;
const PII_PRIORITY = 5;
const ID_PRIORITY = 6;

/** Luhn checksum over digits, ignoring spaces and dashes. */
export function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/g, "");
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Mainland-China 18-digit resident ID checksum (ISO 7064 MOD 11-2). */
export function idCard18Valid(candidate: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(candidate)) return false;
  const year = Number(candidate.slice(6, 10));
  const month = Number(candidate.slice(10, 12));
  const day = Number(candidate.slice(12, 14));
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const check = "10X98765432";
  let sum = 0;
  for (let index = 0; index < 17; index += 1) sum += Number(candidate[index]) * weights[index];
  return check[sum % 11] === candidate[17].toUpperCase();
}

export function phoneCnValid(candidate: string): boolean {
  const digits = candidate.replace(/[^\d]/g, "").replace(/^0086/, "").replace(/^86/, "");
  return /^1[3-9]\d{9}$/.test(digits);
}

export function emailValid(candidate: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(candidate);
}

function assignmentValueValid(value: string): boolean {
  if (value.length < 6) return false;
  if (/(?:example|sample|placeholder|changeme|your[_-]?|xxxx|redacted)/i.test(value)) return false;
  if (value.startsWith("{{") || value.startsWith("[REDACTED")) return false;
  return true;
}

function connstrPasswordValid(value: string): boolean {
  if (value.length < 4) return false;
  if (/^(?:password|passwd|pass|pwd|secret|token|user|username|xxxx+|\*+)$/i.test(value)) return false;
  return true;
}

function ipv4PrivateValid(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function buildRules(config: DetectConfig): Rule[] {
  const rules: Rule[] = [];
  const add = (label: string, pattern: string, priority: number, enabled: boolean, group?: number, validate?: Rule["validate"], flags = "g") => {
    if (!enabled) return;
    rules.push({ label, regex: new RegExp(pattern, flags), priority, enabled, ...(group === undefined ? {} : { group }), ...(validate === undefined ? {} : { validate }) });
  };

  const s = config.rules.secrets;
  add("PRIVATE_KEY", String.raw`-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]{0,20000}?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----`, 11, s && config.rules.privateKey);
  add("PRIVATE_KEY", String.raw`-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----`, 11, s && config.rules.privateKey);
  add("API_KEY", String.raw`\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b`, SECRET_PRIORITY, s);
  add("GITHUB_TOKEN", String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b`, SECRET_PRIORITY, s);
  add("AWS_KEY", String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`, SECRET_PRIORITY, s);
  add("GOOGLE_KEY", String.raw`\bAIza[0-9A-Za-z_-]{35}\b`, SECRET_PRIORITY, s);
  add("SLACK_TOKEN", String.raw`\bxox[baprs]-[0-9A-Za-z-]{10,}\b`, SECRET_PRIORITY, s);
  add("STRIPE_KEY", String.raw`\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b`, SECRET_PRIORITY, s);
  add("NPM_TOKEN", String.raw`\bnpm_[A-Za-z0-9]{30,}\b`, SECRET_PRIORITY, s);
  add("PYPI_TOKEN", String.raw`\bpypi-[A-Za-z0-9_-]{30,}\b`, SECRET_PRIORITY, s);
  add("GITLAB_TOKEN", String.raw`\bglpat-[A-Za-z0-9_-]{20,}\b`, SECRET_PRIORITY, s);
  add("HF_TOKEN", String.raw`\bhf_[A-Za-z0-9]{30,}\b`, SECRET_PRIORITY, s);
  add("JWT", String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`, SECRET_PRIORITY, s && config.rules.jwt);
  add("BEARER", String.raw`\bBearer\s+([A-Za-z0-9._~+/=-]{20,})`, 9, s, 1);
  add(
    "SECRET",
    String.raw`\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*[:=]\s*["']?([A-Za-z0-9!@#$%^&*_~+=./-]{6,})`,
    SECRET_PRIORITY,
    s,
    1,
    assignmentValueValid,
    "gi",
  );
  add(
    "CONNSTR",
    String.raw`\b[a-z][a-z0-9+.-]{0,32}://[^\s:@/]+:([^\s@/]{4,})@`,
    SECRET_PRIORITY,
    s,
    1,
    connstrPasswordValid,
  );

  add("EMAIL", String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`, PII_PRIORITY, config.rules.email, 0, emailValid);
  add(
    "PHONE",
    String.raw`(?<!\d)(?:\+?86|0086)[ -]?1[3-9]\d(?:[ -]?\d{4}){2}(?!\d)|(?<!\d)1[3-9]\d(?:[ -]?\d{4}){2}(?!\d)`,
    PII_PRIORITY,
    config.rules.phone,
    0,
    phoneCnValid,
  );
  add("IDCARD", String.raw`(?<!\d)\d{17}[\dXx](?!\d)`, ID_PRIORITY, config.rules.idcard, 0, idCard18Valid);
  add("BANKCARD", String.raw`(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)`, PII_PRIORITY, config.rules.bankcard, 0, luhnValid);
  add(
    "IP_PRIVATE",
    String.raw`(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])`,
    PII_PRIORITY,
    config.rules.ipPrivate,
    0,
    ipv4PrivateValid,
  );

  for (const custom of config.customRules) {
    rules.push({
      label: custom.label,
      regex: new RegExp(custom.pattern, "g"),
      priority: 8,
      enabled: true,
    });
  }
  return rules;
}

function overlaps(start: number, end: number, ranges: ReadonlyArray<{ start: number; end: number }>): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function mergeMatches(matches: Match[]): Match[] {
  const sorted = [...matches].sort((a, b) =>
    a.start - b.start || b.priority - a.priority || b.value.length - a.value.length,
  );
  const out: Match[] = [];
  for (const match of sorted) {
    const previous = out[out.length - 1];
    if (previous === undefined || match.start >= previous.end) {
      out.push(match);
      continue;
    }
    if (
      match.priority > previous.priority ||
      (match.priority === previous.priority && match.value.length > previous.value.length)
    ) {
      out[out.length - 1] = match;
    }
  }
  return out;
}

/** Detect every enabled sensitive span in one string. */
export function detectMatches(text: string, config: DetectConfig): Match[] {
  if (text.length === 0) return [];
  const existing = tokenRanges(text);
  const matches: Match[] = [];
  for (const rule of buildRules(config)) {
    if (!rule.enabled) continue;
    rule.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        rule.regex.lastIndex += 1;
        continue;
      }
      const group = rule.group ?? 0;
      const value = match[group];
      if (value === undefined || value.length === 0) continue;
      const offset = group === 0 ? 0 : Math.max(0, match[0].lastIndexOf(value));
      const start = match.index + offset;
      const end = start + value.length;
      if (overlaps(start, end, existing)) continue;
      if (rule.validate !== undefined && !rule.validate(value, text)) continue;
      if (config.allowlist.some((entry) => entry.length > 0 && value.toLowerCase().includes(entry.toLowerCase()))) continue;
      matches.push({ start, end, value, label: rule.label, priority: rule.priority });
    }
  }
  return mergeMatches(matches);
}

/** Replace every detected span from the end so earlier offsets stay valid. */
export function applyMatches(
  text: string,
  matches: readonly Match[],
  replacement: (match: Match) => string,
): string {
  let out = text;
  for (const match of [...matches].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, match.start) + replacement(match) + out.slice(match.end);
  }
  return out;
}

/** Token ranges for callers that need to preserve existing placeholders. */
export function existingTokenRanges(text: string): Array<{ start: number; end: number }> {
  return tokenRanges(text);
}

/** Exported for callers that want to validate a standalone candidate. */
export const validators = {
  luhn: luhnValid,
  idCard18: idCard18Valid,
  phoneCn: phoneCnValid,
  email: emailValid,
  ipv4Private: ipv4PrivateValid,
};

/** A cheap sentinel used by `/privacy test`; never a real credential. */
export const SENTINEL_TEXT = "phone 13800138000, email a@b.com, key sk-1234567890abcdefghijklmn";
export { TOKEN_RE };
