# skillminer

**Mine your local AI-agent history into reusable skills.**

Every session you run with Claude Code, Codex, or Claude Desktop leaves a trail of what you asked for, what you corrected, what stack you use, and how you like to work. skillminer reads those local logs, distills them into **provider-agnostic skills** (plain `SKILL.md` files), and keeps them up to date as you keep working — globally and **per repository**.

- 🔌 **Provider-agnostic** — one normalized model; Claude Code, Codex CLI, and Claude Desktop exports today, any agent tomorrow (adding a provider is one file).
- 🔒 **Privacy-first** — everything runs locally. Emails, API keys, tokens, phone numbers, IPs, private keys, and home paths are redacted *before* analysis; skills carry your **requirements, never your data**.
- 📁 **Repo-aware** — builds a `project-context` skill for each repo using only the sessions that ran inside that repo.
- 🔁 **Improvable** — `skillminer improve` folds new sessions into existing skills, merging instead of overwriting (your hand-added bullets survive).
- 🧰 **MCP server mode** — expose `scan_logs` / `list_repos` / `build_skills` / `improve_skills` as MCP tools so any MCP client (Claude Code, Claude Desktop, Cursor, Codex) can drive it.
- 🪶 **Zero runtime dependencies** — plain Node ≥ 18.17.

## Walkthrough

### 1. Install

```bash
npm install -g skillminer
# or run ad-hoc:
npx skillminer scan
```

### 2. See what you have

```bash
skillminer scan
```

```
Providers:
  claude-code      42 conversation(s)   (~/.claude/projects)
  codex            7 conversation(s)    (~/.codex/sessions)
  claude-desktop   not found            (~/Downloads)
```

### 3. See which repos have history

```bash
skillminer repos
```

```
Repos with mineable history:
  ~/work/acme-api      18 session(s), 212 user message(s)
  ~/side/blog          5 session(s), 40 user message(s)
```

### 4. Build your skills

```bash
skillminer build
```

Writes to `~/.skillminer/skills/`:

```
~/.skillminer/skills/
├── global/
│   ├── user-preferences/SKILL.md    # standing requirements, preferences, past corrections
│   ├── tech-stack/SKILL.md          # technologies you actually use, ranked
│   └── working-style/SKILL.md       # how you communicate & like to work
└── repos/
    └── acme-api/
        └── project-context/SKILL.md # requirements stated specifically in that repo
```

Add `--install` to also copy global skills into `~/.claude/skills/` and each repo skill into `<repo>/.claude/skills/`, where Claude Code picks them up automatically. For other agents, point them at the generated markdown — it's plain `SKILL.md` with YAML frontmatter.

### 5. Build for one repo only

```bash
skillminer build --repo ~/work/acme-api --install
```

Only sessions whose working directory was that repo are read — context from other projects never bleeds in.

### 6. Improve as you keep working

Weeks later, after more sessions:

```bash
skillminer improve
```

Re-scans everything, reports how many session files are new or changed, and **merges** fresh findings into the existing skills. Merging is per-section, per-bullet: duplicates are dropped, and bullets you added by hand are preserved.

### 7. Include Claude Desktop / claude.ai chats

Claude Desktop stores chats server-side, so use the official export (**Settings → Privacy → Export data**), then:

```bash
skillminer build --import ~/Downloads/conversations.json
```

(If a `conversations.json` is sitting in `~/Downloads`, it's picked up automatically.)

### 8. Connect as an MCP server

```bash
# Claude Code
claude mcp add skillminer -- npx skillminer mcp
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "skillminer": { "command": "npx", "args": ["skillminer", "mcp"] }
  }
}
```

Then from inside any agent session: *"use skillminer to rebuild my skills for this repo"* — the agent calls `build_skills` with the repo path, and the skills land on disk.

| MCP tool | What it does |
|---|---|
| `scan_logs` | Report providers found and conversation counts |
| `list_repos` | Repos/directories with mineable history |
| `build_skills` | Full build; optional `repo` and `outDir` arguments |
| `improve_skills` | Merge new sessions into existing skills |

### 9. Optional: LLM polish

Extraction is pure heuristics and fully offline. If you want the mined bullets rewritten into crisper instructions, opt in to a one-shot polish pass — only the already-redacted bullets are sent, never your logs:

```bash
export SKILLMINER_LLM=anthropic   # or: openai | ollama (local, no key needed)
export ANTHROPIC_API_KEY=...      # provider key if applicable
skillminer build --llm
```

`SKILLMINER_MODEL` and `SKILLMINER_LLM_BASE_URL` override the model and endpoint (any OpenAI-compatible gateway works).

## What goes into a skill — and what never does

**In:** requirement sentences ("make sure…", "always…", "never…"), preferences ("I prefer…", "use X instead of Y"), corrections you made ("no, that's wrong — …"), technology frequency, communication patterns (plans-first? tests expected? terse or detailed prompts?).

**Never:** emails, phone numbers, API keys/tokens/JWTs, private keys, IPs, card-like numbers, credentialed URLs, your username or home paths (rewritten to `~`), pasted documents (long pastes are excluded from sentence mining), and any line that still looks sensitive after redaction is dropped entirely.

## CLI reference

```
skillminer scan                     Show providers, log locations, session counts
skillminer repos                    List repos with mineable history
skillminer build [options]          Build global + per-repo skills
skillminer improve [options]        Fold new sessions into existing skills
skillminer mcp                      Run as an MCP stdio server

--repo <path>      Scope the build to one repository
--out <dir>        Output directory (default ~/.skillminer/skills)
--import <path>    Claude Desktop/claude.ai export (conversations.json or folder)
--provider <name>  Restrict to claude-code | codex | claude-desktop (repeatable)
--llm              Polish bullets with a configured LLM
--install          Copy skills into ~/.claude/skills and <repo>/.claude/skills
--json             Machine-readable output
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design — pipeline stages, the normalized conversation model, the provider interface, the merge algorithm, and how to add a new provider.

## License

MIT
