import z from "@deepseek-ai/schemastery";
import type { CustomRule, RuleFlags } from "./detect.js";

export interface ShieldConfig {
  /** Master switch; `/privacy on|off` overrides it per session at runtime. */
  readonly enabled: boolean;
  /** `vault` stores reversible tokens; `mask` is irreversible. */
  readonly mode: "mask" | "vault";
  readonly maskUserMessages: boolean;
  readonly maskToolResults: boolean;
  /** Vault write/read failure semantics. `closed` refuses to send unmasked data. */
  readonly failMode: "closed" | "open";
  readonly rules: RuleFlags;
  readonly customRules: readonly CustomRule[];
  readonly allowlist: readonly string[];
  readonly vault: {
    readonly backend: "memory" | "file";
    /** Empty means `$DSH_HOME/privacy-shield/vault.json`. */
    readonly path: string;
  };
  readonly secureTools: {
    readonly enabled: boolean;
    /** Empty means any host is allowed; otherwise exact host or `*.suffix`. */
    readonly allowedHosts: readonly string[];
  };
}

export const DEFAULT_CONFIG: ShieldConfig = Object.freeze({
  enabled: true,
  mode: "vault",
  maskUserMessages: true,
  maskToolResults: true,
  failMode: "closed",
  rules: Object.freeze({
    secrets: true,
    phone: true,
    email: true,
    idcard: true,
    bankcard: true,
    ipPrivate: false,
    jwt: true,
    privateKey: true,
  }),
  customRules: Object.freeze([]),
  allowlist: Object.freeze([]),
  vault: Object.freeze({ backend: "file", path: "" }),
  secureTools: Object.freeze({ enabled: true, allowedHosts: Object.freeze([]) }),
});

/** Schemastery schema for the DSH plugin config surface. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  mode: z.union(["mask", "vault"]).default("vault"),
  maskUserMessages: z.boolean().default(true),
  maskToolResults: z.boolean().default(true),
  failMode: z.union(["closed", "open"]).default("closed"),
  rules: z
    .object({
      secrets: z.boolean().default(true),
      phone: z.boolean().default(true),
      email: z.boolean().default(true),
      idcard: z.boolean().default(true),
      bankcard: z.boolean().default(true),
      ipPrivate: z.boolean().default(false),
      jwt: z.boolean().default(true),
      privateKey: z.boolean().default(true),
    })
    .default({}),
  customRules: z
    .array(z.object({ label: z.string(), pattern: z.string() }))
    .default([]),
  allowlist: z.array(z.string()).default([]),
  vault: z
    .object({
      backend: z.union(["memory", "file"]).default("file"),
      path: z.string().default(""),
    })
    .default({}),
  secureTools: z
    .object({
      enabled: z.boolean().default(true),
      allowedHosts: z.array(z.string()).default([]),
    })
    .default({}),
});

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function customRules(value: unknown): CustomRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const label = typeof record.label === "string" ? record.label : "";
    const pattern = typeof record.pattern === "string" ? record.pattern : "";
    return label.length > 0 && pattern.length > 0 ? [{ label, pattern }] : [];
  });
}

/** Resolve defaults without trusting the loader to have applied the schema. */
export function normalizeConfig(raw: unknown): ShieldConfig {
  const cfg = asRecord(raw);
  const rules = asRecord(cfg.rules);
  const vault = asRecord(cfg.vault);
  const secure = asRecord(cfg.secureTools);
  return {
    enabled: bool(cfg.enabled, DEFAULT_CONFIG.enabled),
    mode: cfg.mode === "mask" || cfg.mode === "vault" ? cfg.mode : DEFAULT_CONFIG.mode,
    maskUserMessages: bool(cfg.maskUserMessages, DEFAULT_CONFIG.maskUserMessages),
    maskToolResults: bool(cfg.maskToolResults, DEFAULT_CONFIG.maskToolResults),
    failMode: cfg.failMode === "open" || cfg.failMode === "closed" ? cfg.failMode : DEFAULT_CONFIG.failMode,
    rules: {
      secrets: bool(rules.secrets, DEFAULT_CONFIG.rules.secrets),
      phone: bool(rules.phone, DEFAULT_CONFIG.rules.phone),
      email: bool(rules.email, DEFAULT_CONFIG.rules.email),
      idcard: bool(rules.idcard, DEFAULT_CONFIG.rules.idcard),
      bankcard: bool(rules.bankcard, DEFAULT_CONFIG.rules.bankcard),
      ipPrivate: bool(rules.ipPrivate, DEFAULT_CONFIG.rules.ipPrivate),
      jwt: bool(rules.jwt, DEFAULT_CONFIG.rules.jwt),
      privateKey: bool(rules.privateKey, DEFAULT_CONFIG.rules.privateKey),
    },
    customRules: customRules(cfg.customRules),
    allowlist: list(cfg.allowlist),
    vault: {
      backend: vault.backend === "memory" || vault.backend === "file" ? vault.backend : DEFAULT_CONFIG.vault.backend,
      path: typeof vault.path === "string" ? vault.path : DEFAULT_CONFIG.vault.path,
    },
    secureTools: {
      enabled: bool(secure.enabled, DEFAULT_CONFIG.secureTools.enabled),
      allowedHosts: list(secure.allowedHosts),
    },
  };
}
