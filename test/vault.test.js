import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, vaultKeyPath } from "../dist/vault.js";

test("memory vault deduplicates values and restores tokens", async () => {
  const vault = new Vault("memory");
  await vault.init();
  const first = await vault.store("13800138000", "PHONE");
  const second = await vault.store("13800138000", "PHONE");
  assert.equal(first, second);
  assert.match(first, /^\{\{PHONE_[a-z2-7]{6}\}\}$/);
  assert.equal(vault.restore(`call ${first}`), "call 13800138000");
  assert.equal(vault.restore("{{UNKNOWN_abcdef}}"), "{{UNKNOWN_abcdef}}");
  assert.throws(() => vault.substitute("{{UNKNOWN_abcdef}}"), /unknown token/);
});

test("encrypted file vault persists 0600, hides plaintext, and reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "privacy-shield-"));
  const path = join(directory, "vault.json");
  try {
    const first = new Vault("file", path);
    await first.init();
    const token = await first.store("sk-1234567890abcdefghijklmn", "API_KEY");
    const onDisk = await readFile(path, "utf8");
    assert.ok(!onDisk.includes("sk-1234567890abcdefghijklmn"));
    assert.equal(JSON.parse(onDisk).version, 2);
    assert.equal(JSON.parse(onDisk).alg, "aes-256-gcm");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(vaultKeyPath(path))).mode & 0o777, 0o600);

    const second = new Vault("file", path);
    await second.init();
    assert.equal(second.resolve(token), "sk-1234567890abcdefghijklmn");
    assert.equal(second.size, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a vault without its key fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "privacy-shield-"));
  const path = join(directory, "vault.json");
  try {
    const first = new Vault("file", path);
    await first.init();
    await first.store("13800138000", "PHONE");
    await rm(vaultKeyPath(path), { force: true });
    const second = new Vault("file", path);
    await assert.rejects(() => second.init(), /missing key file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a v1 plaintext vault is still readable and migrates on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "privacy-shield-"));
  const path = join(directory, "vault.json");
  try {
    const { writeFile } = await import("node:fs/promises");
    const token = "{{PHONE_abcdef}}";
    await writeFile(path, JSON.stringify({ version: 1, entries: { [token]: { value: "13800138000", label: "PHONE" } } }), "utf8");
    const vault = new Vault("file", path);
    await vault.init();
    assert.equal(vault.resolve(token), "13800138000");
    await vault.close();
    const migrated = await readFile(path, "utf8");
    assert.equal(JSON.parse(migrated).version, 2);
    assert.ok(!migrated.includes("13800138000"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt file vault fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "privacy-shield-"));
  const path = join(directory, "vault.json");
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{not-json", "utf8");
    const vault = new Vault("file", path);
    await assert.rejects(() => vault.init(), /not valid JSON/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
