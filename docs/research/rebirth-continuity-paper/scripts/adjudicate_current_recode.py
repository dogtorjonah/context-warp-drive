#!/usr/bin/env python3
"""Reconcile current rebirth recode judge outputs.

The emitter writes provisional `heuristic_current_recode_v1` labels into
current_recovery_roots.jsonl and writes judge_packets.jsonl for independent
review. This script validates optional judge-a/judge-b JSONL files and emits a
single adjudicated_recode.jsonl plus aggregate summary.

If both judge files are present, exact label agreement becomes consensus and
disagreements are marked `needs_human_adjudication` rather than silently forced.
If no valid judge file is present, the script emits a clearly labeled
`provisional_heuristic_only` artifact so the paper never confuses it with a
manual dual-review recode.
"""

from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACT_DIR = PROJECT_ROOT / "artifacts" / "recode-2026-06-08"
ALLOWED_LABELS = {
    "same_intent_nudge_or_reask",
    "operator_supersession_new_intent",
    "external_chat_or_system_preemption",
    "ambiguous",
    "hard_churn/no_success",
    "recovered_after_same_nudge",
}
CENSOR_LABELS = {
    "operator_supersession_new_intent",
    "external_chat_or_system_preemption",
    "ambiguous",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIR)
    parser.add_argument("--roots", type=Path)
    parser.add_argument("--judge-a", type=Path)
    parser.add_argument("--judge-b", type=Path)
    return parser.parse_args()


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8") as handle:
        for lineno, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{lineno}: invalid JSON: {exc}") from exc
    return rows


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True) + "\n")


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def index_judge(rows: list[dict[str, Any]], label: str) -> tuple[dict[str, dict[str, Any]], list[str]]:
    out: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for pos, row in enumerate(rows, start=1):
        root = row.get("root")
        if not root:
            errors.append(f"{label}:{pos}: missing root")
            continue
        if root in out:
            errors.append(f"{label}:{pos}: duplicate root {root}")
            continue
        recode_label = row.get("label")
        if recode_label not in ALLOWED_LABELS:
            errors.append(f"{label}:{pos}: invalid label {recode_label!r} for {root}")
        out[str(root)] = row
    return out, errors


def normalize_from_label(label: str) -> tuple[str, bool, str | None]:
    if label == "recovered_after_same_nudge":
        return "recovered_after_same_nudge", True, None
    if label == "hard_churn/no_success":
        return "hard_churn/no_success", False, None
    if label in CENSOR_LABELS:
        return f"censored_{label}", False, label
    if label == "same_intent_nudge_or_reask":
        return "hard_churn_after_same_nudge", False, None
    return "needs_human_adjudication", False, "ambiguous"


def cohen_kappa(a_labels: list[str], b_labels: list[str]) -> dict[str, Any] | None:
    if not a_labels or len(a_labels) != len(b_labels):
        return None
    labels = sorted(set(a_labels) | set(b_labels))
    n = len(a_labels)
    agree = sum(1 for a, b in zip(a_labels, b_labels) if a == b)
    pa = agree / n if n else 0.0
    a_counts = collections.Counter(a_labels)
    b_counts = collections.Counter(b_labels)
    pe = sum((a_counts[label] / n) * (b_counts[label] / n) for label in labels) if n else 0.0
    kappa = (pa - pe) / (1 - pe) if pe != 1 else 1.0
    return {
        "n": n,
        "labels": labels,
        "observed_agreement": pa,
        "expected_agreement": pe,
        "cohen_kappa": kappa,
    }


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    actionable = [row for row in rows if row.get("actionable")]
    uncensored = [row for row in actionable if not row.get("adjudicated_censor")]
    recovered = [row for row in uncensored if row.get("adjudicated_recovered")]
    censored = [row for row in actionable if row.get("adjudicated_censor")]
    hard_fail = [
        row
        for row in uncensored
        if not row.get("adjudicated_recovered")
        and row.get("adjudicated_status") != "needs_human_adjudication"
    ]
    human = [row for row in actionable if row.get("root_source") == "human_direct"]
    human_uncensored = [row for row in human if not row.get("adjudicated_censor")]
    human_recovered = [row for row in human_uncensored if row.get("adjudicated_recovered")]
    return {
        "rows_total": len(rows),
        "actionable": len(actionable),
        "uncensored": {"k": len(recovered), "n": len(uncensored), "pct": pct(len(recovered), len(uncensored))},
        "human_uncensored": {
            "k": len(human_recovered),
            "n": len(human_uncensored),
            "pct": pct(len(human_recovered), len(human_uncensored)),
        },
        "censored_cells": dict(collections.Counter(row.get("adjudicated_censor") for row in censored)),
        "hard_fail": {"k": len(hard_fail), "n_total": len(actionable), "n_uncensored": len(uncensored)},
        "status_counts": dict(collections.Counter(row.get("adjudicated_status") for row in actionable)),
        "label_counts": dict(collections.Counter(row.get("adjudicated_label") for row in actionable)),
        "needs_human_adjudication": sum(
            1 for row in actionable if row.get("adjudicated_status") == "needs_human_adjudication"
        ),
    }


