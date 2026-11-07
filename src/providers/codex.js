/**
 * Provider: OpenAI Codex CLI
 *
 * Reads rollout files from ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 * Rollout lines look like:
 *   { "type": "session_meta",  "payload": { "id", "cwd", "timestamp", ... } }
 *   { "type": "response_item", "payload": { "type": "message", "role": "user"|"assistant",
 *       "content": [ { "type": "input_text"|"output_text", "text": "..." } ] } }
 * Older Codex builds wrote flat { "record_type": ... } lines; we tolerate both.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeConversation, makeMessage, contentToText, isSyntheticText } from "../core/model.js";

export const name = "codex";

export function defaultRoot() {
  return path.join(os.homedir(), ".codex", "sessions");
}

export function detect(root = defaultRoot()) {
  return fs.existsSync(root);
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield full;
  }
}

export function* listSessionFiles(root = defaultRoot()) {
  yield* walk(root);
}

// Codex wraps user turns in XML-ish tags for environment context; strip them.
function cleanCodexUserText(text) {
  if (/^<(environment_context|user_instructions|turn_context)/.test(text.trim())) return "";
  return text;
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
  let id = null;
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
    const ts = rec.timestamp ?? null;

    if (rec.type === "session_meta" && rec.payload) {
      id = rec.payload.id ?? id;
      cwd = rec.payload.cwd ?? cwd;
      startedAt = rec.payload.timestamp ?? startedAt;
      continue;
    }

    // New format: response_item envelope. Old format: the message is the line itself.
    const item = rec.type === "response_item" ? rec.payload : rec;
    if (!item || item.type !== "message" || !item.role) continue;

    let text = contentToText(item.content);
    if (item.role === "user") {
      text = cleanCodexUserText(text);
      if (isSyntheticText(text)) continue;
      messages.push(makeMessage("user", text, ts));
    } else if (item.role === "assistant") {
      if (!text) continue;
      messages.push(makeMessage("assistant", text, ts));
    }
    if (!startedAt) startedAt = ts;
    endedAt = ts ?? endedAt;
  }

  if (messages.length === 0) return null;
  return makeConversation({
    id: id ?? path.basename(file, ".jsonl"),
    provider: name,
    cwd,
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
