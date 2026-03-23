let weave = null;
let enabled = false;
let projectRef = null;

let pollSummaryOp = null;
let trackClassificationOp = null;
let errorOp = null;

function makeProjectRef(entity, project) {
  const e = (entity || "").trim();
  const p = (project || "").trim();
  if (!e || !p) return null;
  return `${e}/${p}`;
}

export async function initWandbLogging({ entity, project, service = "spotify-vibe-router-lite" } = {}) {
  projectRef = makeProjectRef(entity, project);
  if (!projectRef) {
    console.warn("[wandb] Missing entity/project; W&B logging disabled");
    return false;
  }

  try {
    weave = await import("weave");
    await weave.init(projectRef);

    pollSummaryOp = weave.op(async function vibe_router_poll_summary(payload) {
      return { ok: true, service, loggedAtMs: Date.now(), ...payload };
    });

    trackClassificationOp = weave.op(async function vibe_router_track_classification(payload) {
      return { ok: true, service, loggedAtMs: Date.now(), ...payload };
    });

    errorOp = weave.op(async function vibe_router_error(payload) {
      return { ok: true, service, loggedAtMs: Date.now(), ...payload };
    });

    enabled = true;
    console.log(`[wandb] logging enabled -> ${projectRef}`);
    return true;
  } catch (error) {
    enabled = false;
    console.warn(`[wandb] logging disabled (${error?.message ?? String(error)})`);
    return false;
  }
}

async function safeLog(op, payload) {
  if (!enabled || !op) return;
  try {
    await op(payload);
  } catch (error) {
    console.warn(`[wandb] log failed (${error?.message ?? String(error)})`);
  }
}

export async function logPollSummary(payload) {
  await safeLog(pollSummaryOp, payload);
}

export async function logTrackClassification(payload) {
  await safeLog(trackClassificationOp, payload);
}

export async function logWandbError(payload) {
  await safeLog(errorOp, payload);
}

export async function finishWandbLogging() {
  if (!enabled || !weave) return;
  try {
    if (typeof weave.finish === "function") {
      await weave.finish();
    }
  } catch (error) {
    console.warn(`[wandb] finish failed (${error?.message ?? String(error)})`);
  }
}
