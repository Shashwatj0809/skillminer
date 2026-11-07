#!/usr/bin/env node
/**
 * skillminer CLI
 *
 *   skillminer scan                      what logs exist, where, how many sessions
 *   skillminer repos                     repos with mineable history
 *   skillminer build [--repo <path>] [--out <dir>] [--import <claude-export>] [--llm] [--install]
 *   skillminer improve [--out <dir>] [--llm]
 *   skillminer mcp                       run as an MCP stdio server
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseArgs } from "node:util";
import { scan, build, improve, listRepos, exportSkills, importSkills, defaultOutDir } from "../src/index.js";
import { startMcpServer } from "../src/mcp/server.js";

const HELP = `skillminer — mine your local AI-agent logs into reusable skills

Usage:
  skillminer scan                     Show which providers have logs and how many sessions
  skillminer repos                    List repos/directories with mineable history
  skillminer build [options]          Build global + per-repo skills from all logs
  skillminer improve [options]        Re-scan and refine existing skills with new sessions
  skillminer export [--file <path>]   Bundle skills into a portable .skillpack.json
  skillminer import <file>            Merge a .skillpack.json into local skills (append, deduped)
  skillminer mcp                      Run as an MCP server (stdio) for any MCP client

Options:
  --repo <path>      Build skills only for sessions that ran in this repo
  --out <dir>        Output directory (default: ~/.skillminer/skills)
  --import <path>    Claude Desktop/claude.ai data export (conversations.json or its folder)
  --provider <name>  Restrict to one provider: claude-code | codex | claude-desktop (repeatable)
  --llm              Polish mined bullets with an LLM (set SKILLMINER_LLM=anthropic|openai|ollama)
  --install          Also install global skills into ~/.claude/skills (and repo skills into <repo>/.claude/skills)
  --json             Machine-readable output
  -h, --help         Show this help

Privacy: analysis is fully local. Generated skills contain mined requirements and
preferences only — emails, keys, tokens, paths and personal data are redacted first.`;

function parse(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      out: { type: "string" },
      file: { type: "string" },
      import: { type: "string" },
      provider: { type: "string", multiple: true },
      llm: { type: "boolean", default: false },
      install: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

function toOpts(values) {
  const opts = {
    outDir: values.out,
    repoFilter: values.repo,
    llm: values.llm,
    only: values.provider,
  };
  if (values.import) opts.roots = { "claude-desktop": path.resolve(values.import) };
  return opts;
}

function printReport(report) {
  for (const r of report) {
    const status = r.error
      ? `error: ${r.error}`
      : r.detected
        ? `${r.found} conversation(s)`
        : "not found";
    console.log(`  ${r.provider.padEnd(16)} ${status}   (${r.root})`);
  }
}

function installSkills(summary) {
  const claudeSkills = path.join(os.homedir(), ".claude", "skills");
  const out = summary.outDir;
  const globalDir = path.join(out, "global");
  if (fs.existsSync(globalDir)) {
    for (const name of fs.readdirSync(globalDir)) {
      const src = path.join(globalDir, name);
      const dst = path.join(claudeSkills, name);
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(path.join(src, "SKILL.md"), path.join(dst, "SKILL.md"));
      console.log(`  installed → ${dst}/SKILL.md`);
    }
  }
  for (const r of summary.repos ?? []) {
    if (!fs.existsSync(r.repo)) continue;
    const repoSlug = path.basename(r.repo).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const src = path.join(out, "repos", repoSlug, "project-context", "SKILL.md");
    if (!fs.existsSync(src)) continue;
    const dstDir = path.join(r.repo, ".claude", "skills", "project-context");
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(src, path.join(dstDir, "SKILL.md"));
    console.log(`  installed → ${path.join(dstDir, "SKILL.md")}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  let values, positionals;
  try {
    ({ values, positionals } = parse(rest));
  } catch (err) {
    console.error(`skillminer: ${err.message}\n`);
    console.error(HELP);
    process.exit(1);
  }

  if (!cmd || values.help || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "scan": {
      const { report } = scan(toOpts(values));
      if (values.json) return void console.log(JSON.stringify(report, null, 2));
      console.log("Providers:");
      printReport(report);
      break;
    }
    case "repos": {
      const repos = listRepos(toOpts(values));
      if (values.json) return void console.log(JSON.stringify(repos, null, 2));
      if (!repos.length) return void console.log("No repos with agent history found.");
      console.log("Repos with mineable history:");
      for (const r of repos) {
        console.log(`  ${r.repo}   ${r.sessions} session(s), ${r.userMessages} user message(s)`);
      }
      break;
    }
    case "build": {
      const summary = await build(toOpts(values));
      if (values.json) return void console.log(JSON.stringify(summary, null, 2));
      console.log("Scanned:");
      printReport(summary.report);
      if (summary.global) {
        console.log(
          `\nGlobal skills: ${summary.global.requirements} requirement(s), ${summary.global.preferences} preference(s), ${summary.global.corrections} correction(s), ${summary.global.stack} stack item(s)`
        );
      }
      for (const r of summary.repos) {
        console.log(`Repo skill: ${r.repo} (${r.sessions} sessions → ${r.requirements} requirements)`);
      }
      for (const s of summary.skipped) {
        console.log(`Skipped: ${s.repo} — ${s.reason}`);
      }
      console.log(`\nWrote ${summary.written.length} skill file(s) under ${summary.outDir}`);
      if (values.install) installSkills(summary);
      break;
    }
    case "improve": {
      const summary = await improve(toOpts(values));
      if (values.json) return void console.log(JSON.stringify(summary, null, 2));
      console.log(summary.note);
      console.log(`Refreshed ${summary.written.length} skill file(s) under ${summary.outDir}`);
      if (values.install) installSkills(summary);
      break;
    }
    case "export": {
      const result = exportSkills({ outDir: values.out, file: values.file });
      if (values.json) return void console.log(JSON.stringify(result, null, 2));
      console.log(`Exported ${result.skills} skill(s) from ${result.skillsDir}`);
      console.log(`Pack: ${path.resolve(result.file)}`);
      console.log(`Import on another machine with: skillminer import ${path.basename(result.file)}`);
      break;
    }
    case "import": {
      const file = positionals[0] ?? values.file;
      if (!file) {
        console.error("skillminer: import needs a pack file — skillminer import <file.skillpack.json>");
        process.exit(1);
      }
      const result = importSkills(path.resolve(file), { outDir: values.out });
      if (values.json) return void console.log(JSON.stringify(result, null, 2));
      console.log(
        `Imported pack (exported ${result.exportedAt}): ${result.added} new skill(s), ${result.merged} merged into existing ones.`
      );
      console.log(`Skills dir: ${result.skillsDir}`);
      if (values.install) installSkills({ outDir: result.skillsDir, repos: [] });
      break;
    }
    case "mcp":
      startMcpServer();
      break;
    default:
      console.error(`skillminer: unknown command "${cmd}"\n`);
      console.error(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`skillminer: ${err?.stack ?? err}`);
  process.exit(1);
});
void defaultOutDir;
