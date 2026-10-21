import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { makeToken, normalizeLabel, parseToken, randomSuffix, TOKEN_RE } from "./tokens.js";

export type VaultBackend = "memory" | "file";

interface Entry {
  readonly value: string;
  readonly label: string;
}

/** Default on-disk vault: `$DSH_HOME/privacy-shield/vault.json`, else `~/.dsh/...`. */
export function defaultVaultPath(env: Record<string, string | undefined> = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== "" ? env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "privacy-shield", "vault.json");
}

/**
 * Reversible token store. The vault owns the only mapping; the model and the
 * session log only ever see tokens. File mode persists the mapping (0600) so a
 * restart can still resolve tokens; memory mode is ephemeral by design.
 */
export class Vault {
  private readonly byToken = new Map<string, Entry>();
  private readonly byValue = new Map<string, string>();
  private readonly backend: VaultBackend;
  private readonly path: string;

  constructor(backend: VaultBackend, path?: string) {
    this.backend = backend;
    this.path = path !== undefined && path !== "" ? path : defaultVaultPath();
  }

  async init(): Promise<void> {
    if (this.backend !== "file") return;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (raw.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`privacy-shield vault: ${this.path} is not valid JSON`, { cause: error });
    }
    const record = parsed as { version?: unknown; entries?: unknown };
    if (record === null || typeof record !== "object" || record.entries === null || typeof record.entries !== "object") {
      throw new Error(`privacy-shield vault: ${this.path} must contain an entries object`);
    }
    for (const [token, entry] of Object.entries(record.entries as Record<string, unknown>)) {
      if (parseToken(token) === undefined) {
        throw new Error(`privacy-shield vault: invalid token ${JSON.stringify(token)}`);
      }
      const value = entry as { value?: unknown; label?: unknown };
      if (value === null || typeof value !== "object" || typeof value.value !== "string") {
        throw new Error(`privacy-shield vault: invalid entry for ${token}`);
      }
      const label = normalizeLabel(typeof value.label === "string" ? value.label : "SECRET");
      this.byToken.set(token, { value: value.value, label });
      this.byValue.set(value.value, token);
    }
  }

  get size(): number {
    return this.byToken.size;
  }

  /** Return a stable token for the value, storing it first when necessary. */
  async store(value: string, label: string): Promise<string> {
    const existing = this.byValue.get(value);
    if (existing !== undefined) return existing;
    let token = "";
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = makeToken(label, randomSuffix());
      if (!this.byToken.has(candidate)) {
        token = candidate;
        break;
      }
    }
    if (token === "") throw new Error("privacy-shield vault: could not allocate a unique token");
    this.byToken.set(token, { value, label: normalizeLabel(label) });
    this.byValue.set(value, token);
    if (this.backend === "file") await this.persist();
    return token;
  }

  resolve(token: string): string | undefined {
    return this.byToken.get(token)?.value;
  }

  /** Whether this exact token is known to the vault. */
  has(token: string): boolean {
    return this.byToken.has(token);
  }

  /** Replace every known token; unknown tokens are left untouched. */
  restore(text: string): string {
    return text.replace(TOKEN_RE, (token) => this.resolve(token) ?? token);
  }

  /** Replace every token; fail closed when any token is unknown. */
  substitute(text: string): string {
    let unknown: string | undefined;
    const out = text.replace(TOKEN_RE, (token) => {
      const value = this.resolve(token);
      if (value === undefined) {
        unknown ??= token;
        return token;
      }
      return value;
    });
    if (unknown !== undefined) throw new Error(`privacy-shield: unknown token ${unknown}; refusing to execute`);
    return out;
  }

  async close(): Promise<void> {
    if (this.backend === "file") await this.persist().catch(() => undefined);
    this.byToken.clear();
    this.byValue.clear();
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entries: Record<string, Entry> = {};
    for (const [token, entry] of this.byToken) entries[token] = entry;
    const body = `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
    const temporary = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** Open the configured vault; file mode creates the directory lazily on first write. */
export async function openVault(backend: VaultBackend, path?: string): Promise<Vault> {
  const vault = new Vault(backend, path);
  await vault.init();
  return vault;
}
