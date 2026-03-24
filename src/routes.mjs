import { readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.mjs";
import { loadState, setState } from "./state.mjs";
import { logger } from "./logger.mjs";
import { VIBES } from "./vibes.mjs";
import {
  refreshIfNeeded,
  handleLogin as authHandleLogin,
  handleCallback as authHandleCallback,
  getAuthState,
  updateAuthHealth
} from "./spotify/auth.mjs";
import { spotifyFetch, getRateState } from "./spotify/client.mjs";
import {
  ensurePlaylists,
  getAudioFeatures,
  getRewindItems
} from "./spotify/api.mjs";
import {
  pollOnce,
  getPollState,
  setManualLabel,
  setManualLabels,
  appendOnlineTrainingExample,
  computeQualitySnapshot
} from "./poller.mjs";

/* ── helpers ─────────────────────────────────────────────── */

function nowMs() { return Date.now(); }

const LOG_CLEAR_MARKER = "[UI_LOG_CLEAR_MARKER]";

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/* ── caches ──────────────────────────────────────────────── */

let rewindCache = { atMs: 0, payload: null };
let rewindCompareCache = new Map();

/* ── route handlers (async (req, res, url)) ──────────────── */

// POST /run-once
export async function handleRunOnce(_req, res, _u) {
  const out = await pollOnce();
  json(res, 200, { ok: true, ...out });
}

// GET /login
export async function handleLoginRoute(req, res, _u) {
  const authUrl = authHandleLogin(req);
  res.writeHead(302, { Location: authUrl });
  res.end();
}

// GET /callback
export async function handleCallbackRoute(req, res, u) {
  const stored = await authHandleCallback(req, u);
  await ensurePlaylists(stored.access_token);
  res.writeHead(302, { Location: "/?auth=ok" });
  res.end();
}

// GET /test-playlist-add
export async function handleTestPlaylistAdd(_req, res, _u) {
  try {
    const token = await refreshIfNeeded();
    const accessToken = token.access_token;

    const me = await spotifyFetch("https://api.spotify.com/v1/me", accessToken);
    console.log("[TEST] User ID:", me.id);

    const playlists = await spotifyFetch("https://api.spotify.com/v1/me/playlists?limit=3", accessToken);
    console.log("[TEST] First 3 playlists:", playlists.items.map(p => ({ name: p.name, id: p.id })).slice(0, 3));

    if (playlists.items.length > 0) {
      const testPlaylist = playlists.items[0];
      console.log(`[TEST] Testing add to playlist: ${testPlaylist.name} (${testPlaylist.id})`);

      const testTrackUri = "spotify:track:4iV5W9uYEdYUVa79Axb7Rh"; // Don't Stop Me Now by Queen
      try {
        await spotifyFetch(`https://api.spotify.com/v1/playlists/${encodeURIComponent(testPlaylist.id)}/items`, accessToken, {
          method: "POST",
          body: JSON.stringify({ uris: [testTrackUri] })
        });
        json(res, 200, { ok: true, message: "Successfully added track to playlist" });
      } catch (error) {
        console.error("[TEST] Failed to add track:", error.message);
        json(res, 200, { ok: false, error: error.message, playlist: testPlaylist.name, track: testTrackUri });
      }
    } else {
      json(res, 200, { ok: false, error: "No playlists found" });
    }
  } catch (error) {
    console.error("[TEST] Error:", error);
    json(res, 500, { ok: false, error: error.message });
  }
}

// GET /recent-tracks
export async function handleRecentTracks(_req, res, _u) {
  try {
    const logPath = config.STATE_PATH.replace("state.json", "server.log");
    const logContent = readFileSync(logPath, "utf8");
    const trackLogs = logContent.split("\n")
      .filter(line => line.includes("[TRACK_LOG]"))
      .slice(-50)
      .map(line => {
        const match = line.match(/\[TRACK_LOG\] (.*)/);
        return match ? match[1] : line;
      });
    json(res, 200, { ok: true, tracks: trackLogs.reverse() });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
}

// GET /api/analytics
export async function handleAnalytics(_req, res, _u) {
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
  json(res, 200, {
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
  });
}

// GET /api/low-confidence
export async function handleLowConfidence(_req, res, _u) {
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
  json(res, 200, { ok: true, items: out });
}

// GET /api/rewind
export async function handleRewind(_req, res, _u) {
  try {
    const cacheTtlMs = 15 * 60_000;
    if (rewindCache.payload && (nowMs() - rewindCache.atMs) < cacheTtlMs) {
      json(res, 200, { ...rewindCache.payload, cached: true });
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
    const MAX_AUDIO_SAMPLES = config.REWIND_AUDIO_SAMPLE_MAX;
    const SAMPLE_PER_YEAR = config.REWIND_AUDIO_SAMPLE_PER_YEAR;
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
    const peakDay = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];

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
    json(res, 200, payload);
  } catch (error) {
    const fallback = rewindCache.payload || {
      ok: true, source: "spotify_saved_tracks", scanned: 0,
      currentYear: new Date().getFullYear(), byYear: {}, byMonth: {},
      audioProfileByYear: {}, patterns: {}, journey: { milestones: [] }
    };
    json(res, 200, { ...fallback, warning: error.message, cached: Boolean(rewindCache.payload) });
  }
}

// GET /api/rewind-compare
export async function handleRewindCompare(_req, res, u) {
  try {
    const cacheKey = u.searchParams.toString() || "default";
    const compareTtlMs = config.REWIND_COMPARE_CACHE_TTL_MS;
    const cached = rewindCompareCache.get(cacheKey);
    if (cached && (nowMs() - cached.atMs) < compareTtlMs) {
      json(res, 200, { ...cached.payload, cached: true });
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
    function startOfDayMs(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
    function endOfDayMs(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x.getTime(); }
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
        topArtists: Object.entries(artistCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, count]) => ({ key: k, count })),
        topTracks: Object.entries(trackCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, count]) => ({ key: k, count }))
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
    json(res, 200, payload);
  } catch (error) {
    json(res, 200, { ok: false, error: error.message || "failed" });
  }
}

