/**
 * Provider registry.
 *
 * A provider is any module exporting:
 *   name: string
 *   defaultRoot(): string
 *   detect(root?): boolean
 *   load({ root }): Conversation[]
 *
 * Adding support for a new agent (Gemini CLI, Aider, Cursor, ...) means
 * adding one file here — nothing downstream changes.
 */
import * as claudeCode from "./claude-code.js";
import * as codex from "./codex.js";
import * as claudeDesktop from "./claude-desktop.js";

export const providers = [claudeCode, codex, claudeDesktop];

export function getProvider(name) {
  return providers.find((p) => p.name === name) ?? null;
}

/**
 * Load conversations from all (or selected) providers.
 * opts.only   — array of provider names to restrict to
 * opts.roots  — { [providerName]: customRootPath } overrides (e.g. --import)
 */
export function loadAll(opts = {}) {
  const selected = opts.only?.length
    ? providers.filter((p) => opts.only.includes(p.name))
    : providers;

  const conversations = [];
  const report = [];
  for (const p of selected) {
    const root = opts.roots?.[p.name] ?? p.defaultRoot();
    const present = p.detect(root);
    let convs = [];
    if (present) {
      try {
        convs = p.load({ root });
      } catch (err) {
        report.push({ provider: p.name, root, found: 0, error: String(err?.message ?? err) });
        continue;
      }
    }
    conversations.push(...convs);
    report.push({ provider: p.name, root, found: convs.length, detected: present });
  }
  return { conversations, report };
}
