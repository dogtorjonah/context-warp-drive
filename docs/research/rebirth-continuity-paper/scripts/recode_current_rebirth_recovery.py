#!/usr/bin/env python3
"""Emit current rebirth recovery roots and a provisional recode.

This is the repo-tracked replacement for the old temporary linker/recode
workflow. It keeps the original
parser-floor root definition, then adds enough row-level context for a current
manual/dual-judge recode:

  root = interrupted turn with no ai_result
         + next turn is trigger_type='rebirth'
         + root itself is not a rebirth turn

The parser floor still counts any fresh non-rebirth trigger before success as
a break. The "heuristic_current_recode" layer is deliberately labeled as a
provisional machine pass; judge packets are emitted beside it so independent
reviewers can overwrite the label columns without changing the denominator.
"""

from __future__ import annotations

import argparse
import bisect
import collections
import datetime as dt
import hashlib
import json
import math
import os
import random
import re
import sqlite3
import subprocess
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_ROOT = Path(os.environ.get("RELAY_DATA_DIR", "relay/data"))
DEFAULT_OUT_DIR = Path(
    os.environ.get(
        "REBIRTH_PAPER_ARTIFACT_DIR",
        str(PROJECT_ROOT / "artifacts" / "recode-2026-06-08"),
    )
)
WINDOW = 15
BOOTSTRAP_SEED = 20260608
BOOTSTRAP_B = 5000

CHATFRAME_RE = re.compile(r'\[Chat Room "|Mentioned by|^-- .+ in #|^\u2500\u2500 .+ in #', re.M)
CLOSER_RE = re.compile(
    r"^\s*(ok(ay)?|k|thx|thanks?|thank you|ty|cool|nice|great|perfect|"
    r"got it|sounds good|yes|yep|yeah|no|nope|stop|done|continue|"
    r"go ahead|go|proceed|sure|right|exactly|[.?!])\W*$",
    re.I,
)
SAME_INTENT_RE = re.compile(
    r"\b("
    r"continue|keep going|go ahead|go for it|proceed|finish|finish it|"
    r"carry on|resume|pick up|same|that|those|it|this|do it|do that|"
    r"did you|have you|any update|status|fixed|fix it|ship it|land it|"
    r"do all|do it all|load a rail|run it|rerun|re-run|try again|"
    r"yes|yep|yeah|ok|okay|sounds good"
    r")\b",
    re.I,
)
EXTERNAL_RE = re.compile(
    r"\[Chat Room |Mentioned by|^-- .+ in #|^\u2500\u2500 .+ in #|"
    r"\[DIGEST DELTA|\[CHATROOM SIGNALS|\[Task rail|\[CONTEXT REBIRTH\]",
    re.M,
)
PFX_RE = re.compile(r"^mcp__[a-z0-9-]+__")

REORIENT_TOOLS = {
    "atlas_query",
    "atlas_graph",
    "Grep",
    "Glob",
    "Read",
    "tap_instance_messages",
    "psychic_pov",
    "query_global_index",
    "query_turns",
    "chatroom",
    "WebSearch",
    "WebFetch",
    "search_docs",
    "partner_file_claims",
    "squad_file_claims",
}
SUBSTANTIVE_TOOLS = {"Edit", "Write", "NotebookEdit", "apply_migration", "apply_patch"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=DEFAULT_DATA_ROOT)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--window", type=int, default=WINDOW)
    parser.add_argument("--snapshot-dir", type=Path)
    parser.add_argument("--bootstrap-b", type=int, default=BOOTSTRAP_B)
    parser.add_argument("--bootstrap-seed", type=int, default=BOOTSTRAP_SEED)
    return parser.parse_args()


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def as_ms(value: Any) -> int | None:
    if value is None:
        return None
    try:
        ivalue = int(value)
    except (TypeError, ValueError):
        return None
    if ivalue < 10_000_000_000:
        return ivalue * 1000
    return ivalue


def iso_ms(value: Any) -> str | None:
    ms = as_ms(value)
    if ms is None:
        return None
    return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )


def load_json(value: str | None, fallback: Any = None) -> Any:
    if not value:
        return [] if fallback is None else fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return [] if fallback is None else fallback


def norm_tool(name: str | None) -> str | None:
    if not name:
        return name
    return PFX_RE.sub("", name)


def actionable(text: str | None) -> bool:
    stripped = (text or "").strip()
    return len(stripped) >= 8 and not CLOSER_RE.match(stripped)


def source_kind(text: str | None) -> str:
    return "chatroom_agent" if CHATFRAME_RE.search(text or "") else "human_direct"


