# spotify-vibe-router AGENTS.md


## Commit Hygiene Rule
- Before every commit, check whether behavior, setup, env vars, endpoints, scripts, or architecture changed.
- If yes, update `README.md` in the same commit so docs stay in sync with code.
- Do not merge/push commits that change runtime behavior without corresponding README updates.

## Project Overview
This agent automatically sorts Spotify liked songs into vibe-based playlists every minute.

## Key Features
- Polls Spotify Liked Songs every 1-5 minutes (configurable)
- Classifies songs into 25+ vibe playlists using genre-agnostic heuristics
- Falls back to basic track info when audio features unavailable
- Deduplicates tracks within a configurable time window
- Creates and maintains all vibe playlists automatically

## Configuration
- `POLL_MINUTES`: Polling interval (default: 1)
- `DEDUP_MINUTES`: Deduplication window (default: 60)
- `PLAYLIST_VISIBILITY`: Playlist visibility (default: private)

## Recent Issues & Fixes
- **Audio Features 403 Error**: Spotify API returns 403 for audio features endpoint
  - **Solution**: Implemented graceful fallback to basic track information
  - **Impact**: Reduced classification accuracy but full functionality maintained
  - **Date**: 2026-03-19

## File Structure
- `src/server.mjs` — HTTP server entry point
- `src/spotify/` — Spotify OAuth, API client, operations
- `src/classifier/` — vibe classification (keywords, audio, priors)
- `src/poller.mjs` — poll loop orchestration
- `src/config.mjs` — configuration and validation
- `src/state.mjs` — runtime state/cache (tokens, playlist mappings, processed tracks)
- `src/vibes.mjs` — vibe taxonomy
- `public/` — dashboard UI (HTML/CSS/JS)
- `eval/` — classifier evaluation tooling
- `test/` — test suite

## Dependencies
- Node.js built-in modules only (no external dependencies)
- Spotify Web API (OAuth 2.0 with PKCE)

## Setup Instructions
1. Create Spotify Developer app with redirect URI: `http://127.0.0.1:8888/callback`
2. Set environment variable: `SPOTIFY_CLIENT_ID="your_client_id"`
3. Run: `npm start`
4. Authenticate at: `http://127.0.0.1:8888/login`

## Vibe Playlists
1. a-bys-ride - bus/train/window stare, getting lost in thought
2. Windowseat Auteur - cinematic main-character mood; spacious + narrative
3. Soft Focus, Hard Feelings - tender + heavy; romantic/sad without melodrama
4. Afterhours Soliloquy - late-night introspection; dim lights, internal monologue
5. Monochrome Martini - sleek, understated swagger; cool tempo
6. Velvet Rope Behavior - nightlife confidence; flirt/edge/pregame-to-club
7. Gallery Opening (I Don't Know Anyone) - art-cool; tasteful weird; aloof curiosity
8. Left of the Groove - off-kilter rhythms/structure; idiosyncratic
9. Tastefully Unhinged - maximal/chaotic/bold choices; still listenable
10. Glitch & Grace - textural electronic/ambient-pop; sparkly + strange
11. Fast, Not Furious - momentum for walking/doing; upbeat not aggressive
12. Neon Cardio - higher BPM dopamine; movement-forward
13. Errandcore Deluxe - everyday missions with style; bouncy + light
14. Cashmere Background - cozy, classy background warmth; low-drama
15. Honeyed & Home - intimate comfort; acoustic/soft soul/quiet R&B
16. Menace Mileage - gym menace energy; hard/confident
17. Iron & Irreverence - heavier/meaner PR-attempt music
18. Tearjerk, With Subwoofers - sad lyrics, big chorus/beat; cathartic bounce
19. Crying in Designer - polished pain; singable sadness
20. Sunlit Recalibration - calm productive reset; tidy-your-life
21. Linen Day Rituals - soft reset: shower, sheets, sunlight
22. Stove Clock, No Rush - slow-simmer groove; cooking like a film scene
23. Decant & Dance - wine-in-hand; kitchen becomes a lounge
24. Commit Season - focus coding; steady drive; low lyrical distraction
25. Terminal Serenity - calm concentration; ambient/electronic/lofi
26. Unsorted, But Expensive - holding playlist when vibe match is weak/ambiguous

## Commands

### Start the service
```bash
npm start
```

### Start with custom polling interval (e.g., 2 minutes)
```bash
POLL_MINUTES=2 SPOTIFY_CLIENT_ID="your_client_id" npm start
```

### Run tests
```bash
npm test
node --test test/classifier.test.mjs
```

### Check if service is running
```bash
ps aux | grep server.mjs
```

### Stop the service
```bash
pkill -f "src/server.mjs"
```

### Run classification once manually
```bash
curl -s http://127.0.0.1:8888/run-once | jq .
```

### Health check
```bash
curl -s http://127.0.0.1:8888/healthz
```

### Test playlist add capability
```bash
curl -s http://127.0.0.1:8888/test-playlist-add | jq .
```

### View recent tracks that should have been added
```bash
curl -s http://127.0.0.1:8888/recent-tracks | jq .
```

### Check current state
```bash
cat state.json | jq .
```

### Restart the service
```bash
pkill -f "src/server.mjs" && sleep 3 && npm start
```

## Troubleshooting
- **403 Forbidden**: Check Spotify app configuration and redirect URI
- **Rate Limiting**: Increase POLL_MINUTES if experiencing throttling
- **Playlist Creation Failures**: Verify app has correct scopes in Spotify Dashboard

## Spotify API Build Rules (Aj)
You are helping me build an application using the Spotify Web API. Follow these rules:
- OpenAPI spec: Refer to the Spotify OpenAPI specification at https://developer.spotify.com/reference/web-api/open-api-schema.yaml for all endpoint paths, parameters, and response schemas. Do not guess endpoints or field names.
- Authorization: Use the Authorization Code with PKCE flow (https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) for any user-specific data. If the app has a secure backend, the Authorization Code flow (https://developer.spotify.com/documentation/web-api/tutorials/code-flow) is also acceptable. Only use Client Credentials for public, non-user data. Never use the Implicit Grant flow (it is deprecated).
- Redirect URIs: Always use HTTPS redirect URIs (except http://127.0.0.1 for local development). Never use http://localhost or wildcard URIs. See https://developer.spotify.com/documentation/web-api/concepts/redirect_uri for requirements.
- Scopes: Request only the minimum scopes (https://developer.spotify.com/documentation/web-api/concepts/scopes) needed for the features being built. Do not request broad scopes preemptively.
- Token management: Store tokens securely. Never expose the Client Secret in client-side code. Implement token refresh (https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens) logic so the app does not break when access tokens expire.
- Rate limits: Implement exponential backoff and respect the Retry-After header when receiving HTTP 429 responses. Do not retry immediately or in tight loops.
- Deprecated endpoints: Do not use deprecated endpoints. Prefer /playlists/{id}/items over /playlists/{id}/tracks, and use /me/library over the type-specific library endpoints.
- Error handling: Handle all HTTP error codes documented in the OpenAPI schema. Read the returned error message and use it to provide meaningful feedback to the user.
- Developer Terms of Service: Comply with the Spotify Developer Terms (https://developer.spotify.com/terms). In particular: do not cache Spotify content beyond what is needed for immediate use, always attribute content to Spotify, and do not use the API to train machine learning models on Spotify data.