def pct(k: int, n: int) -> float | None:
    return (100 * k / n) if n else None


def main() -> None:
    args = parse_args()
    artifact_dir = args.artifact_dir
    roots_path = args.roots or artifact_dir / "current_recovery_roots.jsonl"
    judge_a_path = args.judge_a or artifact_dir / "judge-a.labels.jsonl"
    judge_b_path = args.judge_b or artifact_dir / "judge-b.labels.jsonl"

    roots = load_jsonl(roots_path)
    judge_a, errors_a = index_judge(load_jsonl(judge_a_path), "judge-a")
    judge_b, errors_b = index_judge(load_jsonl(judge_b_path), "judge-b")
    errors = errors_a + errors_b
    if errors:
        raise SystemExit("\n".join(errors))

    expected_suspects = [row["root"] for row in roots if row.get("actionable") and not row.get("recovered")]
    present_judges = []
    if judge_a:
        present_judges.append("judge-a")
    if judge_b:
        present_judges.append("judge-b")

    missing_by_judge = {
        "judge-a": sorted(set(expected_suspects) - set(judge_a)) if judge_a else expected_suspects,
        "judge-b": sorted(set(expected_suspects) - set(judge_b)) if judge_b else expected_suspects,
    }

    adjudicated: list[dict[str, Any]] = []
    disagreements: list[dict[str, Any]] = []
    paired_a: list[str] = []
    paired_b: list[str] = []

    for row in roots:
        out = dict(row)
        root = row["root"]
        if not row.get("actionable") or row.get("recovered"):
            label = "recovered_after_same_nudge" if row.get("recoded_status") == "recovered_after_same_nudge" else "recovered_original"
            out.update(
                {
                    "adjudicated_label": label,
                    "adjudicated_status": row.get("recoded_status"),
                    "adjudicated_recovered": row.get("recoded_recovered"),
                    "adjudicated_censor": row.get("recoded_censor"),
                    "adjudication_source": "parser_floor",
                }
            )
            adjudicated.append(out)
            continue

        a = judge_a.get(root)
        b = judge_b.get(root)
        if a and b:
            paired_a.append(a["label"])
            paired_b.append(b["label"])
            if a["label"] == b["label"]:
                status, recovered, censor = normalize_from_label(a["label"])
                out.update(
                    {
                        "adjudicated_label": a["label"],
                        "adjudicated_status": status,
                        "adjudicated_recovered": recovered,
                        "adjudicated_censor": censor,
                        "adjudication_source": "judge_consensus",
                        "judge_a": a,
                        "judge_b": b,
                    }
                )
            else:
                out.update(
                    {
                        "adjudicated_label": "ambiguous",
                        "adjudicated_status": "needs_human_adjudication",
                        "adjudicated_recovered": False,
                        "adjudicated_censor": "ambiguous",
                        "adjudication_source": "judge_disagreement",
                        "judge_a": a,
                        "judge_b": b,
                    }
                )
                disagreements.append(out)
        else:
            out.update(
                {
                    "adjudicated_label": row.get("first_break_label") or row.get("reason"),
                    "adjudicated_status": row.get("recoded_status"),
                    "adjudicated_recovered": row.get("recoded_recovered"),
                    "adjudicated_censor": row.get("recoded_censor"),
                    "adjudication_source": "provisional_heuristic_only",
                    "judge_a": a,
                    "judge_b": b,
                }
            )
        adjudicated.append(out)

    summary = {
        "artifact_dir": str(artifact_dir),
        "roots_path": str(roots_path),
        "judge_files": {
            "judge-a": {"path": str(judge_a_path), "rows": len(judge_a), "missing_roots": len(missing_by_judge["judge-a"])},
            "judge-b": {"path": str(judge_b_path), "rows": len(judge_b), "missing_roots": len(missing_by_judge["judge-b"])},
        },
        "present_judges": present_judges,
        "mode": "dual_judge" if judge_a and judge_b else "provisional_heuristic_only",
        "agreement": cohen_kappa(paired_a, paired_b),
        "disagreements": len(disagreements),
        "rates": summarize(adjudicated),
    }

    write_jsonl(artifact_dir / "adjudicated_recode.jsonl", adjudicated)
    write_jsonl(artifact_dir / "disagreements.jsonl", disagreements)
    write_json(artifact_dir / "adjudication_summary.json", summary)
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