def classify_reason(reason: str | None) -> str:
    value = (reason or "").lower()
    if not value:
        return "unknown"
    if any(token in value for token in ("wave", "decompose", "shoot", "review", "improve")):
        return "wave_pipeline"
    if any(token in value for token in ("manual", "operator", "ui", "button")):
        return "manual_operator"
    if any(token in value for token in ("threshold", "context", "compact", "ceiling")):
        return "threshold_or_context_pressure"
    if any(token in value for token in ("resume", "restore", "library")):
        return "resume_restore"
    if "self" in value:
        return "self_rebirth_tool"
    if any(token in value for token in ("watchdog", "refresh", "health")):
        return "watchdog_refresh"
    if any(token in value for token in ("evolution", "alternating", "protocol")):
        return "pipeline_other"
    return "other"


def classify_break(text: str | None, tools_used: list[str], root_text: str | None) -> str:
    body = text or ""
    if EXTERNAL_RE.search(body):
        return "external_chat_or_system_preemption"

    normalized_tools = {norm_tool(name) for name in tools_used}
    if normalized_tools & {"chatroom", "tap_instance_messages"} and CHATFRAME_RE.search(body):
        return "external_chat_or_system_preemption"

    stripped = body.strip()
    if not stripped:
        return "ambiguous"
    if len(stripped) <= 24 and SAME_INTENT_RE.search(stripped):
        return "same_intent_nudge_or_reask"
    if SAME_INTENT_RE.search(stripped) and weak_text_overlap(root_text, stripped):
        return "same_intent_nudge_or_reask"
    if SAME_INTENT_RE.search(stripped) and len(stripped) <= 80:
        return "same_intent_nudge_or_reask"
    if len(stripped) < 10:
        return "ambiguous"
    return "operator_supersession_new_intent"


def weak_text_overlap(a: str | None, b: str | None) -> bool:
    stop = {
        "the",
        "and",
        "for",
        "you",
        "that",
        "this",
        "with",
        "from",
        "have",
        "what",
        "when",
        "where",
        "how",
        "are",
        "all",
        "can",
        "into",
        "our",
        "your",
    }
    aw = {w for w in re.findall(r"[a-z0-9_/-]{4,}", (a or "").lower()) if w not in stop}
    bw = {w for w in re.findall(r"[a-z0-9_/-]{4,}", (b or "").lower()) if w not in stop}
    if not aw or not bw:
        return False
    return len(aw & bw) >= 2


def row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def files(row: sqlite3.Row | dict[str, Any]) -> set[str]:
    return set(load_json(row["files_touched_json"]))


def tools(row: sqlite3.Row | dict[str, Any]) -> list[str]:
    return [str(item) for item in load_json(row["tools_used_json"])]


def turn_brief(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    raw = row_to_dict(row) if isinstance(row, sqlite3.Row) else dict(row)
    return {
        "turn_id": raw.get("turn_id"),
        "started_at": raw.get("started_at"),
        "started_at_iso": iso_ms(raw.get("started_at")),
        "ended_at": raw.get("ended_at"),
        "ended_at_iso": iso_ms(raw.get("ended_at")),
        "trigger_type": raw.get("trigger_type"),
        "outcome": raw.get("outcome"),
        "user_request": raw.get("user_request"),
        "ai_result_excerpt": excerpt(raw.get("ai_result"), 500),
        "files_touched": load_json(raw.get("files_touched_json")),
        "tools_used": tools(raw),
        "token_count": raw.get("token_count"),
    }


def excerpt(value: str | None, limit: int = 600) -> str | None:
    if value is None:
        return None
    compact = re.sub(r"\s+", " ", value).strip()
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1] + "..."


def to_seconds(value: Any) -> float | None:
    ms = as_ms(value)
    if ms is None:
        return None
    return ms / 1000


