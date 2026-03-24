# Production Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the spotify-vibe-router monolith into a well-organized, deployable Node.js service with proper module boundaries, static file serving, structured logging, and Docker support.

**Architecture:** Split the 2332-line server.mjs into focused modules under src/ (config, state, spotify auth/client/api, classifier layers, poller, logger, HTTP server). Extract the inline HTML/CSS/JS dashboard into public/ static files. Move eval tooling into eval/. Add package.json, Dockerfile, health endpoint, and graceful shutdown.

**Tech Stack:** Node.js 18+ (built-in modules only), node:test for tests, Docker for deployment.

---

## File Structure

### New files to create:
- `src/config.mjs` — env var parsing + validation, frozen config export
- `src/state.mjs` — loadState/saveState/setState file persistence
- `src/logger.mjs` — structured JSON logging + optional W&B
- `src/spotify/auth.mjs` — OAuth PKCE flow, token refresh, login/callback handlers
- `src/spotify/client.mjs` — spotifyFetch with retry/backoff, rate state
- `src/spotify/api.mjs` — higher-level Spotify operations (playlists, tracks, audio features)
- `src/classifier/keywords.mjs` — keyword/regex scoring rules
- `src/classifier/audio.mjs` — audio feature heuristic scoring
- `src/classifier/priors.mjs` — Bayesian priors from training data
- `src/classifier/index.mjs` — classifyWithDiagnostics orchestrator
- `src/poller.mjs` — poll loop orchestration
- `src/routes.mjs` — HTTP route handlers (API endpoints)
- `src/server.mjs` — HTTP server, static files, graceful shutdown (entry point)
- `src/vibes.mjs` — VIBES array (moved from root)
- `public/index.html` — dashboard HTML
- `public/style.css` — dashboard CSS
- `public/app.js` — dashboard client-side JS
- `test/classifier.test.mjs` — classifier unit tests
- `test/config.test.mjs` — config validation tests
- `test/ui-smoke.test.mjs` — adapted smoke test
- `package.json` — project manifest
- `.env.example` — env var template
- `Dockerfile` — container image
- `.dockerignore` — Docker build exclusions

### Files to move:
- `training_data.json` → `eval/training_data.json`
- `evaluate_dataset.mjs` → `eval/evaluate_dataset.mjs`
- `build_training_data.mjs` → `eval/build_training_data.mjs`
- `run_wandb_experiments.py` → `eval/run_wandb_experiments.py`
- `create_ablation_report.py` → `eval/create_ablation_report.py`

### Files to delete after migration:
- `server.mjs` (root)
- `classify.mjs`
- `smart_classify.mjs`
- `simple_smart_classify.mjs`
- `adjusted_smart_classify.mjs`
- `vibes.mjs` (root)
- `wandb_logger.mjs`
- `test_smart_classifier.mjs`
- `test_smart_classifier_detailed.mjs`
- `test_ui_smoke.mjs`

---

### Task 1: Scaffold project structure and package.json

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `.dockerignore`
- Create: `Dockerfile`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "spotify-vibe-router",
  "version": "1.0.0",
  "description": "Automated Spotify listener that routes liked songs into vibe-matching playlists",
  "type": "module",
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "start": "node src/server.mjs",
    "test": "node --test test/",
    "test:eval": "node eval/evaluate_dataset.mjs eval/training_data.json"
  },
  "private": true
}
```

- [ ] **Step 2: Create .env.example**

```bash
# Required
SPOTIFY_CLIENT_ID=your_spotify_client_id

# Server
PORT=8888
# SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback

# Polling
POLL_MINUTES=1
DEDUP_MINUTES=60

# Playlists
PLAYLIST_VISIBILITY=private

# Classifier
CLASSIFIER_MODE=hybrid          # hybrid | keywords | audio
CLASSIFIER_THRESHOLD=0.40
# CLASSIFIER_THRESHOLDS_JSON={}

# Multi-label
MULTI_LABEL_ENABLED=true
MULTI_LABEL_MARGIN=0.08
MULTI_LABEL_MAX=3

# LLM fallback (optional)
LLM_FALLBACK_ENABLED=false
# LLM_FALLBACK_MODEL=gpt-4o-mini
# OPENAI_API_KEY=

# W&B logging (optional)
WANDB_ENABLED=false
# WANDB_ENTITY=dipy_genai
# WANDB_PROJECT=vibe-classification-spotify

# State file location
# STATE_PATH=./state.json
```

- [ ] **Step 3: Remove .env from git tracking**

Run: `git rm --cached .env`
Expected: `.env` removed from index but still on disk

- [ ] **Step 4: Create .dockerignore**

```
.git/
.env
.env.*
state.json
*.log
eval/
test/
docs/
wandb/
__pycache__/
*.pyc
node_modules/
.dockerignore
AGENTS.md
CLAUDE.md
```

- [ ] **Step 5: Create Dockerfile**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json .
COPY src/ src/
COPY public/ public/
EXPOSE 8888
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:8888/healthz || exit 1
CMD ["node", "src/server.mjs"]
```

- [ ] **Step 6: Create directory structure**

Run: `mkdir -p src/spotify src/classifier public test eval`

- [ ] **Step 7: Commit scaffold**

```bash
git add package.json .env.example .dockerignore Dockerfile
git commit -m "chore: scaffold project structure with package.json, Dockerfile, env template"
```

---

### Task 2: Extract src/config.mjs and src/state.mjs

