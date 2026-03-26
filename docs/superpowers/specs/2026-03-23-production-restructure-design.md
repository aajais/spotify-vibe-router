# Production Restructure Design

## Goal

Restructure the spotify-vibe-router from a single-file prototype into a well-organized, deployable Node.js service. No new features — just structural improvements, deployment readiness, and maintainability.

## Directory Structure

```
spotify-vibe-router/
├── src/
│   ├── server.mjs          # HTTP server, route dispatch, static files, health, shutdown
│   ├── spotify/
│   │   ├── auth.mjs         # OAuth PKCE flow + token refresh
│   │   ├── client.mjs       # spotifyFetch with retry/backoff/rate-limit tracking
│   │   └── api.mjs          # getLikedSongs, getAudioFeatures, ensurePlaylist, addTracks
│   ├── classifier/
│   │   ├── keywords.mjs     # Keyword/regex scoring rules
│   │   ├── audio.mjs        # Audio feature heuristic scoring
│   │   ├── priors.mjs       # Bayesian priors from training_data.json
│   │   └── index.mjs        # classifyWithDiagnostics — orchestrates modes, merges scores
│   ├── poller.mjs           # Poll loop: fetch → classify → route → dedupe
│   ├── state.mjs            # loadState/saveState/setState (file-based JSON)
│   ├── config.mjs           # Env var parsing, validation, frozen config export
│   ├── logger.mjs           # Structured JSON logging + optional W&B integration
│   └── vibes.mjs            # VIBES array
├── public/
│   ├── index.html           # Extracted from server.mjs inline HTML
│   ├── style.css            # Extracted from inline styles
│   └── app.js               # Extracted from inline JS
├── test/
│   ├── classifier.test.mjs  # Unit tests for classifier layers
│   ├── config.test.mjs      # Config validation tests
│   └── ui-smoke.test.mjs    # Adapted from existing test_ui_smoke.mjs
├── eval/
│   ├── evaluate_dataset.mjs
│   ├── build_training_data.mjs
│   ├── run_wandb_experiments.py
│   ├── create_ablation_report.py
│   └── training_data.json
├── package.json
├── Dockerfile
├── .dockerignore
├── .env.example
├── .gitignore
├── CLAUDE.md
├── AGENTS.md
└── README.md
```

## Module Decomposition (from server.mjs)

### src/config.mjs
- Parses all env vars with defaults
- Validates: SPOTIFY_CLIENT_ID required, numerics are numbers, CLASSIFIER_MODE in allowed set
- Exports a frozen config object
- Fails fast on startup with clear error messages

### src/state.mjs
- `loadState()` / `saveState(s)` / `setState(patch)` — unchanged logic
- Uses STATE_PATH from config
- Exports pure functions, no module-level state

### src/spotify/auth.mjs
- `makeVerifier()`, `makeChallenge()`, `buildLoginUrl()`, `exchangeCode()`, `refreshIfNeeded()`
- PKCE crypto helpers
- Reads/writes tokens via state.mjs
- Exports handler functions for /login and /callback routes

### src/spotify/client.mjs
- `spotifyFetch(url, accessToken, init)` with exponential backoff + jitter
- Rate limit state tracking (429 count, retry count, timestamps)
- Exports `getRateState()` for health/diagnostics

### src/spotify/api.mjs
- `getLikedSongs(token, limit)` → fetches /me/tracks
- `getAudioFeatures(token, trackIds)` → batched /audio-features with 403 fallback
- `ensurePlaylist(token, userId, name, visibility)` → find-or-create
- `addTracksToPlaylist(token, playlistId, uris)` → POST items
- Uses client.mjs for all HTTP calls

### src/classifier/keywords.mjs
- Keyword/regex scoring extracted from classify.mjs
- `scoreKeywords(track)` → array of {key, score, why}

### src/classifier/audio.mjs
- Audio feature heuristic scoring extracted from classify.mjs
- `scoreAudioFeatures(af)` → array of {key, score, why}

### src/classifier/priors.mjs
- Bayesian prior logic from adjusted_smart_classify.mjs
- Loads training_data.json, builds artist→vibe and album-token→vibe maps
- `scorePriors(track)` → array of {key, score, why}

