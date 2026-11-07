/**
 * Run state, kept in ~/.skillminer/state.json.
 *
 * Remembers when we last ran and which source files we have already seen
 * (path + mtime + size), so `improve` can report what is new and merge
 * instead of rebuilding blind.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function stateDir() {
  return process.env.SKILLMINER_HOME ?? path.join(os.homedir(), ".skillminer");
}

export function statePath() {
  return path.join(stateDir(), "state.json");
}

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return { lastRun: null, seenFiles: {}, outDir: null };
  }
}

export function saveState(state) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

export function fingerprint(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** Partition conversations into { fresh, known } based on source-file fingerprints. */
export function diffAgainstState(conversations, state) {
  const fresh = [];
  const known = [];
  for (const conv of conversations) {
    const fp = conv.sourceFile ? fingerprint(conv.sourceFile) : null;
    const prev = conv.sourceFile ? state.seenFiles[conv.sourceFile] : null;
    if (fp && prev === fp) known.push(conv);
    else fresh.push(conv);
  }
  return { fresh, known };
}

export function recordSeen(conversations, state) {
  for (const conv of conversations) {
    if (!conv.sourceFile) continue;
    const fp = fingerprint(conv.sourceFile);
    if (fp) state.seenFiles[conv.sourceFile] = fp;
  }
  state.lastRun = new Date().toISOString();
  return state;
}
