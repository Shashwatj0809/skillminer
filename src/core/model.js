/**
 * Provider-agnostic conversation model.
 *
 * Every log provider (Claude Code, Codex, Claude Desktop export, ...)
 * normalizes its raw records into this shape before anything downstream
 * (redaction, analysis, skill building) touches it.
 *
 * Conversation {
 *   id:        string            // stable id (session id / file hash)
 *   provider:  string            // "claude-code" | "codex" | "claude-desktop" | ...
 *   title:     string | null
 *   cwd:       string | null     // working directory the session ran in, if known
 *   gitBranch: string | null
 *   startedAt: string | null     // ISO timestamp
 *   endedAt:   string | null
 *   sourceFile:string            // where this came from on disk
 *   messages:  Message[]
 * }
 *
 * Message {
 *   role: "user" | "assistant"
 *   text: string                 // plain text only — tool payloads are dropped
 *   ts:   string | null
 * }
 */

export function makeConversation(partial) {
  return {
    id: partial.id ?? null,
    provider: partial.provider,
    title: partial.title ?? null,
    cwd: partial.cwd ?? null,
    gitBranch: partial.gitBranch ?? null,
    startedAt: partial.startedAt ?? null,
    endedAt: partial.endedAt ?? null,
    sourceFile: partial.sourceFile ?? null,
    messages: partial.messages ?? [],
  };
}

export function makeMessage(role, text, ts = null) {
  return { role, text, ts };
}

/** Extract plain text from a message `content` that may be a string or an array of blocks. */
export function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === "text" || b.type === "input_text" || b.type === "output_text"))
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
  }
  return "";
}

/** True for harness-injected noise we never want to mine. */
export function isSyntheticText(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("<system-reminder>")) return true;
  if (t.startsWith("<local-command-")) return true;
  if (t.startsWith("<command-name>")) return true;
  if (t.startsWith("Caveat: The messages below were generated")) return true;
  if (t.startsWith("[Request interrupted")) return true;
  return false;
}