### src/classifier/index.mjs
- `classifyWithDiagnostics(track, audioFeatures, options)` — main entry point
- Orchestrates keyword + audio + prior layers based on CLASSIFIER_MODE
- Merges scores, applies threshold, handles multi-label
- Returns { finalKeys, mergedScores, rawScores, usedAudioFeatures }

### src/poller.mjs
- `startPolling(interval)` / `stopPolling()` — manages the setInterval
- Each tick: refreshIfNeeded → getLikedSongs → classify each → route to playlists → dedupe
- Owns pollState (running, lastStart, lastFinish, errors)
- Logs via logger.mjs, optionally logs to W&B

### src/logger.mjs
- `log(level, msg, ctx)` — writes JSON to stdout: {"ts","level","msg","ctx"}
- Convenience: `logger.info()`, `logger.warn()`, `logger.error()`, `logger.debug()`
- W&B integration: `initWandb()`, `logTrackClassification()`, `logPollSummary()`, `finishWandb()`
- W&B only initializes if WANDB_ENABLED=true and weave is importable

### src/server.mjs (entry point)
- Creates HTTP server
- Route dispatch: /login, /callback, /api/*, /healthz, /run-once, static files from public/
- `GET /healthz` → { status, authenticated, lastPollAt }
- Serves public/ directory for static files
- Graceful shutdown: SIGTERM/SIGINT → stop poller → drain requests → flush W&B → exit
- Shutdown timeout: 10s

## public/ (extracted UI)

The inline HTML/CSS/JS from server.mjs gets extracted into:
- `public/index.html` — the dashboard markup
- `public/style.css` — all styles
- `public/app.js` — all client-side JS (fetch calls, DOM manipulation)

API calls from the frontend stay the same (relative URLs like `/api/analytics`).

## package.json

```json
{
  "name": "spotify-vibe-router",
  "version": "1.0.0",
  "type": "module",
  "engines": { "node": ">=18" },
  "scripts": {
    "start": "node src/server.mjs",
    "test": "node --test test/",
    "test:eval": "node eval/evaluate_dataset.mjs"
  }
}
```

No runtime dependencies. weave is a dynamic optional import.

## .env.example

All env vars with defaults documented. The current .env (which contains a real client ID) gets removed from git tracking.

## Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json .
COPY src/ src/
COPY public/ public/
EXPOSE 8888
HEALTHCHECK CMD wget -qO- http://localhost:8888/healthz || exit 1
CMD ["node", "src/server.mjs"]
```

## .dockerignore

eval/, test/, .env, state.json, .git/, wandb/, docs/, *.md (except needed ones)

## Tests (node:test)

### test/classifier.test.mjs
- Tests each classifier layer independently with known track inputs
- Tests mode switching (hybrid/keywords/audio)
- Tests multi-label behavior
- Tests threshold edge cases
- Tests uncertain fallback when no score meets threshold

### test/config.test.mjs
- Tests default values
- Tests validation errors (missing CLIENT_ID, invalid CLASSIFIER_MODE)
- Tests numeric parsing

### test/ui-smoke.test.mjs
- Adapted from existing test_ui_smoke.mjs
- Checks /healthz, /api/analytics, /api/rewind, /api/system-info
- Checks index.html contains expected UI elements

## Production Hardening

### Structured logging
All console.log/warn/error replaced with logger calls. Output is JSON, one object per line. Parseable by any log aggregator.

### Config validation
Startup fails immediately with descriptive errors if config is invalid. No silent defaults for required values.

### Graceful shutdown
SIGTERM/SIGINT handler: stop poll timer → wait for in-flight poll to finish → flush W&B → close HTTP server → exit 0. Hard timeout at 10s → exit 1.

### Health check
GET /healthz returns authentication status and last poll timestamp. Used by Docker HEALTHCHECK and any external monitoring.

## Migration Notes

- Old root-level files (classify.mjs, smart_classify.mjs, adjusted_smart_classify.mjs, simple_smart_classify.mjs, vibes.mjs, wandb_logger.mjs) are deleted after their logic moves into src/
- Old test files (test_smart_classifier.mjs, test_smart_classifier_detailed.mjs, test_ui_smoke.mjs) are deleted after adapting into test/
- eval/ files are moved, not rewritten — just import paths updated
- state.json location unchanged (project root by default via STATE_PATH)
- .env stays in project root, unchanged
