import { describe, it } from "node:test";
import assert from "node:assert/strict";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8888";

describe("UI smoke test (requires running server)", () => {
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
    const ct = r.headers.get("content-type") || "";
    assert.ok(ct.includes("css"), "Content-Type should include css");
  });

  it("serves static JS", async () => {
    const r = await fetch(base + "/app.js");
    assert.equal(r.status, 200);
    const ct = r.headers.get("content-type") || "";
    assert.ok(ct.includes("javascript"), "Content-Type should include javascript");
  });

  it("returns 404 for unknown paths", async () => {
    const r = await fetch(base + "/nonexistent-path");
    assert.equal(r.status, 404);
  });

  it("redirects legacy /analytics to /?tab=analytics", async () => {
    const r = await fetch(base + "/analytics", { redirect: "manual" });
    assert.equal(r.status, 302);
    const loc = r.headers.get("location") || "";
    assert.ok(loc.includes("tab=analytics"));
  });
});
