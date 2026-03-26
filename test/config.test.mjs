import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("config", () => {
  it("exports a frozen config object when SPOTIFY_CLIENT_ID is set", async () => {
    const orig = process.env.SPOTIFY_CLIENT_ID;
    process.env.SPOTIFY_CLIENT_ID = "test_id_123";
    const { config } = await import(`../src/config.mjs?t=${Date.now()}`);
    assert.equal(config.SPOTIFY_CLIENT_ID, "test_id_123");
    assert.equal(config.PORT, 8888);
    assert.equal(config.CLASSIFIER_MODE, "hybrid");
    assert.equal(typeof config.CLASSIFIER_THRESHOLD, "number");
    assert.throws(() => { config.PORT = 9999; }, TypeError);
    if (orig !== undefined) process.env.SPOTIFY_CLIENT_ID = orig;
    else delete process.env.SPOTIFY_CLIENT_ID;
  });
});
