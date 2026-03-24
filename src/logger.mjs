let weave = null;
let wandbEnabled = false;
let pollSummaryOp = null;
let trackClassificationOp = null;
let errorOp = null;

function formatLog(level, msg, ctx = {}) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...((Object.keys(ctx).length > 0) ? { ctx } : {})
  });
}

export const logger = {
  debug(msg, ctx) { console.debug(formatLog("debug", msg, ctx)); },
  info(msg, ctx) { console.log(formatLog("info", msg, ctx)); },
  warn(msg, ctx) { console.warn(formatLog("warn", msg, ctx)); },
  error(msg, ctx) { console.error(formatLog("error", msg, ctx)); },
};

export async function initWandb({ entity, project, service = "spotify-vibe-router" } = {}) {
  const e = (entity || "").trim();
  const p = (project || "").trim();
  if (!e || !p) {
    logger.warn("W&B logging disabled: missing entity/project");
    return false;
  }
  try {
    weave = await import("weave");
    await weave.init(`${e}/${p}`);
    pollSummaryOp = weave.op(async function vibe_router_poll_summary(payload) {
      return { ok: true, service, loggedAtMs: Date.now(), ...payload };
    });
    trackClassificationOp = weave.op(async function vibe_router_track_classification(payload) {
      return { ok: true, service, loggedAtMs: Date.now(), ...payload };
    });
    errorOp = weave.op(async function vibe_router_error(payload) {
      return { ok: true, service, loggedAtMs: Date.now(), ...payload };
    });
    wandbEnabled = true;
    logger.info(`W&B logging enabled -> ${e}/${p}`);
    return true;
  } catch (error) {
    wandbEnabled = false;
    logger.warn(`W&B logging disabled: ${error?.message ?? String(error)}`);
    return false;
  }
}

async function safeLog(op, payload) {
  if (!wandbEnabled || !op) return;
  try { await op(payload); } catch (error) {
    logger.warn(`W&B log failed: ${error?.message ?? String(error)}`);
  }
}

export async function logPollSummary(payload) { await safeLog(pollSummaryOp, payload); }
export async function logTrackClassification(payload) { await safeLog(trackClassificationOp, payload); }
export async function logWandbError(payload) { await safeLog(errorOp, payload); }

export async function finishWandb() {
  if (!wandbEnabled || !weave) return;
  try {
    if (typeof weave.finish === "function") await weave.finish();
  } catch (error) {
    logger.warn(`W&B finish failed: ${error?.message ?? String(error)}`);
  }
}