**Files:**
- Create: `src/config.mjs`
- Create: `src/state.mjs`

- [ ] **Step 1: Write test for config validation**

Create `test/config.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("config", () => {
  it("exports a frozen config object when SPOTIFY_CLIENT_ID is set", async () => {
    // Save and override env
    const orig = process.env.SPOTIFY_CLIENT_ID;
    process.env.SPOTIFY_CLIENT_ID = "test_id_123";
    // Clear module cache by using dynamic import with cache bust
    const { config } = await import(`../src/config.mjs?t=${Date.now()}`);
    assert.equal(config.SPOTIFY_CLIENT_ID, "test_id_123");
    assert.equal(config.PORT, 8888);
    assert.equal(config.CLASSIFIER_MODE, "hybrid");
    assert.equal(typeof config.CLASSIFIER_THRESHOLD, "number");
    assert.throws(() => { config.PORT = 9999; }, TypeError);
    // Restore
    if (orig !== undefined) process.env.SPOTIFY_CLIENT_ID = orig;
    else delete process.env.SPOTIFY_CLIENT_ID;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement src/config.mjs**

Extract all env var parsing from server.mjs lines 20-43. Parse, validate, freeze, export.

```js
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
if (!CLIENT_ID) {
  console.error("Missing SPOTIFY_CLIENT_ID env var. Set it in .env or environment.");
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 8888);
const CLASSIFIER_MODE = process.env.CLASSIFIER_MODE ?? "hybrid";
const VALID_MODES = ["hybrid", "keywords", "audio"];
if (!VALID_MODES.includes(CLASSIFIER_MODE)) {
  console.error(`Invalid CLASSIFIER_MODE "${CLASSIFIER_MODE}". Must be one of: ${VALID_MODES.join(", ")}`);
  process.exit(1);
}

export const config = Object.freeze({
  SPOTIFY_CLIENT_ID: CLIENT_ID,
  PORT,
  REDIRECT_URI: process.env.SPOTIFY_REDIRECT_URI ?? `http://127.0.0.1:${PORT}/callback`,
  POLL_MINUTES: Number(process.env.POLL_MINUTES ?? 5),
  DEDUP_MINUTES: Number(process.env.DEDUP_MINUTES ?? 60),
  PLAYLIST_VISIBILITY: process.env.PLAYLIST_VISIBILITY ?? "private",

  CLASSIFIER_MODE,
  CLASSIFIER_THRESHOLD: Number(process.env.CLASSIFIER_THRESHOLD ?? 0.40),
  CLASSIFIER_THRESHOLDS_JSON: process.env.CLASSIFIER_THRESHOLDS_JSON ?? "",
  MULTI_LABEL_ENABLED: (process.env.MULTI_LABEL_ENABLED ?? "true").toLowerCase() !== "false",
  MULTI_LABEL_MARGIN: Number(process.env.MULTI_LABEL_MARGIN ?? 0.08),
  MULTI_LABEL_MAX: Number(process.env.MULTI_LABEL_MAX ?? 3),

  LLM_FALLBACK_ENABLED: (process.env.LLM_FALLBACK_ENABLED ?? "false").toLowerCase() === "true",
  LLM_FALLBACK_MODEL: process.env.LLM_FALLBACK_MODEL ?? "gpt-4o-mini",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",

  WANDB_ENABLED: (process.env.WANDB_ENABLED ?? "true").toLowerCase() !== "false",
  WANDB_ENTITY: process.env.WANDB_ENTITY ?? "dipy_genai",
  WANDB_PROJECT: process.env.WANDB_PROJECT ?? "vibe-classification-spotify",

  STATE_PATH: process.env.STATE_PATH ?? path.join(__dirname, "..", "state.json"),
  TRAINING_DATA_PATH: process.env.TRAINING_DATA_PATH ?? path.join(__dirname, "..", "eval", "training_data.json"),

  SCOPES: [
    "user-library-read",
    "playlist-read-private",
    "playlist-modify-private",
    "playlist-modify-public",
    "user-read-private"
  ],

  REWIND_MAX_TRACKS: Number(process.env.REWIND_MAX_TRACKS ?? 5000),
  REWIND_AUDIO_SAMPLE_MAX: Number(process.env.REWIND_AUDIO_SAMPLE_MAX ?? 1200),
  REWIND_AUDIO_SAMPLE_PER_YEAR: Number(process.env.REWIND_AUDIO_SAMPLE_PER_YEAR ?? 180),
  AUDIO_FEATURES_CACHE_TTL_MS: Number(process.env.AUDIO_FEATURES_CACHE_TTL_MS ?? 7 * 24 * 60 * 60 * 1000),
  AUDIO_FEATURES_CACHE_NULL_TTL_MS: Number(process.env.AUDIO_FEATURES_CACHE_NULL_TTL_MS ?? 60 * 60 * 1000),
  SPOTIFY_MAX_RETRIES: Number(process.env.SPOTIFY_MAX_RETRIES ?? 4),
  REWIND_COMPARE_CACHE_TTL_MS: Number(process.env.REWIND_COMPARE_CACHE_TTL_MS ?? 10 * 60_000),
});
```

- [ ] **Step 4: Implement src/state.mjs**

Extract loadState/saveState/setState from server.mjs lines 63-75.

```js
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
```

- [ ] **Step 5: Run tests**

Run: `SPOTIFY_CLIENT_ID=test_id_123 node --test test/config.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config.mjs src/state.mjs test/config.test.mjs
git commit -m "feat: extract config validation and state persistence modules"
```

---

### Task 3: Extract src/logger.mjs

**Files:**
- Create: `src/logger.mjs`

- [ ] **Step 1: Implement src/logger.mjs**

Structured JSON logging + W&B integration extracted from wandb_logger.mjs.

```js
let weave = null;
let wandbEnabled = false;
let pollSummaryOp = null;
let trackClassificationOp = null;
let errorOp = null;

