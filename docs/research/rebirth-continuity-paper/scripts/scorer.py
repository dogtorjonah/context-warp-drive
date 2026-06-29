#!/usr/bin/env python3
"""
scorer.py - deterministic continuity scorer.

Reads transitions.jsonl (from parser.py) and computes the four Score A
sub-signals + the deterministic headline composite per the paper definition and
approved defaults: R_read, R_ret, T_pos equal-weighted in the headline;
D_con deferred to s6 (LLM-judge on a sample). Emits scored.jsonl and prints
headline aggregates (overall, warm/cold = H1, model-swap vs same-model = H2).

Pure offline. Schema: corpus-schema-and-design.md.
Usage: python3 scorer.py        (after parser.py has produced transitions.jsonl)
"""
import json, os, argparse, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))


def clamp01(x):
    return max(0.0, min(1.0, x))


def score_row(row):
    rs = row["raw_signals"]
    det = row.get("detail", {})
    mfc = rs["manifest_file_count"]
    num_retr = len(det.get("retrievals", []))
    # R_read: fraction of handed files NOT wastefully (unjustifiably) re-read
    R_read = clamp01(1 - rs["unjustified_manifest_rereads"] / mfc) if mfc > 0 else None
    # R_ret: fraction of retrievals NOT already present in the manifest
    R_ret = clamp01(1 - rs["retrievals_in_manifest"] / num_retr) if num_retr > 0 else None
    # T_pos: resumed the handed rail (defined only when a rail was handed over)
    T_pos = (1.0 if rs["resumed_rail"] else 0.0) if row["manifest"].get("rail_present") else None
    parts = [v for v in (R_read, R_ret, T_pos) if v is not None]
    score_a = sum(parts) / len(parts) if parts else None
    # Handoff-Debt-style raw re-discovery cost: redundant acquisitions in-window
    redundancy = rs["unjustified_manifest_rereads"] + rs["retrievals_in_manifest"]
    win = row["window"]
    err_rate = win["errors"] / win["turns"] if win["turns"] else 0.0
    return {
        "R_read": R_read, "R_ret": R_ret, "T_pos": T_pos, "D_con": None,
        "score_a": score_a, "redundancy_cost": redundancy,
        "tokens_in": win["tokens_in"], "err_rate": round(err_rate, 4),
        "n_actions": win["n_actions"],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default=os.path.join(HERE, "transitions.jsonl"))
    ap.add_argument("--out", default=os.path.join(HERE, "scored.jsonl"))
    args = ap.parse_args()

    rows = []
    with open(args.inp) as fh:
        for line in fh:
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    pkgs = [r["packageChars"] or 0 for r in rows]
    med = st.median(pkgs) if pkgs else 0

    scored = []
    with open(args.out, "w") as out:
        for r in rows:
            s = score_row(r)
            rec = {"transition_id": r["transition_id"], "trigger_class": r["trigger_class"],
                   "packageChars": r["packageChars"], "model_swapped": r["model_swapped"],
                   "predecessorStatus": r["predecessorStatus"],
                   "warm": (r["packageChars"] or 0) >= med, **s}
            scored.append(rec)
            out.write(json.dumps(rec) + "\n")

    def agg(sub, key):
        vals = [x[key] for x in sub if x.get(key) is not None]
        return (round(st.mean(vals), 3), len(vals)) if vals else (None, 0)

    def report(label, sub):
        if not sub:
            print(f"\n[{label}] n=0")
            return
        print(f"\n[{label}] n={len(sub)}")
        for k in ("score_a", "R_read", "R_ret", "T_pos"):
            m, c = agg(sub, k)
            print(f"  {k:8} mean={m} (n={c})")
        rc = [x["redundancy_cost"] for x in sub]
        print(f"  redundancy_cost mean={round(st.mean(rc), 2) if rc else None}")

    report("ALL", scored)
    report("WARM (pkg>=median)", [x for x in scored if x["warm"]])
    report("COLD (pkg<median)", [x for x in scored if not x["warm"]])
    report("MODEL-SWAP", [x for x in scored if x["model_swapped"]])
    report("SAME-MODEL", [x for x in scored if x["model_swapped"] is False])
    print(f"\n[scorer] {len(scored)} scored -> {args.out} (packageChars median={med})")


if __name__ == "__main__":
    main()
