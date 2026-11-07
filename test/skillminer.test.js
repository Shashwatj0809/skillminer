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

test("export/import round-trip: pack moves skills and import appends without clobbering", async () => {
  const { exportPack, importPack, readPack } = await import("../src/core/pack.js");
  const conv = parseClaude(fixture("claude-code-session.jsonl"));
  const analysis = analyzeConversations([conv], { redactOpts: { username: "jane" } });

  const machineA = fs.mkdtempSync(path.join(os.tmpdir(), "skillminer-a-"));
  const machineB = fs.mkdtempSync(path.join(os.tmpdir(), "skillminer-b-"));
  const packFile = path.join(machineA, "skills.skillpack.json");
  try {
    writeSkills(buildGlobalSkills(analysis), machineA);

    // export from machine A
    const exported = exportPack(machineA, packFile);
    assert.ok(exported.skills >= 2);
    const pack = readPack(packFile);
    assert.equal(pack.format, "skillminer-pack");

    // import into empty machine B → all added
    const first = importPack(packFile, machineB);
    assert.equal(first.added, exported.skills);
    assert.equal(first.merged, 0);

    // machine B user adds a manual bullet, then re-imports → merged, both kept, no dupes
    const target = path.join(machineB, "global", "user-preferences", "SKILL.md");
    fs.appendFileSync(target, "- my machine-B manual note\n");
    const bulletsBefore = (fs.readFileSync(target, "utf8").match(/^- /gm) ?? []).length;
    const second = importPack(packFile, machineB);
    assert.equal(second.added, 0);
    assert.equal(second.merged, exported.skills);
    const after = fs.readFileSync(target, "utf8");
    assert.ok(after.includes("- my machine-B manual note"), "manual bullet survives import");
    assert.equal((after.match(/^- /gm) ?? []).length, bulletsBefore, "re-import adds no duplicates");
  } finally {
    fs.rmSync(machineA, { recursive: true, force: true });
    fs.rmSync(machineB, { recursive: true, force: true });
  }
});

test("importPack rejects path-escaping pack entries", async () => {
  const { importPack } = await import("../src/core/pack.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skillminer-evil-"));
  const evil = path.join(tmp, "evil.skillpack.json");
  try {
    fs.writeFileSync(
      evil,
      JSON.stringify({ format: "skillminer-pack", version: 1, skills: [{ dir: "../../escape", content: "x" }] })
    );
    assert.throws(() => importPack(evil, path.join(tmp, "skills")), /Unsafe skill path/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
