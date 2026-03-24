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
