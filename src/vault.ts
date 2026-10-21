import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { makeToken, normalizeLabel, parseToken, randomSuffix, TOKEN_RE } from "./tokens.js";

export type VaultBackend = "memory" | "file";
export type VaultEncryption = "aes-256-gcm" | "none";

interface Entry {
  readonly value: string;
  readonly label: string;
}

interface EncryptedFile {
  readonly version: 2;
  readonly alg: "aes-256-gcm";
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

interface PlainFile {
  readonly version: 1;
  readonly entries: Record<string, Entry>;
}

/** Default on-disk vault: `$DSH_HOME/privacy-shield/vault.json`, else `~/.dsh/...`. */
export function defaultVaultPath(env: Record<string, string | undefined> = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== "" ? env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "privacy-shield", "vault.json");
}

/** Key file next to the vault, mode 0600. Created lazily on the first encrypted write. */
export function vaultKeyPath(vaultPath: string): string {
  return `${vaultPath}.key`;
}

function decodeBase64(value: unknown, field: string): Buffer {
  if (typeof value !== "string") throw new Error(`privacy-shield vault: ${field} must be base64`);
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0) throw new Error(`privacy-shield vault: ${field} is empty`);
  return buffer;
}

/**
 * Reversible token store. The vault owns the only mapping; the model and the
 * session log only ever see tokens. File mode persists the mapping (0600) so a
 * restart can still resolve tokens; memory mode is ephemeral by design.
 *
 * File format v2 is AES-256-GCM with a 0600 key file next to the vault. A v1
 * plaintext file is still readable and is re-encrypted on the next persist.
 */
export class Vault {
  private readonly byToken = new Map<string, Entry>();
  private readonly byValue = new Map<string, string>();
  private readonly backend: VaultBackend;
  private readonly path: string;
  private readonly encryption: VaultEncryption;
  private dirty = false;

  constructor(backend: VaultBackend, path?: string, encryption: VaultEncryption = "aes-256-gcm") {
    this.backend = backend;
    this.path = path !== undefined && path !== "" ? path : defaultVaultPath();
    this.encryption = encryption;
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
    const record = parsed as Record<string, unknown>;
    if (record === null || typeof record !== "object") throw new Error("privacy-shield vault: invalid document");

    if (record.version === 2 && record.alg === "aes-256-gcm") {
      const key = await this.readKey();
      const iv = decodeBase64(record.iv, "iv");
      const tag = decodeBase64(record.tag, "tag");
      const data = decodeBase64(record.data, "data");
      let plaintext: string;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
      } catch (error) {
        throw new Error("privacy-shield vault: cannot decrypt (wrong key or corrupt file)", { cause: error });
      }
      let entries: unknown;
      try {
        entries = (JSON.parse(plaintext) as { entries?: unknown }).entries;
      } catch (error) {
        throw new Error("privacy-shield vault: decrypted payload is not JSON", { cause: error });
      }
      this.loadEntries(entries);
      return;
    }

    if (record.version === 1 || record.entries !== undefined) {
      this.loadEntries(record.entries);
      // A v1 plaintext file is upgraded to v2 on the next persist.
      this.dirty = this.encryption === "aes-256-gcm";
      return;
    }

    throw new Error(`privacy-shield vault: unsupported format in ${this.path}`);
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
    this.dirty = true;
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
    if (this.backend === "file" && (this.dirty || this.encryption === "aes-256-gcm")) {
      await this.persist().catch(() => undefined);
    }
    this.byToken.clear();
    this.byValue.clear();
  }

  private loadEntries(value: unknown): void {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("privacy-shield vault: entries must be an object");
    }
    for (const [token, entry] of Object.entries(value as Record<string, unknown>)) {
      if (parseToken(token) === undefined) {
        throw new Error(`privacy-shield vault: invalid token ${JSON.stringify(token)}`);
      }
      const raw = entry as { value?: unknown; label?: unknown };
      if (raw === null || typeof raw !== "object" || typeof raw.value !== "string") {
        throw new Error(`privacy-shield vault: invalid entry for ${token}`);
      }
      const label = normalizeLabel(typeof raw.label === "string" ? raw.label : "SECRET");
      this.byToken.set(token, { value: raw.value, label });
      this.byValue.set(raw.value, token);
    }
  }

  private async readKey(): Promise<Buffer> {
    const keyPath = vaultKeyPath(this.path);
    let key: Buffer;
    try {
      key = await readFile(keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`privacy-shield vault: missing key file ${keyPath}`);
      }
      throw error;
    }
    if (key.length !== 32) throw new Error(`privacy-shield vault: key file ${keyPath} must be 32 bytes`);
    return key;
  }

  private async ensureKey(): Promise<Buffer> {
    const keyPath = vaultKeyPath(this.path);
    try {
      return await this.readKey();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("missing key file")) throw error;
    }
    const key = randomBytes(32);
    await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
    await writeFile(keyPath, key, { mode: 0o600 });
    await chmod(keyPath, 0o600);
    return key;
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entries: Record<string, Entry> = {};
    for (const [token, entry] of this.byToken) entries[token] = entry;

    let body: string;
    if (this.encryption === "none") {
      const plain: PlainFile = { version: 1, entries };
      body = `${JSON.stringify(plain, null, 2)}\n`;
    } else {
      const key = await this.ensureKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify({ version: 2, entries }), "utf8"),
        cipher.final(),
      ]);
      const encrypted: EncryptedFile = {
        version: 2,
        alg: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: ciphertext.toString("base64"),
      };
      body = `${JSON.stringify(encrypted, null, 2)}\n`;
    }

    const temporary = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    this.dirty = false;
  }
}

/** Open the configured vault; file mode creates the directory lazily on first write. */
export async function openVault(
  backend: VaultBackend,
  path?: string,
  encryption: VaultEncryption = "aes-256-gcm",
): Promise<Vault> {
  const vault = new Vault(backend, path, encryption);
  await vault.init();
  return vault;
}
