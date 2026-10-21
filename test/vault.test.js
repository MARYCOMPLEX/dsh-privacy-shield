import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../dist/vault.js";

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

test("file vault persists 0600 and reloads the mapping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "privacy-shield-"));
  const path = join(directory, "vault.json");
  try {
    const first = new Vault("file", path);
    await first.init();
    const token = await first.store("sk-1234567890abcdefghijklmn", "API_KEY");
    assert.equal((await stat(path)).mode & 0o777, 0o600);

    const second = new Vault("file", path);
    await second.init();
    assert.equal(second.resolve(token), "sk-1234567890abcdefghijklmn");
    assert.equal(second.size, 1);
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
