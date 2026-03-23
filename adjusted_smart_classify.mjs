import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    const p = path.join(__dirname, "training_data.json");
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
    // ignore and continue with empty priors
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

function hashToFallback(track) {
  const seed = `${track.name || ""}|${(track.artists || []).join(",")}`.toLowerCase();
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PRIOR_FALLBACK_ORDER[h % PRIOR_FALLBACK_ORDER.length];
}

export async function adjustedSmartClassifyVibes(track, af, options = {}) {
  const mode = options.mode ?? "hybrid"; // hybrid | keywords | audio
  const returnDebug = options.returnDebug === true;

  const t = (track.name + " " + track.artists.join(" ")).toLowerCase();
  const scores = [];
  const push = (key, score, why) => scores.push({ key, score, why });
  const useKeywordSignals = mode === "hybrid" || mode === "keywords";
  const useAudioSignals = mode === "hybrid" || mode === "audio";

  if (useKeywordSignals) {
    if (/(remix|edit|flip|vip|club mix|dub mix|bootleg)/.test(t)) push("velvet_rope", 0.35, "remix/edit cue");
    if (/(live|acoustic|piano version|stripped|unplugged|mtv unplugged)/.test(t)) push("honeyed_home", 0.4, "acoustic/live cue");
    if (/(instrumental|ambient|study|lofi|chill|background|atmosphere)/.test(t)) push("terminal_serenity", 0.45, "instrumental/focus cue");
    if (/(workout|gym|training|beast mode|cardio|fitness|exercise)/.test(t)) push("menace_mileage", 0.4, "workout cue");
    if (/(sad|heartbreak|lonely|melancholy|blue|down|broken)/.test(t)) push("soft_focus", 0.35, "sad/emotional cue");
    if (/(party|celebrat|dance|banger|turn up|lit)/.test(t)) push("neon_cardio", 0.35, "party/dance cue");
    if (/(focus|study|concentration|deep work|productivity)/.test(t)) push("commit_season", 0.4, "focus cue");
    if (/(road trip|driving|cruise|journey|highway)/.test(t)) push("abysride", 0.35, "travel cue");
    if (/(morning|wake up|rise|sun|dawn|daybreak)/.test(t)) push("sunlit_recal", 0.3, "morning/reset cue");
    if (/(cooking|kitchen|recipe|chef|dinner|lunch)/.test(t)) push("stove_clock", 0.3, "cooking cue");
    if (/(coffee|cafe|morning brew|breakfast)/.test(t)) push("sunlit_recal", 0.35, "morning/coffee cue");
    if (/(rain|storm|thunder|nature|forest|waves|ocean)/.test(t)) push("terminal_serenity", 0.4, "nature/ambient cue");
    if (/(retro|80s|90s|nostalgia|vintage)/.test(t)) push("gallery_opening", 0.3, "retro/nostalgic cue");
    if (/(experimental|weird|strange|odd|unusual)/.test(t)) push("left_of_groove", 0.35, "experimental cue");

    const artistString = track.artists.join(" ").toLowerCase();
    if (artistString.includes("bhat") || artistString.includes("donn") || artistString.includes("indian") || artistString.includes("bollywood") || artistString.includes("hindi") || artistString.includes("desi")) {
      push("cashmere_bg", 0.4, "indian/desi music");
    }
  }

  if (af && useAudioSignals) {
    const { energy, valence, tempo, danceability, acousticness, speechiness, instrumentalness } = af;
    if (tempo >= 130 && energy >= 0.65) push("neon_cardio", 0.75, "high tempo + high energy");
    if (tempo >= 105 && energy >= 0.5 && tempo < 140) push("fast_not_furious", 0.55, "medium-high tempo + energy");
    if (danceability >= 0.7 && energy >= 0.55) push("errandcore", 0.5, "danceable + upbeat");
    if (danceability >= 0.6 && energy >= 0.45 && valence >= 0.35 && valence <= 0.7) push("monochrome_martini", 0.45, "balanced valence + danceability");
    if (danceability >= 0.7 && energy >= 0.65) push("velvet_rope", 0.6, "club-ready energy + danceability");
    if (acousticness >= 0.55 && energy <= 0.55) push("honeyed_home", 0.55, "acoustic + not too energetic");
    if (energy <= 0.45 && valence >= 0.35 && acousticness >= 0.25) push("cashmere_bg", 0.45, "warm low-energy");
    if (valence <= 0.4 && energy <= 0.55) push("soft_focus", 0.55, "low valence + moderate/low energy");
    if (valence <= 0.35 && tempo <= 115) push("afterhours", 0.45, "late-night low valence/tempo");
    if (energy <= 0.5 && tempo <= 120) push("abysride", 0.35, "transit-friendly pacing");
    if (instrumentalness >= 0.5 || (energy <= 0.5 && speechiness <= 0.07)) push("windowseat_auteur", 0.4, "spacious/instrumental leaning");
    if (energy >= 0.65 && danceability <= 0.45) push("left_of_groove", 0.5, "high energy but not danceable");
    if (speechiness <= 0.04 && instrumentalness >= 0.3 && valence >= 0.2 && valence <= 0.6) push("glitch_grace", 0.45, "textural/instrumental blend");
    if (energy >= 0.8 && tempo >= 120) push("menace_mileage", 0.6, "very high energy + tempo");
    if (energy >= 0.85 && (speechiness >= 0.08 || track.explicit)) push("iron_irreverence", 0.55, "aggressive energy + (speechiness/explicit)");
    if (valence <= 0.35 && energy >= 0.6) push("tearjerk_subwoofers", 0.6, "sad valence but high energy");
    if (valence <= 0.4 && danceability >= 0.6) push("crying_designer", 0.5, "sad-ish but danceable");
    if (valence >= 0.45 && energy <= 0.55 && tempo <= 125) push("sunlit_recal", 0.45, "light valence + calm energy");
    if (acousticness >= 0.4 && valence >= 0.45 && energy <= 0.55) push("linen_day", 0.45, "soft acoustic reset");
    if (tempo >= 85 && tempo <= 120 && danceability >= 0.55 && energy <= 0.7) push("decant_dance", 0.45, "mid tempo groove");
    if (tempo <= 110 && energy <= 0.6 && valence >= 0.35) push("stove_clock", 0.4, "unhurried, warm");
    if (instrumentalness >= 0.6 || (speechiness <= 0.05 && energy >= 0.35 && energy <= 0.65)) push("commit_season", 0.5, "low lyrical distraction + steady energy");
    if (energy <= 0.55 && instrumentalness >= 0.4) push("terminal_serenity", 0.5, "calm instrumental");
  } else if (mode !== "audio") {
    const durationSec = (track.duration_ms || 0) / 1000;
    if (durationSec > 600) {
      push("windowseat_auteur", 0.5, "long track - possibly instrumental/cinematic");
      push("terminal_serenity", 0.45, "long track - ambient");
    } else if (durationSec > 300) {
      push("honeyed_home", 0.45, "medium-long track - possibly classical/acoustic");
    } else if (durationSec < 90) {
      push("neon_cardio", 0.35, "short track - possibly high energy");
      push("errandcore", 0.3, "short track - quick burst");
    }
    if (track.explicit) push("iron_irreverence", 0.5, "explicit content");
  }

  // data-driven fallback from locally built dataset priors
  const priors = loadPriors();
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

  const merged = new Map();
  for (const s of scores) {
    const prev = merged.get(s.key);
    if (!prev || s.score > prev.score) merged.set(s.key, s);
  }

  let mergedScores = Array.from(merged.values()).sort((a, b) => b.score - a.score);
  if (mergedScores.length === 0) {
    const fallbackKey = hashToFallback(track);
    mergedScores = [{ key: fallbackKey, score: 0.31, why: "deterministic fallback from priors" }];
  }

  if (returnDebug) {
    return {
      rawScores: scores,
      mergedScores,
      mode,
      usedAudioFeatures: Boolean(af)
    };
  }
  return mergedScores;
}

