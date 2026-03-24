import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { config } from "./config.mjs";

export function loadState() {
  if (!existsSync(config.STATE_PATH)) return {};
  return JSON.parse(readFileSync(config.STATE_PATH, "utf8"));
}

export function saveState(s) {
  writeFileSync(config.STATE_PATH, JSON.stringify(s, null, 2));
}

export function setState(patch) {
  const s = loadState();
  const next = { ...s, ...patch };
  saveState(next);
  return next;
}
