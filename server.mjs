import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { VIBES } from "./vibes.mjs";
import { classifyVibes } from "./classify.mjs";
import { classifyWithDiagnostics } from "./adjusted_smart_classify.mjs";
import {
  initWandbLogging,
  logPollSummary,
  logTrackClassification,
  logWandbError,
  finishWandbLogging
} from "./wandb_logger.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
if (!CLIENT_ID) {
  console.error("Missing SPOTIFY_CLIENT_ID env var");
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 8888);
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI ?? `http://127.0.0.1:${PORT}/callback`;
const POLL_MINUTES = Number(process.env.POLL_MINUTES ?? 5);
const DEDUP_MINUTES = Number(process.env.DEDUP_MINUTES ?? 60);
const PLAYLIST_VISIBILITY = process.env.PLAYLIST_VISIBILITY ?? "private";

const WANDB_ENABLED = (process.env.WANDB_ENABLED ?? "true").toLowerCase() !== "false";
const WANDB_ENTITY = process.env.WANDB_ENTITY ?? "dipy_genai";
const WANDB_PROJECT = process.env.WANDB_PROJECT ?? "vibe-classification-spotify";
const CLASSIFIER_MODE = process.env.CLASSIFIER_MODE ?? "hybrid"; // hybrid | keywords | audio
const CLASSIFIER_THRESHOLD = Number(process.env.CLASSIFIER_THRESHOLD ?? 0.40);
const CLASSIFIER_THRESHOLDS_JSON = process.env.CLASSIFIER_THRESHOLDS_JSON ?? "";
const MULTI_LABEL_ENABLED = (process.env.MULTI_LABEL_ENABLED ?? "true").toLowerCase() !== "false";
const MULTI_LABEL_MARGIN = Number(process.env.MULTI_LABEL_MARGIN ?? 0.08);
const MULTI_LABEL_MAX = Number(process.env.MULTI_LABEL_MAX ?? 3);
const LLM_FALLBACK_ENABLED = (process.env.LLM_FALLBACK_ENABLED ?? "false").toLowerCase() === "true";
const LLM_FALLBACK_MODEL = process.env.LLM_FALLBACK_MODEL ?? "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

const SCOPES = [
  "user-library-read",
  "playlist-read-private",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-read-private"
];

const STATE_PATH = process.env.STATE_PATH ?? path.join(__dirname, "state.json");
const LOG_CLEAR_MARKER = "[UI_LOG_CLEAR_MARKER]";
let rewindCache = { atMs: 0, payload: null };
let rewindTracksCache = { atMs: 0, items: null };
let rewindCompareCache = new Map();
let audioFeaturesCache = new Map();
let spotifyRateState = { rate429: 0, retries: 0, lastRateLimitAtMs: null, lastRetryAtMs: null };
let pollState = { running: false, lastStartAtMs: null, lastFinishAtMs: null, lastResult: null, consecutiveFailures: 0, lastError: null };
let authState = { healthy: false, lastCheckedAtMs: null, lastError: null };

function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}
function saveState(s) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}
function setState(patch) {
  const s = loadState();
  const next = { ...s, ...patch };
  saveState(next);
  return next;
}

function base64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function makeVerifier(len = 64) {
  return base64Url(crypto.randomBytes(len));
}
function makeChallenge(verifier) {
  return base64Url(crypto.createHash("sha256").update(verifier).digest());
}

function nowMs() {
  return Date.now();
}

function loadThresholdsByVibe() {
  try {
    if (CLASSIFIER_THRESHOLDS_JSON?.trim()) return JSON.parse(CLASSIFIER_THRESHOLDS_JSON);
  } catch {}
  const s = loadState();
  if (s.classifierThresholdsByVibe && typeof s.classifierThresholdsByVibe === "object") {
    return s.classifierThresholdsByVibe;
  }
  return {};
}
function isExpired(token, skewMs = 30_000) {
  const expiresAt = token.obtained_at_ms + token.expires_in * 1000;
  return nowMs() + skewMs >= expiresAt;
}

async function postForm(url, bodyObj) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(bodyObj)
  });
  if (!res.ok) throw new Error(`Token endpoint ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function spotifyFetch(url, accessToken, init = {}) {
  const maxRetries = Number(process.env.SPOTIFY_MAX_RETRIES ?? 4);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });

    if (res.ok) {
      if (res.status === 204) return null;
      return await res.json();
    }

    const retryAfter = Number(res.headers.get("retry-after") || "0");
    const retriable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    if (res.status === 429) {
      spotifyRateState.rate429 += 1;
      spotifyRateState.lastRateLimitAtMs = nowMs();
    }
    if (retriable && attempt < maxRetries) {
      const baseMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(20_000, 400 * (2 ** attempt));
      const jitterMs = Math.floor(Math.random() * 250);
      const waitMs = baseMs + jitterMs;
      spotifyRateState.retries += 1;
      spotifyRateState.lastRetryAtMs = nowMs();
      console.warn(`[spotifyFetch] ${res.status} retry ${attempt + 1}/${maxRetries} in ${waitMs}ms -> ${url}`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    const errorText = await res.text();
    console.error(`Spotify API error for ${url}: ${res.status} - ${errorText}`);
    throw new Error(`Spotify ${res.status}: ${errorText}`);
  }

  throw new Error("Spotify request failed after retries");
}

async function refreshIfNeeded() {
  const s = loadState();
  if (!s.token) throw new Error("Not authenticated");
  if (!isExpired(s.token)) return s.token;
  if (!s.token.refresh_token) throw new Error("Expired and no refresh_token; reauth");

  const refreshed = await postForm("https://accounts.spotify.com/api/token", {
    grant_type: "refresh_token",
    refresh_token: s.token.refresh_token,
    client_id: CLIENT_ID
  });

  const next = {
    access_token: refreshed.access_token,
    token_type: refreshed.token_type,
    expires_in: refreshed.expires_in,
    refresh_token: s.token.refresh_token,
    scope: refreshed.scope,
    obtained_at_ms: nowMs()
  };

  setState({ token: next });
  return next;
}

async function updateAuthHealth() {
  try {
    const token = await refreshIfNeeded();
    await spotifyFetch("https://api.spotify.com/v1/me", token.access_token);
    authState.healthy = true;
    authState.lastCheckedAtMs = nowMs();
    authState.lastError = null;
    return true;
  } catch (error) {
    authState.healthy = false;
    authState.lastCheckedAtMs = nowMs();
    authState.lastError = error?.message ?? String(error);
    return false;
  }
}

async function listAllPlaylists(accessToken) {
  const out = [];
  let url = "https://api.spotify.com/v1/me/playlists?limit=50";
  while (url) {
    const page = await spotifyFetch(url, accessToken);
    out.push(...page.items.map(p => ({ id: p.id, name: p.name })));
    url = page.next;
  }
  return out;
}

async function fetchSavedTracksHistory(accessToken, maxTracks = Number(process.env.REWIND_MAX_TRACKS ?? 5000)) {
  const out = [];
  let url = "https://api.spotify.com/v1/me/tracks?limit=50";
  while (url && out.length < maxTracks) {
    const page = await spotifyFetch(url, accessToken);
    for (const it of page.items || []) {
      if (!it?.track?.id) continue;
      out.push(it);
      if (out.length >= maxTracks) break;
    }
    url = page.next;
  }
  return out;
}

async function getRewindItems(accessToken) {
  const cacheTtlMs = 15 * 60_000;
  if (Array.isArray(rewindTracksCache.items) && (nowMs() - rewindTracksCache.atMs) < cacheTtlMs) {
    return rewindTracksCache.items;
  }
  const items = await fetchSavedTracksHistory(accessToken);
  rewindTracksCache = { atMs: nowMs(), items };
  return items;
}

async function ensurePlaylists(accessToken) {
  const me = await spotifyFetch("https://api.spotify.com/v1/me", accessToken);
  const existing = await listAllPlaylists(accessToken);
  const byName = new Map(existing.map(p => [p.name.toLowerCase(), p]));

  for (const vibe of VIBES) {
    if (byName.has(vibe.name.toLowerCase())) continue;
    await spotifyFetch(`https://api.spotify.com/v1/me/playlists`, accessToken, {
      method: "POST",
      body: JSON.stringify({
        name: vibe.name,
        public: PLAYLIST_VISIBILITY === "public",
        description: `Auto-sorted by vibe-router: ${vibe.description}`
      })
    });
  }

  const refreshed = await listAllPlaylists(accessToken);
  const map = {};
  for (const vibe of VIBES) {
    const p = refreshed.find(x => x.name.toLowerCase() === vibe.name.toLowerCase());
    if (p) map[vibe.key] = p.id;
  }

  setState({ playlistMap: map });
  return map;
}

async function getAudioFeatures(accessToken, ids) {
  if (ids.length === 0) return new Map();

  const out = new Map();
  const now = nowMs();
  const ttlMs = Number(process.env.AUDIO_FEATURES_CACHE_TTL_MS ?? 7 * 24 * 60 * 60 * 1000); // 7d default
  const ttlNullMs = Number(process.env.AUDIO_FEATURES_CACHE_NULL_TTL_MS ?? 60 * 60 * 1000); // 1h for nulls/errors

  // prune stale cache entries opportunistically
  if (audioFeaturesCache.size > 10_000) {
    for (const [k, v] of audioFeaturesCache.entries()) {
      if (!v || !Number.isFinite(v.expiresAtMs) || v.expiresAtMs <= now) audioFeaturesCache.delete(k);
    }
  }

  const misses = [];
  for (const id of ids) {
    const cached = audioFeaturesCache.get(id);
    if (cached && cached.expiresAtMs > now) {
      out.set(id, cached.value ?? null);
    } else {
      misses.push(id);
    }
  }

  for (let i = 0; i < misses.length; i += 100) {
    const chunk = misses.slice(i, i + 100);
    const url = `https://api.spotify.com/v1/audio-features?ids=${encodeURIComponent(chunk.join(","))}`;
    try {
      const resp = await spotifyFetch(url, accessToken);
      for (const item of resp.audio_features || []) {
        if (item && item.id) {
          const { id, ...rest } = item;
          out.set(id, rest);
          audioFeaturesCache.set(id, { value: rest, expiresAtMs: now + ttlMs });
        }
      }
      for (const id of chunk) {
        if (!out.has(id)) {
          out.set(id, null);
          audioFeaturesCache.set(id, { value: null, expiresAtMs: now + ttlNullMs });
        }
      }
    } catch (error) {
      console.warn(`Failed to fetch audio features (falling back to basic track info): ${error.message}`);
      for (const id of chunk) {
        out.set(id, null);
        audioFeaturesCache.set(id, { value: null, expiresAtMs: now + ttlNullMs });
      }
    }
  }

  return out;
}