def median(values: list[float | int | None]) -> float | int | None:
    clean = sorted(v for v in values if v is not None)
    if not clean:
        return None
    return clean[len(clean) // 2]


def wilson(k: int, n: int, z: float = 1.96) -> dict[str, float | int]:
    if n == 0:
        return {"k": k, "n": n, "pct": 0.0, "lo": 0.0, "hi": 0.0}
    p = k / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return {
        "k": k,
        "n": n,
        "pct": 100 * p,
        "lo": 100 * (center - half),
        "hi": 100 * (center + half),
    }


def cluster_bootstrap_rate(
    rows: list[dict[str, Any]],
    *,
    success_key: str,
    denom_filter: str | None = None,
    cluster_key: str = "iid",
    b: int = BOOTSTRAP_B,
    seed: int = BOOTSTRAP_SEED,
) -> dict[str, Any]:
    sample = [
        row
        for row in rows
        if denom_filter is None or bool(row.get(denom_filter))
    ]
    if not sample:
        return {"k": 0, "n": 0, "pct": 0.0, "lo": 0.0, "hi": 0.0, "clusters": 0}
    clusters: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for row in sample:
        clusters[str(row.get(cluster_key))].append(row)
    keys = sorted(clusters)
    rng = random.Random(seed)
    vals: list[float] = []
    for _ in range(b):
        selected = [clusters[rng.choice(keys)] for _ in keys]
        flat = [row for group in selected for row in group]
        denom = len(flat)
        num = sum(1 for row in flat if row.get(success_key))
        vals.append(num / denom if denom else 0.0)
    vals.sort()
    lo = vals[max(0, int(0.025 * len(vals)) - 1)]
    hi = vals[min(len(vals) - 1, int(0.975 * len(vals)))]
    k = sum(1 for row in sample if row.get(success_key))
    n = len(sample)
    return {
        "k": k,
        "n": n,
        "pct": 100 * k / n,
        "lo": 100 * lo,
        "hi": 100 * hi,
        "clusters": len(keys),
        "bootstrap_b": b,
        "bootstrap_seed": seed,
    }


def load_turns(data_root: Path) -> list[sqlite3.Row]:
    db_path = data_root / "global_index.sqlite"
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.text_factory = lambda b: b.decode("utf-8", "replace")
    con.row_factory = sqlite3.Row
    query = """
      SELECT turn_id, instance_id, instance_name, engine, workspace, started_at,
             ended_at, trigger_type, user_request, ai_result, summary,
             files_touched_json, tools_used_json, tags_json, outcome,
             token_count, cwd, repo_key
      FROM turns
      ORDER BY instance_id, started_at
    """
    return con.execute(query).fetchall()


def load_rebirth_artifacts(data_root: Path) -> dict[str, list[dict[str, Any]]]:
    by_instance: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for path in sorted((data_root / "rebirth").glob("*.jsonl")):
        iid = path.stem
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                rec["_file"] = str(path)
                rec["_reason_class"] = classify_reason(rec.get("reason"))
                by_instance[iid].append(rec)
    for records in by_instance.values():
        records.sort(key=lambda item: int(item.get("t") or 0))
    return by_instance


def nearest_rebirth_artifact(
    records: list[dict[str, Any]],
    started_at: Any,
) -> dict[str, Any] | None:
    if not records:
        return None
    target = as_ms(started_at)
    if target is None:
        return None
    times = [int(item.get("t") or 0) for item in records]
    idx = bisect.bisect_left(times, target)
    candidates = []
    for pos in (idx - 1, idx, idx + 1):
        if 0 <= pos < len(records):
            candidates.append(records[pos])
    if not candidates:
        return None
    best = min(candidates, key=lambda item: abs(int(item.get("t") or 0) - target))
    delta_ms = abs(int(best.get("t") or 0) - target)
    if delta_ms > 10 * 60 * 1000:
        return None
    out = dict(best)
    out["_delta_ms"] = delta_ms
    return out


def substantive_before_reorient(turns_in_chain: list[sqlite3.Row]) -> tuple[int, bool]:
    reorient = 0
    saw_substantive = False
    for turn in turns_in_chain:
        for name in (norm_tool(item) for item in tools(turn)):
            if name in SUBSTANTIVE_TOOLS:
                saw_substantive = True
                break
            if name in REORIENT_TOOLS and not saw_substantive:
                reorient += 1
        if saw_substantive:
            break
    return reorient, saw_substantive


def classify_future_after_same_nudge(
    seq: list[sqlite3.Row],
    *,
    start_index: int,
    end_index: int,
    root: sqlite3.Row,
) -> tuple[bool, str, str | None, list[str], str | None]:
    labels: list[str] = ["same_intent_nudge_or_reask"]
    root_files = files(root)
    root_text = root["user_request"]
    for pos in range(start_index + 1, end_index + 1):
        turn = seq[pos]
        if turn["outcome"] == "success":
            return True, "recovered_after_same_nudge", None, labels, None
        if turn["trigger_type"] == "rebirth":
            continue
        if root_files and files(turn) & root_files:
            continue
        label = classify_break(turn["user_request"], tools(turn), root_text)
        labels.append(label)
        if label == "same_intent_nudge_or_reask":
            continue
        if label == "operator_supersession_new_intent":
            return (
                False,
                "censored_after_same_nudge_operator_supersession_new_intent",
                "operator_supersession_new_intent",
                labels,
                turn["turn_id"],
            )
        if label == "external_chat_or_system_preemption":
            return (
                False,
                "censored_after_same_nudge_external_chat_or_system_preemption",
                "external_chat_or_system_preemption",
                labels,
                turn["turn_id"],
            )
        return (
            False,
            "censored_after_same_nudge_ambiguous",
            "ambiguous",
            labels,
            turn["turn_id"],
        )
    return False, "hard_churn_after_same_nudge", None, labels, None


def emit_rows(
    turns_rows: list[sqlite3.Row],
    rebirth_artifacts: dict[str, list[dict[str, Any]]],
    *,
    window: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    by_instance: dict[str, list[sqlite3.Row]] = collections.defaultdict(list)
    for row in turns_rows:
        by_instance[row["instance_id"]].append(row)

    out: list[dict[str, Any]] = []
    raw_roots = 0
    interrupted_next_rebirth = 0
    non_actionable = 0

    for iid, seq in by_instance.items():
        for i, root in enumerate(seq):
            if (
                i + 1 < len(seq)
                and root["outcome"] == "interrupted"
                and not root["ai_result"]
                and seq[i + 1]["trigger_type"] == "rebirth"
            ):
                interrupted_next_rebirth += 1
            if root["outcome"] != "interrupted":
                continue
            if root["ai_result"]:
                continue
            if root["trigger_type"] == "rebirth":
                continue
            if i + 1 >= len(seq) or seq[i + 1]["trigger_type"] != "rebirth":
                continue

            raw_roots += 1
            root_actionable = actionable(root["user_request"])
            if not root_actionable:
                non_actionable += 1

            root_files = files(root)
            recovered = False
            completed_index: int | None = None
            break_index: int | None = None
            break_reason = "no_success_in_window"

            last_index = min(i + window, len(seq) - 1)
            for j in range(i + 1, last_index + 1):
                turn = seq[j]
                if j > i + 1 and turn["trigger_type"] != "rebirth":
                    same_file_thread = bool(root_files and files(turn) & root_files)
                    context_rebirth_frame = "[CONTEXT REBIRTH]" in (turn["user_request"] or "")
                    if not same_file_thread and not context_rebirth_frame:
                        break_index = j
                        break_reason = "broke_fresh_trigger"
                        break
                if turn["outcome"] == "success":
                    recovered = True
                    completed_index = j
                    break

            end_index = completed_index if completed_index is not None else last_index
            chain = seq[i + 1 : end_index + 1]
            reorient, saw_substantive = substantive_before_reorient(chain)
            elapsed_s = None
            if completed_index is not None:
                start_s = to_seconds(root["started_at"])
                end_s = to_seconds(seq[completed_index]["ended_at"])
                if start_s is not None and end_s is not None and end_s >= start_s:
                    elapsed_s = end_s - start_s

            next_rebirth = seq[i + 1]
            artifact = nearest_rebirth_artifact(
                rebirth_artifacts.get(iid, []),
                next_rebirth["started_at"],
            )
            break_turn = seq[break_index] if break_index is not None else None
            first_break_label = None
            recoded_recovered = recovered
            recoded_status = "recovered_original" if recovered else "hard_churn/no_success"
            recoded_censor = None
            future_labels: list[str] | None = None
            recode_break_turn_id = None

            if break_turn is not None:
                first_break_label = classify_break(
                    break_turn["user_request"],
                    tools(break_turn),
                    root["user_request"],
                )
                if first_break_label == "same_intent_nudge_or_reask":
                    (
                        recoded_recovered,
                        recoded_status,
                        recoded_censor,
                        labels,
                        recode_break_turn_id,
                    ) = classify_future_after_same_nudge(
                        seq,
                        start_index=break_index,
                        end_index=last_index,
                        root=root,
                    )
                    future_labels = labels
                elif first_break_label == "operator_supersession_new_intent":
                    recoded_status = "censored_operator_supersession_new_intent"
                    recoded_censor = "operator_supersession_new_intent"
                    recoded_recovered = False
                    recode_break_turn_id = break_turn["turn_id"]
                elif first_break_label == "external_chat_or_system_preemption":
                    recoded_status = "censored_external_chat_or_system_preemption"
                    recoded_censor = "external_chat_or_system_preemption"
                    recoded_recovered = False
                    recode_break_turn_id = break_turn["turn_id"]
                else:
                    recoded_status = "censored_ambiguous"
                    recoded_censor = "ambiguous"
                    recoded_recovered = False
                    recode_break_turn_id = break_turn["turn_id"]

            row = {
                "root": root["turn_id"],
                "iid": iid,
                "instance_name": root["instance_name"],
                "engine": root["engine"],
                "workspace": root["workspace"],
                "repo_key": root["repo_key"],
                "started_at": root["started_at"],
                "started_at_iso": iso_ms(root["started_at"]),
                "root_source": source_kind(root["user_request"]),
                "actionable": root_actionable,
                "recovered": recovered,
                "chain_len": len(chain) if recovered else None,
                "elapsed_s": elapsed_s,
                "sum_tok": sum(int(turn["token_count"] or 0) for turn in chain),
                "reorient": reorient,
                "saw_substantive_tool": saw_substantive,
                "root_has_files": bool(root_files),
                "root_files": sorted(root_files),
                "reason": None if recovered else break_reason,
                "completed_turn": seq[completed_index]["turn_id"] if completed_index is not None else None,
                "break_turn": break_turn["turn_id"] if break_turn is not None else None,
                "break_turn_source": source_kind(break_turn["user_request"]) if break_turn else None,
                "first_break_label": first_break_label,
                "future_labels": future_labels,
                "recoded_status": recoded_status,
                "recoded_recovered": recoded_recovered,
                "recoded_censor": recoded_censor,
                "recoded_break_turn": recode_break_turn_id,
                "recode_method": "heuristic_current_recode_v1",
                "successor_rebirth_turn": next_rebirth["turn_id"],
                "successor_rebirth_started_at": next_rebirth["started_at"],
                "successor_rebirth_started_at_iso": iso_ms(next_rebirth["started_at"]),
                "successor_rebirth_reason": artifact.get("reason") if artifact else None,
                "successor_rebirth_reason_class": artifact.get("_reason_class") if artifact else "unknown",
                "successor_rebirth_predecessor_status": artifact.get("predecessorStatus")
                if artifact
                else None,
                "successor_rebirth_package_chars": artifact.get("packageChars") if artifact else None,
                "successor_rebirth_artifact_delta_ms": artifact.get("_delta_ms") if artifact else None,
                "root_turn": turn_brief(root),
                "successor_rebirth_turn_brief": turn_brief(next_rebirth),
                "break_turn_brief": turn_brief(break_turn) if break_turn is not None else None,
                "window_turns": [turn_brief(turn) for turn in seq[i + 1 : last_index + 1]],
            }
            out.append(row)

    diagnostics = {
        "raw_roots_pre_actionability": raw_roots,
        "interrupted_next_rebirth": interrupted_next_rebirth,
        "non_actionable_roots": non_actionable,
        "actionable_roots": raw_roots - non_actionable,
    }
    return out, diagnostics


def rate_block(rows: list[dict[str, Any]], label: str) -> dict[str, Any]:
    n = len(rows)
    k = sum(1 for row in rows if row["recovered"])
    recovered = [row for row in rows if row["recovered"]]
    multihop = [row for row in recovered if row.get("chain_len") and row["chain_len"] > 1]
    return {
        "label": label,
        "parser_floor": wilson(k, n),
        "wake_turn_immediate": {
            "k": sum(1 for row in recovered if row.get("chain_len") == 1),
            "n": len(recovered),
        },
        "multihop_recovered": {
            "k": len(multihop),
            "n": len(recovered),
        },
        "cost_recovered": {
            "chain_len_median": median([row.get("chain_len") for row in recovered]),
            "elapsed_s_median": median([row.get("elapsed_s") for row in recovered]),
            "tokens_median": median([row.get("sum_tok") for row in recovered]),
            "reorient_median": median([row.get("reorient") for row in recovered]),
        },
        "cost_multihop_recovered": {
            "chain_len_median": median([row.get("chain_len") for row in multihop]),
            "elapsed_s_median": median([row.get("elapsed_s") for row in multihop]),
            "tokens_median": median([row.get("sum_tok") for row in multihop]),
            "reorient_median": median([row.get("reorient") for row in multihop]),
        },
    }


def recoded_rate(rows: list[dict[str, Any]], label: str) -> dict[str, Any]:
    censored = [row for row in rows if row.get("recoded_censor")]
    uncensored = [row for row in rows if not row.get("recoded_censor")]
    hard_fail = [
        row
        for row in uncensored
        if not row.get("recoded_recovered") and row.get("recoded_status") != "recovered_original"
    ]
    return {
        "label": label,
        "uncensored": wilson(sum(1 for row in uncensored if row["recoded_recovered"]), len(uncensored)),
        "censored_cells": dict(collections.Counter(row["recoded_censor"] for row in censored)),
        "censored_n": len(censored),
        "hard_fail": {"k": len(hard_fail), "n_total": len(rows), "n_uncensored": len(uncensored)},
        "status_counts": dict(collections.Counter(row["recoded_status"] for row in rows)),
        "first_break_counts": dict(
            collections.Counter(row["first_break_label"] for row in rows if row["first_break_label"])
        ),
        "reason_counts": dict(collections.Counter(row["reason"] for row in rows if row["reason"])),
    }


def summarize(
    rows: list[dict[str, Any]],
    persistence_rows: list[dict[str, Any]],
    diagnostics: dict[str, Any],
    *,
    bootstrap_b: int,
    bootstrap_seed: int,
) -> dict[str, Any]:
    actionable_rows = [row for row in rows if row["actionable"]]
    human_rows = [row for row in actionable_rows if row["root_source"] == "human_direct"]
    chat_rows = [row for row in actionable_rows if row["root_source"] == "chatroom_agent"]
    suspect_rows = [row for row in actionable_rows if not row["recovered"]]

    summary = {
        "generated_at": utc_now(),
        "diagnostics": diagnostics,
        "counts": {
            "rows_total": len(rows),
            "actionable": len(actionable_rows),
            "human_direct_actionable": len(human_rows),
            "chatroom_agent_actionable": len(chat_rows),
            "suspect_actionable": len(suspect_rows),
        },
        "parser_floor": {
            "all_actionable": rate_block(actionable_rows, "all actionable roots"),
            "human_direct": rate_block(human_rows, "human-direct dogfood roots"),
            "chatroom_agent": rate_block(chat_rows, "chatroom/agent-relayed roots"),
            "cluster_bootstrap": {
                "all_actionable": cluster_bootstrap_rate(
                    actionable_rows,
                    success_key="recovered",
                    b=bootstrap_b,
                    seed=bootstrap_seed,
                ),
                "human_direct": cluster_bootstrap_rate(
                    human_rows,
                    success_key="recovered",
                    b=bootstrap_b,
                    seed=bootstrap_seed,
                ),
                "chatroom_agent": cluster_bootstrap_rate(
                    chat_rows,
                    success_key="recovered",
                    b=bootstrap_b,
                    seed=bootstrap_seed,
                ),
            },
        },
        "heuristic_current_recode": {
            "all_actionable": recoded_rate(actionable_rows, "all actionable roots"),
            "human_direct": recoded_rate(human_rows, "human-direct roots"),
            "chatroom_agent": recoded_rate(chat_rows, "chatroom/agent-relayed roots"),
            "cluster_bootstrap": {
                "all_uncensored": cluster_bootstrap_rate(
                    [row for row in actionable_rows if not row.get("recoded_censor")],
                    success_key="recoded_recovered",
                    b=bootstrap_b,
                    seed=bootstrap_seed,
                ),
                "human_uncensored": cluster_bootstrap_rate(
                    [row for row in human_rows if not row.get("recoded_censor")],
                    success_key="recoded_recovered",
                    b=bootstrap_b,
                    seed=bootstrap_seed,
                ),
            },
        },
        "trigger_reason_strata": {},
        "successor_engine": {},
        "persistence": summarize_persistence(
            persistence_rows,
            bootstrap_b=bootstrap_b,
            bootstrap_seed=bootstrap_seed,
        ),
    }

    reason_groups: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    engine_groups: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for row in actionable_rows:
        reason_groups[row.get("successor_rebirth_reason_class") or "unknown"].append(row)
        engine_groups[row.get("engine") or "unknown"].append(row)
    summary["trigger_reason_strata"] = {
        key: rate_block(value, key) for key, value in sorted(reason_groups.items())
    }
    summary["successor_engine"] = {
        key: rate_block(value, key)
        for key, value in sorted(engine_groups.items(), key=lambda item: (-len(item[1]), item[0]))
    }
    return summary


def persistence_follow(
    seq: list[sqlite3.Row],
    start_index: int,
    prior_files: set[str],
    *,
    window: int,
) -> tuple[bool, int | None]:
    for pos in range(start_index, min(start_index + window, len(seq))):
        turn = seq[pos]
        if pos > start_index and turn["trigger_type"] != "rebirth":
            same_file_thread = bool(prior_files and files(turn) & prior_files)
            context_rebirth_frame = "[CONTEXT REBIRTH]" in (turn["user_request"] or "")
            if not same_file_thread and not context_rebirth_frame:
                return False, None
        if turn["outcome"] == "success":
            return True, pos
    return False, None


def emit_persistence(turns_rows: list[sqlite3.Row], *, window: int) -> list[dict[str, Any]]:
    by_instance: dict[str, list[sqlite3.Row]] = collections.defaultdict(list)
    for row in turns_rows:
        by_instance[row["instance_id"]].append(row)

    out: list[dict[str, Any]] = []
    for iid, seq in by_instance.items():
        for index, rebirth_turn in enumerate(seq):
            if rebirth_turn["trigger_type"] != "rebirth":
                continue
            if index == 0:
                out.append(
                    {
                        "rebirth_turn": rebirth_turn["turn_id"],
                        "iid": iid,
                        "engine": rebirth_turn["engine"],
                        "cohort": "no_predecessor",
                        "persisted": None,
                        "immediate": False,
                    }
                )
                continue
            predecessor = seq[index - 1]
            cohort = (
                "interrupt_preceded"
                if predecessor["outcome"] == "interrupted" and not predecessor["ai_result"]
                else "clean_boundary"
            )
            prior_files: set[str] = set()
            for prior in seq[max(0, index - 3) : index]:
                prior_files |= files(prior)
            persisted, completed_index = persistence_follow(
                seq,
                index,
                prior_files,
                window=window,
            )
            out.append(
                {
                    "rebirth_turn": rebirth_turn["turn_id"],
                    "iid": iid,
                    "engine": rebirth_turn["engine"],
                    "cohort": cohort,
                    "persisted": persisted,
                    "immediate": bool(persisted and completed_index == index),
                }
            )
    return out


def summarize_persistence(
    rows: list[dict[str, Any]],
    *,
    bootstrap_b: int,
    bootstrap_seed: int,
) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "total_rebirth_arrivals": len(rows),
        "cohorts": {},
        "cluster_bootstrap": {},
    }
    for cohort in ("interrupt_preceded", "clean_boundary", "no_predecessor"):
        cohort_rows = [row for row in rows if row["cohort"] == cohort]
        measured = [row for row in cohort_rows if row["persisted"] is not None]
        if cohort == "no_predecessor":
            summary["cohorts"][cohort] = {"n": len(cohort_rows)}
            continue
        k = sum(1 for row in measured if row["persisted"])
        summary["cohorts"][cohort] = {
            "n": len(measured),
            "persisted": k,
            "wilson": wilson(k, len(measured)),
            "immediate": sum(1 for row in measured if row["immediate"]),
        }
        summary["cluster_bootstrap"][cohort] = cluster_bootstrap_rate(
            measured,
            success_key="persisted",
            b=bootstrap_b,
            seed=bootstrap_seed,
        )
    return summary


def artifact_manifest(data_root: Path, snapshot_dir: Path | None) -> dict[str, Any]:
    git_sha = None
    git_dirty = None
    try:
        git_sha = (
            subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL)
            .strip()
        )
        git_dirty = bool(
            subprocess.check_output(["git", "status", "--porcelain"], text=True, stderr=subprocess.DEVNULL)
            .strip()
        )
    except (OSError, subprocess.CalledProcessError):
        pass

    def dir_info(path: Path) -> dict[str, Any]:
        files = [p for p in path.glob("*.jsonl") if p.is_file()]
        line_count = 0
        byte_count = 0
        max_mtime = 0.0
        for item in files:
            stat = item.stat()
            byte_count += stat.st_size
            max_mtime = max(max_mtime, stat.st_mtime)
            with item.open("rb") as handle:
                line_count += sum(1 for _ in handle)
        return {
            "path": str(path),
            "file_count": len(files),
            "line_count": line_count,
            "bytes": byte_count,
            "max_mtime_iso": dt.datetime.fromtimestamp(max_mtime, tz=dt.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
            if max_mtime
            else None,
        }

    db_path = data_root / "global_index.sqlite"
    db_hash = sha256_file(db_path, max_bytes=64 * 1024 * 1024)
    return {
        "generated_at": utc_now(),
        "git_sha": git_sha,
        "git_dirty": git_dirty,
        "data_root": str(data_root),
        "snapshot_dir": str(snapshot_dir) if snapshot_dir else None,
        "global_index": {
            "path": str(db_path),
            "bytes": db_path.stat().st_size if db_path.exists() else None,
            "partial_sha256_first_64m": db_hash,
            "hash_note": "Full corpus checksums live in the research-snapshot freeze; this partial hash is a cheap run identity guard.",
        },
        "directories": {
            "messages": dir_info(data_root / "messages"),
            "events": dir_info(data_root / "events"),
            "rebirth": dir_info(data_root / "rebirth"),
        },
    }


def sha256_file(path: Path, *, max_bytes: int | None = None) -> str | None:
    if not path.exists():
        return None
    digest = hashlib.sha256()
    read = 0
    with path.open("rb") as handle:
        while True:
            chunk_size = 1024 * 1024
            if max_bytes is not None:
                remaining = max_bytes - read
                if remaining <= 0:
                    break
                chunk_size = min(chunk_size, remaining)
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            read += len(chunk)
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True) + "\n")


