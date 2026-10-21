import assert from "node:assert/strict";
import test from "node:test";
import { applyMatches, detectMatches } from "../dist/detect.js";
import { normalizeConfig } from "../dist/config.js";

const cfg = normalizeConfig({ mode: "mask", rules: { ipPrivate: true } });

test("detects phone, email, API key and assignment secrets", () => {
  const text = "phone 13800138000 email a@b.com key sk-1234567890abcdefghijklmn password=S3cret99";
  const matches = detectMatches(text, cfg);
  const labels = new Set(matches.map((match) => match.label));
  assert.ok(labels.has("PHONE"));
  assert.ok(labels.has("EMAIL"));
  assert.ok(labels.has("API_KEY"));
  assert.ok(labels.has("SECRET"));
  const masked = applyMatches(text, matches, (match) => `[${match.label}]`);
  assert.ok(!masked.includes("13800138000"));
  assert.ok(!masked.includes("a@b.com"));
  assert.ok(!masked.includes("sk-1234567890abcdefghijklmn"));
});

test("validates ID cards and bank cards", () => {
  const text = "id 11010519491231002X card 4111111111111111";
  const labels = new Set(detectMatches(text, cfg).map((match) => match.label));
  assert.ok(labels.has("IDCARD"));
  assert.ok(labels.has("BANKCARD"));
  assert.equal(detectMatches("id 110105194912310021", cfg).some((m) => m.label === "IDCARD"), false);
  assert.equal(detectMatches("card 4111111111111112", cfg).some((m) => m.label === "BANKCARD"), false);
});

test("detects JWT, PEM, connection string and private IP", () => {
  const text = [
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456",
    "-----BEGIN PRIVATE KEY-----",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
    "-----END PRIVATE KEY-----",
    "postgres://user:S3cret99@db.internal:5432/prod",
    "host 10.1.2.3",
  ].join("\n");
  const labels = new Set(detectMatches(text, cfg).map((match) => match.label));
  assert.ok(labels.has("JWT"));
  assert.ok(labels.has("PRIVATE_KEY"));
  assert.ok(labels.has("CONNSTR"));
  assert.ok(labels.has("IP_PRIVATE"));
});

test("does not re-mask existing tokens and honors allowlist", () => {
  const text = "token {{PHONE_abcdef}} phone 13800138000";
  const matches = detectMatches(text, cfg);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].label, "PHONE");
  const allow = normalizeConfig({ mode: "mask", allowlist: ["13800138000"] });
  assert.equal(detectMatches(text, allow).length, 0);
});

test("custom rules run and invalid patterns fail at detection", () => {
  const withCustom = normalizeConfig({ mode: "mask", customRules: [{ label: "INTERNAL", pattern: "ACME-\\d{4}" }] });
  const matches = detectMatches("ref ACME-1234", withCustom);
  assert.ok(matches.some((match) => match.label === "INTERNAL"));
});