async function addTrackToPlaylist(accessToken, playlistId, trackUri) {
  try {
    await spotifyFetch(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items`, accessToken, {
      method: "POST",
      body: JSON.stringify({ uris: [trackUri] })
    });
    return true; // Success
  } catch (error) {
    console.warn(`Failed to add track to playlist (will retry next poll): ${error.message}`);
    throw error;
  }
}

function appendAnalyticsPoll(entry) {
  const s = loadState();
  const pollHistory = Array.isArray(s.pollHistory) ? s.pollHistory : [];
  pollHistory.push(entry);
  const capped = pollHistory.slice(-2000);
  setState({ pollHistory: capped });
}

function appendAnalyticsTrack(entry) {
  const s = loadState();
  const trackHistory = Array.isArray(s.trackHistory) ? s.trackHistory : [];
  trackHistory.push(entry);
  const capped = trackHistory.slice(-5000);
  setState({ trackHistory: capped });
}

function setManualLabel(trackId, vibeKey) {
  const s = loadState();
  const labels = s.manualLabels && typeof s.manualLabels === "object" ? s.manualLabels : {};
  labels[String(trackId)] = { vibeKey, vibeKeys: [vibeKey], labeledAtMs: nowMs() };
  setState({ manualLabels: labels });
}

function setManualLabels(trackId, vibeKeys) {
  const cleaned = Array.from(new Set((vibeKeys || []).filter(v => VIBES.some(x => x.key === v))));
  if (!cleaned.length) return false;
  const s = loadState();
  const labels = s.manualLabels && typeof s.manualLabels === "object" ? s.manualLabels : {};
  labels[String(trackId)] = { vibeKey: cleaned[0], vibeKeys: cleaned, labeledAtMs: nowMs() };
  setState({ manualLabels: labels });
  return true;
}

function appendOnlineTrainingExample(trackId, vibeKey) {
  try {
    const s = loadState();
    const tracks = Array.isArray(s.trackHistory) ? s.trackHistory : [];
    const latest = [...tracks].reverse().find(t => t.trackId === trackId);
    if (!latest) return false;

    const trainingPath = path.join(__dirname, "training_data.json");
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

function computeQualitySnapshot() {
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

async function llmFallbackVibe(track, candidateScores) {
  if (!LLM_FALLBACK_ENABLED || !OPENAI_API_KEY) return null;
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
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: LLM_FALLBACK_MODEL,
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

async function pollOnce() {
  if (pollState.running) {
    return { processed: 0, added: 0, skipped: true, reason: "poll already running" };
  }

  pollState.running = true;
  pollState.lastStartAtMs = nowMs();

  try {
  const pollStartedAt = nowMs();
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

  console.log(`[DEBUG] Found ${items.length} tracks in library`);
  if (items.length > 0) {
    console.log(`[DEBUG] Newest track timestamp: ${Math.max(...items.map(x => x.addedAtMs))}`);
    console.log(`[DEBUG] Oldest track timestamp: ${Math.min(...items.map(x => x.addedAtMs))}`);
  }

  const lastSeen = Number(s.lastSeenAddedAtMs ?? 0);
  console.log(`[DEBUG] Last seen timestamp: ${lastSeen}`);
  const newOnes = items.filter(x => x.addedAtMs > lastSeen);
  console.log(`[DEBUG] Found ${newOnes.length} new tracks`);
  if (items.length) setState({ lastSeenAddedAtMs: Math.max(...items.map(x => x.addedAtMs)) });

  if (newOnes.length === 0) return { processed: 0, added: 0 };

  const ids = newOnes.map(x => x.track.id);
  const afMap = await getAudioFeatures(accessToken, ids);

  s = loadState();
  const processedTracks = s.processedTracks ?? {}; // { [trackId]: processedAtMs }
  const dedupWindowMs = DEDUP_MINUTES * 60_000;

  let processed = 0;
  let added = 0;

  for (const it of newOnes) {
    const tr = it.track;
    const prev = processedTracks[tr.id];
    if (prev && nowMs() - prev < dedupWindowMs) continue;

    console.log(`[DEBUG] Processing track: ${tr.name} by ${tr.artists[0].name}`);

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
        mode: CLASSIFIER_MODE,
        threshold: CLASSIFIER_THRESHOLD,
        thresholdsByVibe: loadThresholdsByVibe()
      }
    );

    const scored = diagnostics.mergedScores;
    const winners = diagnostics.winners;
    let finalKeys = diagnostics.finalKeys;

    if (MULTI_LABEL_ENABLED) {
      const top = scored[0]?.score ?? 0;
      const multi = scored
        .filter(s => s.key !== "uncertain")
        .filter(s => (top - s.score) <= MULTI_LABEL_MARGIN)
        .slice(0, MULTI_LABEL_MAX)
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

    console.log(`[DEBUG] Classified track into playlists: ${finalKeys.join(', ')}`);

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
      atMs: nowMs(),
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
        console.warn(`[DEBUG] No playlist ID found for key: ${key}`);
        continue;
      }
      console.log(`[DEBUG] Attempting to add track to playlist: ${key} (${playlistId})`);
      
      // Log the track that should be added (even if we fail)
      console.log(`[TRACK_LOG] Would add "${tr.name}" by ${tr.artists[0].name} to playlist "${key}"`);
      
      try {
        await addTrackToPlaylist(accessToken, playlistId, tr.uri);
        added += 1;
        console.log(`[DEBUG] Successfully added track to playlist: ${key}`);
      } catch (error) {
        console.warn(`Failed to add track to playlist ${key}: ${error.message}`);
        // Don't increment added counter, but continue processing
      }
    }

    processedTracks[tr.id] = nowMs();
    processed += 1;
  }

  // prune old processed entries (keep it from growing forever)
  const pruneBefore = nowMs() - 30 * 24 * 60_000; // 30 days
  for (const [id, ts] of Object.entries(processedTracks)) {
    if (typeof ts === "number" && ts < pruneBefore) delete processedTracks[id];
  }

  setState({ processedTracks });

  const pollFinishedAt = nowMs();
  await logPollSummary({
    pollStartedAt,
    pollFinishedAt,
    processed,
    added,
    totalLibraryTracksSeen: items.length,
    newTracksDetected: newOnes.length,
    dedupMinutes: DEDUP_MINUTES,
    threshold: CLASSIFIER_THRESHOLD,
    classifierMode: CLASSIFIER_MODE
  });

  appendAnalyticsPoll({
    atMs: pollFinishedAt,
    processed,
    added,
    newTracksDetected: newOnes.length,
    totalLibraryTracksSeen: items.length,
    classifierMode: CLASSIFIER_MODE,
    threshold: CLASSIFIER_THRESHOLD
  });

  pollState.lastFinishAtMs = pollFinishedAt;
  pollState.lastResult = { processed, added };
  pollState.consecutiveFailures = 0;
  pollState.lastError = null;

  return { processed, added };
  } catch (error) {
    pollState.lastFinishAtMs = nowMs();
    pollState.lastResult = null;
    pollState.consecutiveFailures += 1;
    pollState.lastError = error?.message ?? String(error);
    if (String(pollState.lastError).includes("invalid_grant") || String(pollState.lastError).toLowerCase().includes("reauth")) {
      authState.healthy = false;
      authState.lastCheckedAtMs = nowMs();
      authState.lastError = pollState.lastError;
    }
    throw error;
  } finally {
    pollState.running = false;
  }
}

function computeRedirectUri(req) {
  const forced = (process.env.SPOTIFY_REDIRECT_URI || "").trim();
  if (forced) return forced;

  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${PORT}`;
  const protoHdr = req.headers["x-forwarded-proto"] || "http";
  const proto = String(protoHdr).split(",")[0].trim() || "http";
  return `${proto}://${host}/callback`;
}

function html(s) {
  return `<!doctype html>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="theme-color" content="#06331D" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Vibe Router" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/icon.svg" />
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
    :root{
      --bg:#060a08; --panel:#0b110f; --panel-2:#0f1714; --text:#daf7e9; --muted:#8dc4aa; --line:#1e3e2f;
      --mint:#8DC4AA; --sage:#669A79; --foam:#DAF7E9; --forest:#1E5E3F; --deep:#06331D;
      --space-1:4px; --space-2:8px; --space-3:16px; --space-4:32px; --space-5:48px;
      --fs-1:16px; --fs-2:20px; --fs-3:24px; --fs-4:32px; --fs-5:48px;
      --radius:16px;
    }
    *{box-sizing:border-box}
    body{margin:0;color:var(--text);font-family:'Space Grotesk',ui-sans-serif,system-ui;background:radial-gradient(1100px 700px at -10% -10%,#11332233,transparent 60%),radial-gradient(900px 600px at 110% -5%,#0c3b2744,transparent 55%),linear-gradient(180deg,#050806,#090f0c)}
    .wrap{max-width:1280px;margin:0 auto;padding:var(--space-4)}
    .main-layout{display:grid;grid-template-columns:260px 1fr;gap:var(--space-3)}
    .main-content{display:grid;gap:var(--space-3)}
    .hero{padding:var(--space-4);border:1px solid #234535;background:linear-gradient(160deg,rgba(11,17,15,.9),rgba(6,12,10,.85));backdrop-filter:blur(14px);border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
    .title{font-size:var(--fs-4);font-weight:700;letter-spacing:-.02em;margin:0 0 var(--space-2)}
    .sub{color:var(--mint);font-size:var(--fs-1);margin:0}
    .btns{display:flex;flex-wrap:wrap;gap:var(--space-2);margin-top:var(--space-3)}
    .btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 14px;border-radius:12px;border:1px solid #2c5743;background:#0f1714;color:var(--foam);text-decoration:none;font-weight:600;transition:transform .18s ease,border-color .18s ease,background .18s ease,box-shadow .22s ease;cursor:pointer}
    .btn:hover{transform:translateY(-1px);border-color:#3a7458;background:#13211c;box-shadow:0 8px 24px rgba(30,94,63,.25)}
    .btn:active{transform:translateY(0)}
    .btn.primary{background:linear-gradient(180deg,var(--sage),var(--forest));border-color:#2c6b4d;color:#f5fffa}
    select,button{font-family:'Space Grotesk',ui-sans-serif,system-ui}
    .input{min-height:44px;padding:0 12px;border-radius:10px;border:1px solid #2c5743;background:#0f1714;color:var(--foam)}
    .chip{padding:8px 12px;border:1px solid #2c5743;border-radius:999px;background:#0f1714;color:#daf7e9}
    .dd{position:relative;display:inline-block;min-width:220px}
    .dd-trigger{min-height:44px;width:100%;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-radius:10px;border:1px solid #2c5743;background:#0f1714;color:#daf7e9;cursor:pointer}
    .dd-menu{position:absolute;left:0;top:46px;z-index:40;min-width:260px;max-height:240px;overflow:auto;padding:6px;border-radius:12px;border:1px solid #2c5743;background:#0a120f;box-shadow:0 18px 40px rgba(0,0,0,.35);display:none}
    .dd.open .dd-menu{display:block;animation:grow .15s ease}
    .dd-item{width:100%;text-align:left;padding:10px;border:0;border-radius:8px;background:transparent;color:#daf7e9;cursor:pointer;min-height:44px}
    .dd-item:hover{background:#142019}
    .grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:var(--space-3);margin-top:var(--space-3)}
    .chart{overflow:auto}
    .card{border:1px solid #1f3d31;background:linear-gradient(180deg,var(--panel),var(--panel-2));border-radius:var(--radius);padding:var(--space-3);box-shadow:0 8px 26px rgba(0,0,0,.22);transition:transform .22s ease,border-color .22s ease}
    .card:hover{transform:translateY(-1px);border-color:#2a5744}
    .kpi{grid-column:span 12}.left{grid-column:span 6}.right{grid-column:span 6}.full{grid-column:span 12}
    .h{margin:0 0 var(--space-2);font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--mint)}
    pre{white-space:pre-wrap;word-break:break-word;background:#0a120f;border:1px solid #1f3d31;padding:var(--space-3);border-radius:12px;color:#c5ead8;line-height:1.5;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px}
    .chart{background:#0a120f;border:1px solid #1f3d31;border-radius:12px;padding:12px;min-height:220px}
    .bars .row{display:grid;grid-template-columns:180px 1fr 44px;gap:8px;align-items:center;margin:8px 0;font-size:14px}
    .bars .track{height:10px;background:#0f1e18;border-radius:999px;overflow:hidden}
    .bars .fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--sage),var(--mint));transform-origin:left;animation:grow .7s ease both}
    .tiny{font-size:12px;color:var(--mint)}
    @keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
    @keyframes pulseGlow{0%,100%{box-shadow:0 0 0 rgba(141,196,170,0)}50%{box-shadow:0 0 24px rgba(141,196,170,.12)}}
    #toast{min-height:22px;animation:pulseGlow 2s ease infinite}
    @media (max-width:1100px){
      .wrap{padding:16px}
      .main-layout{grid-template-columns:1fr}
      .main-layout > .card{position:static !important;top:auto !important}
      .grid{grid-template-columns:1fr}
      .left,.right,.full,.kpi{grid-column:span 1}
    }
    @media (max-width:768px){
      .wrap{padding:12px}
      .hero{padding:16px;border-radius:14px}
      .title{font-size:24px}
      .btns{gap:8px}
      .btn{min-height:44px;padding:0 12px;font-size:14px}
      .card{padding:12px;border-radius:12px}
      .h{font-size:11px}
      .bars .row{grid-template-columns:120px 1fr 36px;font-size:12px}
      pre{font-size:12px;padding:10px}
      .mobile-tabs{display:grid;grid-auto-flow:column;grid-auto-columns:max-content;overflow:auto;gap:8px;padding-bottom:4px}
    }
  </style>
  <body><div class="wrap">${s}</div>
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      });
    }
  </script>
  </body>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (u.pathname === "/manifest.webmanifest") {
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      res.end(JSON.stringify({
        name: "Spotify Vibe Router",
        short_name: "Vibe Router",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#060a08",
        theme_color: "#06331D",
        description: "Automated Spotify vibe routing dashboard",
        icons: [
          { src: "/icon.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any maskable" },
          { src: "/icon.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any maskable" }
        ]
      }));
      return;
    }

    if (u.pathname === "/sw.js") {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-cache" });
      res.end(`
        const CACHE = 'vibe-router-shell-v1';
        const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];
        self.addEventListener('install', (e) => {
          e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
        });
        self.addEventListener('activate', (e) => {
          e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
        });
        self.addEventListener('fetch', (e) => {
          if (e.request.method !== 'GET') return;
          e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
        });
      `);
      return;
    }

    if (u.pathname === "/icon.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
      res.end(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='#8DC4AA'/><stop offset='100%' stop-color='#1E5E3F'/></linearGradient></defs><rect width='512' height='512' rx='96' fill='#060a08'/><circle cx='256' cy='256' r='182' fill='url(#g)' opacity='0.18'/><path d='M130 300c60-72 192-72 252 0' stroke='#DAF7E9' stroke-width='28' fill='none' stroke-linecap='round'/><path d='M164 256c44-52 140-52 184 0' stroke='#8DC4AA' stroke-width='24' fill='none' stroke-linecap='round'/><circle cx='256' cy='338' r='24' fill='#DAF7E9'/></svg>`);
      return;
    }

    if (u.pathname === "/") {
      const s = loadState();
      const hasToken = Boolean(s.token?.access_token);
      const healthy = hasToken ? await updateAuthHealth() : false;
      const authed = hasToken && healthy;
      const needsReauth = hasToken && !healthy;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        html(`
          <section class="hero">
            <h1 class="title">Spotify Vibe Router</h1>
            <p class="sub">A single-pane control app for automated Spotify vibe routing.</p>
            <p class="sub" style="margin-top:6px">Status: <b style="color:${authed ? "#22c55e" : "#f59e0b"}">${authed ? "authenticated" : "not authenticated"}</b></p>
            ${needsReauth ? '<p class="sub" style="margin-top:6px;color:#f59e0b">Session expired/revoked. Please reconnect Spotify.</p>' : ''}
            <div class="btns">
              ${authed ? "" : '<a class="btn primary" href="/login">Connect Spotify</a>'}
              <a class="btn" id="btnRunOnce" href="#" onclick="runOnce();return false;">Run Once</a>
              <a class="btn" id="btnDiagnose" href="#" onclick="diagnose();return false;">Audio Diagnose</a>
              <a class="btn" id="btnCalibrate" href="#" onclick="calibrate();return false;">Calibrate Confidence</a>
            </div>
            <div id="toast" class="sub" style="margin-top:8px"></div>
          </section>

          <section class="main-layout">
            <div class="card" style="position:sticky;top:14px;height:max-content">
              <h3 class="h">Navigation</h3>
              <div class="sub" style="margin-bottom:10px">Single-page control surface</div>
              <div class="btns mobile-tabs" style="display:grid;grid-template-columns:1fr;gap:8px;margin-top:0">
                <a class="btn" href="#" data-tab="overview" onclick="showTab('overview');return false;">Overview</a>
                <a class="btn" href="#" data-tab="analytics" onclick="showTab('analytics');return false;">Rewind Analytics</a>
                <a class="btn" href="#" data-tab="logs" onclick="showTab('logs');return false;">Server Logs</a>
                <a class="btn" href="#" data-tab="system" onclick="showTab('system');return false;">System Info</a>
              </div>
            </div>

            <div class="main-content" style="display:grid;gap:14px">
              <div id="tab-overview" class="tabpanel card">
                <div class="card kpi"><h3 class="h">System KPI</h3><div id="kpis"></div></div>
                <div class="grid">
                  <div class="card left"><h3 class="h">Playlist Distribution (All)</h3><div id="bars"></div></div>
                  <div class="card right"><h3 class="h">Quality Snapshot</h3><pre id="quality"></pre></div>
                  <div class="card left"><h3 class="h">Confidence Distribution</h3><div id="confDistOverview"></div></div>
                  <div class="card right"><h3 class="h">Margin Distribution</h3><div id="marginDistOverview"></div></div>
                  <div class="card full"><h3 class="h">Low Confidence Queue</h3><div id="queue"></div></div>
                  <div class="card full"><h3 class="h">Recent Poll Trend</h3><pre id="polls"></pre></div>
                </div>
              </div>

              <div id="tab-analytics" class="tabpanel card" style="display:none">
                <h3 class="h">Spotify Rewind Style</h3>
                <div id="analyticsLoading" class="tiny" style="display:none;margin-bottom:8px;color:#8DC4AA">Loading analytics…</div>
                <div class="card" style="margin-bottom:10px">
                  <div class="h">API Usage Mode</div>
                  <div class="tiny" style="margin-top:6px">Low API mode avoids automatic deep refreshes (rewind/compare). Use manual buttons.</div>
                  <div class="btns" style="margin-top:8px">
                    <a class="btn" href="#" id="btnToggleLowApi" onclick="toggleLowApiMode();return false;">Low API: OFF</a>
                    <a class="btn" href="#" onclick="refreshAnalytics();return false;">Refresh Rewind</a>
                    <a class="btn" href="#" onclick="refreshCompare();return false;">Refresh Compare</a>
                  </div>
                </div>
                <div class="card" style="margin-bottom:10px">
                  <div class="h">Compare Periods</div>
                  <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px">
                    <div>
                      <div class="tiny">Period A</div>
                      <select id="cmpPresetA" class="input" style="width:100%;margin-top:4px">
                        <option value="last90">Last 90 days</option>
                        <option value="thisYear">This year</option>
                        <option value="lastYear">Last year</option>
                        <option value="prev90">Previous 90 days</option>
                      </select>
                    </div>
                    <div>
                      <div class="tiny">Period B</div>
                      <select id="cmpPresetB" class="input" style="width:100%;margin-top:4px">
                        <option value="prev90">Previous 90 days</option>
                        <option value="last90">Last 90 days</option>
                        <option value="thisYear">This year</option>
                        <option value="lastYear">Last year</option>
                      </select>
                    </div>
                  </div>
                  <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-top:8px">
                    <div><div class="tiny">A from</div><input id="cmpFromA" type="date" class="input"/></div>
                    <div><div class="tiny">A to</div><input id="cmpToA" type="date" class="input"/></div>
                    <div><div class="tiny">B from</div><input id="cmpFromB" type="date" class="input"/></div>
                    <div><div class="tiny">B to</div><input id="cmpToB" type="date" class="input"/></div>
                    <a class="btn" href="#" onclick="refreshCompare();return false;">Run Compare</a>
                    <a class="btn" href="#" onclick="exportCompareCsv();return false;">Export CSV</a>
                  </div>
                </div>
                <div class="grid">
                  <div class="card left"><h3 class="h">Songs Added by Year</h3><div id="rewindYear" class="chart"></div></div>
                  <div class="card right"><h3 class="h">Current Year Monthly Pattern</h3><div id="rewindMonth" class="chart"></div></div>
                  <div class="card left"><h3 class="h">Top Artists (latest year)</h3><div id="rewindArtists" class="chart bars"></div></div>
                  <div class="card right"><h3 class="h">Top Tracks (latest year)</h3><div id="rewindTracks" class="chart bars"></div></div>
                  <div class="card left"><h3 class="h">Journey Milestones</h3><div id="rewindJourney" class="chart"></div></div>
                  <div class="card right"><h3 class="h">Deep Pattern Metrics</h3><div id="rewindPatterns" class="chart"></div></div>
                  <div class="card full"><h3 class="h">Vibe Drift Timeline (last 12 months)</h3><div id="rewindVibeDrift" class="chart"></div></div>
                  <div class="card full"><h3 class="h">Vibe Drift Drilldown</h3><div class="btns" style="margin-top:0;margin-bottom:8px"><a class="btn" href="#" onclick="exportVibeDrillCsv();return false;">Export Vibe CSV</a></div><div id="rewindVibeDrill" class="chart"></div></div>
                  <div class="card full"><h3 class="h">Year Audio Profile (latest year)</h3><div id="rewindAudio" class="chart"></div></div>
                  <div class="card full"><h3 class="h">Compare Snapshot (A vs B)</h3><div id="rewindCompare" class="chart"></div></div>
                  <div class="card full"><h3 class="h">Compare Drilldown</h3><div id="rewindDrill" class="chart"></div></div>
                  <div class="card full"><h3 class="h">Behavior Summary</h3><div id="rewindDetail" class="chart"></div></div>
                </div>
              </div>

              <div id="tab-logs" class="tabpanel card" style="display:none">
                <h3 class="h">Server Logs</h3>
                <div class="btns" style="margin-top:0;margin-bottom:8px">
                  <a class="btn" href="#" id="btnClearLogs" onclick="clearLogs();return false;">Clear logs</a>
                </div>
                <pre id="liveLogs">Loading...</pre>
              </div>

              <div id="tab-system" class="tabpanel card" style="display:none">
                <h3 class="h">System Info</h3>
                <pre id="systemInfo">Loading...</pre>
              </div>
            </div>
          </section>

          <script>
            const vibes = ${JSON.stringify(VIBES.map(v => v.key))};
            let currentTab = 'overview';
            let compareState = null;
            let compareLastAt = 0;
            let vibeDrillRows = [];
            let lowApiMode = localStorage.getItem('lowApiMode') === '1';

            function showTab(name){
              currentTab = name;
              document.querySelectorAll('.tabpanel').forEach(el=>el.style.display='none');
              const el = document.getElementById('tab-'+name); if(el) el.style.display='block';
              document.querySelectorAll('[data-tab]').forEach(b=>{
                const active = b.getAttribute('data-tab')===name;
                b.style.borderColor = active ? '#2c6b4d' : '#1e3e2f';
                b.style.background = active ? 'linear-gradient(180deg,#163326,#0f1714)' : '#0f1714';
                b.style.color = active ? '#daf7e9' : '#b7dbc8';
              });
            }

            function toast(msg, ok=true){
              const el=document.getElementById('toast'); if(!el) return;
              el.style.color=ok?'#22c55e':'#f59e0b'; el.textContent=msg;
              setTimeout(()=>{ if(el.textContent===msg) el.textContent=''; }, 5000);
            }

            function updateLowApiUi(){
              const b=document.getElementById('btnToggleLowApi');
              if(!b) return;
              b.textContent='Low API: '+(lowApiMode?'ON':'OFF');
              b.style.borderColor = lowApiMode ? '#2c6b4d' : '#1e3e2f';
              b.style.background = lowApiMode ? 'linear-gradient(180deg,#163326,#0f1714)' : '#0f1714';
              b.style.color = lowApiMode ? '#daf7e9' : '#b7dbc8';
            }

            function toggleLowApiMode(){
              lowApiMode = !lowApiMode;
              localStorage.setItem('lowApiMode', lowApiMode ? '1' : '0');
              updateLowApiUi();
              toast('Low API mode '+(lowApiMode?'enabled':'disabled'), true);
            }

            function buildSelect(){
              const root=document.createElement('div');
              root.className='dd';
              const trigger=document.createElement('button');
              trigger.type='button';
              trigger.className='dd-trigger';
              trigger.innerHTML='<span data-value>Select vibes</span><span>▾</span>';

              const menu=document.createElement('div');
              menu.className='dd-menu';
              const selected=new Set();

              function refreshLabel(){
                const arr=[...selected];
                trigger.querySelector('[data-value]').textContent = arr.length ? (arr.length===1 ? arr[0] : (arr.length+' selected')) : 'Select vibes';
              }

              for(const v of vibes){
                const item=document.createElement('button');
                item.type='button';
                item.className='dd-item';
                item.innerHTML='<span style="display:flex;align-items:center;gap:8px"><input type="checkbox" /> <span>'+v+'</span></span>';
                const cb=item.querySelector('input');
                item.onclick=(e)=>{
                  e.preventDefault();
                  cb.checked=!cb.checked;
                  if(cb.checked) selected.add(v); else selected.delete(v);
                  refreshLabel();
                };
                menu.appendChild(item);
              }

              trigger.onclick=(e)=>{ e.preventDefault(); root.classList.toggle('open'); };
              document.addEventListener('click',(e)=>{ if(!root.contains(e.target)) root.classList.remove('open'); });

              root.appendChild(trigger);
              root.appendChild(menu);
              root.getValues=()=>{
                const arr=[...selected];
                return arr.length ? arr : [vibes[0]];
              };
              return root;
            }

            async function labelTrack(trackId, vibeKey){
              await fetch('/api/label-track?trackId='+encodeURIComponent(trackId)+'&vibeKey='+encodeURIComponent(vibeKey));
              await refreshOverview();
            }

            async function labelTrackMulti(trackId, vibeKeys){
              const qs = encodeURIComponent((vibeKeys||[]).join(','));
              await fetch('/api/label-track-multi?trackId='+encodeURIComponent(trackId)+'&vibeKeys='+qs);
              await refreshOverview();
            }

            function lineTop(items, n=3){ return (items||[]).slice(0,n).map(x=>x.key+'('+x.count+')').join(', '); }

            async function runOnce(){
              const r = await fetch('/run-once').then(x=>x.json()).catch(()=>({ok:false,error:'request failed'}));
              if(!r.ok){ toast('Run failed: '+(r.error||'unknown'), false); return; }
              if((r.processed||0)===0) toast('Run complete: 0 new songs found', false);
              else toast('Run complete: processed '+r.processed+' / added '+r.added, true);
              await refreshAll();
            }

            async function diagnose(){
              const r = await fetch('/diagnose-audio-features').then(x=>x.json()).catch(()=>({ok:false,error:'request failed'}));
              if(r && typeof r.status !== 'undefined') toast('Audio diagnose status: '+r.status, r.status===200);
              else toast('Audio diagnose failed', false);
            }

            async function calibrate(){
              const r = await fetch('/api/calibrate-thresholds').then(x=>x.json()).catch(()=>({ok:false,error:'request failed'}));
              if(r.ok) toast('Calibrated '+Object.keys(r.thresholds||{}).length+' vibe thresholds', true);
              else toast('Calibration failed', false);
              await refreshSystem();
            }

            async function refreshOverview(){
              const [a,q,sys] = await Promise.all([
                fetch('/api/analytics').then(x=>x.json()),
                fetch('/api/low-confidence').then(x=>x.json()),
                fetch('/api/system-info').then(x=>x.json())
              ]);
              const s=a.summary||{};
              const cb=s.confidenceBands||{};
              const rs=sys.spotifyRateState||{};
              const ps=sys.pollState||{};
              const kpis='Polls: '+(s.totalPolls||0)+' | Classified: '+(s.totalClassified||0)+' | Conf(H/M/L): '+(cb.high||0)+'/'+(cb.medium||0)+'/'+(cb.low||0)+' | 429s: '+(rs.rate429||0)+' | Retries: '+(rs.retries||0)+' | Poll: '+(ps.running?'running':'idle')+' | Labeled: '+((a.quality&&a.quality.labeledCount)||0)+' | Top1(labeled): '+(((a.quality&&a.quality.top1AccuracyOnLabeled)==null)?'n/a':(a.quality.top1AccuracyOnLabeled*100).toFixed(1)+'%');
              const limitedRecently = rs.lastRateLimitAtMs && (Date.now() - rs.lastRateLimitAtMs < 5*60*1000);
              const recovering = limitedRecently && !ps.running;
              const badge = limitedRecently ? (recovering ? '<span class="chip" style="border-color:#2c6b4d;background:#13231b">Status: Recovering</span>' : '<span class="chip" style="border-color:#2c6b4d;background:#183026">Status: Rate Limited</span>') : '<span class="chip">Status: Healthy</span>';
              const k=document.getElementById('kpis'); if(k) k.innerHTML='<div style="display:flex;flex-wrap:wrap;gap:8px">'+badge+kpis.split(' | ').map(x=>'<span class="chip">'+x+'</span>').join('')+'</div>';

              const vc=s.vibeCounts||{};
              const ordered=vibes.map(v=>[v, vc[v]||0]);
              const extras=Object.entries(vc).filter(([k])=>!vibes.includes(k));
              const entries=[...ordered, ...extras].sort((x,y)=>y[1]-x[1]);
              const max=Math.max(1,...entries.map(e=>e[1]));
              const bars=entries.map(([k,v])=>{
                const w=Math.max(2,Math.round((v/max)*100));
                return '<div class="row"><div>'+k+'</div><div class="track"><div class="fill" style="width:'+w+'%"></div></div><div>'+v+'</div></div>';
              }).join('') || '<div class="tiny">No data</div>';
              const b=document.getElementById('bars'); if(b) b.innerHTML='<div class="bars">'+bars+'</div>';

              const tracks=(a.tracks||[]).slice(-500);
              const bands={high:0,medium:0,low:0};
              const margins=[0,0,0,0,0];
              for(const t of tracks){
                if(t.confidenceBand && bands[t.confidenceBand]!==undefined) bands[t.confidenceBand]++;
                const m=Number(t.margin||0);
                if(m<0.1) margins[0]++; else if(m<0.2) margins[1]++; else if(m<0.3) margins[2]++; else if(m<0.4) margins[3]++; else margins[4]++;
              }
              const maxBand=Math.max(1,bands.high,bands.medium,bands.low);
              const cd=document.getElementById('confDistOverview'); if(cd){
                cd.innerHTML='<div class="bars">'+['high','medium','low'].map(k=>{
                  const w=Math.max(2,Math.round((bands[k]/maxBand)*100));
                  const color=(k==='high'?'#8DC4AA':k==='medium'?'#669A79':'#1E5E3F');
                  return '<div class="row"><div>'+k+'</div><div class="track"><div class="fill" style="width:'+w+'%;background:'+color+'"></div></div><div>'+bands[k]+'</div></div>';
                }).join('')+'</div>';
              }
              const labels=['0-0.1','0.1-0.2','0.2-0.3','0.3-0.4','0.4+'];
              const maxM=Math.max(1,...margins);
              const md=document.getElementById('marginDistOverview'); if(md){
                md.innerHTML='<div class="bars">'+labels.map((lbl,i)=>{
                  const w=Math.max(2,Math.round((margins[i]/maxM)*100));
                  return '<div class="row"><div>'+lbl+'</div><div class="track"><div class="fill" style="width:'+w+'%;background:#1E5E3F"></div></div><div>'+margins[i]+'</div></div>';
                }).join('')+'</div>';
              }

              const ql=document.getElementById('quality'); if(ql) ql.textContent=JSON.stringify(a.quality||{}, null, 2);
              const pl=document.getElementById('polls'); if(pl) pl.textContent=(a.polls||[]).slice(-30).map(x=>new Date(x.atMs).toLocaleString()+' | new='+x.newTracksDetected+' processed='+x.processed+' added='+x.added).join('\\n') || 'No polls yet';

              const qel=document.getElementById('queue'); if(qel){
                qel.innerHTML='';
                for(const t of (q.items||[]).slice(0,20)){
                  const card=document.createElement('div');
                  card.style.cssText='padding:10px;border:1px solid #1f3d31;border-radius:10px;margin:8px 0;background:#0a120f';
                  card.innerHTML='<b>'+(t.trackName||'')+'</b> — '+(t.artist||'')+' <small>(score '+(t.topScore==null?'n/a':t.topScore)+')</small><br/>pred: '+(((t.selectedVibes||[])[0])||'?');
                  const row=document.createElement('div'); row.style.cssText='margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
                  const sel=buildSelect(); row.appendChild(sel);
                  const btn=document.createElement('button'); btn.textContent='Save labels'; btn.className='btn';
                  btn.onclick=()=>labelTrackMulti(t.trackId, sel.getValues());
                  const done=document.createElement('button'); done.textContent='Looks good, remove'; done.className='btn';
                  done.onclick=async()=>{await fetch('/api/dismiss-low-confidence?trackId='+encodeURIComponent(t.trackId)); await refreshOverview();};
                  row.appendChild(btn); row.appendChild(done); card.appendChild(row); qel.appendChild(card);
                }
                if(!(q.items||[]).length) qel.textContent='No low-confidence items';
              }
            }

            function setAnalyticsLoading(on){
              const el=document.getElementById('analyticsLoading');
              if(el) el.style.display=on?'block':'none';
            }

            async function refreshAnalytics(){
              setAnalyticsLoading(true);
              try {
                const [r,a] = await Promise.all([
                  fetch('/api/rewind').then(x=>x.json()),
                  fetch('/api/analytics').then(x=>x.json()).catch(()=>({tracks:[]}))
                ]);
              const years=Object.entries(r.byYear||{}).sort((a,b)=>Number(a[0])-Number(b[0]));
              const yearVals=years.map(([,v])=>v.total||0);
              const maxYear=Math.max(1,...yearVals);
              const yearChart=years.map(([y,v])=>{
                const h=Math.max(8,Math.round((v.total/maxYear)*140));
                return '<div style="display:flex;flex-direction:column;align-items:center;gap:8px"><div class="tiny">'+v.total+'</div><div style="width:26px;height:'+h+'px;border-radius:10px;background:linear-gradient(180deg,#8DC4AA,#1E5E3F);animation:grow .7s ease both"></div><div class="tiny">'+y+'</div></div>';
              }).join('');
              const ry=document.getElementById('rewindYear'); if(ry) ry.innerHTML='<div style="display:flex;align-items:flex-end;gap:10px;height:190px">'+yearChart+'</div>';

              const months=Object.entries(r.byMonth||{}).sort((a,b)=>Number(a[0])-Number(b[0]));
              const mVals=months.map(([,v])=>v.total||0);
              const maxMonth=Math.max(1,...mVals);
              const monthSvgPts=months.map(([m,v],i)=>{
                const x=20+i*((320)/(Math.max(1,months.length-1))); const y=160-((v.total||0)/maxMonth)*120; return {x,y,m,total:v.total||0};
              });
              const path=monthSvgPts.map((p,i)=>(i?'L':'M')+p.x+','+p.y).join(' ');
              const dots=monthSvgPts.map(p=>'<circle cx="'+p.x+'" cy="'+p.y+'" r="4" fill="#8DC4AA"></circle><text x="'+p.x+'" y="178" text-anchor="middle" fill="#8DC4AA" font-size="10">'+p.m+'</text>').join('');
              const rm=document.getElementById('rewindMonth'); if(rm) rm.innerHTML='<svg viewBox="0 0 360 190" width="100%" height="190"><path d="'+path+'" fill="none" stroke="#8DC4AA" stroke-width="3"/><path d="'+path+' L 340,160 L 20,160 Z" fill="rgba(141,196,170,0.14)"/>'+dots+'</svg>';

              const latestYear = years.length ? years[years.length-1][0] : null;
              const latest=latestYear ? r.byYear[latestYear] : null;
              const artists=latest?.topArtists||[];
              const tracks=latest?.topTracks||[];
              const renderRows=(arr)=>{
                const mx=Math.max(1,...arr.map(x=>x.count||0));
                return '<div class="bars">'+arr.map(x=>'<div class="row"><div>'+x.key+'</div><div class="track"><div class="fill" style="width:'+Math.max(2,Math.round((x.count/mx)*100))+'%"></div></div><div>'+x.count+'</div></div>').join('')+'</div>';
              };
              const ra=document.getElementById('rewindArtists'); if(ra) ra.innerHTML=artists.length?renderRows(artists):'<div class="tiny">No data</div>';
              const rt=document.getElementById('rewindTracks'); if(rt) rt.innerHTML=tracks.length?renderRows(tracks):'<div class="tiny">No data</div>';

              const jm=document.getElementById('rewindJourney');
              if(jm){
                const milestones=(r.journey?.milestones||[]).slice(0,6);
                jm.innerHTML = milestones.length
                  ? milestones.map(x=>'<div style="padding:8px 10px;margin:6px 0;border:1px solid #1f3d31;border-radius:9px;background:#0c1612"><b>'+x.title+'</b><div class="tiny">'+x.detail+'</div></div>').join('')
                  : '<div class="tiny">No milestone data</div>';
              }

              const patt=document.getElementById('rewindPatterns');
              if(patt){
                const p=r.patterns||{};
                patt.innerHTML='<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">'+
                  '<div class="card"><div class="tiny">Discovery Rate</div><div style="font-size:24px">'+(((p.discoveryRate||0)*100).toFixed(1))+'%</div></div>'+
                  '<div class="card"><div class="tiny">Artist Diversity</div><div style="font-size:24px">'+(p.artistDiversity||0).toFixed(2)+'</div></div>'+
                  '<div class="card"><div class="tiny">Repeat Rate</div><div style="font-size:24px">'+(((p.repeatRate||0)*100).toFixed(1))+'%</div></div>'+
                  '<div class="card"><div class="tiny">Peak Month</div><div style="font-size:24px">'+(p.peakMonthLabel||'n/a')+'</div></div>'+
                '</div>';
              }

              const raud=document.getElementById('rewindAudio');
              if(raud){
                const ap=r.audioProfileByYear?.[latestYear]||null;
                if(!ap){
                  raud.innerHTML='<div class="tiny">Audio feature profile unavailable</div>';
                } else {
                  const rows=[
                    ['Energy', ap.energy],
                    ['Valence', ap.valence],
                    ['Danceability', ap.danceability],
                    ['Acousticness', ap.acousticness],
                    ['Instrumentalness', ap.instrumentalness],
                    ['Speechiness', ap.speechiness],
                    ['Liveness', ap.liveness]
                  ];
                  const bars=rows.map(([k,v])=>'<div class="row"><div>'+k+'</div><div class="track"><div class="fill" style="width:'+Math.max(2,Math.round((Number(v)||0)*100))+'%"></div></div><div>'+((Number(v)||0).toFixed(2))+'</div></div>').join('');
                  raud.innerHTML='<div class="bars">'+bars+'</div><div class="tiny" style="margin-top:8px">Tempo avg: '+(ap.tempo||0).toFixed(1)+' BPM • sample '+(ap.sampleSize||0)+' tracks</div>';
                }
              }

              const vd=document.getElementById('rewindVibeDrift');
              if(vd){
                const tracks=(a.tracks||[]).filter(t=>Number.isFinite(Number(t.addedAtMs)));
                const now=new Date();
                const monthKeys=[];
                for(let i=11;i>=0;i--){
                  const d=new Date(now.getFullYear(), now.getMonth()-i, 1);
                  const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
                  monthKeys.push(k);
                }
                const buckets=Object.fromEntries(monthKeys.map(k=>[k,{}]));
                for(const t of tracks){
                  const d=new Date(Number(t.addedAtMs));
                  const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
                  if(!buckets[k]) continue;
                  const v=(t.selectedVibes&&t.selectedVibes[0])||'unknown';
                  buckets[k][v]=(buckets[k][v]||0)+1;
                }
                const topVibes=Object.entries((a.summary&&a.summary.vibeCounts)||{}).sort((x,y)=>y[1]-x[1]).slice(0,4).map(x=>x[0]);
                const colors=['#8DC4AA','#669A79','#3D7A5F','#1E5E3F'];
                const rows=monthKeys.map(k=>{
                  const total=Object.values(buckets[k]||{}).reduce((x,y)=>x+y,0)||1;
                  const seg=topVibes.map((v,idx)=>{
                    const c=(buckets[k][v]||0); const w=Math.round((c/total)*100);
                    return '<div title="'+v+': '+c+'" style="height:14px;width:'+w+'%;background:'+colors[idx%colors.length]+'"></div>';
                  }).join('');
                  return '<div data-vibe-month="'+k+'" style="display:grid;grid-template-columns:78px 1fr 46px;align-items:center;gap:8px;margin:6px 0;cursor:pointer"><div class="tiny">'+k+'</div><div style="display:flex;border:1px solid #1f3d31;border-radius:8px;overflow:hidden">'+seg+'</div><div class="tiny">'+(total===1&&Object.keys(buckets[k]||{}).length===0?0:total)+'</div></div>';
                }).join('');

                let shiftLabel='n/a';
                let shiftVal=-1;
                for(let i=1;i<monthKeys.length;i++){
                  const p=buckets[monthKeys[i-1]]||{}; const c=buckets[monthKeys[i]]||{};
                  const pTot=Math.max(1,Object.values(p).reduce((x,y)=>x+y,0));
                  const cTot=Math.max(1,Object.values(c).reduce((x,y)=>x+y,0));
                  const keys=new Set([...Object.keys(p),...Object.keys(c)]);
                  let d=0;
                  for(const k of keys){ d += Math.abs((p[k]||0)/pTot - (c[k]||0)/cTot); }
                  if(d>shiftVal){ shiftVal=d; shiftLabel=monthKeys[i-1]+' → '+monthKeys[i]; }
                }

                vd.innerHTML='<div class="tiny" style="margin-bottom:8px">Biggest vibe shift: '+shiftLabel+' (score '+(shiftVal<0?'n/a':shiftVal.toFixed(2))+')</div>'+
                  rows+
                  '<div class="tiny" style="margin-top:8px">Legend: '+topVibes.map((v,i)=>'<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px"><span style="display:inline-block;width:10px;height:10px;background:'+colors[i%colors.length]+';border-radius:2px"></span>'+v+'</span>').join('')+'</div>';

                const tracksByMonth = {};
                for (const t of tracks) {
                  const d = new Date(Number(t.addedAtMs));
                  const mk = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
                  tracksByMonth[mk] = tracksByMonth[mk] || [];
                  const trackId = t.trackId || '';
                  tracksByMonth[mk].push({
                    date: new Date(Number(t.addedAtMs)).toISOString().slice(0,10),
                    trackName: t.trackName || '',
                    artist: t.artist || '',
                    vibe: (t.selectedVibes&&t.selectedVibes[0])||'unknown',
                    trackId,
                    url: trackId ? ('https://open.spotify.com/track/'+trackId) : ''
                  });
                }

                function renderVibeDrill(monthKey){
                  const box=document.getElementById('rewindVibeDrill'); if(!box) return;
                  const rows=(tracksByMonth[monthKey]||[]).slice().sort((x,y)=>String(y.date).localeCompare(String(x.date)));
                  vibeDrillRows=rows;
                  if(!rows.length){ box.innerHTML='<div class="tiny">No tracks for '+monthKey+'</div>'; return; }
                  box.innerHTML='<div class="tiny">Month: '+monthKey+' • '+rows.length+' tracks</div>'+
                    '<table style="width:100%;font-size:12px;margin-top:8px"><thead><tr><th align="left">Date</th><th align="left">Track</th><th align="left">Artist</th><th align="left">Vibe</th></tr></thead><tbody>'+rows.slice(0,200).map(r=>{
                      const trackCell = r.url ? ('<a href="'+r.url+'" target="_blank" rel="noopener noreferrer" style="color:#8DC4AA">'+r.trackName+'</a>') : r.trackName;
                      return '<tr><td>'+r.date+'</td><td>'+trackCell+'</td><td>'+r.artist+'</td><td>'+r.vibe+'</td></tr>';
                    }).join('')+'</tbody></table>';
                }

                vd.querySelectorAll('[data-vibe-month]').forEach(el=>{
                  el.addEventListener('click', ()=>renderVibeDrill(el.getAttribute('data-vibe-month')));
                });
                renderVibeDrill(monthKeys[monthKeys.length-1]);
              }

              const rd=document.getElementById('rewindDetail');
              if(rd){
                const activeMonths=latest?.activeMonths||0;
                const total=latest?.total||0;
                const uniqueArtists=latest?.uniqueArtists||0;
                const repeatRate=latest?.repeatRate||0;
                rd.innerHTML='<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px">'+
                  '<div class="card"><div class="h">Data Source</div><div style="font-size:20px">'+(r.source||'spotify')+'</div><div class="tiny">Scanned '+(r.scanned||0)+' saved tracks</div></div>'+
                  '<div class="card"><div class="h">Latest Year Total</div><div style="font-size:32px;line-height:1">'+total+'</div><div class="tiny">songs added</div></div>'+
                  '<div class="card"><div class="h">Unique Artists</div><div style="font-size:32px;line-height:1">'+uniqueArtists+'</div><div class="tiny">in '+latestYear+'</div></div>'+
                  '<div class="card"><div class="h">Repeat Rate</div><div style="font-size:32px;line-height:1">'+(repeatRate*100).toFixed(1)+'%</div><div class="tiny">repeat listens by year</div></div>'+
                '</div><div class="tiny" style="margin-top:8px">Active months in '+latestYear+': '+activeMonths+'</div>';
              }
              } finally {
                setAnalyticsLoading(false);
              }
            }

            function fmtPct(x){ return Number.isFinite(x) ? (x*100).toFixed(1)+'%' : 'n/a'; }
            function fmtNum(x, d=2){ return Number.isFinite(x) ? Number(x).toFixed(d) : 'n/a'; }

            async function refreshCompare(){
              const presetA=(document.getElementById('cmpPresetA')||{}).value||'last90';
              const presetB=(document.getElementById('cmpPresetB')||{}).value||'prev90';
              const fromA=(document.getElementById('cmpFromA')||{}).value||'';
              const toA=(document.getElementById('cmpToA')||{}).value||'';
              const fromB=(document.getElementById('cmpFromB')||{}).value||'';
              const toB=(document.getElementById('cmpToB')||{}).value||'';
              const qs=new URLSearchParams({presetA,presetB,fromA,toA,fromB,toB,limit:'200'}).toString();
              const j=await fetch('/api/rewind-compare?'+qs).then(x=>x.json()).catch(()=>({ok:false,error:'request failed'}));
              compareState=j;
              compareLastAt = Date.now();
              const cmp=document.getElementById('rewindCompare');
              if(cmp){
                if(!j.ok){ cmp.innerHTML='<div class="tiny">Compare failed: '+(j.error||'unknown')+'</div>'; }
                else {
                  const a=j.summaryA||{}; const b=j.summaryB||{}; const d=j.deltas||{};
                  const valFor=(obj,k)=> (k==='energy'||k==='valence'||k==='danceability'||k==='tempo') ? (obj.audio||{})[k] : obj[k];
                  const card=(k,label,fmt=(x)=>fmtNum(x,2))=>{
                    const av=valFor(a,k); const bv=valFor(b,k); const delta=d[k]?.abs;
                    const up=Number(delta)>=0;
                    return '<div class="card" data-drill="'+k+'" style="cursor:pointer"><div class="tiny">'+label+'</div><div style="font-size:20px">'+fmt(av)+' <span class="tiny">vs '+fmt(bv)+'</span></div><div style="color:'+(up?'#22c55e':'#f59e0b')+'">'+(Number.isFinite(delta)?((up?'+':'')+fmt(delta)):'n/a')+'</div></div>';
                  };
                  cmp.innerHTML='<div class="tiny">A: '+j.rangeA.label+' ('+j.rangeA.from+' → '+j.rangeA.to+') • B: '+j.rangeB.label+' ('+j.rangeB.from+' → '+j.rangeB.to+')</div>'+
                    '<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:8px">'+
                    card('total','Total Adds',(x)=>String(Math.round(Number(x)||0)))+
                    card('discoveryRate','Discovery Rate',(x)=>fmtPct(x))+
                    card('repeatRate','Repeat Rate',(x)=>fmtPct(x))+
                    card('artistDiversity','Artist Diversity',(x)=>fmtNum(x,3))+
                    card('energy','Energy',(x)=>fmtNum(x,3))+
                    card('valence','Valence',(x)=>fmtNum(x,3))+
                    card('danceability','Danceability',(x)=>fmtNum(x,3))+
                    card('tempo','Tempo',(x)=>fmtNum(x,1))+
                    '</div>';
                  cmp.querySelectorAll('[data-drill]').forEach(el=>el.addEventListener('click',()=>renderDrill(el.getAttribute('data-drill'))));
                }
              }
              renderDrill('total');
            }

            function renderDrill(metric){
              const el=document.getElementById('rewindDrill'); if(!el) return;
              const j=compareState;
              if(!j || !j.ok){ el.innerHTML='<div class="tiny">No compare data yet</div>'; return; }
              const rowsA=(j.rowsA||[]); const rowsB=(j.rowsB||[]);
              const row=(r)=>{
                const url = r.trackId ? ('https://open.spotify.com/track/'+r.trackId) : '';
                const trackCell = url ? ('<a href="'+url+'" target="_blank" rel="noopener noreferrer" style="color:#8DC4AA">'+r.track+'</a>') : r.track;
                return '<tr><td>'+String(r.addedAt||'').slice(0,10)+'</td><td>'+trackCell+'</td><td>'+r.artist+'</td></tr>';
              };
              el.innerHTML='<div class="tiny">Drilldown metric: '+metric+' (showing recent rows)</div>'+
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px">'+
                '<div><div class="h">Period A ('+(rowsA.length||0)+')</div><table style="width:100%;font-size:12px"><thead><tr><th align="left">Date</th><th align="left">Track</th><th align="left">Artist</th></tr></thead><tbody>'+rowsA.slice(0,80).map(row).join('')+'</tbody></table></div>'+
                '<div><div class="h">Period B ('+(rowsB.length||0)+')</div><table style="width:100%;font-size:12px"><thead><tr><th align="left">Date</th><th align="left">Track</th><th align="left">Artist</th></tr></thead><tbody>'+rowsB.slice(0,80).map(row).join('')+'</tbody></table></div>'+
                '</div>';
            }

            function exportCompareCsv(){
              const j=compareState; if(!j || !j.ok) return toast('No compare data to export', false);
              const out=['period,date,track,artist,spotify_url'];
              for(const r of (j.rowsA||[])) {
                const url = r.trackId ? ('https://open.spotify.com/track/'+r.trackId) : '';
                out.push(['A', String(r.addedAt||'').slice(0,10), '"'+String(r.track||'').replaceAll('"','""')+'"', '"'+String(r.artist||'').replaceAll('"','""')+'"', '"'+url+'"'].join(','));
              }
              for(const r of (j.rowsB||[])) {
                const url = r.trackId ? ('https://open.spotify.com/track/'+r.trackId) : '';
                out.push(['B', String(r.addedAt||'').slice(0,10), '"'+String(r.track||'').replaceAll('"','""')+'"', '"'+String(r.artist||'').replaceAll('"','""')+'"', '"'+url+'"'].join(','));
              }
              const blob=new Blob([out.join('\\n')], {type:'text/csv;charset=utf-8;'});
              const url=URL.createObjectURL(blob);
              const a=document.createElement('a'); a.href=url; a.download='rewind-compare.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
              toast('Exported rewind-compare.csv', true);
            }

            function exportVibeDrillCsv(){
              if(!vibeDrillRows.length) return toast('No vibe drill data to export', false);
              const out=['date,track,artist,vibe,spotify_url'];
              for(const r of vibeDrillRows){
                out.push([
                  r.date || '',
                  '"'+String(r.trackName||'').replaceAll('"','""')+'"',
                  '"'+String(r.artist||'').replaceAll('"','""')+'"',
                  '"'+String(r.vibe||'').replaceAll('"','""')+'"',
                  '"'+String(r.url||'').replaceAll('"','""')+'"'
                ].join(','));
              }
              const blob=new Blob([out.join('\\n')], {type:'text/csv;charset=utf-8;'});
              const url=URL.createObjectURL(blob);
              const a=document.createElement('a'); a.href=url; a.download='vibe-drift-drilldown.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
              toast('Exported vibe-drift-drilldown.csv', true);
            }

            async function refreshLogs(){ 

              const j = await fetch('/api/logs').then(x=>x.json()).catch(()=>({lines:['failed to load logs']}));
              const el=document.getElementById('liveLogs'); if(el) el.textContent=(j.lines||[]).join('\\n');
            }

            async function clearLogs(){
              const r = await fetch('/api/logs/clear').then(x=>x.json()).catch(()=>({ok:false}));
              if(r.ok) toast('Logs cleared', true); else toast('Failed to clear logs', false);
              await refreshLogs();
            }

            async function refreshSystem(){
              const j = await fetch('/api/system-info').then(x=>x.json()).catch(()=>({error:'failed'}));
              const el=document.getElementById('systemInfo'); if(el) el.textContent=JSON.stringify(j, null, 2);
            }

            async function refreshAll(){
              // Fast panels first so UI doesn't look empty while deeper analytics loads.
              await Promise.allSettled([refreshOverview(), refreshLogs(), refreshSystem()]);
              if (!lowApiMode) {
                refreshAnalytics().catch(()=>{});
                refreshCompare().catch(()=>{});
              }
            }

            const b1=document.getElementById('btnRunOnce'); if(b1) b1.addEventListener('click', (e)=>{e.preventDefault(); runOnce();});
            const b2=document.getElementById('btnDiagnose'); if(b2) b2.addEventListener('click', (e)=>{e.preventDefault(); diagnose();});
            const b3=document.getElementById('btnCalibrate'); if(b3) b3.addEventListener('click', (e)=>{e.preventDefault(); calibrate();});
            const b4=document.getElementById('btnClearLogs'); if(b4) b4.addEventListener('click', (e)=>{e.preventDefault(); clearLogs();});
            document.querySelectorAll('[data-tab]').forEach(btn=>btn.addEventListener('click', ()=>showTab(btn.getAttribute('data-tab'))));

            showTab('overview');
            updateLowApiUi();
            refreshAll();
            setInterval(async ()=>{
              if(currentTab==='overview') await refreshOverview();
              else if(currentTab==='analytics') {
                if (lowApiMode) return;
                await refreshAnalytics();
                // Compare is expensive; auto-fetch only once until user changes filters.
                if (!compareState) {
                  await refreshCompare();
                  compareLastAt = Date.now();
                }
              }
              else if(currentTab==='logs') await refreshLogs();
              else if(currentTab==='system') await refreshSystem();
            }, 30000);
          </script>
        `)
      );
      return;
    }

    if (u.pathname === "/run-once") {
      const out = await pollOnce();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...out }));
      return;
    }

    if (u.pathname === "/login") {
      const verifier = makeVerifier();
      const challenge = makeChallenge(verifier);
      const state = crypto.randomBytes(16).toString("hex");
      const redirectUri = computeRedirectUri(req);
      setState({ pkce: { verifier }, oauthState: state, oauthRedirectUri: redirectUri });

      const auth = new URL("https://accounts.spotify.com/authorize");
      auth.searchParams.set("client_id", CLIENT_ID);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("redirect_uri", redirectUri);
      auth.searchParams.set("code_challenge_method", "S256");
      auth.searchParams.set("code_challenge", challenge);
      auth.searchParams.set("scope", SCOPES.join(" "));
      auth.searchParams.set("state", state);

      res.writeHead(302, { Location: auth.toString() });
      res.end();
      return;
    }

    if (u.pathname === "/callback") {
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      const s = loadState();
      if (!code) throw new Error("Missing code");
      if (!state || state !== s.oauthState) throw new Error("Bad state");
      if (!s.pkce?.verifier) throw new Error("Missing PKCE verifier");

      const redirectUri = s.oauthRedirectUri || computeRedirectUri(req);
      const tok = await postForm("https://accounts.spotify.com/api/token", {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: s.pkce.verifier
      });

      const stored = {
        access_token: tok.access_token,
        token_type: tok.token_type,
        expires_in: tok.expires_in,
        refresh_token: tok.refresh_token,
        scope: tok.scope,
        obtained_at_ms: nowMs()
      };

      setState({ token: stored });
      await ensurePlaylists(stored.access_token);

      res.writeHead(302, { Location: "/?auth=ok" });
      res.end();
      return;
    }