def write_readme(path: Path, summary: dict[str, Any], manifest: dict[str, Any]) -> None:
    pf = summary["parser_floor"]["all_actionable"]["parser_floor"]
    human = summary["parser_floor"]["human_direct"]["parser_floor"]
    rec = summary["heuristic_current_recode"]["all_actionable"]["uncensored"]
    human_rec = summary["heuristic_current_recode"]["human_direct"]["uncensored"]
    text = f"""# Rebirth Recovery Recode - 2026-06-08

Generated: `{summary['generated_at']}`

This directory is the current replacement for the old temporary linker/recode
artifacts. The root definition is
unchanged: interrupted turn, no `ai_result`, root is not itself a rebirth, and
the next turn is `trigger_type='rebirth'`.

## Files

- `current_recovery_roots.jsonl` - all roots, with parser-floor and provisional
  recode fields.
- `current_persistence_rows.jsonl` - all rebirth-arrival persistence rows used
  for the clean/interrupt handoff rates.
- `suspect_rows.jsonl` - actionable roots not recovered by the parser floor.
- `judge_packets.jsonl` - compact row packets for independent recoding.
- `summary.json` - aggregate counts/rates and trigger-reason strata.
- `run_manifest.json` - data-root, snapshot, and source-count metadata.
- `judge-a-deepseek.labels.jsonl` / `judge-b.labels.jsonl` - independent
  suspect-row judge passes, when present.
- `adjudicated_recode.jsonl`, `disagreements.jsonl`, and
  `adjudication_summary.json` - dual-judge reconciliation outputs, when present.
- `refreshTurns-2026-06-08.log` - turn-rebuild log.

## Headline Current Parser Floor

- All actionable roots: **{pf['pct']:.1f}%** ({pf['k']} / {pf['n']};
  Wilson 95% CI [{pf['lo']:.1f}, {pf['hi']:.1f}]).
- Human-direct dogfood roots: **{human['pct']:.1f}%** ({human['k']} / {human['n']};
  Wilson 95% CI [{human['lo']:.1f}, {human['hi']:.1f}]).

## Provisional Current Recode

This is **not** a manual dual-judge recode. It is a deterministic
`heuristic_current_recode_v1` pass over the current suspect rows. Treat it as a
current estimate and adjudication worklist, not as a final paper-grade judged
claim.

- All-actionable uncensored: **{rec['pct']:.1f}%** ({rec['k']} / {rec['n']};
  Wilson 95% CI [{rec['lo']:.1f}, {rec['hi']:.1f}]).
- Human-direct uncensored: **{human_rec['pct']:.1f}%** ({human_rec['k']} / {human_rec['n']};
  Wilson 95% CI [{human_rec['lo']:.1f}, {human_rec['hi']:.1f}]).

Snapshot source: `{manifest.get('snapshot_dir')}`
"""
    path.write_text(text, encoding="utf-8")


