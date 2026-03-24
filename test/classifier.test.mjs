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