// GET /api/label-track
export async function handleLabelTrack(_req, res, u) {
  const trackId = String(u.searchParams.get("trackId") || "").trim();
  const vibeKey = String(u.searchParams.get("vibeKey") || "").trim();
  if (!trackId || !vibeKey) {
    json(res, 400, { ok: false, error: "trackId and vibeKey required" });
    return;
  }
  if (!VIBES.some(v => v.key === vibeKey)) {
    json(res, 400, { ok: false, error: "invalid vibeKey" });
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
  json(res, 200, { ok: true });
}

// GET /api/dismiss-low-confidence
export async function handleDismissLowConfidence(_req, res, u) {
  const trackId = String(u.searchParams.get("trackId") || "").trim();
  if (!trackId) {
    json(res, 400, { ok: false, error: "trackId required" });
    return;
  }
  const s = loadState();
  const dismissed = s.lowConfidenceDismissed && typeof s.lowConfidenceDismissed === "object" ? s.lowConfidenceDismissed : {};
  dismissed[trackId] = nowMs();
  setState({ lowConfidenceDismissed: dismissed });
  json(res, 200, { ok: true });
}

// GET /api/label-track-multi
export async function handleLabelTrackMulti(_req, res, u) {
  const trackId = String(u.searchParams.get("trackId") || "").trim();
  const raw = String(u.searchParams.get("vibeKeys") || "");
  const vibeKeys = raw.split(",").map(x => x.trim()).filter(Boolean);
  if (!trackId || !vibeKeys.length) {
    json(res, 400, { ok: false, error: "trackId and vibeKeys required" });
    return;
  }
  const okSet = setManualLabels(trackId, vibeKeys);
  if (!okSet) {
    json(res, 400, { ok: false, error: "no valid vibeKeys" });
    return;
  }
  for (const vk of vibeKeys) appendOnlineTrainingExample(trackId, vk);
  const s = loadState();
  const dismissed = s.lowConfidenceDismissed && typeof s.lowConfidenceDismissed === "object" ? s.lowConfidenceDismissed : {};
  if (dismissed[trackId]) {
    delete dismissed[trackId];
    setState({ lowConfidenceDismissed: dismissed });
  }
  json(res, 200, { ok: true });
}

// GET /api/calibrate-thresholds
export async function handleCalibrateThresholds(_req, res, _u) {
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
    thresholds[vibe] = Number((arr[idx] ?? config.CLASSIFIER_THRESHOLD).toFixed(3));
  }

  setState({ classifierThresholdsByVibe: thresholds, classifierThresholdsUpdatedAtMs: nowMs() });
  json(res, 200, { ok: true, thresholds });
}

