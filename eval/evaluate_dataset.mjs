import fs from "node:fs";
import { classifyWithDiagnostics } from "../src/classifier/index.mjs";

const datasetPath = process.argv[2] ?? "training_data.json";
const mode = process.argv[3] ?? "hybrid";
const threshold = Number(process.argv[4] ?? "0.4");

const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
const rows = dataset.data ?? [];

const records = [];
let correctTop1 = 0;

for (const row of rows) {
  const track = {
    id: row.track_id,
    name: row.track_name,
    artists: row.artist_names ?? [],
    explicit: Boolean(row.explicit),
    duration_ms: row.duration_ms,
    album_name: row.album_name
  };

  const diagnostics = await classifyWithDiagnostics(track, row.audio_features, { mode, threshold });
  const predicted = diagnostics.finalKeys[0] ?? "uncertain";
  const actual = row.vibe_label ?? "uncertain";
  if (predicted === actual) correctTop1 += 1;

  records.push({
    track_id: row.track_id,
    track_name: row.track_name,
    artists: (row.artist_names ?? []).join(", "),
    actual,
    predicted,
    top_score: diagnostics.mergedScores?.[0]?.score ?? null,
    mode,
    threshold,
    used_audio_features: diagnostics.usedAudioFeatures,
    raw_rule_contributions: diagnostics.rawScores,
    merged_scores: diagnostics.mergedScores
  });
}

const accuracy = rows.length ? correctTop1 / rows.length : 0;

const output = {
  dataset_path: datasetPath,
  dataset_size: rows.length,
  mode,
  threshold,
  metrics: {
    accuracy_top1: accuracy
  },
  predictions: records
};

console.log(JSON.stringify(output));