// Add this new endpoint after the run-once endpoint
    if (u.pathname === "/test-playlist-add") {
      try {
        const token = await refreshIfNeeded();
        const accessToken = token.access_token;
        
        // Get user info first
        const me = await spotifyFetch("https://api.spotify.com/v1/me", accessToken);
        console.log("[TEST] User ID:", me.id);
        
        // List first few playlists
        const playlists = await spotifyFetch("https://api.spotify.com/v1/me/playlists?limit=3", accessToken);
        console.log("[TEST] First 3 playlists:", playlists.items.map(p => ({ name: p.name, id: p.id })).slice(0, 3));
        
        if (playlists.items.length > 0) {
          const testPlaylist = playlists.items[0];
          console.log(`[TEST] Testing add to playlist: ${testPlaylist.name} (${testPlaylist.id})`);
          
          // Try to add a test track
          const testTrackUri = "spotify:track:4iV5W9uYEdYUVa79Axb7Rh"; // Don't Stop Me Now by Queen
          try {
            await spotifyFetch(`https://api.spotify.com/v1/playlists/${encodeURIComponent(testPlaylist.id)}/items`, accessToken, {
              method: "POST",
              body: JSON.stringify({ uris: [testTrackUri] })
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, message: "Successfully added track to playlist" }));
          } catch (error) {
            console.error("[TEST] Failed to add track:", error.message);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: error.message, playlist: testPlaylist.name, track: testTrackUri }));
          }
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "No playlists found" }));
        }
      } catch (error) {
        console.error("[TEST] Error:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    // Add endpoint to view recent tracks that should have been added
    if (u.pathname === "/recent-tracks") {
      try {
        // Read the server log and extract TRACK_LOG entries
        const logContent = readFileSync(STATE_PATH.replace('state.json', 'server.log'), 'utf8');
        const trackLogs = logContent.split('\n')
          .filter(line => line.includes('[TRACK_LOG]'))
          .slice(-50) // Get last 50 track logs
          .map(line => {
            const match = line.match(/\[TRACK_LOG\] (.*)/);
            return match ? match[1] : line;
          });
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, tracks: trackLogs.reverse() })); // Most recent first
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    if (u.pathname === "/api/analytics") {
      const s = loadState();
      const pollHistory = Array.isArray(s.pollHistory) ? s.pollHistory : [];
      const trackHistory = Array.isArray(s.trackHistory) ? s.trackHistory : [];
      const vibeCounts = {};
      const confidenceBands = { high: 0, medium: 0, low: 0 };
      for (const t of trackHistory) {
        const k = t?.selectedVibes?.[0] || "unknown";
        vibeCounts[k] = (vibeCounts[k] || 0) + 1;
        if (t?.confidenceBand && confidenceBands[t.confidenceBand] !== undefined) confidenceBands[t.confidenceBand] += 1;
      }
      const quality = computeQualitySnapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        since: pollHistory[0]?.atMs || null,
        polls: pollHistory.slice(-300),
        tracks: trackHistory.slice(-500),
        quality,
        summary: {
          totalPolls: pollHistory.length,
          totalClassified: trackHistory.length,
          vibeCounts,
          confidenceBands
        }
      }));
      return;
    }

    if (u.pathname === "/api/low-confidence") {
      const s = loadState();
      const trackHistory = Array.isArray(s.trackHistory) ? s.trackHistory : [];
      const labels = s.manualLabels && typeof s.manualLabels === "object" ? s.manualLabels : {};
      const dismissed = s.lowConfidenceDismissed && typeof s.lowConfidenceDismissed === "object" ? s.lowConfidenceDismissed : {};
      const out = trackHistory
        .filter(t => t.confidenceBand === "low" || (typeof t.topScore === "number" && t.topScore < 0.5))
        .filter(t => !labels[t.trackId])
        .filter(t => !dismissed[t.trackId])
        .slice(-200)
        .reverse()
        .slice(0, 30);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, items: out }));
      return;
    }

    if (u.pathname === "/api/rewind") {
      try {
        const cacheTtlMs = 15 * 60_000;
        if (rewindCache.payload && (nowMs() - rewindCache.atMs) < cacheTtlMs) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...rewindCache.payload, cached: true }));
          return;
        }

        const token = await refreshIfNeeded();
        const accessToken = token.access_token;
        const items = await getRewindItems(accessToken);

        const byYear = {};
        const byMonth = {};
        const byDay = {};
        const now = new Date();
        const currentYear = now.getFullYear();

        function inc(map, key) { map[key] = (map[key] || 0) + 1; }
        function topN(map, n = 5) {
          return Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v }));
        }
        function avg(arr) {
          const vals = (arr || []).filter(v => Number.isFinite(v));
          if (!vals.length) return null;
          return vals.reduce((a, b) => a + b, 0) / vals.length;
        }

        for (const it of items) {
          const tr = it.track;
          const ts = Date.parse(it.added_at || "");
          if (!tr?.id || !Number.isFinite(ts)) continue;
          const d = new Date(ts);
          const y = d.getFullYear();
          const m = d.getMonth() + 1;
          const day = d.getDay();
          const artist = tr.artists?.[0]?.name || "unknown";
          const track = tr.name || "unknown";

          byYear[y] = byYear[y] || { total: 0, artists: {}, tracks: {}, months: {}, trackIds: [] };
          byYear[y].total += 1;
          inc(byYear[y].artists, artist);
          inc(byYear[y].tracks, `${track} — ${artist}`);
          inc(byYear[y].months, m);
          byYear[y].trackIds.push(tr.id);

          byDay[day] = (byDay[day] || 0) + 1;

          if (y === currentYear) {
            byMonth[m] = byMonth[m] || { total: 0, artists: {}, tracks: {} };
            byMonth[m].total += 1;
            inc(byMonth[m].artists, artist);
            inc(byMonth[m].tracks, `${track} — ${artist}`);
          }
        }

        // Audio profile sampling (capped for speed/rate safety)
        const MAX_AUDIO_SAMPLES = Number(process.env.REWIND_AUDIO_SAMPLE_MAX ?? 1200);
        const SAMPLE_PER_YEAR = Number(process.env.REWIND_AUDIO_SAMPLE_PER_YEAR ?? 180);
        const sampledIds = [];
        const sampledByYear = {};
        for (const [y, v] of Object.entries(byYear)) {
          const ids = Array.from(new Set(v.trackIds || [])).slice(0, SAMPLE_PER_YEAR);
          sampledByYear[y] = ids;
          sampledIds.push(...ids);
        }
        const uniqueSampled = Array.from(new Set(sampledIds)).slice(0, MAX_AUDIO_SAMPLES);
        const afMap = await getAudioFeatures(accessToken, uniqueSampled);

        const audioProfileByYear = {};
        for (const [y, ids] of Object.entries(sampledByYear)) {
          const feats = ids.map(id => afMap.get(id)).filter(Boolean);
          audioProfileByYear[y] = {
            sampleSize: feats.length,
            energy: avg(feats.map(f => f.energy)),
            valence: avg(feats.map(f => f.valence)),
            danceability: avg(feats.map(f => f.danceability)),
            acousticness: avg(feats.map(f => f.acousticness)),
            instrumentalness: avg(feats.map(f => f.instrumentalness)),
            speechiness: avg(feats.map(f => f.speechiness)),
            liveness: avg(feats.map(f => f.liveness)),
            tempo: avg(feats.map(f => f.tempo))
          };
        }

        const rewindByYear = Object.fromEntries(Object.entries(byYear).map(([y, v]) => {
          const uniqueArtists = Object.keys(v.artists || {}).length;
          const uniqueTracks = Object.keys(v.tracks || {}).length;
          const repeatRate = v.total ? Math.max(0, (v.total - uniqueTracks) / v.total) : 0;
          const topArtistCount = topN(v.artists, 1)[0]?.count || 0;
          const topArtistShare = v.total ? topArtistCount / v.total : 0;
          return [y, {
            total: v.total,
            topArtists: topN(v.artists, 5),
            topTracks: topN(v.tracks, 5),
            activeMonths: Object.keys(v.months).length,
            uniqueArtists,
            uniqueTracks,
            repeatRate,
            topArtistShare
          }];
        }));

        const rewindByMonth = Object.fromEntries(Object.entries(byMonth).map(([m, v]) => [m, {
          total: v.total,
          topArtists: topN(v.artists, 3),
          topTracks: topN(v.tracks, 3)
        }]));

        const orderedYears = Object.entries(rewindByYear).sort((a, b) => Number(a[0]) - Number(b[0]));
        const firstYear = orderedYears[0]?.[0] || null;
        const lastYear = orderedYears[orderedYears.length - 1]?.[0] || null;
        const latest = lastYear ? rewindByYear[lastYear] : null;
        const previous = orderedYears.length > 1 ? rewindByYear[orderedYears[orderedYears.length - 2][0]] : null;
        const growth = (latest && previous && previous.total) ? (latest.total - previous.total) / previous.total : null;

        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const peakDay = Object.entries(byDay).sort((a,b)=>b[1]-a[1])[0];

        const patterns = {
          discoveryRate: latest && latest.total ? (latest.uniqueTracks / latest.total) : 0,
          artistDiversity: latest && latest.total ? (latest.uniqueArtists / latest.total) : 0,
          repeatRate: latest?.repeatRate || 0,
          peakMonthLabel: (() => {
            const top = Object.entries(rewindByMonth).sort((a, b) => (b[1]?.total || 0) - (a[1]?.total || 0))[0];
            return top ? `${top[0]} (${top[1].total})` : "n/a";
          })()
        };

        const journey = {
          firstYear,
          lastYear,
          milestones: [
            firstYear ? { title: "Journey start", detail: `First saved-track year: ${firstYear}` } : null,
            lastYear ? { title: "Current era", detail: `Latest active year: ${lastYear}` } : null,
            growth == null ? null : { title: "Year-over-year shift", detail: `${growth >= 0 ? "+" : ""}${(growth * 100).toFixed(1)}% vs previous year` },
            peakDay ? { title: "Peak listen day", detail: `${dayNames[Number(peakDay[0])] || "?"} has the highest additions (${peakDay[1]})` } : null,
            latest ? { title: "Latest year diversity", detail: `${latest.uniqueArtists} unique artists across ${latest.total} additions` } : null
          ].filter(Boolean)
        };

        const payload = {
          ok: true,
          source: "spotify_saved_tracks",
          scanned: items.length,
          currentYear,
          byYear: rewindByYear,
          byMonth: rewindByMonth,
          audioProfileByYear,
          patterns,
          journey
        };
        rewindCache = { atMs: nowMs(), payload };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      } catch (error) {
        const fallback = rewindCache.payload || { ok: true, source: "spotify_saved_tracks", scanned: 0, currentYear: new Date().getFullYear(), byYear: {}, byMonth: {}, audioProfileByYear: {}, patterns: {}, journey: { milestones: [] } };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...fallback, warning: error.message, cached: Boolean(rewindCache.payload) }));
      }
      return;
    }

    if (u.pathname === "/api/rewind-compare") {
      try {
        const cacheKey = u.searchParams.toString() || "default";
        const compareTtlMs = Number(process.env.REWIND_COMPARE_CACHE_TTL_MS ?? 10 * 60_000);
        const cached = rewindCompareCache.get(cacheKey);
        if (cached && (nowMs() - cached.atMs) < compareTtlMs) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...cached.payload, cached: true }));
          return;
        }

        const token = await refreshIfNeeded();
        const accessToken = token.access_token;
        const items = await getRewindItems(accessToken);

        const presetA = String(u.searchParams.get("presetA") || "last90");
        const presetB = String(u.searchParams.get("presetB") || "prev90");
        const fromAIn = String(u.searchParams.get("fromA") || "");
        const toAIn = String(u.searchParams.get("toA") || "");
        const fromBIn = String(u.searchParams.get("fromB") || "");
        const toBIn = String(u.searchParams.get("toB") || "");
        const limit = Math.max(20, Math.min(500, Number(u.searchParams.get("limit") || 120)));

        const now = new Date();
        function startOfDayMs(d) { const x = new Date(d); x.setHours(0,0,0,0); return x.getTime(); }
        function endOfDayMs(d) { const x = new Date(d); x.setHours(23,59,59,999); return x.getTime(); }
        function parseDate(s, end = false) {
          const t = Date.parse(s);
          if (!Number.isFinite(t)) return null;
          return end ? endOfDayMs(t) : startOfDayMs(t);
        }
        function dateStr(ms) { return new Date(ms).toISOString().slice(0, 10); }
        function rangeFromPreset(preset) {
          const todayEnd = endOfDayMs(now);
          const todayStart = startOfDayMs(now);
          if (preset === "thisYear") {
            const y = now.getFullYear();
            return { fromMs: new Date(y, 0, 1).getTime(), toMs: todayEnd, label: `this year (${y})` };
          }
          if (preset === "lastYear") {
            const y = now.getFullYear() - 1;
            return { fromMs: new Date(y, 0, 1).getTime(), toMs: new Date(y, 11, 31, 23, 59, 59, 999).getTime(), label: `last year (${y})` };
          }
          if (preset === "prev90") {
            const toMs = todayStart - 1;
            const fromMs = startOfDayMs(toMs - 89 * 24 * 3600 * 1000);
            return { fromMs, toMs, label: "previous 90 days" };
          }
          const fromMs = startOfDayMs(todayEnd - 89 * 24 * 3600 * 1000);
          return { fromMs, toMs: todayEnd, label: "last 90 days" };
        }
        const presetRangeA = rangeFromPreset(presetA);
        const presetRangeB = rangeFromPreset(presetB);
        const rangeA = {
          fromMs: parseDate(fromAIn, false) ?? presetRangeA.fromMs,
          toMs: parseDate(toAIn, true) ?? presetRangeA.toMs,
          label: (fromAIn && toAIn) ? `${fromAIn} → ${toAIn}` : presetRangeA.label
        };
        const rangeB = {
          fromMs: parseDate(fromBIn, false) ?? presetRangeB.fromMs,
          toMs: parseDate(toBIn, true) ?? presetRangeB.toMs,
          label: (fromBIn && toBIn) ? `${fromBIn} → ${toBIn}` : presetRangeB.label
        };

        function between(ts, r) { return Number.isFinite(ts) && ts >= r.fromMs && ts <= r.toMs; }
        function avg(arr) {
          const vals = (arr || []).filter(v => Number.isFinite(v));
          if (!vals.length) return null;
          return vals.reduce((a, b) => a + b, 0) / vals.length;
        }
        function pickRows(range) {
          return items
            .map(it => {
              const ts = Date.parse(it.added_at || "");
              if (!between(ts, range)) return null;
              return {
                trackId: it.track?.id,
                addedAtMs: ts,
                addedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
                track: it.track?.name || "unknown",
                artist: it.track?.artists?.[0]?.name || "unknown"
              };
            })
            .filter(Boolean)
            .sort((a, b) => b.addedAtMs - a.addedAtMs);
        }

        const rowsAAll = pickRows(rangeA);
        const rowsBAll = pickRows(rangeB);

        async function summarize(rowsAll) {
          const total = rowsAll.length;
          const artistCounts = {};
          const trackCounts = {};
          for (const r of rowsAll) {
            artistCounts[r.artist] = (artistCounts[r.artist] || 0) + 1;
            const tk = `${r.track} — ${r.artist}`;
            trackCounts[tk] = (trackCounts[tk] || 0) + 1;
          }
          const uniqueArtists = Object.keys(artistCounts).length;
          const uniqueTracks = Object.keys(trackCounts).length;
          const discoveryRate = total ? uniqueTracks / total : 0;
          const repeatRate = total ? Math.max(0, (total - uniqueTracks) / total) : 0;
          const artistDiversity = total ? uniqueArtists / total : 0;

          const sampleIds = Array.from(new Set(rowsAll.map(r => r.trackId).filter(Boolean))).slice(0, 240);
          const afMap = await getAudioFeatures(accessToken, sampleIds);
          const feats = sampleIds.map(id => afMap.get(id)).filter(Boolean);
          const audio = {
            sampleSize: feats.length,
            energy: avg(feats.map(f => f.energy)),
            valence: avg(feats.map(f => f.valence)),
            danceability: avg(feats.map(f => f.danceability)),
            tempo: avg(feats.map(f => f.tempo))
          };

          return {
            total,
            uniqueArtists,
            uniqueTracks,
            discoveryRate,
            repeatRate,
            artistDiversity,
            audio,
            topArtists: Object.entries(artistCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,count])=>({key:k,count})),
            topTracks: Object.entries(trackCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,count])=>({key:k,count}))
          };
        }

        const [summaryA, summaryB] = await Promise.all([summarize(rowsAAll), summarize(rowsBAll)]);

        function delta(a, b) { return (Number(a) || 0) - (Number(b) || 0); }
        function deltaPct(a, b) {
          if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
          return (a - b) / b;
        }

        const deltas = {
          total: { abs: delta(summaryA.total, summaryB.total), pct: deltaPct(summaryA.total, summaryB.total) },
          discoveryRate: { abs: delta(summaryA.discoveryRate, summaryB.discoveryRate), pct: null },
          repeatRate: { abs: delta(summaryA.repeatRate, summaryB.repeatRate), pct: null },
          artistDiversity: { abs: delta(summaryA.artistDiversity, summaryB.artistDiversity), pct: null },
          energy: { abs: delta(summaryA.audio.energy, summaryB.audio.energy), pct: null },
          valence: { abs: delta(summaryA.audio.valence, summaryB.audio.valence), pct: null },
          danceability: { abs: delta(summaryA.audio.danceability, summaryB.audio.danceability), pct: null },
          tempo: { abs: delta(summaryA.audio.tempo, summaryB.audio.tempo), pct: null }
        };

        const payload = {
          ok: true,
          rangeA: { ...rangeA, from: dateStr(rangeA.fromMs), to: dateStr(rangeA.toMs) },
          rangeB: { ...rangeB, from: dateStr(rangeB.fromMs), to: dateStr(rangeB.toMs) },
          summaryA,
          summaryB,
          deltas,
          rowsA: rowsAAll.slice(0, limit),
          rowsB: rowsBAll.slice(0, limit)
        };
        rewindCompareCache.set(cacheKey, { atMs: nowMs(), payload });
        if (rewindCompareCache.size > 40) {
          const keys = [...rewindCompareCache.keys()];
          rewindCompareCache.delete(keys[0]);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      } catch (error) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error.message || "failed" }));
      }
      return;
    }

    if (u.pathname === "/api/label-track") {
      const trackId = String(u.searchParams.get("trackId") || "").trim();
      const vibeKey = String(u.searchParams.get("vibeKey") || "").trim();
      if (!trackId || !vibeKey) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "trackId and vibeKey required" }));
        return;
      }
      if (!VIBES.some(v => v.key === vibeKey)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid vibeKey" }));
        return;
      }
      setManualLabel(trackId, vibeKey);
      appendOnlineTrainingExample(trackId, vibeKey);
      const s = loadState();
      const dismissed = s.lowConfidenceDismissed && typeof s.lowConfidenceDismissed === "object" ? s.lowConfidenceDismissed : {};
      if (dismissed[trackId]) {
        delete dismissed[trackId];
        setState({ lowConfidenceDismissed: dismissed });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (u.pathname === "/api/dismiss-low-confidence") {
      const trackId = String(u.searchParams.get("trackId") || "").trim();
      if (!trackId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "trackId required" }));
        return;
      }
      const s = loadState();
      const dismissed = s.lowConfidenceDismissed && typeof s.lowConfidenceDismissed === "object" ? s.lowConfidenceDismissed : {};
      dismissed[trackId] = nowMs();
      setState({ lowConfidenceDismissed: dismissed });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (u.pathname === "/api/label-track-multi") {
      const trackId = String(u.searchParams.get("trackId") || "").trim();
      const raw = String(u.searchParams.get("vibeKeys") || "");
      const vibeKeys = raw.split(',').map(x => x.trim()).filter(Boolean);
      if (!trackId || !vibeKeys.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "trackId and vibeKeys required" }));
        return;
      }
      const okSet = setManualLabels(trackId, vibeKeys);
      if (!okSet) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "no valid vibeKeys" }));
        return;
      }
      for (const vk of vibeKeys) appendOnlineTrainingExample(trackId, vk);
      const s = loadState();
      const dismissed = s.lowConfidenceDismissed && typeof s.lowConfidenceDismissed === "object" ? s.lowConfidenceDismissed : {};
      if (dismissed[trackId]) {
        delete dismissed[trackId];
        setState({ lowConfidenceDismissed: dismissed });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (u.pathname === "/api/calibrate-thresholds") {
      const s = loadState();
      const labels = s.manualLabels && typeof s.manualLabels === "object" ? s.manualLabels : {};
      const tracks = Array.isArray(s.trackHistory) ? s.trackHistory : [];
      const latestByTrack = new Map();
      for (const t of tracks) latestByTrack.set(t.trackId, t);

      const byVibe = {};
      for (const [trackId, lbl] of Object.entries(labels)) {
        const t = latestByTrack.get(trackId);
        if (!t || typeof t.topScore !== "number") continue;
        const vibe = lbl.vibeKey;
        byVibe[vibe] = byVibe[vibe] || [];
        byVibe[vibe].push(t.topScore);
      }

      const thresholds = {};
      for (const [vibe, arr] of Object.entries(byVibe)) {
        arr.sort((a, b) => a - b);
        const idx = Math.floor(arr.length * 0.35);
        thresholds[vibe] = Number((arr[idx] ?? CLASSIFIER_THRESHOLD).toFixed(3));
      }

      setState({ classifierThresholdsByVibe: thresholds, classifierThresholdsUpdatedAtMs: nowMs() });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, thresholds }));
      return;
    }

    if (u.pathname === "/api/system-info") {
      const s = loadState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        now: new Date().toISOString(),
        env: {
          port: PORT,
          pollMinutes: POLL_MINUTES,
          dedupMinutes: DEDUP_MINUTES,
          classifierMode: CLASSIFIER_MODE,
          classifierThreshold: CLASSIFIER_THRESHOLD,
          llmFallbackEnabled: LLM_FALLBACK_ENABLED,
          wandbEnabled: WANDB_ENABLED,
          multiLabelEnabled: MULTI_LABEL_ENABLED,
          multiLabelMargin: MULTI_LABEL_MARGIN,
          multiLabelMax: MULTI_LABEL_MAX
        },
        auth: {
          hasToken: Boolean(s.token?.access_token),
          tokenExpiresIn: s.token?.expires_in ?? null,
          tokenObtainedAtMs: s.token?.obtained_at_ms ?? null,
          healthy: authState.healthy,
          lastCheckedAtMs: authState.lastCheckedAtMs,
          lastError: authState.lastError,
          reauthRequired: Boolean(s.token?.access_token) && !authState.healthy
        },
        stateCounts: {
          polls: Array.isArray(s.pollHistory) ? s.pollHistory.length : 0,
          tracks: Array.isArray(s.trackHistory) ? s.trackHistory.length : 0,
          labels: s.manualLabels ? Object.keys(s.manualLabels).length : 0
        },
        spotifyRateState,
        pollState
      }));
      return;
    }

    if (u.pathname === "/api/logs") {
      try {
        const logPath = STATE_PATH.replace("state.json", "server.log");
        const text = readFileSync(logPath, "utf8");
        const all = text.split("\n");
        let start = Math.max(0, all.length - 500);
        for (let i = all.length - 1; i >= 0; i--) {
          if (all[i].includes(LOG_CLEAR_MARKER)) {
            start = Math.max(start, i + 1);
            break;
          }
        }
        const lines = all.slice(start).filter(Boolean);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, lines }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    if (u.pathname === "/api/logs/clear") {
      try {
        const logPath = STATE_PATH.replace("state.json", "server.log");
        const marker = `${LOG_CLEAR_MARKER} ${new Date().toISOString()}`;
        // Add a marker so /api/logs only returns lines after this point.
        writeFileSync(logPath, `${marker}\n`, { flag: "a" });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    if (u.pathname === "/analytics") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html(`
        <h2 class="title" style="font-size:24px">Rewind Analytics</h2>
        <p><a class="btn" href="/">← Home</a></p>
        <section class="grid">
          <div class="card left"><h3 class="h">Year Cards</h3><div id="years"></div></div>
          <div class="card right"><h3 class="h">Current Year by Month</h3><div id="months"></div></div>
          <div class="card full"><h3 class="h">Top Artists / Tracks</h3><pre id="details"></pre></div>
        </section>
        <script>
          function renderList(items){return (items||[]).map(x=>x.key+' ('+x.count+')').join(', ')}
          async function load(){
            const r = await fetch('/api/rewind').then(x=>x.json());
            const years = Object.entries(r.byYear||{}).sort((a,b)=>Number(b[0])-Number(a[0]));
            document.getElementById('years').innerHTML = years.map(([y,v])=>
              '<div style="border:1px solid #1f3d31;border-radius:10px;padding:10px;margin:8px 0;background:#0a120f">'+
              '<div style="font-weight:700">'+y+' • '+v.total+' songs</div>'+
              '<div style="color:#94a3b8">Top vibes: '+renderList(v.topVibes)+'</div>'+
              '<div style="color:#94a3b8">Top artists: '+renderList(v.topArtists)+'</div>'+
              '</div>'
            ).join('') || 'No data';

            const months = Object.entries(r.byMonth||{}).sort((a,b)=>Number(a[0])-Number(b[0]));
            document.getElementById('months').innerHTML = months.map(([m,v])=>
              '<div style="display:flex;gap:8px;align-items:center;margin:6px 0">'+
              '<div style="width:90px">Month '+m+'</div><div style="color:#94a3b8">'+v.total+' songs · '+renderList(v.topVibes)+'</div></div>'
            ).join('') || 'No data';

            const latestYear = years[0]?.[0];
            const detail = latestYear ? (r.byYear||{})[latestYear] : null;
            document.getElementById('details').textContent = detail ? JSON.stringify({year:latestYear, topArtists:detail.topArtists, topTracks:detail.topTracks}, null, 2) : 'No data';
          }
          load();
        </script>
      `));
      return;
    }

    if (u.pathname === "/logs") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html('<h2>Server Logs</h2><p><a class="btn" href="/">← Home</a></p><pre id="out"></pre><script>async function load(){const j=await fetch("/api/logs").then(r=>r.json());document.getElementById("out").textContent=(j.lines||[]).join("\\n");} load(); setInterval(load,5000);</script>'));
      return;
    }

    if (u.pathname === "/system") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html('<h2>System Info</h2><p><a class="btn" href="/">← Home</a></p><pre id="out"></pre><script>fetch("/api/system-info").then(r=>r.json()).then(j=>{document.getElementById("out").textContent=JSON.stringify(j,null,2)});</script>'));
      return;
    }

    if (u.pathname === "/dashboard") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html(
        '<h1>Vibe Router Dashboard</h1>' +
        '<p><a href="/">Home</a> · <a href="/run-once">Run once</a></p>' +
        '<div id="kpis" style="font-weight:600;margin-bottom:8px"></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">' +
        '<div><h3>Vibe distribution</h3><div id="bars"></div></div>' +
        '<div><h3>Quality (labeled)</h3><pre id="quality"></pre></div>' +
        '</div>' +
        '<h3>Poll trend (last 30)</h3><pre id="polls"></pre>' +
        '<h3>Low-confidence queue</h3><div id="queue"></div>' +
        '<script>' +
        'const vibes='+JSON.stringify(VIBES.map(v=>v.key))+';' +
        'function buildSelect(id){var opts=vibes.map(function(v){return "<option value=\""+v+"\">"+v+"</option>";}).join(""); return "<select data-id=\""+id+"\">"+opts+"</select>";}' +
        'async function labelTrack(trackId, vibeKey){await fetch("/api/label-track?trackId="+encodeURIComponent(trackId)+"&vibeKey="+encodeURIComponent(vibeKey)); load();}' +
        'async function load(){' +
        'const a=await fetch("/api/analytics").then(r=>r.json()); const q=await fetch("/api/low-confidence").then(r=>r.json()); const s=a.summary||{};' +
        'document.getElementById("kpis").textContent = "Polls: " + (s.totalPolls||0) + " | Classified: " + (s.totalClassified||0) + " | Labeled: " + ((a.quality&&a.quality.labeledCount)||0) + " | Top1(labeled): " + (((a.quality&&a.quality.top1AccuracyOnLabeled)==null)?"n/a":(a.quality.top1AccuracyOnLabeled*100).toFixed(1)+"%");' +
        'var entries=Object.entries(s.vibeCounts||{}).sort(function(x,y){return y[1]-x[1];}).slice(0,15); var max=1; for(var i=0;i<entries.length;i++){if(entries[i][1]>max)max=entries[i][1];}' +
        'document.getElementById("bars").innerHTML=entries.map(function(e){var k=e[0],v=e[1],w=Math.round((v/max)*240); return "<div style=\"display:flex;gap:8px;align-items:center;margin:4px 0\"><div style=\"width:170px\">"+k+"</div><div style=\"background:#669A79;height:12px;width:"+w+"px;border-radius:4px\"></div><div>"+v+"</div></div>";}).join("") || "No data";' +
        'document.getElementById("quality").textContent = JSON.stringify(a.quality||{}, null, 2);' +
        'document.getElementById("polls").textContent=(a.polls||[]).slice(-30).map(function(x){return new Date(x.atMs).toLocaleString()+" | new="+x.newTracksDetected+" processed="+x.processed+" added="+x.added;}).join("\n") || "No polls yet";' +
        'var qel=document.getElementById("queue"); qel.innerHTML=""; (q.items||[]).slice(0,20).forEach(function(t){' +
        'var card=document.createElement("div"); card.style.cssText="padding:8px;border:1px solid #ddd;border-radius:6px;margin:6px 0";' +
        'var title=document.createElement("div"); title.innerHTML="<b>"+(t.trackName||"")+"</b> — "+(t.artist||"")+" <small>(score "+(t.topScore==null?"n/a":t.topScore)+")</small><br/>pred: "+(((t.selectedVibes||[])[0])||"?"); card.appendChild(title);' +
        'var row=document.createElement("div"); row.style.marginTop="6px";' +
        'var sel=document.createElement("select"); vibes.forEach(function(v){var o=document.createElement("option"); o.value=v; o.textContent=v; sel.appendChild(o);}); row.appendChild(sel);' +
        'var btn=document.createElement("button"); btn.textContent=" Save label "; btn.style.marginLeft="8px"; btn.onclick=function(){labelTrack(t.trackId, sel.value);}; row.appendChild(btn);' +
        'card.appendChild(row); qel.appendChild(card); }); if(!(q.items||[]).length){qel.textContent="No low-confidence items";}' +
        '}' +
        'load(); setInterval(load, 15000);' +
        '</script>'
      ));
      return;
    }

    if (u.pathname === "/diagnose-audio-features") {
      try {
        const token = await refreshIfNeeded();
        const accessToken = token.access_token;
        const trackId = u.searchParams.get("track_id") || "39lMkFLypjv3a0Y1i7ze9M";

        const response = await fetch(`https://api.spotify.com/v1/audio-features/${encodeURIComponent(trackId)}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });

        const bodyText = await response.text();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: response.ok,
          status: response.status,
          endpoint: `https://api.spotify.com/v1/audio-features/${trackId}`,
          note: "Spotify marks Audio Features as deprecated; many apps get 403 unless whitelisted.",
          body: bodyText
        }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(err?.stack ?? err));
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await finishWandbLogging();
    process.exit(0);
  });
}

server.listen(PORT, "127.0.0.1", async () => {
  if (WANDB_ENABLED) {
    await initWandbLogging({
      entity: WANDB_ENTITY,
      project: WANDB_PROJECT,
      service: "spotify-vibe-router-lite"
    });
  }

  console.log(`spotify-vibe-router running: http://127.0.0.1:${PORT}`);
  console.log(`Login: http://127.0.0.1:${PORT}/login`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);

  setInterval(() => {
    pollOnce()
      .then(r => console.log(`[poll] processed=${r.processed} added=${r.added}`))
      .catch(async e => {
        const message = e?.message ?? String(e);
        console.error("[poll]", message);
        await logWandbError({
          phase: "poll-loop",
          message,
          stack: e?.stack ?? null,
          atMs: nowMs()
        });
      });
  }, POLL_MINUTES * 60_000);
});
