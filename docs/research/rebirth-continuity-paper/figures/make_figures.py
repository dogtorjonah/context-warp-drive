#!/usr/bin/env python3
"""
Figure generation for the rebirth-continuity paper.

Renders publication-clean figures from the relay's prompt-cache / cost telemetry.
Deterministic given the input data.

RUN (use a Python environment with matplotlib installed):
    python3 make_figures.py

DATA SOURCE: reads cost/cache telemetry from FIG_COSTS_DIR. The raw telemetry corpus is
operator-private and not shipped in this public repo; see Appendix A for the data policy.

Figures produced:
  From the frozen cost/cache telemetry (deterministic):
    fig1_cache_rate.png      — prompt-cache read rate by provider (Anthropic ~94%)
    fig2_cache_savings.png   — measured input-cost reduction from caching (~84%)
    fig3_hotswap.png         — one identity hot-swapped across N engines (real session)
  From the analysis results in hard-numbers.md (each rung/row = N + 95% CI + substrate label):
    fig4_recovery_ladder.png — recovery floor (current) vs uncensored ceiling (stale <=May-19)
    fig5_noninferiority.png  — hot-swap delta forest vs the 0-line and the -5pp margin
No faked data: the sawtooth is intentionally NOT plotted (cost logs are turn-aggregated, §6).
"""
import os, glob, json
from collections import defaultdict, OrderedDict
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

# Reproducibility: the raw cost corpus is intentionally not published. Set FIG_COSTS_DIR to a local
# frozen costs directory to regenerate figures 1-3; figures 4-5 are hardcoded from hard-numbers.md.
COSTS_DIR = os.environ.get("FIG_COSTS_DIR", "")
OUT = os.path.dirname(os.path.abspath(__file__))
print(f"costs source: {COSTS_DIR}")

# ---------- shared restrained style (color used functionally, not decoratively) ----------
plt.rcParams.update({
    "figure.dpi": 160, "savefig.dpi": 160,
    "font.family": "DejaVu Sans", "font.size": 11,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.edgecolor": "#555555", "axes.labelcolor": "#222222",
    "text.color": "#222222", "xtick.color": "#555555", "ytick.color": "#555555",
    "axes.grid": True, "grid.color": "#ECECEC", "grid.linewidth": 0.8,
})
ACCENT = "#2F6DB5"   # confident blue — the highlighted result
MUTE   = "#C2CAD3"   # muted slate — context / non-highlighted
SAVE   = "#C0552B"   # warm terracotta — the "savings" delta
INK    = "#222222"

ENGINE_COLORS = OrderedDict([
    ("Anthropic", "#2F6DB5"), ("Codex", "#3F9C8E"), ("GPT", "#6FA8C7"),
    ("GLM", "#C99A3B"), ("DeepSeek", "#8E6FB0"), ("Gemini", "#B5654C"),
    ("MiniMax", "#7A8B99"), ("Kimi", "#A0566B"),
])

def fam(tier):
    t = (tier or "").lower()
    if any(a in t for a in ("opus", "sonnet", "haiku", "claude")): return "Anthropic"
    if "codex" in t: return "Codex"
    if t.startswith("gpt"): return "GPT"
    if "glm" in t: return "GLM"
    if "deepseek" in t: return "DeepSeek"
    if "gemini" in t: return "Gemini"
    if "minimax" in t: return "MiniMax"
    if "kimi" in t: return "Kimi"
    return (t.split("-")[0] or "other").title()

def load_rows():
    rows = []
    if not COSTS_DIR:
        return rows
    if not os.path.isdir(COSTS_DIR):
        print(f"FIG_COSTS_DIR not found: {COSTS_DIR}")
        return rows
    for f in sorted(glob.glob(COSTS_DIR + "/*.jsonl")):
        iid = os.path.basename(f)[:-6]
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line: continue
                    r = json.loads(line); r["_iid"] = iid; rows.append(r)
        except Exception:
            pass
    return rows