export async function classifyWithAdjustedThreshold(track, af, options = {}) {
  const threshold = options.threshold ?? 0.40;
  const mode = options.mode ?? "hybrid";
  const results = await adjustedSmartClassifyVibes(track, af, { mode });
  const winners = results.filter(s => s.score >= threshold);
  if (winners.length > 0) return results;
  return results;
}

export async function classifyWithDiagnostics(track, af, options = {}) {
  const threshold = options.threshold ?? 0.40;
  const mode = options.mode ?? "hybrid";
  const allowUncertain = options.allowUncertain === true;
  const thresholdsByVibe = options.thresholdsByVibe || {};

  const out = await adjustedSmartClassifyVibes(track, af, { mode, returnDebug: true });
  const mergedScores = out.mergedScores ?? [];

  const winners = mergedScores.filter(s => {
    if (s.key === "uncertain") return false;
    const vibeThr = Number.isFinite(Number(thresholdsByVibe[s.key])) ? Number(thresholdsByVibe[s.key]) : threshold;
    return s.score >= vibeThr;
  });

  let finalKeys = winners.length ? winners.map(w => w.key) : [mergedScores[0]?.key || "uncertain"];

  if (!allowUncertain && finalKeys[0] === "uncertain") {
    const fallback = mergedScores.find(x => x.key !== "uncertain")?.key || hashToFallback(track);
    finalKeys = [fallback];
  }

  const top1 = mergedScores[0]?.score ?? 0;
  const top2 = mergedScores[1]?.score ?? 0;
  const margin = Math.max(0, top1 - top2);

  const evidenceSources = new Set();
  for (const r of out.rawScores ?? []) {
    const why = String(r.why || "").toLowerCase();
    if (why.includes("artist prior")) evidenceSources.add("artist-prior");
    else if (why.includes("album-token prior")) evidenceSources.add("album-prior");
    else if (why.includes("cue") || why.includes("classical") || why.includes("explicit")) evidenceSources.add("rules");
    else if (why.includes("fallback")) evidenceSources.add("fallback");
  }
  if (af) evidenceSources.add("audio");

  const sourceCount = evidenceSources.size;
  const confidence = Math.max(0, Math.min(1, (top1 * 0.7) + (margin * 0.5) + (sourceCount >= 2 ? 0.1 : 0)));
  const confidenceBand = confidence >= 0.75 ? "high" : confidence >= 0.5 ? "medium" : "low";

  return {
    threshold,
    mode,
    rawScores: out.rawScores ?? [],
    mergedScores,
    winners,
    finalKeys,
    usedAudioFeatures: out.usedAudioFeatures,
    top1,
    top2,
    margin,
    confidence,
    confidenceBand,
    evidenceSources: Array.from(evidenceSources),
  };
}
