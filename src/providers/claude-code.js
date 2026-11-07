/**
 * Provider: Claude Code CLI
 *
 * Reads session transcripts from ~/.claude/projects/<slug>/<session>.jsonl.
 * Each line is a JSON record; we keep only human user prompts and assistant
 * text replies. Tool calls, attachments, snapshots and sidechains are dropped.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeConversation, makeMessage, contentToText, isSyntheticText } from "../core/model.js";

export const name = "claude-code";

export function defaultRoot() {
  return path.join(os.homedir(), ".claude", "projects");
}

export function detect(root = defaultRoot()) {
  return fs.existsSync(root);
}

export function* listSessionFiles(root = defaultRoot()) {
  if (!fs.existsSync(root)) return;
  for (const projectDir of fs.readdirSync(root)) {
    const full = path.join(root, projectDir);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith(".jsonl")) yield path.join(full, f);
    }
  }
}

export function parseSessionFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const messages = [];
  let cwd = null;
  let gitBranch = null;
  let sessionId = null;
  let startedAt = null;
  let endedAt = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.isSidechain) continue;
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId;
    if (rec.cwd && !cwd) cwd = rec.cwd;
    if (rec.gitBranch && !gitBranch) gitBranch = rec.gitBranch;

    if (rec.type === "user" && rec.message?.role === "user") {
      // Only prompts a human actually typed/pasted — not tool results fed back.
      const origin = rec.origin?.kind;
      if (origin && origin !== "human") continue;
      const text = contentToText(rec.message.content);
      if (isSyntheticText(text)) continue;
      messages.push(makeMessage("user", text, rec.timestamp ?? null));
      if (!startedAt) startedAt = rec.timestamp ?? null;
      endedAt = rec.timestamp ?? endedAt;
    } else if (rec.type === "assistant" && rec.message?.role === "assistant") {
      const text = contentToText(rec.message.content);
      if (!text) continue;
      messages.push(makeMessage("assistant", text, rec.timestamp ?? null));
      endedAt = rec.timestamp ?? endedAt;
    }
  }

  if (messages.length === 0) return null;
  return makeConversation({
    id: sessionId ?? path.basename(file, ".jsonl"),
    provider: name,
    cwd,
    gitBranch,
    startedAt,
    endedAt,
    sourceFile: file,
    messages,
  });
}

export function load({ root = defaultRoot() } = {}) {
  const out = [];
  for (const file of listSessionFiles(root)) {
    const conv = parseSessionFile(file);
    if (conv) out.push(conv);
  }
  return out;
}
