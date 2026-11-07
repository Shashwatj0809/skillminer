/**
 * Provider: Claude Desktop / claude.ai data export
 *
 * Claude Desktop keeps chat content server-side, so the reliable local source
 * is the official data export (Settings → Privacy → Export data), which
 * delivers a conversations.json like:
 *   [ { "uuid", "name", "created_at", "updated_at",
 *       "chat_messages": [ { "sender": "human"|"assistant", "text", "created_at",
 *                            "content": [ { "type": "text", "text" } ] } ] } ]
 *
 * Point skillminer at it with --import <path-to-conversations.json or dir>.
 * We also auto-check ~/Downloads for a recent export as a convenience.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeConversation, makeMessage, isSyntheticText } from "../core/model.js";

export const name = "claude-desktop";

export function defaultRoot() {
  // No reliable default — export location is user-chosen. We opportunistically
  // look for a conversations.json in ~/Downloads (top level only).
  return path.join(os.homedir(), "Downloads");
}

export function detect(root = defaultRoot()) {
  return findExportFile(root) !== null;
}

export function findExportFile(root) {
  if (!root) return null;
  try {
    const stat = fs.statSync(root);
    if (stat.isFile()) return root;
    if (stat.isDirectory()) {
      const direct = path.join(root, "conversations.json");
      if (fs.existsSync(direct)) return direct;
    }
  } catch {
    return null;
  }
  return null;
}

function messageText(m) {
  if (Array.isArray(m.content)) {
    const t = m.content
      .filter((b) => b && b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
    if (t) return t;
  }
  return (m.text ?? "").trim();
}

export function load({ root = defaultRoot() } = {}) {
  const file = findExportFile(root);
  if (!file) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const out = [];
  for (const conv of data) {
    const msgs = [];
    for (const m of conv.chat_messages ?? []) {
      const text = messageText(m);
      if (!text || isSyntheticText(text)) continue;
      const role = m.sender === "human" ? "user" : "assistant";
      msgs.push(makeMessage(role, text, m.created_at ?? null));
    }
    if (msgs.length === 0) continue;
    out.push(
      makeConversation({
        id: conv.uuid ?? null,
        provider: name,
        title: conv.name ?? null,
        startedAt: conv.created_at ?? null,
        endedAt: conv.updated_at ?? null,
        sourceFile: file,
        messages: msgs,
      })
    );
  }
  return out;
}