// GET /api/system-info
export async function handleSystemInfo(_req, res, _u) {
  const s = loadState();
  const authSt = getAuthState();
  const spotifyRateState = getRateState();
  const pollState = getPollState();
  json(res, 200, {
    ok: true,
    now: new Date().toISOString(),
    env: {
      port: config.PORT,
      pollMinutes: config.POLL_MINUTES,
      dedupMinutes: config.DEDUP_MINUTES,
      classifierMode: config.CLASSIFIER_MODE,
      classifierThreshold: config.CLASSIFIER_THRESHOLD,
      llmFallbackEnabled: config.LLM_FALLBACK_ENABLED,
      wandbEnabled: config.WANDB_ENABLED,
      multiLabelEnabled: config.MULTI_LABEL_ENABLED,
      multiLabelMargin: config.MULTI_LABEL_MARGIN,
      multiLabelMax: config.MULTI_LABEL_MAX
    },
    auth: {
      hasToken: Boolean(s.token?.access_token),
      tokenExpiresIn: s.token?.expires_in ?? null,
      tokenObtainedAtMs: s.token?.obtained_at_ms ?? null,
      healthy: authSt.healthy,
      lastCheckedAtMs: authSt.lastCheckedAtMs,
      lastError: authSt.lastError,
      reauthRequired: Boolean(s.token?.access_token) && !authSt.healthy
    },
    stateCounts: {
      polls: Array.isArray(s.pollHistory) ? s.pollHistory.length : 0,
      tracks: Array.isArray(s.trackHistory) ? s.trackHistory.length : 0,
      labels: s.manualLabels ? Object.keys(s.manualLabels).length : 0
    },
    spotifyRateState,
    pollState
  });
}

// GET /api/logs
export async function handleLogs(_req, res, _u) {
  try {
    const logPath = config.STATE_PATH.replace("state.json", "server.log");
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
    json(res, 200, { ok: true, lines });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
}

// POST /api/logs/clear
export async function handleLogsClear(_req, res, _u) {
  try {
    const logPath = config.STATE_PATH.replace("state.json", "server.log");
    const marker = `${LOG_CLEAR_MARKER} ${new Date().toISOString()}`;
    writeFileSync(logPath, `${marker}\n`, { flag: "a" });
    json(res, 200, { ok: true });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
}

// GET /diagnose-audio-features
export async function handleDiagnoseAudioFeatures(_req, res, u) {
  try {
    const token = await refreshIfNeeded();
    const accessToken = token.access_token;
    const trackId = u.searchParams.get("track_id") || "39lMkFLypjv3a0Y1i7ze9M";

    const response = await fetch(`https://api.spotify.com/v1/audio-features/${encodeURIComponent(trackId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const bodyText = await response.text();
    json(res, 200, {
      ok: response.ok,
      status: response.status,
      endpoint: `https://api.spotify.com/v1/audio-features/${trackId}`,
      note: "Spotify marks Audio Features as deprecated; many apps get 403 unless whitelisted.",
      body: bodyText
    });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
}

// GET /api/vibes
export async function handleVibes(_req, res, _u) {
  json(res, 200, { vibes: VIBES.map(v => v.key) });
}

// GET /healthz
export async function handleHealthz(_req, res, _u) {
  const s = loadState();
  const pollState = getPollState();
  json(res, 200, {
    status: "ok",
    authenticated: Boolean(s.token?.access_token),
    lastPollAt: pollState.lastFinishAtMs
  });
}

/* ── route table ─────────────────────────────────────────── */

export const routes = new Map([
  ["/run-once", handleRunOnce],
  ["/login", handleLoginRoute],
  ["/callback", handleCallbackRoute],
  ["/test-playlist-add", handleTestPlaylistAdd],
  ["/recent-tracks", handleRecentTracks],
  ["/api/analytics", handleAnalytics],
  ["/api/low-confidence", handleLowConfidence],
  ["/api/rewind", handleRewind],
  ["/api/rewind-compare", handleRewindCompare],
  ["/api/label-track", handleLabelTrack],
  ["/api/dismiss-low-confidence", handleDismissLowConfidence],
  ["/api/label-track-multi", handleLabelTrackMulti],
  ["/api/calibrate-thresholds", handleCalibrateThresholds],
  ["/api/system-info", handleSystemInfo],
  ["/api/logs", handleLogs],
  ["/api/logs/clear", handleLogsClear],
  ["/diagnose-audio-features", handleDiagnoseAudioFeatures],
  ["/api/vibes", handleVibes],
  ["/healthz", handleHealthz],
]);
