/**
 * skillminer programmatic API — what the CLI and the MCP server both call.
 */
import path from "node:path";
import os from "node:os";
import { loadAll } from "./providers/index.js";
import { analyzeConversations, groupByRepo } from "./core/analyze.js";
import { buildGlobalSkills, buildRepoSkill, writeSkills } from "./core/skills.js";
import { loadState, saveState, diffAgainstState, recordSeen } from "./core/state.js";
import { llmConfigured, polishBullets } from "./core/llm.js";

export { loadAll, analyzeConversations, groupByRepo, buildGlobalSkills, buildRepoSkill, writeSkills };

export function defaultOutDir() {
  return path.join(os.homedir(), ".skillminer", "skills");
}

/** Scan all providers; returns { conversations, report }. */
export function scan(opts = {}) {
  return loadAll(opts);
}

/**
 * Full pipeline: scan → analyze (global + per-repo) → build → write.
 * opts: { only, roots, outDir, repoFilter, llm }
 */
export async function build(opts = {}) {
  const outDir = opts.outDir ?? defaultOutDir();
  const { conversations, report } = loadAll(opts);

  let targetConvs = conversations;
  let repoFilterPath = null;
  if (opts.repoFilter) {
    repoFilterPath = path.resolve(opts.repoFilter);
    targetConvs = conversations.filter((c) => c.cwd && path.resolve(c.cwd) === repoFilterPath);
  }

  const written = [];
  const summary = { report, outDir, global: null, repos: [], skipped: [] };

  // Global skills (skipped when building for one repo only)
  if (!repoFilterPath) {
    const analysis = analyzeConversations(conversations);
    if (opts.llm && llmConfigured()) await applyPolish(analysis);
    const globalSkills = buildGlobalSkills(analysis);
    written.push(...writeSkills(globalSkills, outDir));
    summary.global = {
      requirements: analysis.requirements.length,
      preferences: analysis.preferences.length,
      corrections: analysis.corrections.length,
      stack: analysis.stack.length,
    };
  }

  // Per-repo skills
  const groups = groupByRepo(targetConvs);
  for (const [repoPath, convs] of groups) {
    const analysis = analyzeConversations(convs);
    if (opts.llm && llmConfigured()) await applyPolish(analysis);
    const skill = buildRepoSkill(repoPath, analysis);
    if (skill) {
      written.push(...writeSkills([skill], outDir));
      summary.repos.push({
        repo: repoPath,
        sessions: convs.length,
        requirements: analysis.requirements.length,
        preferences: analysis.preferences.length,
      });
    } else {
      summary.skipped.push({ repo: repoPath, sessions: convs.length, reason: "no durable requirements found" });
    }
  }

  // Record what we've seen so `improve` can diff next time.
  const state = loadState();
  state.outDir = outDir;
  recordSeen(conversations, state);
  saveState(state);

  summary.written = written;
  return summary;
}

/**
 * Improve: re-scan, report what changed since last run, and merge new
 * findings into existing skills (writeSkills merges by design).
 */
export async function improve(opts = {}) {
  const state = loadState();
  const outDir = opts.outDir ?? state.outDir ?? defaultOutDir();
  const { conversations } = loadAll(opts);
  const { fresh } = diffAgainstState(conversations, state);
  const summary = await build({ ...opts, outDir });
  summary.freshSources = fresh.length;
  summary.note =
    fresh.length === 0
      ? "No new or changed sessions since last run — skills refreshed from full history."
      : `${fresh.length} new/changed session file(s) folded in.`;
  return summary;
}

/** List repos that have mineable history. */
export function listRepos(opts = {}) {
  const { conversations } = loadAll(opts);
  const groups = groupByRepo(conversations);
  return [...groups.entries()]
    .map(([repo, convs]) => ({
      repo,
      sessions: convs.length,
      userMessages: convs.reduce((n, c) => n + c.messages.filter((m) => m.role === "user").length, 0),
    }))
    .sort((a, b) => b.sessions - a.sessions);
}

async function applyPolish(analysis) {
  for (const key of ["requirements", "preferences"]) {
    const bullets = analysis[key].map((i) => i.text);
    if (bullets.length < 3) continue;
    const polished = await polishBullets(bullets, { purpose: key });
    if (polished) analysis[key] = polished.map((text) => ({ text }));
  }
}
