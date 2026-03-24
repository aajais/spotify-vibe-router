import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";
import { loadState, setState } from "./state.mjs";
import { logger, logPollSummary, logTrackClassification, logWandbError } from "./logger.mjs";
import { VIBES } from "./vibes.mjs";
import { refreshIfNeeded, setAuthUnhealthy } from "./spotify/auth.mjs";
import { spotifyFetch } from "./spotify/client.mjs";
import { ensurePlaylists, getAudioFeatures, addTrackToPlaylist } from "./spotify/api.mjs";
import { classifyWithDiagnostics } from "./classifier/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let pollState = {
  running: false,
  lastStartAtMs: null,
  lastFinishAtMs: null,
  lastResult: null,
  consecutiveFailures: 0,
  lastError: null
};

let _pollInterval = null;

function loadThresholdsByVibe() {
  try {
    if (config.CLASSIFIER_THRESHOLDS_JSON?.trim()) return JSON.parse(config.CLASSIFIER_THRESHOLDS_JSON);
  } catch {}
  const s = loadState();
  if (s.classifierThresholdsByVibe && typeof s.classifierThresholdsByVibe === "object") {
    return s.classifierThresholdsByVibe;
  }
  return {};
}

export function appendAnalyticsPoll(entry) {
  const s = loadState();
  const pollHistory = Array.isArray(s.pollHistory) ? s.pollHistory : [];
  pollHistory.push(entry);
  const capped = pollHistory.slice(-2000);
  setState({ pollHistory: capped });
}

export function appendAnalyticsTrack(entry) {
  const s = loadState();
  const trackHistory = Array.isArray(s.trackHistory) ? s.trackHistory : [];
  trackHistory.push(entry);
  const capped = trackHistory.slice(-5000);
  setState({ trackHistory: capped });
}

export function setManualLabel(trackId, vibeKey) {
  const s = loadState();
  const labels = s.manualLabels && typeof s.manualLabels === "object" ? s.manualLabels : {};
  labels[String(trackId)] = { vibeKey, vibeKeys: [vibeKey], labeledAtMs: Date.now() };
  setState({ manualLabels: labels });
}

export function setManualLabels(trackId, vibeKeys) {
  const cleaned = Array.from(new Set((vibeKeys || []).filter(v => VIBES.some(x => x.key === v))));
  if (!cleaned.length) return false;
  const s = loadState();
  const labels = s.manualLabels && typeof s.manualLabels === "object" ? s.manualLabels : {};
  labels[String(trackId)] = { vibeKey: cleaned[0], vibeKeys: cleaned, labeledAtMs: Date.now() };
  setState({ manualLabels: labels });
  return true;
}

