/**
 * Heuristic analyzer.
 *
 * Takes redacted, normalized conversations and mines:
 *   - requirements:  explicit asks ("make sure", "must", "should", "always", "never"...)
 *   - preferences:   tool / style / workflow choices ("prefer", "use X instead of Y"...)
 *   - corrections:   places the user pushed back — strongest signal of what matters
 *   - stack:         technologies that actually appear in the user's work
 *   - behavior:      how the user communicates and likes to work
 *
 * Pure heuristics so it runs fully offline; the optional LLM pass (llm.js)
 * only polishes wording of already-extracted, already-redacted candidates.
 */
import { redact, looksSensitive } from "./redact.js";

const REQUIREMENT_RE =
  /\b(make sure|ensure|must(?:n't| not)?|should(?:n't| not)?|always|never|don'?t|do not|needs? to|has to|have to|required?|important(?:ly)?|remember to|be sure)\b/i;

const PREFERENCE_RE =
  /\b(i (?:'d |would )?prefer|prefer(?:red|ably)?|i like|i (?:'d |would )?rather|instead of|rather than|use \S+ (?:instead|over|not)|stick (?:to|with)|keep (?:it|things)|no need (?:for|to)|skip the)\b/i;

const CORRECTION_RE =
  /^(no[,.! ]|nope\b|not (?:that|this|like)|actually[,. ]|wait[,. ]|wrong\b|that'?s (?:not|wrong|incorrect)|stop\b|undo\b|revert\b|instead[,. ]|why did you)/i;

const TECH_KEYWORDS = [
  "react", "next.js", "nextjs", "vue", "svelte", "angular", "astro", "remix",
  "node", "deno", "bun", "express", "fastify", "nest",
  "typescript", "javascript", "python", "go", "golang", "rust", "swift", "kotlin", "java", "ruby", "c++", "c#",
  "tailwind", "css", "sass", "shadcn", "framer motion",
  "postgres", "postgresql", "mysql", "sqlite", "mongodb", "redis", "supabase", "prisma", "drizzle",
  "docker", "kubernetes", "terraform", "aws", "gcp", "azure", "vercel", "netlify", "cloudflare",
  "graphql", "rest", "grpc", "websocket",
  "jest", "vitest", "pytest", "playwright", "cypress",
  "npm", "pnpm", "yarn", "pip", "cargo", "brew",
  "git", "github", "gitlab", "mcp", "llm", "openai", "anthropic", "claude", "codex", "gemini",
  "fastapi", "django", "flask", "spring", "rails", "laravel",
  "pandas", "numpy", "pytorch", "tensorflow", "langchain",
  "electron", "react native", "expo", "flutter",
];

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/;

// User messages longer than this are almost always pasted documents
// (skill files, specs, articles) — their sentences are not the user's own
// requirements, so we only mine them for stack/behavior signals.
const PASTE_THRESHOLD = 4000;

function cleanCandidate(sentence) {
  const s = sentence.trim().replace(/\s+/g, " ");
  if (s.length < 15 || s.length > 300) return null;        // too short to mean anything / too long to be a crisp rule
  if (looksSensitive(s)) return null;
  if (/^\s*[{[<#>*`|-]/.test(s)) return null;              // pasted code/JSON/markdown structure, not the user's prose
  if ((s.match(/[;{}()=]/g) ?? []).length > 6) return null; // code-like
  if (/https?:\/\/\S+$/.test(s) && s.split(" ").length < 4) return null;
  return s;
}

export function analyzeConversations(conversations, { redactOpts = {} } = {}) {
  const requirements = [];
  const preferences = [];
  const corrections = [];
  const stackCounts = new Map();
  const behavior = {
    totalConversations: conversations.length,
    totalUserMessages: 0,
    avgUserMessageChars: 0,
    providers: {},
    activeHours: new Array(24).fill(0),
    asksForTests: 0,
    asksForExplanation: 0,
    asksForPlanning: 0,
    givesUrls: 0,
    firstSeen: null,
    lastSeen: null,
  };

  let charSum = 0;

  for (const conv of conversations) {
    behavior.providers[conv.provider] = (behavior.providers[conv.provider] ?? 0) + 1;

    for (const msg of conv.messages) {
      if (msg.role !== "user") continue;
      const text = redact(msg.text, redactOpts);
      behavior.totalUserMessages++;
      charSum += text.length;

      if (msg.ts) {
        const d = new Date(msg.ts);
        if (!Number.isNaN(d.getTime())) {
          behavior.activeHours[d.getHours()]++;
          if (!behavior.firstSeen || msg.ts < behavior.firstSeen) behavior.firstSeen = msg.ts;
          if (!behavior.lastSeen || msg.ts > behavior.lastSeen) behavior.lastSeen = msg.ts;
        }
      }

      if (/\b(test|tests|unit test|coverage)\b/i.test(text)) behavior.asksForTests++;
      if (/\b(explain|why|walk me through|what does)\b/i.test(text)) behavior.asksForExplanation++;
      if (/\b(plan|architecture|design first|before you (?:code|start)|think (?:through|about))\b/i.test(text)) behavior.asksForPlanning++;
      if (/https?:\/\//.test(text)) behavior.givesUrls++;

      const lower = text.toLowerCase();
      for (const kw of TECH_KEYWORDS) {
        if (lower.includes(kw)) stackCounts.set(kw, (stackCounts.get(kw) ?? 0) + 1);
      }

      if (text.length > PASTE_THRESHOLD) continue; // pasted document — mine signals above, not sentences

      if (CORRECTION_RE.test(text.trim())) {
        const c = cleanCandidate(text.split(SENTENCE_SPLIT_RE)[0] ?? text);
        if (c) corrections.push({ text: c, conv: conv.id, provider: conv.provider, cwd: conv.cwd });
      }

      for (const sentence of text.split(SENTENCE_SPLIT_RE)) {
        const c = cleanCandidate(sentence);
        if (!c) continue;
        if (REQUIREMENT_RE.test(c)) {
          requirements.push({ text: c, conv: conv.id, provider: conv.provider, cwd: conv.cwd });
        } else if (PREFERENCE_RE.test(c)) {
          preferences.push({ text: c, conv: conv.id, provider: conv.provider, cwd: conv.cwd });
        }
      }
    }
  }

  behavior.avgUserMessageChars = behavior.totalUserMessages
    ? Math.round(charSum / behavior.totalUserMessages)
    : 0;

  const stack = [...stackCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, n]) => n >= 2)
    .map(([tech, mentions]) => ({ tech, mentions }));

  return {
    requirements: dedupe(requirements),
    preferences: dedupe(preferences),
    corrections: dedupe(corrections),
    stack,
    behavior,
  };
}

/** Group conversations by the repo/directory they ran in. */
export function groupByRepo(conversations) {
  const groups = new Map();
  for (const conv of conversations) {
    if (!conv.cwd) continue;
    const key = conv.cwd;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(conv);
  }
  return groups;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.text.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