function formatLog(level, msg, ctx = {}) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...((Object.keys(ctx).length > 0) ? { ctx } : {})
  });
}

export const logger = {
  debug(msg, ctx) { console.debug(formatLog("debug", msg, ctx)); },
  info(msg, ctx) { console.log(formatLog("info", msg, ctx)); },
  warn(msg, ctx) { console.warn(formatLog("warn", msg, ctx)); },
  error(msg, ctx) { console.error(formatLog("error", msg, ctx)); },
};

export async function initWandb({ entity, project, service = "spotify-vibe-router" } = {}) {
  const e = (entity || "").trim();
  const p = (project || "").trim();
  if (!e || !p) {
    logger.warn("W&B logging disabled: missing entity/project");
    return false;
  }
  try {
    weave = await import("weave");
    await weave.init(`${e}/${p}`);
    pollSummaryOp = weave.op(async function vibe_router_poll_summary(payload) {
      return { ok: true, service, loggedAtMs: Date.now(), ...payload };
    });
    trackClassificationOp = weave.op(async function vibe_router_track_classification(payload) {
      return { ok: true, service, loggedAtMs: Date.now(), ...payload };
    });
    errorOp = weave.op(async function vibe_router_error(payload) {
      return { ok: true, service, loggedAtMs: Date.now(), ...payload };
    });
    wandbEnabled = true;
    logger.info(`W&B logging enabled -> ${e}/${p}`);
    return true;
  } catch (error) {
    wandbEnabled = false;
    logger.warn(`W&B logging disabled: ${error?.message ?? String(error)}`);
    return false;
  }
}

async function safeLog(op, payload) {
  if (!wandbEnabled || !op) return;
  try { await op(payload); } catch (error) {
    logger.warn(`W&B log failed: ${error?.message ?? String(error)}`);
  }
}

export async function logPollSummary(payload) { await safeLog(pollSummaryOp, payload); }
export async function logTrackClassification(payload) { await safeLog(trackClassificationOp, payload); }
export async function logWandbError(payload) { await safeLog(errorOp, payload); }

