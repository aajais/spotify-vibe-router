import json
import subprocess
import wandb
from collections import Counter

ENTITY = "dipy_genai"
PROJECT = "vibe-classification-spotify"
DATASET = "training_data.json"

EXPERIMENTS = [
    {"mode": "hybrid", "threshold": 0.40},
    {"mode": "keywords", "threshold": 0.40},
    {"mode": "audio", "threshold": 0.40},
    {"mode": "hybrid", "threshold": 0.30},
    {"mode": "hybrid", "threshold": 0.55},
]


def run_eval(mode: str, threshold: float):
    out = subprocess.check_output(
        ["node", "evaluate_dataset.mjs", DATASET, mode, str(threshold)],
        text=True,
    )
    return json.loads(out)


def log_experiment(result: dict):
    mode = result["mode"]
    threshold = result["threshold"]
    preds = result["predictions"]

    run = wandb.init(
        entity=ENTITY,
        project=PROJECT,
        job_type="classification_eval",
        config={
            "dataset": result["dataset_path"],
            "dataset_size": result["dataset_size"],
            "mode": mode,
            "threshold": threshold,
        },
        name=f"eval-{mode}-thr{threshold}",
        reinit="finish_previous",
    )

    y_true = [r["actual"] for r in preds]
    y_pred = [r["predicted"] for r in preds]
    class_names = sorted(set(y_true) | set(y_pred))

    misclassified = [r for r in preds if r["actual"] != r["predicted"]]
    misclassified_sorted = sorted(
        misclassified,
        key=lambda r: (r["top_score"] if r["top_score"] is not None else -1),
        reverse=True,
    )
    worst = misclassified_sorted[:5]

    run.log({
        "accuracy_top1": result["metrics"]["accuracy_top1"],
        "samples": len(preds),
        "misclassified_count": len(misclassified),
        "predicted_label_counts": dict(Counter(y_pred)),
        "actual_label_counts": dict(Counter(y_true)),
    })

    run.summary["worst_misclassifications"] = [
        {
            "track_id": r["track_id"],
            "track_name": r["track_name"],
            "actual": r["actual"],
            "predicted": r["predicted"],
            "top_score": r["top_score"],
        }
        for r in worst
    ]

    pred_table = wandb.Table(
        columns=[
            "track_id",
            "track_name",
            "artists",
            "actual",
            "predicted",
            "top_score",
            "used_audio_features",
            "raw_rule_contributions",
            "merged_scores",
        ]
    )

    for r in preds:
        pred_table.add_data(
            r["track_id"],
            r["track_name"],
            r["artists"],
            r["actual"],
            r["predicted"],
            r["top_score"],
            r["used_audio_features"],
            json.dumps(r["raw_rule_contributions"]),
            json.dumps(r["merged_scores"]),
        )

    run.log({"predictions_table": pred_table})

    # confusion-style dashboard as explicit table (robust even for tiny/single-class datasets)
    cm_table = wandb.Table(columns=["actual", "predicted", "count"])
    counts = Counter((a, p) for a, p in zip(y_true, y_pred))
    for (actual, predicted), count in sorted(counts.items()):
        cm_table.add_data(actual, predicted, count)
    run.log({"confusion_counts": cm_table})

    run.finish()


if __name__ == "__main__":
    for exp in EXPERIMENTS:
        result = run_eval(exp["mode"], exp["threshold"])
        log_experiment(result)

    print("Done. Logged experiment runs to W&B.")
