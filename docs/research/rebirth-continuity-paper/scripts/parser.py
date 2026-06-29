#!/usr/bin/env python3
"""
parser.py - rail-7950db67 step s4. Corpus parser / dataset builder.

Reads $RELAY_DATA_DIR/rebirth/*.jsonl (one line = one rebirth transition) and
events/<instanceId>.jsonl (per-instance behavior), emits transitions.jsonl:
one row per transition with the handover manifest M(T), the successor's
early-window behavior (K actions after the rebirth), and raw signals that
the s5 scorer normalizes into Score A.

Pure OFFLINE read. No relay code, no writes to relay data. Run the full
corpus pass via nohup (AGENTS.md long-running-scripts rule).

Schema spec: corpus-schema-and-design.md
Usage:
  python3 parser.py --sample 14         # validate join + print diagnostics, no output file
  nohup python3 parser.py > parse.log 2>&1 &   # full corpus -> transitions.jsonl
"""
import json, os, glob, re, argparse, sys, time, datetime

DATA = os.environ.get("RELAY_DATA_DIR", "relay/data")
REBIRTH_DIR = os.path.join(DATA, "rebirth")
EVENTS_DIR = os.path.join(DATA, "events")
K_DEFAULT = 20
PRED_LOOKBACK = 60  # predecessor tool calls before t to treat as "recently handed" behavioral read-set

RETRIEVAL_TOOLS = {"atlas_query", "atlas_graph", "Grep", "Glob", "WebSearch", "WebFetch",
                   "tap_instance_messages", "search_docs", "knowledge",
                   "query_global_index", "query_turns", "psychic_pov"}
READ_TOOLS = {"Read"}
EDIT_TOOLS = {"Edit", "Write", "NotebookEdit", "apply_migration"}
RAIL_TOOLS = {"task_rail"}
CLAIM_TOOLS = {"partner_claim_file", "squad_claim_file"}

# tsx/jsx BEFORE ts/js so ".tsx" is not truncated to ".ts"; trailing boundary blocks partial matches.
FILE_RE = re.compile(r'[A-Za-z0-9_./\-]+\.(?:tsx|ts|jsx|js|mjs|cjs|py|md|json|rs|scss|css|sql|html|sh|toml|yaml|yml|txt)(?![A-Za-z0-9])')


