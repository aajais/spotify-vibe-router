# spotify-vibe-router

An automated Spotify listener that watches your **Liked Songs** and routes each new track into a vibe-matching playlist.

## What it does

- Polls your Spotify Liked Songs on an interval
- Classifies each song into one of the project’s vibe buckets
- Creates playlists if they don’t exist
- Adds tracks to the matched vibe playlist
- Keeps lightweight state to avoid reprocessing duplicates

## How it works (high level)

1. You authenticate via Spotify OAuth (PKCE flow)
2. The service fetches recent liked tracks
3. A classifier maps each track to a vibe label
4. The router ensures target playlists exist
5. Tracks are inserted into the chosen playlists
6. State is persisted locally for dedupe/checkpointing

## Requirements

- Node.js 18+
- A Spotify Developer app
- Spotify redirect URI configured as:
  - `http://127.0.0.1:8888/callback`

## Setup

### 1) Clone and install

```bash
git clone https://github.com/aajais/spotify-vibe-router.git
cd spotify-vibe-router
```

### 2) Configure environment

Create `.env` in repo root:

```bash
SPOTIFY_CLIENT_ID=your_spotify_client_id
# Optional tunables:
POLL_MINUTES=1
DEDUP_MINUTES=60
PLAYLIST_VISIBILITY=private
PORT=8888
```

> Do not commit `.env`.

### 3) Start service

```bash
node server.mjs
```

Then open:

- `http://127.0.0.1:8888/login`

Complete auth once to grant Spotify scopes.

## Useful endpoints / checks

```bash
# Trigger one routing pass
curl -s http://127.0.0.1:8888/run-once | jq .

# Check recent tracks processed
curl -s http://127.0.0.1:8888/recent-tracks | jq .

# Test playlist write path
curl -s http://127.0.0.1:8888/test-playlist-add | jq .
```

## Files to know

- `server.mjs` — main service loop + Spotify API integration
- `classify.mjs` / `smart_classify.mjs` — vibe classification logic
- `vibes.mjs` — vibe taxonomy
- `state.json` — runtime state/cache (ignored in git)

## Optional: experiment/eval tooling

The repo includes classifier evaluation and W&B utilities:

- `evaluate_dataset.mjs`
- `run_wandb_experiments.py`
- `create_ablation_report.py`

## Security / privacy notes

- Never commit `.env`, tokens, or local runtime state
- Rotate credentials immediately if leaked
- Keep Spotify scopes minimal

## Troubleshooting

- **403 from audio features**: fallback classification should still work with reduced precision
- **No tracks routed**: verify auth is complete and liked songs exist
- **Rate limits (429)**: increase `POLL_MINUTES`
- **Playlist issues**: confirm app scopes + account permissions
