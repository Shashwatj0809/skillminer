import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { parseSessionFile as parseClaude } from "../src/providers/claude-code.js";
import { parseSessionFile as parseCodex } from "../src/providers/codex.js";
import { redact } from "../src/core/redact.js";
import { analyzeConversations, groupByRepo } from "../src/core/analyze.js";
import { buildGlobalSkills, buildRepoSkill, writeSkills, mergeSkill } from "../src/core/skills.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (f) => path.join(here, "fixtures", f);

test("claude-code provider parses sessions, drops noise, keeps human prompts", () => {
  const conv = parseClaude(fixture("claude-code-session.jsonl"));
  assert.ok(conv);
  assert.equal(conv.provider, "claude-code");
  assert.equal(conv.cwd, "/Users/jane/projects/acme-api");
  const userTexts = conv.messages.filter((m) => m.role === "user").map((m) => m.text);
  assert.equal(userTexts.length, 3); // system-reminder line dropped
  assert.ok(userTexts[0].includes("JSON errors"));
});

test("codex provider parses rollout format and strips environment context", () => {
  const conv = parseCodex(fixture("codex-rollout.jsonl"));
  assert.ok(conv);
  assert.equal(conv.provider, "codex");
  assert.equal(conv.cwd, "/Users/jane/projects/acme-api");
  const users = conv.messages.filter((m) => m.role === "user");
  assert.equal(users.length, 1);
  assert.match(users[0].text, /rate limiting/);
});

test("redact removes emails, keys, tokens and home paths", () => {
  const dirty =
    "mail me at jane@example.com, key sk-abcdefghijklmnopqrstuvwxyz123456, token ghp_ABCDEFGHIJKLMNOPQRSTUVWX1234, file /Users/jane/secret.txt";
  const clean = redact(dirty, { username: "jane" });
  assert.ok(!clean.includes("jane@example.com"));
  assert.ok(!clean.includes("sk-abcdefghijklmnopqrstuvwxyz123456"));
  assert.ok(!clean.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWX1234"));
  assert.ok(!clean.includes("/Users/jane"));
  assert.ok(clean.includes("[REDACTED_EMAIL]"));
});

test("analyzer extracts requirements, preferences and corrections", () => {
  const conv = parseClaude(fixture("claude-code-session.jsonl"));
  const analysis = analyzeConversations([conv], { redactOpts: { username: "jane" } });
  assert.ok(analysis.requirements.length >= 1, "finds 'make sure / always' requirements");
  assert.ok(analysis.preferences.length >= 1, "finds 'I prefer pnpm' preference");
  assert.ok(analysis.corrections.length >= 1, "finds the 'No, that's wrong' correction");
  const allText = JSON.stringify(analysis);
  assert.ok(!allText.includes("jane@example.com"), "no emails in analysis output");
  assert.ok(!allText.includes("sk-abcdefghijklmnop"), "no API keys in analysis output");
});

test("skills are written with frontmatter and merge without duplicating", () => {
  const conv = parseClaude(fixture("claude-code-session.jsonl"));
  const analysis = analyzeConversations([conv], { redactOpts: { username: "jane" } });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skillminer-test-"));
  try {
    const skills = [...buildGlobalSkills(analysis), buildRepoSkill("/Users/jane/projects/acme-api", analysis)];
    const written = writeSkills(skills, tmp);
    assert.ok(written.length >= 2);
    const prefSkill = fs.readFileSync(path.join(tmp, "global", "user-preferences", "SKILL.md"), "utf8");
    assert.match(prefSkill, /^---\nname: user-preferences\n/);
    assert.ok(!prefSkill.includes("[REDACTED_EMAIL]") || true); // redacted markers allowed, raw PII is not
    assert.ok(!prefSkill.includes("jane@example.com"));

    // second write merges — bullet count must not double
    const before = (prefSkill.match(/^- /gm) ?? []).length;
    writeSkills(skills, tmp);
    const after = (fs.readFileSync(path.join(tmp, "global", "user-preferences", "SKILL.md"), "utf8").match(/^- /gm) ?? []).length;
    assert.equal(before, after);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mergeSkill preserves hand-added bullets", () => {
  const generated = "---\nname: x\ndescription: d\n---\n\n## Preferences\n\n- use pnpm\n";
  const handEdited = "---\nname: x\ndescription: d\n---\n\n## Preferences\n\n- use pnpm\n- my manual note\n";
  const merged = mergeSkill(handEdited, generated);
  assert.ok(merged.includes("- my manual note"));
  assert.ok(merged.includes("- use pnpm"));
});

test("groupByRepo groups by cwd", () => {
  const c1 = parseClaude(fixture("claude-code-session.jsonl"));
  const c2 = parseCodex(fixture("codex-rollout.jsonl"));
  const groups = groupByRepo([c1, c2]);
  assert.equal(groups.size, 1);
  assert.equal(groups.get("/Users/jane/projects/acme-api").length, 2);
});
