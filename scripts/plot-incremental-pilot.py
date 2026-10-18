"""Optional offline figure regeneration; requires matplotlib, never calls an API."""
import csv
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

root = Path(__file__).resolve().parents[1] / "benchmarks/results/incremental-pilot-2026-10-18"
with (root / "cost-curves.csv").open() as source:
    rows = list(csv.DictReader(source))

plt.rcParams.update({"svg.hashsalt": "belieflang-pilot-2026-10-18", "svg.fonttype": "none", "font.size": 10})
fig, axes = plt.subplots(1, 2, figsize=(11, 4), sharey=True)
styles = {
    "full_history": ("Full history", "#265ba0", "-", 1.8),
    "rolling_summary": ("Rolling summary", "#c07819", "-", 1.8),
    "plain_json": ("Plain JSON", "#146f65", "--", 3.8),
    "belieflang_v3": ("BeliefLang v3", "#9440ad", "-", 1.3),
}
for ax, schedule in zip(axes, ["sparse", "dense"]):
    for method, (label, color, linestyle, width) in styles.items():
        values = [sum(float(r["cumulative_usd"]) for r in rows
                      if r["schedule"] == schedule and r["method"] == method and int(r["turn"]) == turn)
                  for turn in range(1, 25)]
        ax.step(range(1, 25), values, where="post", label=label,
                color=color, linestyle=linestyle, linewidth=width)
    ax.set(title=f"{schedule.capitalize()} demand", xlabel="Conversation turn",
           xlim=(1, 24), xticks=[1, 6, 12, 18, 24], ylim=(0, 0.0061))
    ax.grid(alpha=0.2)
    crossover = 19 if schedule == "sparse" else 3
    ax.axvline(crossover, color="#555555", linestyle=":", linewidth=1)
    ax.text(crossover + 0.3, 0.0059, f"v3 cheaper than history\nthrough final turn: {crossover}",
            fontsize=8, va="top")
axes[0].set_ylabel("Cumulative estimated USD (sum of three cases)")
axes[1].legend(loc="upper left", bbox_to_anchor=(0, 0.81), fontsize=8)
fig.suptitle("Frozen incremental-memory pilot: usage-derived cost estimates", fontsize=13)
fig.text(0.5, 0.01, "24 turns • three authored cases • one repetition • cost-only crossovers • JSON/v3 curves overlap",
         ha="center", fontsize=8)
fig.tight_layout(rect=(0, 0.04, 1, 0.96))
fig.savefig(root / "cost-curves.svg", metadata={"Date": None})
fig.savefig(root / "cost-curves.png", dpi=150, metadata={"Software": "matplotlib"})
svg = root / "cost-curves.svg"
svg.write_text("\n".join(line.rstrip() for line in svg.read_text().splitlines()) + "\n")