def to_ms(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        s = v.strip()
        if s.isdigit():
            return int(s)
        try:
            return int(datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
        except Exception:
            return None
    return None


def ev_ts(e):
    t = to_ms(e.get("ts"))
    if t is None:
        t = to_ms((e.get("p") or {}).get("timestamp"))
    return t


def tool_name(p):
    return p.get("canonicalToolName") or p.get("rawToolName")


def input_paths(inp):
    out = set()
    if isinstance(inp, dict):
        for k in ("file_path", "path", "filePath", "notebook_path"):
            v = inp.get(k)
            if isinstance(v, str):
                out.add(v)
    return out


def model_str(v):
    if isinstance(v, dict):
        return f"{v.get('engine', '')}/{v.get('modelTier') or v.get('model') or ''}".strip("/")
    return str(v or "")[:80]


def path_match(a, b):
    if not a or not b:
        return False
    if a == b:
        return True
    return a.endswith("/" + b) or b.endswith("/" + a)


def trigger_class(reason):
    r = (reason or "").lower()
    if not r:
        return "unknown"
    if "manual ui" in r:
        return "manual_ui"
    if "turn-threshold" in r:
        return "turn_threshold"
    if "compact" in r:
        return "compact"
    if r.startswith("resume") or r.startswith("restore"):
        return "cold_resume"
    if "watchdog" in r:
        return "watchdog"
    if "evolution-chamber" in r:
        return "evolution_chamber"
    if "wave protocol" in r or "wave" in r:
        return "wave_protocol"
    if "review" in r:
        return "review"
    return "context_pressure"  # free-text human/agent-authored reasons


def extract_manifest(rec):
    m = {"files": set(), "rail_active": "", "rail_present": False, "model_swapped": None,
         "model_pred": "", "model_succ": "", "workspace": "", "cwd": "",
         "user_triggered": None, "coord_present": False, "text": ""}
    pj = rec.get("packageJson")
    obj = None
    if pj:
        try:
            obj = json.loads(pj)
        except Exception:
            obj = None
    if isinstance(obj, dict):
        rm = obj.get("runtimeModel") or {}
        if isinstance(rm, dict):
            ch = rm.get("changed")
            m["model_swapped"] = bool(ch) if ch is not None else None
            m["model_pred"] = model_str(rm.get("predecessor"))
            m["model_succ"] = model_str(rm.get("successor"))
        ws = obj.get("workspaceContext") or {}
        if isinstance(ws, dict):
            m["workspace"] = str(ws.get("currentWorkspace") or "")
            m["cwd"] = str(ws.get("currentCwd") or "")
        m["user_triggered"] = obj.get("userMessageTriggered")
        acr = str(obj.get("atlasCrossRef") or "")
        aed = str(obj.get("activeEditDelta") or "")
        trc = str(obj.get("taskRailContext") or "")
        m["rail_present"] = bool(trc.strip())
        mstep = re.search(r'[Aa]ctive[^\n]*?step[^\n]*?([0-9]+/[0-9]+|\bs\d+\b)', trc)
        if mstep:
            m["rail_active"] = mstep.group(1)
        m["coord_present"] = bool(str(obj.get("coordinationState") or "").strip())
        for blob in (acr, aed):
            for mt in FILE_RE.finditer(blob):
                m["files"].add(mt.group(0))
        m["text"] = " ".join(str(obj.get(k) or "") for k in
                             ("lastUserAiMessages", "currentThread", "thinkingTrail", "warmContinuity",
                              "atlasCrossRef", "activeEditDelta", "taskRailContext", "coordinationState"))
    else:
        pt = str(rec.get("packageText") or "")
        m["text"] = pt
        mm = re.search(r'Changed:\s*(yes|no)', pt)
        if mm:
            m["model_swapped"] = (mm.group(1) == "yes")
        for mt in FILE_RE.finditer(pt):
            m["files"].add(mt.group(0))
    return m


def build_event_index(instance_id):
    path = os.path.join(EVENTS_DIR, instance_id + ".jsonl")
    if not os.path.exists(path):
        return None
    evs = []
    with open(path) as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except Exception:
                continue
            ts = ev_ts(e)
            if ts is None:
                continue
            evs.append((ts, e))
    evs.sort(key=lambda x: x[0])
    return evs


def predecessor_recent_reads(evs, t, lookback=PRED_LOOKBACK):
    """File paths the predecessor Read in its last `lookback` tool calls before t."""
    reads = set()
    seen = 0
    for ts, e in reversed(evs):
        if ts >= t:
            continue
        if e.get("ty") != "tool_call_start":
            continue
        seen += 1
        if seen > lookback:
            break
        p = e.get("p") or {}
        if tool_name(p) in READ_TOOLS:
            reads.update(input_paths(p.get("input")))
    return reads


def window_signals(evs, t, K, manifest):
    reads, retrievals, rail_actions = [], [], []
    edits, claims = set(), set()
    window_tids = set()
    n_actions = 0
    window_end = t
    # Pass 1: first K tool_call_start events after t
    for ts, e in evs:
        if ts <= t:
            continue
        if n_actions >= K:
            break
        if e.get("ty") != "tool_call_start":
            continue
        n_actions += 1
        window_end = ts
        p = e.get("p") or {}
        window_tids.add(e.get("tid") or p.get("turnId"))
        tn = tool_name(p)
        inp = p.get("input")
        if tn in READ_TOOLS:
            reads.extend(input_paths(inp))
        elif tn in EDIT_TOOLS:
            edits.update(input_paths(inp))
        elif tn in RAIL_TOOLS:
            op = sid = ""
            if isinstance(inp, dict):
                op = str(inp.get("operation") or inp.get("mode") or "")
                sid = str(inp.get("step_id") or inp.get("stepId") or "")
            rail_actions.append({"op": op, "step": sid})
        elif tn in CLAIM_TOOLS:
            claims.update(input_paths(inp))
        elif tn in RETRIEVAL_TOOLS:
            tgt = ""
            if isinstance(inp, dict):
                tgt = str(inp.get("query") or inp.get("search") or inp.get("pattern") or "")
                if not tgt:
                    for pth in input_paths(inp):
                        tgt = pth
                        break
            retrievals.append({"tool": tn, "target": tgt[:160]})
    # Pass 2: token/error accounting by turnId of in-window actions
    tokens_in = tokens_out = turns = errors = 0
    cost = 0.0
    for ts, e in evs:
        if ts <= t:
            continue
        tid = e.get("tid") or (e.get("p") or {}).get("turnId")
        if tid not in window_tids:
            continue
        ty = e.get("ty")
        p = e.get("p") or {}
        if ty == "turn_result":
            tokens_in += int(p.get("inputTokens") or 0)
            tokens_out += int(p.get("outputTokens") or 0)
            try:
                cost += float(p.get("cost") or 0)
            except Exception:
                pass
            turns += 1
        elif ty == "error":
            errors += 1
    # Raw signals (manifest-based + predecessor-behavioral denominators)
    mf = list(manifest["files"])
    pred_reads = predecessor_recent_reads(evs, t)

    def in_set(pth, s):
        return any(path_match(pth, x) for x in s)
    edits_claims = edits | claims
    reads_of_manifest = [r for r in reads if in_set(r, mf)]
    unjustified_manifest = [r for r in set(reads_of_manifest) if not in_set(r, edits_claims)]
    reads_of_pred = [r for r in reads if in_set(r, pred_reads)]
    unjustified_pred = [r for r in set(reads_of_pred) if not in_set(r, edits_claims)]
    retr_in_manifest = 0
    for r in retrievals:
        tg = r["target"]
        if tg and (in_set(tg, mf) or tg in manifest["text"]):
            retr_in_manifest += 1
    return {
        "n_actions": n_actions, "window_end": window_end,
        "reads": reads, "retrievals": retrievals, "edits": sorted(edits),
        "rail_actions": rail_actions, "claims": sorted(claims),
        "tokens_in": tokens_in, "tokens_out": tokens_out, "cost": round(cost, 6),
        "errors": errors, "turns": turns,
        "manifest_file_count": len(mf),
        "predecessor_read_count": len(pred_reads),
        "rereads_of_manifest": len(reads_of_manifest),
        "unjustified_manifest_rereads": len(unjustified_manifest),
        "rereads_of_pred": len(reads_of_pred),
        "unjustified_pred_rereads": len(unjustified_pred),
        "early_acquisitions": len(reads) + len(retrievals),
        "retrievals_in_manifest": retr_in_manifest,
        "resumed_rail": len(rail_actions) > 0,
        "reclaimed": any(in_set(c, mf) for c in claims),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=0, help="process only first N instances; print diagnostics, no output file")
    ap.add_argument("--K", type=int, default=K_DEFAULT)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "transitions.jsonl"))
    args = ap.parse_args()

    by_inst = {}
    nfiles = ntrans = 0
    for f in sorted(glob.glob(os.path.join(REBIRTH_DIR, "*.jsonl"))):
        if os.path.getsize(f) == 0:
            continue
        nfiles += 1
        with open(f) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                iid = rec.get("instanceId")
                if not iid:
                    continue
                by_inst.setdefault(iid, []).append(rec)
                ntrans += 1
    insts = sorted(by_inst.keys())
    if args.sample:
        insts = insts[:args.sample]
    sys.stderr.write(f"[parser] {nfiles} rebirth files, {ntrans} transitions, {len(by_inst)} instances; processing {len(insts)} (K={args.K})\n")
    sys.stderr.flush()

    out = open(args.out, "w") if not args.sample else None
    written = skipped_no_events = 0
    diag = []
    t0 = time.time()
    for i, iid in enumerate(insts):
        evs = build_event_index(iid)
        if evs is None:
            skipped_no_events += len(by_inst[iid])
            continue
        for rec in by_inst[iid]:
            t = to_ms(rec.get("t"))
            if t is None:
                continue
            man = extract_manifest(rec)
            win = window_signals(evs, t, args.K, man)
            row = {
                "transition_id": f"{iid}:{t}",
                "instanceId": iid, "t": t,
                "reason": rec.get("reason"),
                "trigger_class": trigger_class(rec.get("reason")),
                "predecessorStatus": rec.get("predecessorStatus"),
                "packageChars": rec.get("packageChars"),
                "model_pred": man["model_pred"], "model_succ": man["model_succ"],
                "model_swapped": man["model_swapped"],
                "workspace": man["workspace"], "cwd": man["cwd"],
                "user_triggered": man["user_triggered"],
                "manifest": {"file_count": len(man["files"]), "rail_active": man["rail_active"],
                             "rail_present": man["rail_present"], "coord_present": man["coord_present"]},
                "window": {k: win[k] for k in ("n_actions", "tokens_in", "tokens_out", "cost", "errors", "turns")},
                "detail": {"reads": win["reads"], "retrievals": win["retrievals"], "edits": win["edits"],
                           "rail_actions": win["rail_actions"], "claims": win["claims"]},
                "raw_signals": {k: win[k] for k in ("manifest_file_count", "predecessor_read_count",
                                                    "rereads_of_manifest", "unjustified_manifest_rereads",
                                                    "rereads_of_pred", "unjustified_pred_rereads",
                                                    "early_acquisitions", "retrievals_in_manifest",
                                                    "resumed_rail", "reclaimed")},
            }
            if args.sample:
                row["_manifest_files_sample"] = sorted(man["files"])[:15]
                diag.append(row)
            else:
                out.write(json.dumps(row) + "\n")
                written += 1
        if not args.sample and i % 100 == 0:
            sys.stderr.write(f"[parser] {i}/{len(insts)} instances, {written} rows, {time.time()-t0:.0f}s\n")
            sys.stderr.flush()
    if out:
        out.close()
    sys.stderr.write(f"[parser] DONE wrote={written} skipped_no_events={skipped_no_events} elapsed={time.time()-t0:.0f}s\n")
    sys.stderr.flush()

    if args.sample:
        print(json.dumps(diag[:4], indent=2, default=str))
        n = len(diag) or 1
        nz = sum(1 for r in diag if r["window"]["n_actions"] > 0)
        wm = sum(1 for r in diag if r["raw_signals"]["manifest_file_count"] > 0)
        sw = sum(1 for r in diag if r["model_swapped"])
        tok = sum(1 for r in diag if r["window"]["tokens_in"] > 0)
        rr = sum(r["raw_signals"]["rereads_of_manifest"] for r in diag)
        print(f"\n[sample] {len(diag)} transitions | {nz} w/ in-window actions | {wm} w/ >=1 manifest file | "
              f"{sw} model-swaps | {tok} w/ token data | total manifest-rereads={rr}")
        print(f"[sample] avg in-window actions={sum(r['window']['n_actions'] for r in diag)/n:.1f} "
              f"(if ~0 the timestamp join is BROKEN)")


if __name__ == "__main__":
    main()
