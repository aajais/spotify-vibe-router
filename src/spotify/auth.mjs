import crypto from "node:crypto";
import { config } from "../config.mjs";
import { loadState, setState } from "../state.mjs";
import { spotifyFetch, postForm } from "./client.mjs";

function base64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function makeVerifier(len = 64) {
  return base64Url(crypto.randomBytes(len));
}

export function makeChallenge(verifier) {
  return base64Url(crypto.createHash("sha256").update(verifier).digest());
}

function isExpired(token, skewMs = 30_000) {
  const expiresAt = token.obtained_at_ms + token.expires_in * 1000;
  return Date.now() + skewMs >= expiresAt;
}

export async function refreshIfNeeded() {
  const s = loadState();
  if (!s.token) throw new Error("Not authenticated");
  if (!isExpired(s.token)) return s.token;
  if (!s.token.refresh_token) throw new Error("Expired and no refresh_token; reauth");

  const refreshed = await postForm("https://accounts.spotify.com/api/token", {
    grant_type: "refresh_token",
    refresh_token: s.token.refresh_token,
    client_id: config.SPOTIFY_CLIENT_ID
  });

  const next = {
    access_token: refreshed.access_token,
    token_type: refreshed.token_type,
    expires_in: refreshed.expires_in,
    refresh_token: s.token.refresh_token,
    scope: refreshed.scope,
    obtained_at_ms: Date.now()
  };

  setState({ token: next });
  return next;
}

const authState = { healthy: false, lastCheckedAtMs: null, lastError: null };

export function getAuthState() {
  return { ...authState };
}

export async function updateAuthHealth() {
  try {
    const token = await refreshIfNeeded();
    await spotifyFetch("https://api.spotify.com/v1/me", token.access_token);
    authState.healthy = true;
    authState.lastCheckedAtMs = Date.now();
    authState.lastError = null;
    return true;
  } catch (error) {
    authState.healthy = false;
    authState.lastCheckedAtMs = Date.now();
    authState.lastError = error?.message ?? String(error);
    return false;
  }
}

export function setAuthUnhealthy(errorMsg) {
  authState.healthy = false;
  authState.lastCheckedAtMs = Date.now();
  authState.lastError = errorMsg;
}

export function computeRedirectUri(req) {
  const forced = (process.env.SPOTIFY_REDIRECT_URI || "").trim();
  if (forced) return forced;
  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${config.PORT}`;
  const protoHdr = req.headers["x-forwarded-proto"] || "http";
  const proto = String(protoHdr).split(",")[0].trim() || "http";
  return `${proto}://${host}/callback`;
}

export function handleLogin(req) {
  const verifier = makeVerifier();
  const challenge = makeChallenge(verifier);
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = computeRedirectUri(req);
  setState({ pkce: { verifier }, oauthState: state, oauthRedirectUri: redirectUri });

  const auth = new URL("https://accounts.spotify.com/authorize");
  auth.searchParams.set("client_id", config.SPOTIFY_CLIENT_ID);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("scope", config.SCOPES.join(" "));
  auth.searchParams.set("state", state);
  return auth.toString();
}

export async function handleCallback(req, u) {
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  const s = loadState();
  if (!code) throw new Error("Missing code");
  if (!state || state !== s.oauthState) throw new Error("Bad state");
  if (!s.pkce?.verifier) throw new Error("Missing PKCE verifier");

  const redirectUri = s.oauthRedirectUri || computeRedirectUri(req);
  const tok = await postForm("https://accounts.spotify.com/api/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.SPOTIFY_CLIENT_ID,
    code_verifier: s.pkce.verifier
  });

  const stored = {
    access_token: tok.access_token,
    token_type: tok.token_type,
    expires_in: tok.expires_in,
    refresh_token: tok.refresh_token,
    scope: tok.scope,
    obtained_at_ms: Date.now()
  };

  setState({ token: stored });
  return stored;
}
