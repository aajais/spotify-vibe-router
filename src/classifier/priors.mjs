import fs from "node:fs";
import { config } from "../config.mjs";

const PRIOR_FALLBACK_ORDER = ["abysride", "gallery_opening", "cashmere_bg", "terminal_serenity"];

let priorsCache = null;

function loadPriors() {
  if (priorsCache) return priorsCache;

  const priors = {
    artistToVibe: new Map(),
    albumTokenToVibe: new Map(),
    globalVibeCounts: new Map(),
  };

  try {
    const p = config.TRAINING_DATA_PATH;
    if (!fs.existsSync(p)) {
      priorsCache = priors;
      return priors;
    }
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    const rows = Array.isArray(data?.data) ? data.data : [];

    for (const row of rows) {
      const vibe = row?.vibe_label;
      if (!vibe || vibe === "uncertain") continue;
      priors.globalVibeCounts.set(vibe, (priors.globalVibeCounts.get(vibe) || 0) + 1);

      for (const a of row.artist_names || []) {
        const k = String(a || "").trim().toLowerCase();
        if (!k) continue;
        const m = priors.artistToVibe.get(k) || new Map();
        m.set(vibe, (m.get(vibe) || 0) + 1);
        priors.artistToVibe.set(k, m);
      }

      const album = String(row.album_name || "").toLowerCase();
      for (const tok of album.split(/[^a-z0-9]+/).filter(x => x.length >= 4)) {
        const m = priors.albumTokenToVibe.get(tok) || new Map();
        m.set(vibe, (m.get(vibe) || 0) + 1);
        priors.albumTokenToVibe.set(tok, m);
      }
    }
  } catch {
    // ignore — continue with empty priors
  }

  priorsCache = priors;
  return priors;
}

function topVibeFromCountMap(countMap) {
  let best = null;
  for (const [k, v] of countMap.entries()) {
    if (!best || v > best.v) best = { k, v };
  }
  return best?.k || null;
}

export function hashToFallback(track) {
  const seed = `${track.name || ""}|${(track.artists || []).join(",")}`.toLowerCase();
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PRIOR_FALLBACK_ORDER[h % PRIOR_FALLBACK_ORDER.length];
}

export function scorePriors(track) {
  const priors = loadPriors();
  const scores = [];
  const push = (key, score, why) => scores.push({ key, score, why });

  for (const a of track.artists || []) {
    const k = String(a || "").toLowerCase().trim();
    const counts = priors.artistToVibe.get(k);
    if (counts) {
      const vibe = topVibeFromCountMap(counts);
      if (vibe) push(vibe, 0.52, `artist prior: ${a}`);
    }
  }

  const albumTokens = String(track.album_name || "").toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length >= 4);
  for (const tok of albumTokens.slice(0, 6)) {
    const counts = priors.albumTokenToVibe.get(tok);
    if (counts) {
      const vibe = topVibeFromCountMap(counts);
      if (vibe) push(vibe, 0.46, `album-token prior: ${tok}`);
    }
  }

  return scores;
}

export function resetPriorsCache() {
  priorsCache = null;
}