def main() -> None:
    args = parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    turns_rows = load_turns(args.data_root)
    rebirth_artifacts = load_rebirth_artifacts(args.data_root)
    rows, diagnostics = emit_rows(turns_rows, rebirth_artifacts, window=args.window)
    persistence_rows = emit_persistence(turns_rows, window=args.window)
    summary = summarize(
        rows,
        persistence_rows,
        diagnostics,
        bootstrap_b=args.bootstrap_b,
        bootstrap_seed=args.bootstrap_seed,
    )
    manifest = artifact_manifest(args.data_root, args.snapshot_dir)
    manifest["turns_table"] = {
        "row_count": len(turns_rows),
        "rebirth_turn_count": sum(1 for row in turns_rows if row["trigger_type"] == "rebirth"),
        "min_started_at": min((row["started_at"] for row in turns_rows), default=None),
        "max_started_at": max((row["started_at"] for row in turns_rows), default=None),
        "min_started_at_iso": iso_ms(min((row["started_at"] for row in turns_rows), default=None)),
        "max_started_at_iso": iso_ms(max((row["started_at"] for row in turns_rows), default=None)),
    }
    manifest["script"] = {
        "path": "docs/research/rebirth-continuity-paper/scripts/recode_current_rebirth_recovery.py",
        "window": args.window,
        "bootstrap_b": args.bootstrap_b,
        "bootstrap_seed": args.bootstrap_seed,
    }

    actionable_rows = [row for row in rows if row["actionable"]]
    suspect_rows = [row for row in actionable_rows if not row["recovered"]]
    judge_packets = [
        {
            "root": row["root"],
            "iid": row["iid"],
            "root_source": row["root_source"],
            "started_at_iso": row["started_at_iso"],
            "parser_reason": row["reason"],
            "heuristic_first_break_label": row["first_break_label"],
            "heuristic_recoded_status": row["recoded_status"],
            "heuristic_recoded_censor": row["recoded_censor"],
            "allowed_labels": [
                "same_intent_nudge_or_reask",
                "operator_supersession_new_intent",
                "external_chat_or_system_preemption",
                "ambiguous",
                "hard_churn/no_success",
                "recovered_after_same_nudge",
            ],
            "root_turn": row["root_turn"],
            "break_turn": row["break_turn_brief"],
            "window_turns": row["window_turns"],
        }
        for row in suspect_rows
    ]

    write_jsonl(args.out_dir / "current_recovery_roots.jsonl", rows)
    write_jsonl(args.out_dir / "current_persistence_rows.jsonl", persistence_rows)
    write_jsonl(args.out_dir / "suspect_rows.jsonl", suspect_rows)
    write_jsonl(args.out_dir / "judge_packets.jsonl", judge_packets)
    write_json(args.out_dir / "summary.json", summary)
    write_json(args.out_dir / "run_manifest.json", manifest)
    write_readme(args.out_dir / "README.md", summary, manifest)

    print(json.dumps({"summary": summary["counts"], "out_dir": str(args.out_dir)}, indent=2))


if __name__ == "__main__":
    main()