export async function finishWandb() {
  if (!wandbEnabled || !weave) return;
  try {
    if (typeof weave.finish === "function") await weave.finish();
  } catch (error) {
    logger.warn(`W&B finish failed: ${error?.message ?? String(error)}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/logger.mjs
git commit -m "feat: add structured JSON logger with optional W&B integration"
```

---

### Task 4: Extract src/vibes.mjs

**Files:**
- Create: `src/vibes.mjs`

- [ ] **Step 1: Copy vibes.mjs into src/**

Copy `vibes.mjs` to `src/vibes.mjs` — contents are identical.

- [ ] **Step 2: Commit**

```bash
git add src/vibes.mjs
git commit -m "feat: move vibes taxonomy to src/"
```

---

### Task 5: Extract src/spotify/client.mjs

**Files:**
- Create: `src/spotify/client.mjs`

- [ ] **Step 1: Implement src/spotify/client.mjs**

Extract spotifyFetch + rate state from server.mjs lines 116-157.

```js
import { config } from "../config.mjs";
import { logger } from "../logger.mjs";

const rateState = { rate429: 0, retries: 0, lastRateLimitAtMs: null, lastRetryAtMs: null };

export function getRateState() {
  return { ...rateState };
}

export async function spotifyFetch(url, accessToken, init = {}) {
  const maxRetries = config.SPOTIFY_MAX_RETRIES;

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
      rateState.rate429 += 1;
      rateState.lastRateLimitAtMs = Date.now();
    }

    if (retriable && attempt < maxRetries) {
      const baseMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(20_000, 400 * (2 ** attempt));
      const jitterMs = Math.floor(Math.random() * 250);
      const waitMs = baseMs + jitterMs;
      rateState.retries += 1;
      rateState.lastRetryAtMs = Date.now();
      logger.warn(`Spotify ${res.status} retry ${attempt + 1}/${maxRetries} in ${waitMs}ms`, { url });
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    const errorText = await res.text();
    logger.error(`Spotify API error`, { url, status: res.status, body: errorText });
    throw new Error(`Spotify ${res.status}: ${errorText}`);
  }

  throw new Error("Spotify request failed after retries");
}

export async function postForm(url, bodyObj) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(bodyObj)
  });
  if (!res.ok) throw new Error(`Token endpoint ${res.status}: ${await res.text()}`);
  return await res.json();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/spotify/client.mjs
git commit -m "feat: extract Spotify HTTP client with retry and rate limit tracking"
```

---

### Task 6: Extract src/spotify/auth.mjs

**Files:**
- Create: `src/spotify/auth.mjs`

- [ ] **Step 1: Implement src/spotify/auth.mjs**

Extract PKCE helpers, token refresh, login/callback logic from server.mjs lines 77-182 and 1498-1551.

```js
import crypto from "node:crypto";
import { config } from "../config.mjs";
import { loadState, setState } from "../state.mjs";
import { spotifyFetch, postForm } from "./client.mjs";

function base64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function makeVerifier(len = 64) {
  return base64Url(crypto.randomBytes(len));
}

export function makeChallenge(verifier) {
  return base64Url(crypto.createHash("sha256").update(verifier).digest());
}

function isExpired(token, skewMs = 30_000) {
  const expiresAt = token.obtained_at_ms + token.expires_in * 1000;
  return Date.now() + skewMs >= expiresAt;
}

export async function refreshIfNeeded() {
  const s = loadState();
  if (!s.token) throw new Error("Not authenticated");
  if (!isExpired(s.token)) return s.token;
  if (!s.token.refresh_token) throw new Error("Expired and no refresh_token; reauth");

  const refreshed = await postForm("https://accounts.spotify.com/api/token", {
    grant_type: "refresh_token",
    refresh_token: s.token.refresh_token,
    client_id: config.SPOTIFY_CLIENT_ID
  });

  const next = {
    access_token: refreshed.access_token,
    token_type: refreshed.token_type,
    expires_in: refreshed.expires_in,
    refresh_token: s.token.refresh_token,
    scope: refreshed.scope,
    obtained_at_ms: Date.now()
  };

  setState({ token: next });
  return next;
}

const authState = { healthy: false, lastCheckedAtMs: null, lastError: null };

export function getAuthState() {
  return { ...authState };
}

export async function updateAuthHealth() {
  try {
    const token = await refreshIfNeeded();
    await spotifyFetch("https://api.spotify.com/v1/me", token.access_token);
    authState.healthy = true;
    authState.lastCheckedAtMs = Date.now();
    authState.lastError = null;
    return true;
  } catch (error) {
    authState.healthy = false;
    authState.lastCheckedAtMs = Date.now();
    authState.lastError = error?.message ?? String(error);
    return false;
  }
}

export function setAuthUnhealthy(errorMsg) {
  authState.healthy = false;
  authState.lastCheckedAtMs = Date.now();
  authState.lastError = errorMsg;
}

export function computeRedirectUri(req) {
  const forced = (process.env.SPOTIFY_REDIRECT_URI || "").trim();
  if (forced) return forced;
  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${config.PORT}`;
  const protoHdr = req.headers["x-forwarded-proto"] || "http";
  const proto = String(protoHdr).split(",")[0].trim() || "http";
  return `${proto}://${host}/callback`;
}

export function handleLogin(req) {
  const verifier = makeVerifier();
  const challenge = makeChallenge(verifier);
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = computeRedirectUri(req);
  setState({ pkce: { verifier }, oauthState: state, oauthRedirectUri: redirectUri });

  const auth = new URL("https://accounts.spotify.com/authorize");
  auth.searchParams.set("client_id", config.SPOTIFY_CLIENT_ID);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("scope", config.SCOPES.join(" "));
  auth.searchParams.set("state", state);
  return auth.toString();
}

export async function handleCallback(req, u) {
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
    client_id: config.SPOTIFY_CLIENT_ID,
    code_verifier: s.pkce.verifier
  });

  const stored = {
    access_token: tok.access_token,
    token_type: tok.token_type,
    expires_in: tok.expires_in,
    refresh_token: tok.refresh_token,
    scope: tok.scope,
    obtained_at_ms: Date.now()
  };

  setState({ token: stored });
  return stored;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/spotify/auth.mjs
git commit -m "feat: extract Spotify OAuth PKCE auth module"
```

---

### Task 7: Extract src/spotify/api.mjs

**Files:**
- Create: `src/spotify/api.mjs`

- [ ] **Step 1: Implement src/spotify/api.mjs**

Extract Spotify API operations from server.mjs: listAllPlaylists, ensurePlaylists, getAudioFeatures, addTrackToPlaylist, fetchSavedTracksHistory, getRewindItems. Include the audioFeaturesCache and rewindTracksCache here.

This file contains:
- `listAllPlaylists(accessToken)` — paginated playlist fetch (lines 200-209)
- `ensurePlaylists(accessToken)` — create missing vibe playlists (lines 236-262)
- `getAudioFeatures(accessToken, ids)` — batched with caching (lines 264-317)
- `addTrackToPlaylist(accessToken, playlistId, trackUri)` — (lines 319-330)
- `fetchSavedTracksHistory(accessToken, maxTracks)` — paginated liked songs (lines 211-224)
- `getRewindItems(accessToken)` — cached wrapper (lines 226-234)

Import config for cache TTLs, import spotifyFetch from client, import VIBES, import state for playlist map persistence.

- [ ] **Step 2: Commit**

```bash
git add src/spotify/api.mjs
git commit -m "feat: extract Spotify API operations (playlists, tracks, audio features)"
```

---

### Task 8: Extract classifier modules

**Files:**
- Create: `src/classifier/keywords.mjs`
- Create: `src/classifier/audio.mjs`
- Create: `src/classifier/priors.mjs`
- Create: `src/classifier/index.mjs`
- Create: `test/classifier.test.mjs`

- [ ] **Step 1: Write classifier tests**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Need SPOTIFY_CLIENT_ID for config import chain
process.env.SPOTIFY_CLIENT_ID = "test_classifier";

import { scoreKeywords } from "../src/classifier/keywords.mjs";
import { scoreAudioFeatures } from "../src/classifier/audio.mjs";
import { classifyWithDiagnostics } from "../src/classifier/index.mjs";

describe("keywords classifier", () => {
  it("scores workout track as menace_mileage", () => {
    const track = { name: "Beast Mode Workout Mix", artists: ["DJ Pump"], explicit: false, duration_ms: 200000 };
    const scores = scoreKeywords(track);
    const menace = scores.find(s => s.key === "menace_mileage");
    assert.ok(menace, "should have menace_mileage score");
    assert.ok(menace.score > 0, "score should be positive");
  });

  it("scores instrumental track as terminal_serenity", () => {
    const track = { name: "Ambient Study Session", artists: ["Lofi Beats"], explicit: false, duration_ms: 300000 };
    const scores = scoreKeywords(track);
    const serenity = scores.find(s => s.key === "terminal_serenity");
    assert.ok(serenity, "should have terminal_serenity score");
  });
});

describe("audio features classifier", () => {
  it("scores high energy + tempo as neon_cardio", () => {
    const af = { energy: 0.8, valence: 0.6, tempo: 140, danceability: 0.7, acousticness: 0.1, speechiness: 0.05, instrumentalness: 0.1 };
    const scores = scoreAudioFeatures(af);
    const neon = scores.find(s => s.key === "neon_cardio");
    assert.ok(neon, "should have neon_cardio score");
    assert.ok(neon.score >= 0.75);
  });

  it("returns empty array for null audio features", () => {
    const scores = scoreAudioFeatures(null);
    assert.deepEqual(scores, []);
  });
});

describe("classifyWithDiagnostics", () => {
  it("returns diagnostics object with expected shape", async () => {
    const track = { name: "Test Song", artists: ["Artist"], explicit: false, duration_ms: 200000 };
    const result = await classifyWithDiagnostics(track, null, { mode: "keywords", threshold: 0.4 });
    assert.ok(Array.isArray(result.finalKeys));
    assert.ok(Array.isArray(result.mergedScores));
    assert.equal(result.mode, "keywords");
    assert.equal(typeof result.confidence, "number");
    assert.ok(["high", "medium", "low"].includes(result.confidenceBand));
  });

  it("uses uncertain fallback when no scores meet threshold", async () => {
    const track = { name: "Zzzzz", artists: ["Nobody"], explicit: false, duration_ms: 200000 };
    const result = await classifyWithDiagnostics(track, null, { mode: "keywords", threshold: 0.99 });
    assert.ok(result.finalKeys.length > 0, "should have at least one final key");
    // Should not be 'uncertain' since allowUncertain defaults to false
    assert.notEqual(result.finalKeys[0], "uncertain");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SPOTIFY_CLIENT_ID=test node --test test/classifier.test.mjs`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement src/classifier/keywords.mjs**

Extract keyword/regex rules from adjusted_smart_classify.mjs lines 83-103 and classify.mjs fallback heuristics (lines 68-165).

```js
export function scoreKeywords(track) {
  const t = (track.name + " " + track.artists.join(" ")).toLowerCase();
  const scores = [];
  const push = (key, score, why) => scores.push({ key, score, why });

  // Track title / artist keyword cues
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

  // Artist-based genre heuristics
  const artistString = track.artists.join(" ").toLowerCase();
  if (artistString.includes("bhat") || artistString.includes("donn") || artistString.includes("indian") || artistString.includes("bollywood") || artistString.includes("hindi") || artistString.includes("desi")) {
    push("cashmere_bg", 0.4, "indian/desi music");
  }

  // Genre indicators from artist/title text (fallback heuristics from classify.mjs)
  if (artistString.includes("classical") || t.includes("symphony") || t.includes("orchestra") || t.includes("piano") || t.includes("string quartet") || t.includes("concerto")) {
    push("honeyed_home", 0.45, "classical/piano indicator");
    push("windowseat_auteur", 0.4, "classical - cinematic");
  }
  if (artistString.includes("edm") || artistString.includes("electronic") || artistString.includes("house") || artistString.includes("techno") || artistString.includes("trance") || t.includes("drop")) {
    push("neon_cardio", 0.5, "electronic/dance indicator");
    push("velvet_rope", 0.45, "electronic - club");
  }
  if (artistString.includes("hip hop") || artistString.includes("rap") || t.includes("feat") || t.includes("ft.") || t.includes("mixtape")) {
    push("iron_irreverence", 0.45, "hip hop/rap indicator");
    if (track.explicit) push("iron_irreverence", 0.55, "explicit hip hop");
  }
  if (artistString.includes("jazz") || t.includes("smooth jazz") || t.includes("bebop")) {
    push("cashmere_bg", 0.5, "jazz indicator");
    push("honeyed_home", 0.4, "jazz - cozy");
  }
  if (artistString.includes("lofi") || t.includes("lofi") || t.includes("chillhop") || t.includes("study beats") || t.includes("focus music")) {
    push("terminal_serenity", 0.6, "lofi/chill indicator");
    push("commit_season", 0.5, "focus music");
  }
  if (artistString.includes("metal") || artistString.includes("rock") || t.includes("heavy") || t.includes("aggressive") || t.includes("hardcore")) {
    push("menace_mileage", 0.5, "metal/rock indicator");
    if (track.explicit) push("iron_irreverence", 0.55, "aggressive explicit rock");
  }
  if (artistString.includes("indie") || artistString.includes("alternative") || t.includes("indie") || t.includes("alternative")) {
    push("gallery_opening", 0.45, "indie/alternative indicator");
    push("left_of_groove", 0.4, "alternative - experimental");
  }

  // Mood indicators
  if (t.includes("love") || t.includes("romance") || t.includes("heart") || t.includes("affection") || t.includes("passion")) push("monochrome_martini", 0.4, "romantic theme");
  if (t.includes("rain") || t.includes("storm") || t.includes("thunder") || t.includes("nature") || t.includes("forest")) {
    push("terminal_serenity", 0.5, "nature/ambient theme");
    push("windowseat_auteur", 0.4, "nature - cinematic");
  }
  if (t.includes("coffee") || t.includes("cafe") || t.includes("morning") || t.includes("breakfast") || t.includes("sunrise")) {
    push("sunlit_recal", 0.5, "morning/cafe theme");
    push("cashmere_bg", 0.4, "cozy morning");
  }

  // Duration-based
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

  // Explicit content
  if (track.explicit) push("iron_irreverence", 0.5, "explicit content");

  return scores;
}
```

- [ ] **Step 4: Implement src/classifier/audio.mjs**

Extract audio feature scoring from adjusted_smart_classify.mjs lines 105-129.

```js
export function scoreAudioFeatures(af) {
  if (!af) return [];

  const scores = [];
  const push = (key, score, why) => scores.push({ key, score, why });
  const { energy, valence, tempo, danceability, acousticness, speechiness, instrumentalness } = af;

  // Motion
  if (tempo >= 130 && energy >= 0.65) push("neon_cardio", 0.75, "high tempo + high energy");
  if (tempo >= 105 && energy >= 0.5 && tempo < 140) push("fast_not_furious", 0.55, "medium-high tempo + energy");
  if (danceability >= 0.7 && energy >= 0.55) push("errandcore", 0.5, "danceable + upbeat");

  // Cool/social
  if (danceability >= 0.6 && energy >= 0.45 && valence >= 0.35 && valence <= 0.7) push("monochrome_martini", 0.45, "balanced valence + danceability");
  if (danceability >= 0.7 && energy >= 0.65) push("velvet_rope", 0.6, "club-ready energy + danceability");

  // Cozy
  if (acousticness >= 0.55 && energy <= 0.55) push("honeyed_home", 0.55, "acoustic + not too energetic");
  if (energy <= 0.45 && valence >= 0.35 && acousticness >= 0.25) push("cashmere_bg", 0.45, "warm low-energy");

  // Introspective
  if (valence <= 0.4 && energy <= 0.55) push("soft_focus", 0.55, "low valence + moderate/low energy");
  if (valence <= 0.35 && tempo <= 115) push("afterhours", 0.45, "late-night low valence/tempo");
  if (energy <= 0.5 && tempo <= 120) push("abysride", 0.35, "transit-friendly pacing");
  if (instrumentalness >= 0.5 || (energy <= 0.5 && speechiness <= 0.07)) push("windowseat_auteur", 0.4, "spacious/instrumental leaning");

  // Experimental
  if (energy >= 0.65 && danceability <= 0.45) push("left_of_groove", 0.5, "high energy but not danceable");
  if (speechiness <= 0.04 && instrumentalness >= 0.3 && valence >= 0.2 && valence <= 0.6) push("glitch_grace", 0.45, "textural/instrumental blend");

  // Gym menace
  if (energy >= 0.8 && tempo >= 120) push("menace_mileage", 0.6, "very high energy + tempo");

  // Sad bangers
  if (valence <= 0.35 && energy >= 0.6) push("tearjerk_subwoofers", 0.6, "sad valence but high energy");
  if (valence <= 0.4 && danceability >= 0.6) push("crying_designer", 0.5, "sad-ish but danceable");

  // Reset
  if (valence >= 0.45 && energy <= 0.55 && tempo <= 125) push("sunlit_recal", 0.45, "light valence + calm energy");
  if (acousticness >= 0.4 && valence >= 0.45 && energy <= 0.55) push("linen_day", 0.45, "soft acoustic reset");

  // Cooking
  if (tempo >= 85 && tempo <= 120 && danceability >= 0.55 && energy <= 0.7) push("decant_dance", 0.45, "mid tempo groove");
  if (tempo <= 110 && energy <= 0.6 && valence >= 0.35) push("stove_clock", 0.4, "unhurried, warm");

  // Focus
  if (instrumentalness >= 0.6 || (speechiness <= 0.05 && energy >= 0.35 && energy <= 0.65)) push("commit_season", 0.5, "low lyrical distraction + steady energy");
  if (energy <= 0.55 && instrumentalness >= 0.4) push("terminal_serenity", 0.5, "calm instrumental");

  // Aggressive (needs explicit check from track, but we only have af here — caller merges)
  if (energy >= 0.85 && speechiness >= 0.08) push("iron_irreverence", 0.55, "aggressive energy + speechiness");

  return scores;
}
```

- [ ] **Step 5: Implement src/classifier/priors.mjs**

Extract Bayesian priors from adjusted_smart_classify.mjs lines 8-71.

```js
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
```

- [ ] **Step 6: Implement src/classifier/index.mjs**

Orchestrator combining all layers, from adjusted_smart_classify.mjs `classifyWithDiagnostics` (lines 195-250).

```js
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
```

- [ ] **Step 7: Run classifier tests**

Run: `SPOTIFY_CLIENT_ID=test node --test test/classifier.test.mjs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/classifier/
git add test/classifier.test.mjs
git commit -m "feat: extract classifier into keywords, audio, priors, and orchestrator modules"
```

---

### Task 9: Extract src/poller.mjs

**Files:**
- Create: `src/poller.mjs`

- [ ] **Step 1: Implement src/poller.mjs**

Extract pollOnce from server.mjs lines 485-702, plus multi-label logic, LLM fallback, analytics append helpers. This is the orchestration layer.

Imports: config, state, spotify/auth, spotify/api, classifier/index, logger, vibes.

Exports:
- `pollOnce()` — single poll cycle
- `startPolling(intervalMs)` — starts setInterval, returns cleanup fn
- `stopPolling()` — clears interval
- `getPollState()` — returns copy of pollState
- `llmFallbackVibe(track, candidateScores)` — LLM fallback (moved here)
- Analytics helpers: `appendAnalyticsPoll`, `appendAnalyticsTrack`, `setManualLabel`, `setManualLabels`, `appendOnlineTrainingExample`, `computeQualitySnapshot`

- [ ] **Step 2: Commit**

```bash
git add src/poller.mjs
git commit -m "feat: extract poll loop and classification orchestration"
```

---

### Task 10: Extract public/ UI files

**Files:**
- Create: `public/index.html`
- Create: `public/style.css`
- Create: `public/app.js`

- [ ] **Step 1: Extract CSS from server.mjs**

Take the `<style>` block from the `html()` template (lines 724-789) into `public/style.css`.

Also include the font import: `@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');`

- [ ] **Step 2: Extract JS from server.mjs**

Take the `<script>` block (lines 971-1485) into `public/app.js`.

The `vibes` array will be fetched from a new `/api/vibes` endpoint instead of being inlined with `${JSON.stringify(VIBES.map(v => v.key))}`. Add a fetch at the top of app.js:

```js
let vibes = [];
// Fetch vibes from server instead of inline template
fetch('/api/vibes').then(r => r.json()).then(data => {
  vibes = data.vibes || [];
  showTab('overview');
  updateLowApiUi();
  refreshAll();
});
```

Remove the inlined `const vibes = ...` and the trailing `showTab/updateLowApiUi/refreshAll` calls from the bottom — they happen in the fetch callback above.

- [ ] **Step 3: Extract HTML into public/index.html**

Build the full HTML document. Reference the external CSS and JS:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="theme-color" content="#06331D" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Vibe Router" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/icon.svg" />
  <link rel="stylesheet" href="/style.css" />
  <title>Spotify Vibe Router</title>
</head>
<body>
  <div class="wrap">
    <!-- dashboard sections: hero, main-layout, etc. from lines 858-968 -->
    <!-- NOTE: the auth status and buttons are static HTML; app.js fetches and updates dynamically -->
  </div>
  <script src="/app.js"></script>
</body>
</html>
```

The `index.html` body content comes from the template in lines 858-968 of server.mjs. Remove the dynamic auth check (line 850-854); instead, have `app.js` fetch `/api/system-info` to check auth state and update the UI dynamically.

- [ ] **Step 4: Commit**

```bash
git add public/
git commit -m "feat: extract dashboard UI into static HTML/CSS/JS files"
```

---

### Task 11: Build src/routes.mjs and src/server.mjs

**Files:**
- Create: `src/routes.mjs`
- Create: `src/server.mjs`

- [ ] **Step 1: Implement src/routes.mjs**

Extract all API route handlers from server.mjs into functions. Each handler has signature `async (req, res, url)`.

Exports:
- `handleRunOnce(req, res)` — lines 1491-1496
- `handleLogin(req, res)` — delegates to spotify/auth
- `handleCallback(req, res, u)` — delegates to spotify/auth + ensurePlaylists
- `handleTestPlaylistAdd(req, res)` — lines 1554-1595
- `handleRecentTracks(req, res)` — lines 1598-1617
- `handleApiAnalytics(req, res)` — lines 1619-1646
- `handleApiLowConfidence(req, res)` — lines 1648-1663
- `handleApiRewind(req, res, u)` — lines 1665-1827
- `handleApiRewindCompare(req, res, u)` — lines 1829-1998
- `handleApiLabelTrack(req, res, u)` — lines 2001-2025
- `handleApiDismissLowConfidence(req, res, u)` — lines 2027-2041
- `handleApiLabelTrackMulti(req, res, u)` — lines 2043-2068
- `handleApiCalibrateThresholds(req, res)` — lines 2070-2097
- `handleApiSystemInfo(req, res)` — lines 2099-2135
- `handleApiLogs(req, res)` — lines 2137-2157
- `handleApiLogsClear(req, res)` — lines 2159-2172
- `handleDiagnoseAudioFeatures(req, res, u)` — lines 2262-2288
- `handleApiVibes(req, res)` — NEW: returns `{ vibes: VIBES.map(v => v.key) }`

- [ ] **Step 2: Implement src/server.mjs (entry point)**

The main server module:
- Creates HTTP server
- Route dispatch (if/else chain or Map-based)
- Static file serving for `public/` (index.html, style.css, app.js, plus manifest, icon, sw.js)
- `GET /healthz` → `{ status: "ok", authenticated, lastPollAt }`
- Graceful shutdown on SIGTERM/SIGINT
- Starts W&B if enabled
- Starts poll interval
- Listens on configured PORT

Static file serving: read files from `public/` directory relative to `src/`, serve with correct Content-Type based on extension. For `/`, serve `public/index.html`.

Keep the manifest.webmanifest, sw.js, and icon.svg inline handlers (they're small generated content).

Legacy HTML pages (`/analytics`, `/logs`, `/system`, `/dashboard`) — redirect to `/?tab=<name>` or remove entirely since the SPA handles them via tabs.

Graceful shutdown:
```js
let shutdownInProgress = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    logger.info(`Received ${sig}, shutting down...`);
    stopPolling();
    server.close(() => {
      logger.info("HTTP server closed");
    });
    await finishWandb();
    // Force exit after timeout
    setTimeout(() => { process.exit(1); }, 10_000);
    process.exit(0);
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/routes.mjs src/server.mjs
git commit -m "feat: build HTTP server with route handlers, static serving, health check, graceful shutdown"
```

---

### Task 12: Move eval tooling

**Files:**
- Move: `training_data.json` → `eval/training_data.json`
- Move: `evaluate_dataset.mjs` → `eval/evaluate_dataset.mjs`
- Move: `build_training_data.mjs` → `eval/build_training_data.mjs`
- Move: `run_wandb_experiments.py` → `eval/run_wandb_experiments.py`
- Move: `create_ablation_report.py` → `eval/create_ablation_report.py`

- [ ] **Step 1: Move files**

```bash
git mv training_data.json eval/training_data.json
git mv evaluate_dataset.mjs eval/evaluate_dataset.mjs
git mv build_training_data.mjs eval/build_training_data.mjs
git mv run_wandb_experiments.py eval/run_wandb_experiments.py
git mv create_ablation_report.py eval/create_ablation_report.py
```

- [ ] **Step 2: Update import paths in eval files**

In `eval/evaluate_dataset.mjs`: change `import { classifyWithDiagnostics } from "./adjusted_smart_classify.mjs"` → `import { classifyWithDiagnostics } from "../src/classifier/index.mjs"`

In `eval/build_training_data.mjs`: update the import of VIBES → `import { VIBES } from "../src/vibes.mjs"`

In `eval/run_wandb_experiments.py`: update the node command path → `["node", "eval/evaluate_dataset.mjs", ...]`

- [ ] **Step 3: Commit**

```bash
git add eval/
git commit -m "refactor: move evaluation tooling to eval/ directory"
```

---

### Task 13: Adapt smoke test

**Files:**
- Create: `test/ui-smoke.test.mjs`

- [ ] **Step 1: Implement test/ui-smoke.test.mjs**

Adapt from existing `test_ui_smoke.mjs` to use node:test and check the new endpoints:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8888";

describe("UI smoke test", () => {
  it("serves index.html at /", async () => {
    const r = await fetch(base + "/");
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes("Spotify Vibe Router"), "should contain app title");
    assert.ok(html.includes("app.js"), "should reference app.js");
  });

  it("serves /healthz", async () => {
    const r = await fetch(base + "/healthz");
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, "ok");
  });

  it("serves /api/vibes", async () => {
    const r = await fetch(base + "/api/vibes");
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.vibes));
    assert.ok(j.vibes.length > 20);
  });

  it("serves static CSS", async () => {
    const r = await fetch(base + "/style.css");
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("content-type").includes("css"));
  });

  it("serves static JS", async () => {
    const r = await fetch(base + "/app.js");
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("content-type").includes("javascript"));
  });
});
```

Note: This test requires a running server. Run with `npm start &` first or mark as integration test.

- [ ] **Step 2: Commit**

```bash
git add test/ui-smoke.test.mjs
git commit -m "feat: add UI smoke test for static files, health, and vibes endpoint"
```

---

### Task 14: Delete old root files and update docs

**Files:**
- Delete: `server.mjs`, `classify.mjs`, `smart_classify.mjs`, `simple_smart_classify.mjs`, `adjusted_smart_classify.mjs`, `vibes.mjs`, `wandb_logger.mjs`, `test_smart_classifier.mjs`, `test_smart_classifier_detailed.mjs`, `test_ui_smoke.mjs`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Delete old files**

```bash
git rm server.mjs classify.mjs smart_classify.mjs simple_smart_classify.mjs adjusted_smart_classify.mjs vibes.mjs wandb_logger.mjs test_smart_classifier.mjs test_smart_classifier_detailed.mjs test_ui_smoke.mjs
```

- [ ] **Step 2: Update README.md**

Update commands section:
- `node server.mjs` → `npm start` or `node src/server.mjs`
- Update "Files to know" section with new `src/` structure
- Add Docker section
- Update eval commands to use `eval/` paths

- [ ] **Step 3: Update CLAUDE.md**

Reflect new directory structure, commands, and file locations.

- [ ] **Step 4: Update AGENTS.md**

Update file structure section and command paths.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove old root files, update documentation for new structure"
```

---

### Task 15: End-to-end verification

- [ ] **Step 1: Run unit tests**

Run: `SPOTIFY_CLIENT_ID=test node --test test/config.test.mjs test/classifier.test.mjs`
Expected: All PASS

- [ ] **Step 2: Verify server starts**

Run: `SPOTIFY_CLIENT_ID=test_id node src/server.mjs &`
Expected: Server starts, prints listening URL

- [ ] **Step 3: Run smoke test**

Run: `node --test test/ui-smoke.test.mjs`
Expected: All endpoints respond correctly (some may fail without auth — that's expected)

- [ ] **Step 4: Verify Docker build**

Run: `docker build -t spotify-vibe-router .`
Expected: Image builds successfully

- [ ] **Step 5: Kill test server and commit any fixes**

```bash
pkill -f "node src/server.mjs"
```

- [ ] **Step 6: Final commit if needed**

```bash
git add -A
git commit -m "fix: address issues found during end-to-end verification"
```