ROWS = load_rows()
if ROWS:
    print(f"loaded {len(ROWS):,} cost rows across {len(set(r['_iid'] for r in ROWS)):,} instances")
else:
    print("FIG_COSTS_DIR is unset or empty; skipping cache-derived figures 1-3.")

# ===================== FIG 1: cache-read rate by provider =====================
agg = defaultdict(lambda: [0, 0, 0])   # family -> [cacheR, cacheC, inp]
read_rate = eff = None
if ROWS:
    for r in ROWS:
        a = agg[fam(r.get("tier"))]
        a[0] += r.get("cacheR", 0) or 0
        a[1] += r.get("cacheC", 0) or 0
        a[2] += r.get("inp", 0) or 0
    # only providers that actually emit cache-read telemetry (others report 0 = no data, not "no caching")
    report = [(k, v) for k, v in agg.items() if v[0] > 0]
    report.sort(key=lambda kv: kv[1][0] / sum(kv[1]))
    labels = [k for k, _ in report]
    rates  = [v[0] / sum(v) * 100 for _, v in report]
    ncalls = {fam(r.get("tier")): 0 for r in ROWS}
    for r in ROWS: ncalls[fam(r.get("tier"))] += 1
    colors = [ACCENT if k == "Anthropic" else MUTE for k in labels]

    fig, ax = plt.subplots(figsize=(7.4, 3.7))
    bars = ax.barh(labels, rates, color=colors, height=0.62, zorder=3)
    for b, rt, lab in zip(bars, rates, labels):
        ax.text(b.get_width() + 1.4, b.get_y() + b.get_height() / 2,
                f"{rt:.1f}%", va="center", fontsize=10.5, color=INK,
                fontweight="bold" if lab == "Anthropic" else "normal")
    ax.set_xlim(0, 108)
    ax.set_xlabel("Share of input tokens served from prompt cache (%)")
    ax.set_title("Prompt-cache read rate by provider\nAnthropic sessions stay 94% cache-read — the prefix holds across rebirths",
                 fontsize=12.5, fontweight="bold", loc="left", color=INK)
    ax.grid(axis="y", visible=False)
    cap = ("Anthropic warm-row rate is 94.5% — statistically identical to the 94.3% all-row rate: if rebirth broke the cache "
           "prefix, post-boundary\ncost rows would crater, and they do not. Providers that emit no cache-read telemetry "
           "(DeepSeek/GLM/Gemini/MiniMax/Kimi) are omitted. Source: frozen cost telemetry (Appendix A).")
    fig.text(0.012, -0.13, cap, fontsize=7.6, color="#6A6A6A", ha="left", va="top")
    fig.savefig(os.path.join(OUT, "fig1_cache_rate.png"), bbox_inches="tight", facecolor="white")
    plt.close(fig)

    # ===================== FIG 2: measured cache cost reduction (Anthropic) =====================
    cr = cc = ip = 0
    for r in ROWS:
        if fam(r.get("tier")) == "Anthropic":
            cr += r.get("cacheR", 0) or 0; cc += r.get("cacheC", 0) or 0; ip += r.get("inp", 0) or 0
    tot = cr + cc + ip
    read_rate = cr / tot * 100
    # documented Anthropic input multipliers: cache read 0.10x, cache write 1.25x, fresh 1.0x
    eff = (cr * 0.10 + cc * 1.25 + ip * 1.0) / tot * 100

    fig, ax = plt.subplots(figsize=(5.9, 4.0))
    xs = ["Without caching\n(counterfactual)", "With caching\n(measured)"]
    ys = [100.0, eff]
    bars = ax.bar(xs, ys, color=[MUTE, ACCENT], width=0.56, zorder=3)
    ax.text(0, 102, "100%", ha="center", fontsize=11, color=INK)
    ax.text(1, eff + 3, f"{eff:.1f}%", ha="center", fontsize=12, fontweight="bold", color=ACCENT)
    # savings arrow drawn in open space just right of the bar (bar spans 0.72-1.28), so it never crosses the label
    ax.annotate("", xy=(1.34, eff + 0.5), xytext=(1.34, 99.5),
                arrowprops=dict(arrowstyle="<->", color=SAVE, lw=1.6))
    ax.text(1.46, (100 + eff) / 2, f"−{100 - eff:.1f}%\ninput cost", color=SAVE,
            fontsize=11.5, fontweight="bold", va="center", ha="left")
    ax.set_ylim(0, 116)
    ax.set_ylabel("Relative input-token cost")
    ax.set_title("Caching cuts Anthropic input cost by 83.6%\nMeasured 94.3% cache-read rate × documented 0.1× read price",
                 fontsize=12.5, fontweight="bold", loc="left", color=INK)
    ax.grid(axis="x", visible=False)
    ax.set_xlim(-0.6, 2.05)
    fig.text(0.012, -0.04,
             "Effective input multiplier = (0.10·cache_read + 1.25·cache_write + 1.0·fresh) / total input tokens. "
             "Input cost only (excludes output). Source: frozen cost telemetry (Appendix A).",
             fontsize=7.6, color="#6A6A6A", ha="left", va="top")
    fig.savefig(os.path.join(OUT, "fig2_cache_savings.png"), bbox_inches="tight", facecolor="white")
    plt.close(fig)

    # ===================== FIG 3: hot-swap engine timeline (one real identity) =====================
    by_inst = defaultdict(list)
    for r in ROWS:
        by_inst[r["_iid"]].append(r)

    best = None  # (score, iid, fams)
    for iid, rs in by_inst.items():
        rs2 = sorted(rs, key=lambda r: str(r.get("ts") or ""))
        fams = [fam(r.get("tier")) for r in rs2]
        distinct = len(set(fams))
        if not (24 <= len(fams) <= 64 and distinct >= 4):
            continue
        switches = sum(1 for i in range(1, len(fams)) if fams[i] != fams[i - 1])
        score = distinct * 100 + switches
        if best is None or score > best[0]:
            best = (score, iid, fams)

    if best:
        _, iid, fams = best
        switches = sum(1 for i in range(1, len(fams)) if fams[i] != fams[i - 1])
        used = OrderedDict((f, ENGINE_COLORS.get(f, "#999999")) for f in fams)
        fig, ax = plt.subplots(figsize=(9.4, 2.7))
        for i, f in enumerate(fams):
            ax.barh(0, 1, left=i, height=0.62, color=used[f], edgecolor="white", linewidth=0.5, zorder=3)
        ax.set_xlim(0, len(fams)); ax.set_ylim(-0.5, 0.5)
        ax.set_yticks([])
        ax.set_xlabel("Turn index along one continuous agent identity →")
        ax.set_title(f"One identity, {len(used)} engines, {switches} live model hot-swaps\n"
                     f"Session {iid}: rebirth carries the package across every switch — the agent never resets",
                     fontsize=12, fontweight="bold", loc="left", color=INK)
        handles = [Patch(facecolor=c, label=f) for f, c in used.items()]
        ax.legend(handles=handles, ncol=min(len(used), 8), loc="upper center",
                  bbox_to_anchor=(0.5, -0.42), frameon=False, fontsize=9)
        ax.grid(False)
        for s in ("top", "right", "left", "bottom"):
            ax.spines[s].set_visible(False)
        fig.savefig(os.path.join(OUT, "fig3_hotswap.png"), bbox_inches="tight", facecolor="white")
        plt.close(fig)
        print(f"FIG3 instance={iid} engines={list(used)} turns={len(fams)} switches={switches}")
    else:
        print("FIG3 SKIPPED: no instance with >=4 engine families in 24-64 turns")

