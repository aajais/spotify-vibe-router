import { scoreKeywords } from "./keywords.mjs";
import { scoreAudioFeatures } from "./audio.mjs";
import { scorePriors, hashToFallback } from "./priors.mjs";

function mergeScores(allScores) {
  const merged = new Map();
  for (const s of allScores) {
    const prev = merged.get(s.key);
    if (!prev || s.score > prev.score) merged.set(s.key, s);
  }
  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

export async function classifyWithDiagnostics(track, af, options = {}) {
  const threshold = options.threshold ?? 0.40;
  const mode = options.mode ?? "hybrid";
  const allowUncertain = options.allowUncertain === true;
  const thresholdsByVibe = options.thresholdsByVibe || {};

  const useKeywords = mode === "hybrid" || mode === "keywords";
  const useAudio = mode === "hybrid" || mode === "audio";

  const rawScores = [];
  if (useKeywords) rawScores.push(...scoreKeywords(track));
  if (useAudio && af) rawScores.push(...scoreAudioFeatures(af));

  // Explicit content boost for iron_irreverence (needs track.explicit, only in audio mode with af)
  if (useAudio && af && track.explicit && af.energy >= 0.85) {
    rawScores.push({ key: "iron_irreverence", score: 0.55, why: "aggressive energy + explicit" });
  }

  // Always add priors
  rawScores.push(...scorePriors(track));

  let mergedScores = mergeScores(rawScores);

  if (mergedScores.length === 0) {
    const fallbackKey = hashToFallback(track);
    mergedScores = [{ key: fallbackKey, score: 0.31, why: "deterministic fallback from priors" }];
  }

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
  for (const r of rawScores) {
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
    rawScores,
    mergedScores,
    winners,
    finalKeys,
    usedAudioFeatures: Boolean(af),
    top1,
    top2,
    margin,
    confidence,
    confidenceBand,
    evidenceSources: Array.from(evidenceSources),
  };
}
