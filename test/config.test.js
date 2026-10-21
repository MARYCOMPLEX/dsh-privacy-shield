import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../dist/config.js";

test("normalizes defaults and nested overrides", () => {
  const cfg = normalizeConfig({
    enabled: false,
    mode: "mask",
    rules: { phone: false, ipPrivate: true },
    vault: { backend: "memory" },
    secureTools: { allowedHosts: ["api.example.com"] },
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.mode, "mask");
  assert.equal(cfg.rules.phone, false);
  assert.equal(cfg.rules.ipPrivate, true);
  assert.equal(cfg.rules.email, true);
  assert.equal(cfg.vault.backend, "memory");
  assert.equal(cfg.vault.encryption, "aes-256-gcm");
  assert.deepEqual(cfg.secureTools.allowedHosts, ["api.example.com"]);
  assert.equal(cfg.secureTools.run.denyNetwork, true);
});

test("falls back on invalid enum values and ignores malformed rules", () => {
  const cfg = normalizeConfig({ mode: "nonsense", failMode: "nonsense", customRules: [{ label: "", pattern: "x" }, { label: "OK", pattern: "x" }] });
  assert.equal(cfg.mode, "vault");
  assert.equal(cfg.failMode, "closed");
  assert.deepEqual(cfg.customRules, [{ label: "OK", pattern: "x" }]);
});