export function appendOnlineTrainingExample(trackId, vibeKey) {
  try {
    const s = loadState();
    const tracks = Array.isArray(s.trackHistory) ? s.trackHistory : [];
    const latest = [...tracks].reverse().find(t => t.trackId === trackId);
    if (!latest) return false;

    const trainingPath = config.TRAINING_DATA_PATH;
    let doc = { created_at: new Date().toISOString(), total_examples: 0, data: [] };
    if (existsSync(trainingPath)) {
      try { doc = JSON.parse(readFileSync(trainingPath, "utf8")); } catch {}
    }
    if (!Array.isArray(doc.data)) doc.data = [];

    const exists = doc.data.some(x => x.track_id === trackId && x.vibe_label === vibeKey && x.source_type === "manual_online");
    if (exists) return true;

    doc.data.push({
      track_id: trackId,
      track_name: latest.trackName,
      artist_names: latest.artist ? [latest.artist] : [],
      album_name: null,
      duration_ms: null,
      explicit: null,
      audio_features: null,
      artist_info: [],
      vibe_label: vibeKey,
      source_playlist_name: "manual-label",
      source_type: "manual_online",
      labeled_at: new Date().toISOString()
    });
    doc.total_examples = doc.data.length;
    writeFileSync(trainingPath, JSON.stringify(doc, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function computeQualitySnapshot() {
  const s = loadState();
  const labels = s.manualLabels && typeof s.manualLabels === "object" ? s.manualLabels : {};
  const tracks = Array.isArray(s.trackHistory) ? s.trackHistory : [];
  const latestByTrack = new Map();
  for (const t of tracks) latestByTrack.set(t.trackId, t);

  const byVibe = {};
  let total = 0;
  let correct = 0;

  for (const [trackId, lbl] of Object.entries(labels)) {
    const pred = latestByTrack.get(trackId);
    if (!pred) continue;
    total += 1;
    const predicted = pred.selectedVibes?.[0] || "unknown";
    const actualSet = Array.isArray(lbl.vibeKeys) && lbl.vibeKeys.length ? lbl.vibeKeys : [lbl.vibeKey].filter(Boolean);
    const hit = actualSet.includes(predicted);
    if (hit) correct += 1;
    for (const actual of actualSet) {
      byVibe[actual] = byVibe[actual] || { n: 0, hits: 0 };
      byVibe[actual].n += 1;
      if (hit) byVibe[actual].hits += 1;
    }
  }

  const precisionByVibe = Object.fromEntries(
    Object.entries(byVibe).map(([k, v]) => [k, v.n ? v.hits / v.n : 0])
  );

  return {
    labeledCount: total,
    top1AccuracyOnLabeled: total ? correct / total : null,
    precisionByVibe,
  };
}

export async function llmFallbackVibe(track, candidateScores) {
  if (!config.LLM_FALLBACK_ENABLED || !config.OPENAI_API_KEY) return null;
  try {
    const candidates = VIBES.filter(v => v.key !== "uncertain").map(v => ({ key: v.key, name: v.name, description: v.description }));
    const prompt = {
      track: {
        name: track.name,
        artists: track.artists,
        album: track.album_name,
        explicit: track.explicit,
        duration_ms: track.duration_ms
      },
      candidates,
      currentTopScores: (candidateScores || []).slice(0, 5)
    };

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.LLM_FALLBACK_MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Pick exactly one vibe key from provided candidates. Return JSON: {\"key\": \"...\", \"reason\": \"...\"}." },
          { role: "user", content: JSON.stringify(prompt) }
        ]
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(text);
    const key = String(parsed?.key || "").trim();
    if (!VIBES.some(v => v.key === key && key !== "uncertain")) return null;
    return { key, reason: String(parsed?.reason || "llm fallback") };
  } catch {
    return null;
  }
}

export async function pollOnce() {
  if (pollState.running) {
    return { processed: 0, added: 0, skipped: true, reason: "poll already running" };
  }

  pollState.running = true;
  pollState.lastStartAtMs = Date.now();

  try {
    const pollStartedAt = Date.now();
    const token = await refreshIfNeeded();
    const accessToken = token.access_token;

    let s = loadState();
    if (!s.playlistMap) {
      await ensurePlaylists(accessToken);
      s = loadState();
    }

    const saved = await spotifyFetch("https://api.spotify.com/v1/me/tracks?limit=50", accessToken);
    const items = saved.items
      .map(it => ({ addedAtMs: Date.parse(it.added_at), track: it.track }))
      .filter(x => x.track && x.track.id)
      .sort((a, b) => a.addedAtMs - b.addedAtMs);

    logger.info(`Found ${items.length} tracks in library`);
    if (items.length > 0) {
      logger.info(`Newest track timestamp: ${Math.max(...items.map(x => x.addedAtMs))}`);
      logger.info(`Oldest track timestamp: ${Math.min(...items.map(x => x.addedAtMs))}`);
    }

    const lastSeen = Number(s.lastSeenAddedAtMs ?? 0);
    logger.info(`Last seen timestamp: ${lastSeen}`);
    const newOnes = items.filter(x => x.addedAtMs > lastSeen);
    logger.info(`Found ${newOnes.length} new tracks`);
    if (items.length) setState({ lastSeenAddedAtMs: Math.max(...items.map(x => x.addedAtMs)) });

    if (newOnes.length === 0) return { processed: 0, added: 0 };

    const ids = newOnes.map(x => x.track.id);
    const afMap = await getAudioFeatures(accessToken, ids);

    s = loadState();
    const processedTracks = s.processedTracks ?? {};
    const dedupWindowMs = config.DEDUP_MINUTES * 60_000;

    let processed = 0;
    let added = 0;

    for (const it of newOnes) {
      const tr = it.track;
      const prev = processedTracks[tr.id];
      if (prev && Date.now() - prev < dedupWindowMs) continue;

      logger.info(`Processing track: ${tr.name} by ${tr.artists[0].name}`);

      const af = afMap.get(tr.id) ?? null;
      const diagnostics = await classifyWithDiagnostics(
        {
          id: tr.id,
          name: tr.name,
          artists: tr.artists.map(a => a.name),
          explicit: Boolean(tr.explicit),
          duration_ms: tr.duration_ms,
          album_name: tr.album?.name
        },
        af,
        {
          mode: config.CLASSIFIER_MODE,
          threshold: config.CLASSIFIER_THRESHOLD,
          thresholdsByVibe: loadThresholdsByVibe()
        }
      );

      const scored = diagnostics.mergedScores;
      const winners = diagnostics.winners;
      let finalKeys = diagnostics.finalKeys;

      if (config.MULTI_LABEL_ENABLED) {
        const top = scored[0]?.score ?? 0;
        const multi = scored
          .filter(s => s.key !== "uncertain")
          .filter(s => (top - s.score) <= config.MULTI_LABEL_MARGIN)
          .slice(0, config.MULTI_LABEL_MAX)
          .map(s => s.key);
        if (multi.length) finalKeys = Array.from(new Set(multi));
      }

      if (!winners.length || finalKeys[0] === "uncertain") {
        const llmPick = await llmFallbackVibe({
          name: tr.name,
          artists: tr.artists.map(a => a.name),
          album_name: tr.album?.name,
          explicit: Boolean(tr.explicit),
          duration_ms: tr.duration_ms
        }, scored);
        if (llmPick?.key) {
          finalKeys = [llmPick.key];
        }
      }

      logger.info(`Classified track into playlists: ${finalKeys.join(", ")}`);

      await logTrackClassification({
        trackId: tr.id,
        trackName: tr.name,
        artists: tr.artists.map(a => a.name),
        explicit: Boolean(tr.explicit),
        durationMs: tr.duration_ms,
        albumName: tr.album?.name,
        addedAtMs: it.addedAtMs,
        hasAudioFeatures: Boolean(af),
        classifierMode: diagnostics.mode,
        selectedVibes: finalKeys,
        threshold: diagnostics.threshold,
        rawRuleContributions: diagnostics.rawScores,
        scores: scored,
        topScore: scored[0]?.score ?? null,
        topVibe: scored[0]?.key ?? null,
        confidence: diagnostics.confidence,
        confidenceBand: diagnostics.confidenceBand,
        margin: diagnostics.margin,
        evidenceSources: diagnostics.evidenceSources
      });

      appendAnalyticsTrack({
        atMs: Date.now(),
        addedAtMs: it.addedAtMs,
        trackId: tr.id,
        trackName: tr.name,
        artist: tr.artists?.[0]?.name || "",
        selectedVibes: finalKeys,
        topVibe: scored[0]?.key ?? null,
        topScore: scored[0]?.score ?? null,
        usedAudioFeatures: Boolean(af),
        confidence: diagnostics.confidence,
        confidenceBand: diagnostics.confidenceBand,
        margin: diagnostics.margin,
        evidenceSources: diagnostics.evidenceSources
      });

      for (const key of finalKeys) {
        const playlistId = s.playlistMap?.[key];
        if (!playlistId) {
          logger.warn(`No playlist ID found for key: ${key}`);
          continue;
        }
        logger.info(`Attempting to add track to playlist: ${key} (${playlistId})`);
        logger.info(`Would add "${tr.name}" by ${tr.artists[0].name} to playlist "${key}"`);

        try {
          await addTrackToPlaylist(accessToken, playlistId, tr.uri);
          added += 1;
          logger.info(`Successfully added track to playlist: ${key}`);
        } catch (error) {
          logger.warn(`Failed to add track to playlist ${key}: ${error.message}`);
        }
      }

      processedTracks[tr.id] = Date.now();
      processed += 1;
    }

    // prune old processed entries (keep it from growing forever)
    const pruneBefore = Date.now() - 30 * 24 * 60_000; // 30 days
    for (const [id, ts] of Object.entries(processedTracks)) {
      if (typeof ts === "number" && ts < pruneBefore) delete processedTracks[id];
    }

    setState({ processedTracks });

    const pollFinishedAt = Date.now();
    await logPollSummary({
      pollStartedAt,
      pollFinishedAt,
      processed,
      added,
      totalLibraryTracksSeen: items.length,
      newTracksDetected: newOnes.length,
      dedupMinutes: config.DEDUP_MINUTES,
      threshold: config.CLASSIFIER_THRESHOLD,
      classifierMode: config.CLASSIFIER_MODE
    });

    appendAnalyticsPoll({
      atMs: pollFinishedAt,
      processed,
      added,
      newTracksDetected: newOnes.length,
      totalLibraryTracksSeen: items.length,
      classifierMode: config.CLASSIFIER_MODE,
      threshold: config.CLASSIFIER_THRESHOLD
    });

    pollState.lastFinishAtMs = pollFinishedAt;
    pollState.lastResult = { processed, added };
    pollState.consecutiveFailures = 0;
    pollState.lastError = null;

    return { processed, added };
  } catch (error) {
    pollState.lastFinishAtMs = Date.now();
    pollState.lastResult = null;
    pollState.consecutiveFailures += 1;
    pollState.lastError = error?.message ?? String(error);
    if (String(pollState.lastError).includes("invalid_grant") || String(pollState.lastError).toLowerCase().includes("reauth")) {
      setAuthUnhealthy(pollState.lastError);
    }
    throw error;
  } finally {
    pollState.running = false;
  }
}

export function startPolling(intervalMs) {
  if (_pollInterval) return;
  _pollInterval = setInterval(async () => {
    try {
      await pollOnce();
    } catch (error) {
      logger.error(`Poll failed: ${error?.message ?? String(error)}`);
    }
  }, intervalMs);
  logger.info(`Polling started, interval=${intervalMs}ms`);
}

export function stopPolling() {
  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
    logger.info("Polling stopped");
  }
}

export function getPollState() {
  return { ...pollState };
}