# ===================== FIG 4: recovery ladder (analysis numbers, not cost logs) =====================
# Source: hard-numbers.md §1. Each rung carries N + 95% CI + substrate label.
# Defined bottom -> top: conservative current floor at the base, stale censored ceiling above it.
LADDER = [   # label, rate, ci_lo, ci_hi, disp, n_label, substrate
    ("Raw parser-floor\n(any fresh trigger = break)", 87.0, 83.0, 91.0, "87% [83, 91]",       "736 / 845", "current"),
    ("Uncensored\n(− final censored cells)",          98.3, 97.1, 99.0, "98.3% [97.1, 99.0]", "749 / 762", "stale"),
    ("Uncensored, human-intent roots",                97.6, 95.8, 98.7, "97.6% [95.8, 98.7]", "449 / 460", "stale"),
]
FLOOR_IMMEDIATE, FLOOR_MULTIHOP = 77.0, 10.0   # of all actionable roots (651/845, 85/845)
STALE_FILL, STALE_EDGE = "#E2E8F0", "#90A0B2"

fig, ax = plt.subplots(figsize=(9.0, 4.5))
for y, (lab, rate, lo, hi, disp, nlab, sub) in enumerate(LADDER):
    cur = sub == "current"
    if cur:
        ax.barh(y, FLOOR_IMMEDIATE, height=0.46, color=ACCENT, zorder=3)
        ax.barh(y, FLOOR_MULTIHOP, left=FLOOR_IMMEDIATE, height=0.46, color="#7FA8D4", zorder=3)
        ax.text(FLOOR_IMMEDIATE / 2, y, "immediate 77%", va="center", ha="center",
                color="white", fontsize=8.5, fontweight="bold", zorder=4)
        ax.text(FLOOR_IMMEDIATE + FLOOR_MULTIHOP / 2, y, "+hops", va="center",
                ha="center", color="#10243B", fontsize=7.0, zorder=4)
    else:
        ax.barh(y, rate, height=0.46, color=STALE_FILL, edgecolor=STALE_EDGE,
                linewidth=1.2, linestyle=(0, (4, 2)), zorder=3)
    ax.errorbar(rate, y, xerr=[[rate - lo], [hi - rate]], fmt="none",
                ecolor=INK if cur else "#6A6A6A", elinewidth=1.4, capsize=4, zorder=5)
    tag = "CURRENT" if cur else "STALE"
    ax.text(max(hi, rate) + 1.8, y, f"{disp}   {nlab}   {tag}", va="center", ha="left",
            fontsize=9.3, fontweight="bold" if cur else "normal",
            color=INK if cur else "#5B6675")
