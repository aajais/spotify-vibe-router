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
