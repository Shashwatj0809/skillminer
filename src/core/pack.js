/**
 * Skill packs — portable export/import.
 *
 * A pack is a single JSON file (.skillpack.json) carrying every generated
 * SKILL.md, so skills can move between machines, be shared with a team, or
 * checked into dotfiles. Import never overwrites: each skill is merged into
 * whatever already exists locally (per-section, per-bullet — same engine as
 * `improve`), so imported and local knowledge accumulate together.
 *
 * Format:
 * {
 *   "format": "skillminer-pack",
 *   "version": 1,
 *   "exportedAt": "<ISO timestamp>",
 *   "skills": [ { "dir": "global/user-preferences", "content": "<SKILL.md text>" } ]
 * }
 */
import fs from "node:fs";
import path from "node:path";
import { writeSkills } from "./skills.js";

export const PACK_FORMAT = "skillminer-pack";
export const PACK_VERSION = 1;

function* walkSkillFiles(root, rel = "") {
  const dir = path.join(root, rel);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const childRel = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) yield* walkSkillFiles(root, childRel);
    else if (e.isFile() && e.name === "SKILL.md") yield childRel;
  }
}

/** Collect every SKILL.md under skillsDir into a pack object. */
export function createPack(skillsDir) {
  const skills = [];
  for (const rel of walkSkillFiles(skillsDir)) {
    const content = fs.readFileSync(path.join(skillsDir, rel), "utf8");
    // store the skill's directory (without the SKILL.md filename), POSIX-style
    const dir = path.dirname(rel).split(path.sep).join("/");
    skills.push({ dir, content });
  }
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    exportedAt: new Date().toISOString(),
    skills,
  };
}

/** Write a pack to disk; returns the file path. */
export function exportPack(skillsDir, outFile) {
  const pack = createPack(skillsDir);
  if (pack.skills.length === 0) {
    throw new Error(`No SKILL.md files found under ${skillsDir} — run \`skillminer build\` first.`);
  }
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(pack, null, 2));
  return { file: outFile, skills: pack.skills.length };
}

export function readPack(file) {
  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read pack file ${file}: ${err.message}`);
  }
  if (pack?.format !== PACK_FORMAT || !Array.isArray(pack.skills)) {
    throw new Error(`${file} is not a skillminer pack (expected format "${PACK_FORMAT}").`);
  }
  if (pack.version > PACK_VERSION) {
    throw new Error(`${file} was created by a newer skillminer (pack v${pack.version}); please update.`);
  }
  return pack;
}

/** Guard against path escape: pack dirs must stay inside the skills dir. */
export function safePackDir(dir) {
  const norm = path.normalize(dir).split(path.sep).join("/");
  if (norm.startsWith("..") || path.isAbsolute(norm) || norm.includes("/../")) {
    throw new Error(`Unsafe skill path in pack: ${dir}`);
  }
  return norm;
}

/**
 * Import a pack into skillsDir. Existing skills are merged (read + appended,
 * deduplicated), never overwritten. Returns { added, merged, files }.
 */
export function importPack(file, skillsDir) {
  const pack = readPack(file);
  let added = 0;
  let merged = 0;
  const files = [];
  for (const skill of pack.skills) {
    const dir = safePackDir(skill.dir);
    const target = path.join(skillsDir, dir, "SKILL.md");
    if (fs.existsSync(target)) merged++;
    else added++;
    // writeSkills handles mkdir + merge-on-existing (read + append, deduped)
    files.push(...writeSkills([{ dir, content: skill.content }], skillsDir));
  }
  return { added, merged, files, exportedAt: pack.exportedAt };
}
