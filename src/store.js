import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "..", "data.json");

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    return { warnings: {}, joinTimes: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { warnings: {}, joinTimes: {} };
  }
}

let state = load();

function persist() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function key(chatId, userId) {
  return `${chatId}:${userId}`;
}

export function recordJoin(chatId, userId) {
  state.joinTimes[key(chatId, userId)] = Date.now();
  persist();
}

export function minutesSinceJoin(chatId, userId) {
  const t = state.joinTimes[key(chatId, userId)];
  if (!t) return Infinity;
  return (Date.now() - t) / 60000;
}

export function addWarning(chatId, userId) {
  const k = key(chatId, userId);
  const now = Date.now();
  const entry = state.warnings[k] || { count: 0, lastAt: 0 };
  if (now - entry.lastAt > 24 * 60 * 60 * 1000) {
    entry.count = 0;
  }
  entry.count += 1;
  entry.lastAt = now;
  state.warnings[k] = entry;
  persist();
  return entry.count;
}

export function resetWarnings(chatId, userId) {
  delete state.warnings[key(chatId, userId)];
  persist();
}
