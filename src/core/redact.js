/**
 * Privacy layer.
 *
 * Runs over every piece of text BEFORE analysis, and again over every line
 * that ends up inside a generated skill. Skills must carry requirements and
 * preferences — never credentials, identities, or personal data.
 */
import os from "node:os";

const PATTERNS = [
  // API keys & tokens
  { re: /sk-ant-[A-Za-z0-9_-]{10,}/g, sub: "[REDACTED_API_KEY]" },
  { re: /sk-[A-Za-z0-9_-]{20,}/g, sub: "[REDACTED_API_KEY]" },
  { re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, sub: "[REDACTED_GITHUB_TOKEN]" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, sub: "[REDACTED_GITHUB_TOKEN]" },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, sub: "[REDACTED_SLACK_TOKEN]" },
  { re: /AKIA[0-9A-Z]{16}/g, sub: "[REDACTED_AWS_KEY]" },
  { re: /AIza[0-9A-Za-z_-]{30,}/g, sub: "[REDACTED_GOOGLE_KEY]" },
  { re: /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g, sub: "[REDACTED_JWT]" },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, sub: "Bearer [REDACTED]" },
  // key=value style secrets
  {
    re: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\b(\s*[:=]\s*)(["']?)[^\s"']{6,}\3/gi,
    sub: "$1$2$3[REDACTED]$3",
  },
  // URLs that carry credentials or tokens
  { re: /(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, sub: "$1[REDACTED]@" },
  { re: /([?&](?:token|key|apikey|api_key|access_token|signature|sig)=)[^\s&"']+/gi, sub: "$1[REDACTED]" },
  // Identity
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, sub: "[REDACTED_EMAIL]" },
  { re: /\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, sub: "[REDACTED_PHONE]" },
  { re: /\b(?:\d[ -]*?){13,16}\b/g, sub: "[REDACTED_NUMBER]" },
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, sub: "[REDACTED_IP]" },
  // SSH/PEM blocks
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, sub: "[REDACTED_PRIVATE_KEY]" },
];

export function redact(text, { username = os.userInfo().username } = {}) {
  if (!text) return text;
  let out = text;
  for (const { re, sub } of PATTERNS) {
    out = out.replace(re, sub);
  }
  // Anonymize home paths: /Users/alice/x and /home/alice/x → ~/x
  out = out.replace(/(?:\/Users|\/home)\/([A-Za-z0-9._-]+)/g, "~");
  // Anonymize the OS username anywhere else it appears as a standalone word
  if (username && username.length > 2) {
    out = out.replace(new RegExp(`\\b${escapeRe(username)}\\b`, "g"), "[USER]");
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if a line still looks risky after redaction — such lines are dropped entirely. */
export function looksSensitive(text) {
  return /\b(ssn|social security|passport\s*(no|number)|date of birth|bank account|routing number)\b/i.test(text);
}