ax.set_yticks(range(len(LADDER)))
ax.set_yticklabels([l[0] for l in LADDER], fontsize=9)
ax.set_xlim(0, 116)
ax.set_xlabel("Recovery rate (%) — interrupted intent → rebirth → completion")
ax.axvline(87, color=ACCENT, lw=1.0, ls=":", zorder=2)
ax.set_title("Recovery ladder: the honest floor and the labeled ceiling\n"
             "Current parser-floor 87%; the stale ≤May-19 recode reaches ~98% after final censored cells are removed",
             fontsize=12.5, fontweight="bold", loc="left", color=INK)
ax.grid(axis="y", visible=False)
ax.set_xticks([0, 20, 40, 60, 80, 100])
ax.set_ylim(-0.6, len(LADDER) - 0.4)
fig.text(0.012, -0.05,
         "Solid bar = CURRENT (2026-06-04 rebuild) · dashed = STALE ≤May-19 manual recode (labeled upper bound, not current).\n"
         "Floor counts ANY fresh trigger as a break (conservative — many are same-intent nudges like \"did you fix it?\"). "
         "Uncensored excludes\nfinal censor cells: operator supersession, external preemption, and ambiguous rows (§5.1). "
         "Whiskers = 95% CI. True hard-failure ~2.0% (stale).\n"
         "The ~98% cells are NOT current and NOT \"99%\". Source: hard-numbers.md §1.",
         fontsize=7.4, color="#6A6A6A", ha="left", va="top")
