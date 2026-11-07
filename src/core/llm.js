/**
 * Optional LLM polish pass — provider-agnostic, off by default.
 *
 * The heuristic analyzer does all extraction; this pass only rewrites the
 * already-extracted, already-redacted bullets into crisper skill
 * instructions. Nothing beyond those bullets ever leaves the machine.
 *
 * Configure via environment:
 *   SKILLMINER_LLM=anthropic | openai | ollama
 *   SKILLMINER_MODEL=<model id>            (defaults per provider below)
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY     (ollama needs none)
 *   SKILLMINER_LLM_BASE_URL                (override endpoint, e.g. any
 *                                           OpenAI-compatible gateway)
 */

const DEFAULTS = {
  anthropic: { model: "claude-sonnet-5", url: "https://api.anthropic.com/v1/messages" },
  openai: { model: "gpt-5", url: "https://api.openai.com/v1/chat/completions" },
  ollama: { model: "llama3.1", url: "http://localhost:11434/v1/chat/completions" },
};

const SYSTEM_PROMPT = `You rewrite raw mined notes into crisp, imperative skill instructions for an AI coding agent.
Rules:
- Output one markdown bullet per instruction, nothing else.
- Merge duplicates, drop vague or one-off items, keep durable requirements and preferences.
- Never invent facts not present in the input.
- Never include names, emails, keys, URLs with tokens, or any personal data.`;

export function llmConfigured() {
  return Boolean(process.env.SKILLMINER_LLM);
}

export async function polishBullets(bullets, { purpose = "user preferences" } = {}) {
  const provider = process.env.SKILLMINER_LLM;
  if (!provider || !DEFAULTS[provider]) return null;
  const cfg = DEFAULTS[provider];
  const model = process.env.SKILLMINER_MODEL || cfg.model;
  const url = process.env.SKILLMINER_LLM_BASE_URL || cfg.url;
  const user = `These bullets were mined from past agent sessions as ${purpose}. Rewrite per the rules:\n\n${bullets
    .map((b) => `- ${b}`)
    .join("\n")}`;

  try {
    let text;
    if (provider === "anthropic") {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const data = await res.json();
      text = data.content?.map((b) => b.text ?? "").join("") ?? "";
    } else {
      // openai + ollama share the chat-completions shape
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.OPENAI_API_KEY ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const data = await res.json();
      text = data.choices?.[0]?.message?.content ?? "";
    }
    const polished = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim())
      .filter(Boolean);
    return polished.length ? polished : null;
  } catch (err) {
    console.error(`skillminer: LLM polish skipped (${err.message})`);
    return null;
  }
}
