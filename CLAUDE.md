# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Spotify Vibe Router: a Node.js service that polls Liked Songs and auto-routes each track into one of 26 vibe-based playlists using a heuristic classifier. No external dependencies — Node.js built-in modules only (except optional `weave` for W&B logging).

## Commands

```bash
# Run the service (requires SPOTIFY_CLIENT_ID in .env or env)
npm start
# or
node src/server.mjs

# Trigger one classification pass manually
curl -s http://127.0.0.1:8888/run-once | jq .

# Run all tests
npm test

# Run a specific test file
node --test test/classifier.test.mjs
node --test test/config.test.mjs
node --test test/ui-smoke.test.mjs

# Run classifier evaluation against training data
node eval/evaluate_dataset.mjs eval/training_data.json hybrid 0.4

# Run W&B experiment sweep (requires wandb pip package)
python eval/run_wandb_experiments.py

# Generate ablation report
python eval/create_ablation_report.py

# Build training data from existing playlists (reads state.json for auth token)
node eval/build_training_data.mjs
```

## Architecture

**Module structure (src/):**
- `src/server.mjs` — HTTP server entry point; wires up routes and starts the poller
- `src/routes.mjs` — Express/http route handlers
- `src/poller.mjs` — poll loop orchestration (interval, run-once logic)
- `src/config.mjs` — configuration loading, validation, and defaults
- `src/state.mjs` — state load/save (tokens, playlist mappings, processed track history)
- `src/logger.mjs` — shared logger
- `src/vibes.mjs` — exports the `VIBES` array (26 vibes, each with `key`, `name`, `description`)
- `src/spotify/` — Spotify OAuth PKCE flow, API client, token refresh, playlist/track operations
- `src/classifier/` — vibe classification: keyword regex, audio feature heuristics, Bayesian priors

**Classification pipeline (core flow):**
1. `src/poller.mjs` polls Spotify Liked Songs, fetches audio features, calls classifier, routes tracks to playlists
2. Classification has three layers that produce scores merged together:
   - keyword/regex + audio feature heuristics
   - enhanced classifier with external genre lookup
   - Bayesian priors from `eval/training_data.json` (artist history, album tokens, global vibe distribution)

**Classifier modes** (set via `CLASSIFIER_MODE` env var):
- `hybrid` (default) — keywords + audio features combined
- `keywords` — keyword/regex signals only
- `audio` — audio feature signals only

**Multi-label:** Tracks can be routed to multiple playlists when scores are within `MULTI_LABEL_MARGIN` of top score (configurable).

**State management:** `state.json` (gitignored) stores OAuth tokens, playlist ID mappings, and processed track history.

**public/:** Dashboard UI served as static files (HTML/CSS/JS).

**eval/:** Classifier evaluation tooling — `evaluate_dataset.mjs`, `run_wandb_experiments.py`, `create_ablation_report.py`, `build_training_data.mjs`, `training_data.json`.

**test/:** Node built-in test runner tests — `classifier.test.mjs`, `config.test.mjs`, `ui-smoke.test.mjs`.

## Key Environment Variables

- `SPOTIFY_CLIENT_ID` (required)
- `CLASSIFIER_MODE` — `hybrid` | `keywords` | `audio`
- `CLASSIFIER_THRESHOLD` — confidence threshold (default 0.40)
- `MULTI_LABEL_ENABLED`, `MULTI_LABEL_MARGIN`, `MULTI_LABEL_MAX`
- `WANDB_ENABLED`, `WANDB_ENTITY`, `WANDB_PROJECT`
- `LLM_FALLBACK_ENABLED`, `LLM_FALLBACK_MODEL`, `OPENAI_API_KEY`

## Commit Rules (from AGENTS.md)

Before every commit, check whether behavior, setup, env vars, endpoints, scripts, or architecture changed. If yes, update `README.md` in the same commit so docs stay in sync with code.

## Spotify API Rules

- Use Authorization Code with PKCE flow (never Implicit Grant)
- Use `http://127.0.0.1` for local redirect URIs (not `localhost`)
- Request minimum scopes needed
- Implement exponential backoff on 429s with `Retry-After` header
- Don't use deprecated endpoints (use `/playlists/{id}/items` not `/playlists/{id}/tracks`)
- Refer to official OpenAPI spec at https://developer.spotify.com/reference/web-api/open-api-schema.yaml
