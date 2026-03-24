from wandb_workspaces.reports.v2 import (
    Report,
    H1,
    P,
    MarkdownBlock,
    PanelGrid,
    Runset,
    LinePlot,
    BarPlot,
    RunComparer,
)

ENTITY = "dipy_genai"
PROJECT = "vibe-classification-spotify"

runset = Runset(
    entity=ENTITY,
    project=PROJECT,
    name="Ablation eval runs",
    query='display_name CONTAINS "eval-"',
)

report = Report(
    entity=ENTITY,
    project=PROJECT,
    title="Spotify Vibe Classification – Ablation Comparison",
    description="Auto-generated comparison of ablation experiments.",
    blocks=[
        H1("Spotify Vibe Classification – Ablation Comparison"),
        P(
            "Compares hybrid/keywords/audio modes and threshold sweeps. "
            "Includes accuracy, misclassification counts, and run-level diff view."
        ),
        PanelGrid(
            runsets=[runset],
            panels=[
                LinePlot(
                    title="Accuracy across ablation runs",
                    x="createdAt",
                    y=["accuracy_top1"],
                ),
                BarPlot(
                    title="Accuracy by config.mode",
                    metrics=["accuracy_top1"],
                    groupby="config.mode",
                    orientation="v",
                ),
                BarPlot(
                    title="Misclassified count by run",
                    metrics=["misclassified_count"],
                    orientation="v",
                ),
                RunComparer(diff_only=True),
            ],
        ),
        MarkdownBlock(
            "### Worst misclassifications\n"
            "Open each run and inspect `worst_misclassifications` in summary plus "
            "`predictions_table` artifact for row-level errors."
        ),
    ],
)

report.save()
print(report.url)