fig.savefig(os.path.join(OUT, "fig4_recovery_ladder.png"), bbox_inches="tight", facecolor="white")
plt.close(fig)

# ===================== FIG 5: non-inferiority forest plot (analysis numbers) =====================
# Source: hard-numbers.md §5. Δ = swap − same-model continuation (pp), full-corpus substrate.
FOREST = [   # bottom -> top: label, delta, ci_lo, ci_hi, note, within_engine
    ("Cross-engine swap  (n=133)",              -4.0, -12.4, 4.4, "underpowered", False),
    ("Within-engine swap · W150 (sensitivity)",  3.5,  -6.1, 13.7, "",          True),
    ("Within-engine swap · W60 (primary)",       1.0,  -8.6, 10.7, "",          True),
]
MARGIN = -5   # pre-registered non-inferiority margin (§8)
fig, ax = plt.subplots(figsize=(8.8, 3.8))
ax.axvspan(MARGIN, 16, color="#E8F1E8", zorder=0)
ax.axvline(0, color=INK, lw=1.3, zorder=2)
ax.axvline(MARGIN, color="#3F8F5A", lw=1.3, ls="--", zorder=2)
for y, (lab, d, lo, hi, note, within) in enumerate(FOREST):
    col = ACCENT if within else SAVE
    ax.errorbar(d, y, xerr=[[d - lo], [hi - d]], fmt="o", color=col, ecolor=col,
                elinewidth=1.8, capsize=5, markersize=8, zorder=5)
    txt = f"Δ {d:+g}  [{lo:+g}, {hi:+g}]" + (f"  · {note}" if note else "")
    ax.text(hi + 0.7, y, txt, va="center", ha="left", fontsize=9.3,
            color=col, fontweight="bold" if within else "normal")
ax.set_yticks(range(len(FOREST)))
ax.set_yticklabels([f[0] for f in FOREST], fontsize=9.2)
ax.set_xlim(-16, 16)
ax.set_ylim(-0.6, len(FOREST) - 0.4)
ax.set_xlabel("Δ continuity (percentage points): swap − same-model      ( ← swap worse · swap better → )")
ax.text(MARGIN - 0.2, len(FOREST) - 0.55, "−5pp margin", color="#3F8F5A", fontsize=8.2, va="bottom", ha="right")
ax.text(15.5, len(FOREST) - 0.55, "non-inferiority region", color="#3F8F5A", fontsize=8.2,
        va="bottom", ha="right", fontstyle="italic")
ax.set_title("Model hot-swap: no detected penalty, but underpowered (over-determined axis)\n"
             "Mid-edit state-continuation Δ (swap − same); instance-cluster 95% CIs — full-corpus substrate",
             fontsize=12.2, fontweight="bold", loc="left", color=INK)
ax.grid(axis="x", visible=False)
fig.text(0.012, -0.10,
         "Within-engine point estimates sit at/above zero (no penalty detected), but the cluster-robust CIs are wide — the within-engine cell "
         "sits on the\nover-determined state axis (§4.2) and its interval now crosses the −5pp margin, so it is underpowered to "
         "detect a penalty, not\nevidence of none. Cross-engine (n=133) is more underpowered still; the pre-registered paired fork "
         "(§8) settles it on the intent axis. Source: hard-numbers.md §5.",
         fontsize=7.4, color="#6A6A6A", ha="left", va="top")
fig.savefig(os.path.join(OUT, "fig5_noninferiority.png"), bbox_inches="tight", facecolor="white")
plt.close(fig)
print("FIG4 recovery_ladder + FIG5 noninferiority rendered")

if ROWS:
    print(f"FIG1 anthropic_read_rate={agg['Anthropic'][0]/sum(agg['Anthropic'])*100:.1f}%")
    print(f"FIG2 read_rate={read_rate:.1f}% effective_multiplier={eff:.1f}% reduction={100-eff:.1f}%")
print("done ->", OUT)
