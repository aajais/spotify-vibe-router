import { config } from "../config.mjs";
import { setState } from "../state.mjs";
import { logger } from "../logger.mjs";
import { VIBES } from "../vibes.mjs";
import { spotifyFetch } from "./client.mjs";

const audioFeaturesCache = new Map();
let rewindTracksCache = { atMs: 0, items: null };

export async function listAllPlaylists(accessToken) {
  const out = [];
  let url = "https://api.spotify.com/v1/me/playlists?limit=50";
  while (url) {
    const page = await spotifyFetch(url, accessToken);
    out.push(...page.items.map(p => ({ id: p.id, name: p.name })));
    url = page.next;
  }
  return out;
}

export async function fetchSavedTracksHistory(accessToken, maxTracks = config.REWIND_MAX_TRACKS) {
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

export async function getRewindItems(accessToken) {
  const cacheTtlMs = 15 * 60_000;
  if (Array.isArray(rewindTracksCache.items) && (Date.now() - rewindTracksCache.atMs) < cacheTtlMs) {
    return rewindTracksCache.items;
  }
  const items = await fetchSavedTracksHistory(accessToken);
  rewindTracksCache = { atMs: Date.now(), items };
  return items;
}

export async function ensurePlaylists(accessToken) {
  await spotifyFetch("https://api.spotify.com/v1/me", accessToken);
  const existing = await listAllPlaylists(accessToken);
  const byName = new Map(existing.map(p => [p.name.toLowerCase(), p]));

  for (const vibe of VIBES) {
    if (byName.has(vibe.name.toLowerCase())) continue;
    await spotifyFetch(`https://api.spotify.com/v1/me/playlists`, accessToken, {
      method: "POST",
      body: JSON.stringify({
        name: vibe.name,
        public: config.PLAYLIST_VISIBILITY === "public",
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

export async function getAudioFeatures(accessToken, ids) {
  if (ids.length === 0) return new Map();

  const out = new Map();
  const now = Date.now();
  const ttlMs = config.AUDIO_FEATURES_CACHE_TTL_MS;
  const ttlNullMs = config.AUDIO_FEATURES_CACHE_NULL_TTL_MS;

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
      logger.warn(`Failed to fetch audio features (falling back to basic track info): ${error.message}`);
      for (const id of chunk) {
        out.set(id, null);
        audioFeaturesCache.set(id, { value: null, expiresAtMs: now + ttlNullMs });
      }
    }
  }

  return out;
}

export async function addTrackToPlaylist(accessToken, playlistId, trackUri) {
  try {
    await spotifyFetch(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items`, accessToken, {
      method: "POST",
      body: JSON.stringify({ uris: [trackUri] })
    });
    return true;
  } catch (error) {
    logger.warn(`Failed to add track to playlist (will retry next poll): ${error.message}`);
    throw error;
  }
}
