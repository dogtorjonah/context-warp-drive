/**
 * foldEpisodeCapture.ts — pure capture extraction for the episodic engine.
 *
 * Walks a raw FoldMessage window (both message shapes: Anthropic content
 * blocks with tool_use/tool_result, and OpenAI tool_calls + role:'tool'
 * results) and derives sealed Episodes: zone members from real tool-input
 * touches, a structural-verbatim branch trace with outcomes, and VERBATIM
 * voice annotations mined from the three agent-authored surfaces —
 * atlas_commit changelog entries, tap_star notes, and typed chatroom lines —
 * plus tier-B narration mined at the burst seal from gap-resident assistant
 * prose (post-hoc by position; untagged prose is verdict-shaped by filter;
 * declared 🏁/⚠️ prose is trusted by the SOP message glyph; 🔍/▶/❓ openers
 * self-exclude).
 *
 * OPEN-BURST RULE: the final burst in the window is normally not recorded — it
 * may still be growing. Callers persist everything before it and advance their
 * capture cursor to the open burst's start, so the next epoch re-derives it
 * (sealed by then) without duplicates. The store's dedupe key is the second
 * line of defense; this cursor discipline is the first.
 * SETTLED-TRAILING EXCEPTION: if the trailing burst is already settled — the
 * window has moved >gapEvents non-touch events past its last touch, or >gapMs
 * of wall-clock has elapsed — it will not grow, so it IS recorded and the cursor
 * resumes past it. Without this, high-frequency mid-turn capture (marathon
 * step-fold) over CONTINUOUS work keeps one burst perpetually open: it never
 * seals, the cursor parks, and all of its voice is dropped (the 2026-06-13 15:04
 * regression). The exception is symmetric with inter-burst splitting.
 *
 * Pure CPU: no I/O, no ambient reads except none — `nowIso` arrives from the
 * caller. Safe for the epoch-commit path (zero awaits) and for tests.
 */
import { assignAnnotationsToBursts, buildBranchTrace, classifyMessageGlyph, DEFAULT_EPISODE_GROUPING, deriveEpisodeSummary, extractProcessNarrationLines, extractNarrationLines, extractRationaleLines, groupTouchesIntoEpisodes, isNarrationEligibleGlyph, narrationKindForGlyph, truncateVerbatim, NARRATION_MAX_LINES, NARRATION_MAX_LINES_TAGGED, PROCESS_MAX_LINES, VOICE_TEXT_CAP_CHARS, INTENT_TEXT_CAP_CHARS, } from './foldEpisodes.ts';
import { canonicalizeExtractedPaths } from './foldPathCanon.ts';
import { extractPathsFromBashCommand, extractRecallSignals } from './foldRecall.ts';
import { extractUserText, isSyntheticContextText } from './rollingFold.ts';
const EDIT_TOOL_HINTS = ['edit', 'write', 'apply_patch', 'notebookedit', 'str_replace', 'create_file'];
const CHECK_TOOL_RE = /test|typecheck|tsc|vitest|build|lint/i;
const CHAT_VOICE_TAGS = ['#decision', '#blocker', '#discovery'];
const STAR_CATEGORIES = new Set(['decision', 'discovery', 'pivot', 'handoff', 'gotcha', 'result']);
const RESULT_SCAN_AHEAD_MESSAGES = 6;
const RESULT_HEAD_SCAN_CHARS = 1_600;
const RESULT_DETAIL_CAP_CHARS = 120;
const COMMIT_DETAIL_CAP_CHARS = 40;
/**
 * Narration mining scans at most this many non-empty assistant texts per
 * burst-seal gap, FORWARD from the burst's last touch: the reply that closes
 * a work stretch sits immediately after its final tool results. Later gap
 * texts drift toward the next task's openers — bounded out, and the verdict
 * gate rejects opener shapes anyway.
 */
const NARRATION_SCAN_MAX_MESSAGES = 3;
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : null;
}
/** Yield every tool call across both message shapes, in order. */
function* iterToolCalls(messages, startIndex) {
    for (let i = Math.max(0, startIndex); i < messages.length; i++) {
        const message = messages[i];
        if (Array.isArray(message.content)) {
            for (const rawBlock of message.content) {
                const block = asRecord(rawBlock);
                if (!block || block.type !== 'tool_use')
                    continue;
                const input = asRecord(block.input) ?? {};
                yield {
                    eventIndex: i,
                    id: typeof block.id === 'string' ? block.id : null,
                    name: typeof block.name === 'string' ? block.name : 'tool',
                    input,
                };
            }
        }
        if (Array.isArray(message.tool_calls)) {
            for (const rawCall of message.tool_calls) {
                const call = asRecord(rawCall);
                if (!call)
                    continue;
                const fn = asRecord(call.function);
                if (!fn)
                    continue;
                let input = {};
                if (typeof fn.arguments === 'string') {
                    try {
                        input = asRecord(JSON.parse(fn.arguments)) ?? {};
                    }
                    catch {
                        input = {};
                    }
                }
                else {
                    input = asRecord(fn.arguments) ?? {};
                }
                yield {
                    eventIndex: i,
                    id: typeof call.id === 'string' ? call.id : null,
                    name: typeof fn.name === 'string' ? fn.name : 'tool',
                    input,
                };
            }
        }
    }
}
function resultTextHead(content) {
    if (typeof content === 'string')
        return content.slice(0, RESULT_HEAD_SCAN_CHARS);
    if (Array.isArray(content)) {
        let text = '';
        for (const rawPart of content) {
            const part = asRecord(rawPart);
            if (!part || typeof part.text !== 'string')
                continue;
            text += `${text.length > 0 ? '\n' : ''}${part.text}`;
            if (text.length >= RESULT_HEAD_SCAN_CHARS)
                break;
        }
        return text.slice(0, RESULT_HEAD_SCAN_CHARS);
    }
    return '';
}
function headLooksLikeError(head) {
    return /^\s*(error|✗|failed|exception|traceback)/i.test(head);
}
const RESULT_SIGNAL_RE = /\b(?:root cause|because|found|mismatch|expected|actual|failed|failure|error|exception|passed|verified|confirmed|discovery|regression|tests?[_ -](?:passed|failed)|type[_ -]errors?[_ -]found|error_count)\b/i;
const RESULT_PATH_RE = /(?:^|\s)[^\s:]+\.(?:[cm]?[jt]sx?|json|md|py|rs|go|java|kt|swift|sql|sh)(?::\d+)?(?=[:\s]|$)/i;
const RESULT_NOISE_RE = /^(?:\[(?:Codex|Forge) tool-result spool\]|\[Step compaction\]|Full raw output scheduled|path: |sha256: |chars: |bytes: |Script completed|Wall time|Process exited|Command exited|Output:)/i;
const RESULT_META_RE = /^(?:\[(?:Completion reminder|Protocol Pack:|Task rail\b|Episodic recall\b|fold counters\b)|Acceptance criteria:|When (?:complete|finished),|Sprint ACK:)/i;
const RESULT_GENERIC_RE = /^(?:ok|done|success|successful|committed|sent|pinned|claimed|released|updated|complete|completed|true|false|\[\])?[.!]?$/i;
/**
 * Pick one verbatim result line that can explain the next decision. The score
 * favors explicit findings/errors, path-addressed evidence, and validation
 * summaries while rejecting transport wrappers and acknowledgement-only noise.
 */
function selectResultEvidence(head, toolName, isError) {
    const lowerTool = toolName.toLowerCase();
    const coordination = /claim|release|chatroom|tap_star|task_rail|atlas_commit/.test(lowerTool);
    const investigative = /read|open|search|find|grep|rg|query|lookup|inspect|test|typecheck|tsc|vitest|build|lint/.test(lowerTool);
    let best;
    for (const rawLine of head.split(/\r?\n/)) {
        const line = rawLine.replace(/\s+/g, ' ').trim();
        if (line.length < 4 || RESULT_NOISE_RE.test(line) || RESULT_META_RE.test(line) || RESULT_GENERIC_RE.test(line))
            continue;
        let score = isError ? 80 : 0;
        if (RESULT_SIGNAL_RE.test(line))
            score += 35;
        if (RESULT_PATH_RE.test(line))
            score += 20;
        if (investigative)
            score += 12;
        if (coordination)
            score -= 25;
        if (line.length >= 24)
            score += 5;
        // An investigative tool name alone does not make an arbitrary source line
        // decisive. Require a real finding/path/validation signal (or an error).
        if (score < 25)
            continue;
        const evidence = { text: truncateVerbatim(line, RESULT_DETAIL_CAP_CHARS), score };
        if (!best || evidence.score > best.score)
            best = evidence;
    }
    return best;
}
function resolvedToolResult(content, toolName, explicitError = false) {
    const head = resultTextHead(content);
    const isError = explicitError || headLooksLikeError(head);
    const outcome = isError ? 'error' : CHECK_TOOL_RE.test(toolName) ? 'ok' : undefined;
    const evidence = selectResultEvidence(head, toolName, isError);
    return {
        ...(outcome ? { outcome } : {}),
        ...(evidence ? { evidence } : {}),
    };
}
/** Resolve a tool call's outcome and one evidence candidate from nearby results. */
function resolveToolResult(messages, fromIndex, toolUseId, toolName) {
    if (!toolUseId)
        return {};
    const end = Math.min(messages.length, fromIndex + 1 + RESULT_SCAN_AHEAD_MESSAGES);
    for (let i = fromIndex + 1; i < end; i++) {
        const message = messages[i];
        if (message.role === 'tool' && message.tool_call_id === toolUseId) {
            return resolvedToolResult(message.content, toolName);
        }
        if (!Array.isArray(message.content))
            continue;
        for (const rawBlock of message.content) {
            const block = asRecord(rawBlock);
            if (!block || block.type !== 'tool_result' || block.tool_use_id !== toolUseId)
                continue;
            return resolvedToolResult(block.content, toolName, block.is_error === true);
        }
    }
    return {};
}
function shortToolName(name) {
    const lastSegment = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
    return lastSegment || name;
}
function isEditTool(name) {
    const lower = name.toLowerCase();
    return EDIT_TOOL_HINTS.some((hint) => lower.includes(hint));
}
function basename(p) {
    const idx = p.lastIndexOf('/');
    return idx >= 0 ? p.slice(idx + 1) : p;
}
function extractTouchPaths(input, canon) {
    const paths = new Set();
    try {
        const signals = extractRecallSignals(input, new Set());
        for (const p of signals.touchedPaths)
            paths.add(p);
    }
    catch { /* fail-open per touch */ }
    if (typeof input.command === 'string') {
        try {
            for (const p of extractPathsFromBashCommand(input.command))
                paths.add(p);
        }
        catch { /* fail-open per touch */ }
    }
    const sorted = Array.from(paths).sort();
    if (!canon)
        return sorted;
    // Bridged atlas calls carry a `workspace` argument — the highest-precision
    // repo signal: relative paths re-root against that workspace's root.
    const workspaceArg = typeof input.workspace === 'string' ? input.workspace : undefined;
    try {
        return canonicalizeExtractedPaths(sorted, workspaceArg, canon).paths;
    }
    catch {
        return sorted; // fail-open: legacy forms still match via store history
    }
}
function mineVoice(call) {
    const shortName = shortToolName(call.name).toLowerCase();
    if (shortName === 'atlas_commit') {
        const entry = call.input.changelog_entry;
        if (typeof entry === 'string' && entry.trim().length > 0) {
            const filePath = call.input.file_path;
            return {
                ts: '',
                kind: 'changelog',
                text: truncateVerbatim(entry.split('\n')[0].trim(), VOICE_TEXT_CAP_CHARS),
                ...(typeof filePath === 'string' ? { path: filePath } : {}),
            };
        }
        return null;
    }
    if (shortName === 'tap_star') {
        const note = call.input.note;
        const category = call.input.category;
        if (typeof note === 'string' && note.trim().length > 0
            && typeof category === 'string' && STAR_CATEGORIES.has(category)) {
            return {
                ts: '',
                kind: `star:${category}`,
                text: truncateVerbatim(note.trim(), VOICE_TEXT_CAP_CHARS),
            };
        }
        return null;
    }
    if (shortName === 'chatroom') {
        const message = call.input.message;
        if (call.input.action === 'send' && typeof message === 'string') {
            const firstLine = message.split('\n')[0].trim();
            if (CHAT_VOICE_TAGS.some((tag) => firstLine.startsWith(tag))) {
                return { ts: '', kind: 'chat', text: truncateVerbatim(firstLine, VOICE_TEXT_CAP_CHARS) };
            }
        }
        return null;
    }
    if (shortName === 'task_rail') {
        // Rail ACK notes are deliberate, contemporaneous agent voice — the "what I
        // did / why it's blocked" for a step the agent just closed. A batch shoot
        // carries acks[].note; prefer a blocked/needs_review note (problems are the
        // highest-signal thing to resurface), else the first non-empty note. The
        // single-step ack form carries a top-level `note` instead. task_rail emits
        // no file touches (extractRecallSignals only reads file_path/path keys), so
        // this voice attaches to the work burst it concludes by event proximity.
        const pickAckNote = () => {
            const acks = Array.isArray(call.input.acks) ? call.input.acks : null;
            if (acks) {
                let firstNonEmpty = null;
                for (const raw of acks) {
                    const a = asRecord(raw);
                    if (!a)
                        continue;
                    const note = typeof a.note === 'string' ? a.note.trim() : '';
                    if (note.length === 0)
                        continue;
                    const status = typeof a.ack_status === 'string' ? a.ack_status
                        : typeof a.ackStatus === 'string' ? a.ackStatus : '';
                    if (status === 'blocked' || status === 'needs_review')
                        return note;
                    if (firstNonEmpty === null)
                        firstNonEmpty = note;
                }
                if (firstNonEmpty !== null)
                    return firstNonEmpty;
            }
            const single = typeof call.input.note === 'string' ? call.input.note.trim() : '';
            const isAck = call.input.mode === 'shoot'
                || typeof call.input.ack_status === 'string'
                || typeof call.input.ackStatus === 'string'
                || typeof call.input.ack_step_id === 'string'
                || typeof call.input.ackStepId === 'string';
            return single.length > 0 && isAck ? single : null;
        };
        const ackNote = pickAckNote();
        if (ackNote)
            return { ts: '', kind: 'rail', text: truncateVerbatim(ackNote, VOICE_TEXT_CAP_CHARS) };
        return null;
    }
    return null;
}
function isTaskRailLifecycleBoundary(call) {
    if (shortToolName(call.name).toLowerCase() !== 'task_rail')
        return false;
    const mode = typeof call.input.mode === 'string' ? call.input.mode : '';
    const operation = typeof call.input.operation === 'string' ? call.input.operation : '';
    // draft/edit/template/role operations are bookkeeping. sprint opens real
    // execution, shoot/audit ACK closes a unit, and load/start is a deliberate
    // intent switch. The trailing-open seal path below is what makes ACK notes
    // persist without waiting for an unrelated future file touch.
    return mode === 'sprint'
        || mode === 'shoot'
        || mode === 'audit'
        || (mode === 'load' && operation === 'start');
}
/** Concatenated assistant text blocks of one message ('' for non-assistant). */
function assistantTextOf(message) {
    if (message.role !== 'assistant')
        return '';
    if (typeof message.content === 'string')
        return message.content.trim();
    if (!Array.isArray(message.content))
        return '';
    const parts = [];
    for (const rawBlock of message.content) {
        const block = asRecord(rawBlock);
        if (block && block.type === 'text' && typeof block.text === 'string')
            parts.push(block.text);
    }
    return parts.join('\n').trim();
}
/**
 * Tier-B narration mining for one sealed burst. Two passes over
 * [scanStart, gapEndExclusive), where scanStart is the burst's FIRST touch and
 * burstFinalTouch is its LAST touch (INCLUSIVE) — see the call site.
 *
 * PASS 1 — DELIBERATE REGISTER (the all-in harvest). 🏁 verdict / ⚠️ hazard is
 * an explicit "resurface this" act by the agent (SOP P23): the GLYPH is the
 * trust signal, so POSITION is irrelevant. Capture EVERY eligible 🏁/⚠️ in
 * position across the WHOLE burst, not merely the closer — a hazard declared
 * mid-run is no longer dropped just because it was not the burst's last word.
 * Identical lines are de-duped within the burst (pure hygiene; no information
 * lost). There is deliberately NO count cap: selectVoiceInlays bounds what ever
 * reaches a rendered card by ANNOTATION_PRIORITY at READ time, so the STORE
 * stays complete and a hazard that ranks top in some later recall context is
 * never pre-discarded at write time. 🔍/▶/❓ self-exclude (isNarrationEligibleGlyph)
 * so confidently-wrong mid-burst hypotheses never enter. Per-burst windows stay
 * disjoint (burst i scans [start(i), start(i+1)) — see call site), so a
 * boundary declaration lands on exactly one chapter. If pass 1 captured any
 * deliberate voice, that IS the burst's narration — return it.
 *
 * PASS 2 — UNTAGGED BACKSTOP (unchanged fallback, original behavior verbatim).
 * Runs ONLY when pass 1 found no surviving declared voice, mining the raw
 * closing thought: scan the CLOSING region [burstFinalTouch, gapEnd) FORWARD
 * through at most NARRATION_SCAN_MAX_MESSAGES non-empty assistant texts; the
 * first message yielding verdict-shaped lines wins (the closing user-facing
 * reply is the densest curated prose an untagged agent produces). Representation
 * bridge: a live FC turn glues the closing prose into the burst-final tool touch
 * ([{type:'text'},{type:'tool_use'}]) so the scan STARTS at that touch (exempt
 * from the scan budget — keeps full forward reach); the SPLIT rep
 * (canonical/tests/rebuild) has a tool_use-only final touch, assistantTextOf()
 * === '' and it is skipped for free. Whole-message + per-line synthetic guards
 * keep recalled cards from laundering themselves into new memory.
 */
function mineNarrationForGap(messages, scanStart, burstFinalTouch, gapEndExclusive, timestamps, nowIso, syntheticContext) {
    const start = Math.max(0, scanStart);
    const end = Math.min(messages.length, gapEndExclusive);
    // PASS 1 — every deliberate 🏁/⚠️ in position across the burst, de-duped,
    // UNCAPPED (selectVoiceInlays bounds display at render, not capture). The
    // declared glyph is the lexical trust signal here, so keep safety gates but do
    // not require a "Fixed/Turns out/Confirmed" opener.
    const deliberate = [];
    const seen = new Set();
    for (let i = start; i < end; i++) {
        const text = assistantTextOf(messages[i]);
        if (text.length === 0)
            continue;
        const glyph = classifyMessageGlyph(text);
        if (!isNarrationEligibleGlyph(glyph))
            continue; // 🔍/▶/❓ self-exclude
        const kind = narrationKindForGlyph(glyph);
        if (kind === 'narration')
            continue; // untagged → pass 2 only
        const isSynthetic = (candidate) => isSyntheticContextText(candidate, syntheticContext);
        if (isSynthetic(text))
            continue;
        const lines = extractNarrationLines(text, isSynthetic, NARRATION_MAX_LINES_TAGGED, { requireVerdictShape: false });
        const ts = timestamps?.[i] ?? nowIso;
        for (const line of lines) {
            const key = line.trim().toLowerCase();
            if (seen.has(key))
                continue; // within-burst exact-text dedup (hygiene, not a cap)
            seen.add(key);
            deliberate.push({ eventIndex: i, annotation: { ts, kind, text: line } });
        }
    }
    // Rationale (the "why") is captured ADDITIVELY below, so a burst that BOTH
    // states a verdict AND explains its reasoning keeps both. Pass 1's old early
    // return dropped the reasoning in exactly that (common) case. Priority is
    // preserved: deliberate 🏁/⚠️ > verdict-shaped narration > standalone rationale;
    // rationale only ever rides ALONGSIDE the primary voice (appended last, never
    // displacing it, deduped against voice already taken).
    // PASS 2 + PASS 3 — one bounded closing-prose scan capturing the FIRST
    // verdict-shaped narration AND the FIRST decision-rationale line. The scan
    // budget (NARRATION_SCAN_MAX_MESSAGES) and the burst-final-touch exemption are
    // unchanged. Verdict extraction is skipped once pass 1 already produced
    // deliberate voice (rationale still rides alongside it). Narration is mined
    // AFTER grouping (see deriveEpisodesFromMessages), so adding rationale here
    // cannot change episode count.
    let verdictResult = null;
    let rationale = null;
    let scanned = 0;
    const touchIndex = Math.max(start, burstFinalTouch);
    for (let i = touchIndex; i < end; i++) {
        const text = assistantTextOf(messages[i]);
        if (text.length === 0)
            continue;
        const isBurstFinalTouch = i === burstFinalTouch;
        const glyph = classifyMessageGlyph(text);
        if (!isNarrationEligibleGlyph(glyph)) {
            // Declared 🔍 in-progress / ▶ executing / ❓ blocked: source-side self-exclusion.
            // Consumes the scan window (except at the burst-final touch) so exclusion
            // never extends reach deeper into next-task territory.
            if (!isBurstFinalTouch) {
                scanned += 1;
                if (scanned >= NARRATION_SCAN_MAX_MESSAGES)
                    break;
            }
            continue;
        }
        const isSynthetic = (candidate) => isSyntheticContextText(candidate, syntheticContext);
        if (!isSynthetic(text)) {
            // Verdict-shaped narration — only needed when pass 1 found no declared voice.
            if (deliberate.length === 0 && !verdictResult) {
                const kind = narrationKindForGlyph(glyph);
                const cap = kind === 'narration' ? NARRATION_MAX_LINES : NARRATION_MAX_LINES_TAGGED;
                const lines = extractNarrationLines(text, isSynthetic, cap);
                if (lines.length > 0) {
                    const ts = timestamps?.[i] ?? nowIso;
                    verdictResult = lines.map((line) => ({
                        eventIndex: i,
                        annotation: { ts, kind, text: line },
                    }));
                }
            }
            // Decision reasoning ("chose X over Y because…", "the trade-off was…") the
            // verdict gate drops — the lowest-priority backstop, capped at one line and
            // deduped against deliberate voice already taken in pass 1.
            if (!rationale) {
                const rationaleLines = extractRationaleLines(text, isSynthetic, 1);
                const pick = rationaleLines.find((line) => !seen.has(line.trim().toLowerCase()));
                if (pick) {
                    const ts = timestamps?.[i] ?? nowIso;
                    rationale = { eventIndex: i, annotation: { ts, kind: 'narration', text: pick } };
                }
            }
            // Both surfaces filled (or deliberate already holds the primary): stop.
            if ((deliberate.length > 0 || verdictResult) && rationale)
                break;
        }
        // Eligible register but nothing taken yet (or synthetic): spend a scan unit —
        // except at the burst-final touch, which is free so the gap keeps its full
        // forward reach (see isBurstFinalTouch note above).
        if (!isBurstFinalTouch) {
            scanned += 1;
            if (scanned >= NARRATION_SCAN_MAX_MESSAGES)
                break;
        }
    }
    // Combine. assignAnnotationsToBursts re-sorts by eventIndex, so append order
    // here only needs to be dedup-correct, not chronological.
    const appendRationale = (primary) => {
        if (!rationale)
            return primary;
        const key = rationale.annotation.text.trim().toLowerCase();
        if (primary.some((r) => r.annotation.text.trim().toLowerCase() === key))
            return primary;
        return [...primary, rationale];
    };
    if (deliberate.length > 0)
        return appendRationale(deliberate);
    if (verdictResult)
        return appendRationale(verdictResult);
    if (rationale)
        return [rationale];
    return [];
}
/**
 * Preserve the process that led through a sealed tool burst without promoting
 * it to a verdict. The shared extractor enforces shaped decision/discovery
 * signals, a structural-tool floor, synthetic rejection, and a hard line cap;
 * this layer only supplies the burst-local event/timestamp coordinates.
 */
function mineProcessNarrationForBurst(messages, burstStart, burstEnd, timestamps, nowIso, syntheticContext, toolStepCount) {
    const out = [];
    const seen = new Set();
    const start = Math.max(0, burstStart);
    const end = Math.min(messages.length - 1, burstEnd);
    for (let i = start; i <= end && out.length < PROCESS_MAX_LINES; i++) {
        const text = assistantTextOf(messages[i]);
        if (text.length === 0 || isSyntheticContextText(text, syntheticContext))
            continue;
        const candidates = extractProcessNarrationLines(text, classifyMessageGlyph(text), (candidate) => isSyntheticContextText(candidate, syntheticContext), toolStepCount, PROCESS_MAX_LINES - out.length);
        for (const candidate of candidates) {
            const key = `${candidate.kind}\0${candidate.text.trim().toLowerCase()}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push({
                eventIndex: i,
                annotation: {
                    ts: timestamps?.[i] ?? nowIso,
                    kind: candidate.kind,
                    text: candidate.text,
                },
            });
            if (out.length >= PROCESS_MAX_LINES)
                break;
        }
    }
    return out;
}
function structuralStep(call, outcome, touched) {
    const shortName = shortToolName(call.name);
    if (shortName.toLowerCase() === 'atlas_commit') {
        const entry = call.input.changelog_entry;
        const head = typeof entry === 'string' ? truncateVerbatim(entry.split('\n')[0].trim(), COMMIT_DETAIL_CAP_CHARS) : '';
        return { tool: 'commit', ...(head ? { detail: head } : {}) };
    }
    if (shortName.toLowerCase() === 'task_rail') {
        // Compact lifecycle token rail:<phase> so the trace shows rail boundaries
        // (rail:start / rail:sprint / rail:shoot / rail:update) instead of an opaque
        // "task_rail". For mode=load the operation is the meaningful phase.
        const mode = typeof call.input.mode === 'string' ? call.input.mode : '';
        const operation = typeof call.input.operation === 'string' ? call.input.operation : '';
        const phase = (mode === 'load' && operation) ? operation : (mode || operation || 'rail');
        return { tool: `rail:${phase}`, ...(outcome ? { outcome } : {}) };
    }
    const targetSource = typeof call.input.file_path === 'string'
        ? call.input.file_path
        : typeof call.input.path === 'string'
            ? call.input.path
            : touched[0];
    return {
        tool: shortName,
        ...(targetSource ? { target: basename(targetSource) } : {}),
        ...(outcome ? { outcome } : {}),
    };
}
/**
 * The verbatim operator ask that drove a burst: scan the raw window BACKWARD from
 * the burst's first touch for the nearest genuine user message. Reuses the
 * canonical operator-text gate — extractUserText drops tool_result / Gemini
 * functionResponse blocks and strips host-supplied synthetic user-context wrappers,
 * while isSyntheticContextText drops fold / recall-card / epoch-stamp context —
 * so recalled cards and tool output can never launder into intent. Scans the
 * FULL messages array (not just [startIndex, …]) so an ask issued in a PRIOR
 * epoch still anchors the burst it motivated. Pure CPU, no I/O.
 */
function mineIntentForBurst(messages, burstStartIndex, syntheticContext) {
    for (let i = Math.min(burstStartIndex, messages.length - 1); i >= 0; i--) {
        const message = messages[i];
        if (message.role !== 'user')
            continue;
        const text = extractUserText([message], syntheticContext).trim();
        if (text.length === 0)
            continue; // tool_result-only / empty user turn
        if (isSyntheticContextText(text, syntheticContext))
            continue; // fold / recall / vault / epoch synthetic
        return truncateVerbatim(text, INTENT_TEXT_CAP_CHARS);
    }
    return undefined;
}
/**
 * Derive sealed episodes from the raw message window starting at startIndex.
 * Touch kinds come from tool names (edit-ish vs read); pivot stars seal
 * bursts; voice annotations attach to their burst (gap annotations attach to
 * the preceding chapter — the closing thought); narration is mined from each
 * sealed burst's gap prose (options.narration !== false); the branch trace
 * replicates the burst's exact tool sequence with outcomes, voice inlaid in
 * position.
 */
export function deriveEpisodesFromMessages(messages, startIndex, identity, options = {}) {
    const touches = [];
    const pivots = [];
    const railSealEventIndexes = [];
    const annotated = [];
    const steps = [];
    const syntheticContext = options.syntheticContext ?? {};
    for (const call of iterToolCalls(messages, startIndex)) {
        if (isTaskRailLifecycleBoundary(call))
            railSealEventIndexes.push(call.eventIndex);
        const touched = extractTouchPaths(call.input, options.canon);
        const kind = isEditTool(call.name) ? 'edit' : 'read';
        const ts = options.timestamps?.[call.eventIndex];
        for (const p of touched) {
            touches.push({ eventIndex: call.eventIndex, path: p, kind, ...(ts !== undefined ? { ts } : {}) });
        }
        const voice = mineVoice(call);
        if (voice) {
            const stamped = { ...voice, ts: ts ?? identity.nowIso };
            annotated.push({ eventIndex: call.eventIndex, annotation: stamped });
            if (stamped.kind === 'star:pivot')
                pivots.push({ eventIndex: call.eventIndex });
            steps.push({ eventIndex: call.eventIndex, step: { tool: shortToolName(call.name), voice: stamped } });
            continue;
        }
        const resolved = resolveToolResult(messages, call.eventIndex, call.id, call.name);
        steps.push({
            eventIndex: call.eventIndex,
            step: structuralStep(call, resolved.outcome, touched),
            ...(resolved.evidence ? { evidence: resolved.evidence } : {}),
        });
    }
    // Voice floor: pass voice event indexes to grouping so bursts with zero
    // voice annotations refuse to seal on gap alone — producing fewer, fatter
    // episodes that each carry voice by construction.
    //
    // star:pivot is the ONE star that is a SPLIT boundary, not a hold signal:
    // feeding it into the voice floor (or the tap-star floor below) lets the pivot
    // ENABLE the floor that then suppresses its OWN seal (the burst absorbs the
    // next one). Exclude it from both floors — it still drives grouping via the
    // `pivots` array and still attaches to its closing burst as voice.
    const isPivotAnnotation = (a) => a.annotation.kind === 'star:pivot';
    const voiceEventIndexes = annotated
        .filter((a) => !isPivotAnnotation(a))
        .map((a) => a.eventIndex)
        .sort((a, b) => a - b);
    // Intent voice floor: collect indexes of user messages carrying REAL intent
    // (non-synthetic, non-tool-result user text). The operator's ask that
    // motivates a burst is voice too — without this, 91.7% of the remaining
    // "voiceless" episodes are ones that carry intent but no annotations.
    const intentEventIndexes = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== 'user')
            continue;
        const text = extractUserText([msg], syntheticContext).trim();
        if (text.length === 0)
            continue;
        if (isSyntheticContextText(text, syntheticContext))
            continue;
        intentEventIndexes.push(i);
    }
    // TAP-STAR FLOOR: collect event indexes of deliberate operator pins
    // (star:decision, star:pivot, star:gotcha, star:discovery). These are the
    // strongest "resurface this" signals — the burst holding a pin should hold
    // open longest (gapMs × 2.0) and never seal voiceless. Stars are explicit
    // operator acts, so the floor is always-on like voiceFloor (not env-gated).
    const STAR_PIN_PREFIX = 'star:';
    const tapStarFloorEventIndexes = annotated
        .filter((a) => typeof a.annotation.kind === 'string' && a.annotation.kind.startsWith(STAR_PIN_PREFIX) && !isPivotAnnotation(a))
        .map((a) => a.eventIndex)
        .sort((a, b) => a - b);
    const bursts = groupTouchesIntoEpisodes(touches, {
        pivots,
        ...(voiceEventIndexes.length > 0 || intentEventIndexes.length > 0
            ? { voiceFloor: true, ...(voiceEventIndexes.length > 0 ? { voiceEventIndexes } : {}), ...(intentEventIndexes.length > 0 ? { intentEventIndexes } : {}) }
            : {}),
        // VALUE FLOOR: env-gated — permanently rewrites chunk boundaries, so opt-in.
        // When enabled, compute high-value paths and widen their burst gaps.
        ...(process.env.VOXXO_FOLD_VALUE_FIDELITY === '1'
            ? (() => {
                const vfp = computeValueFloorPaths(messages, touches);
                return vfp.length > 0 ? { valueFloorPaths: vfp } : {};
            })()
            : {}),
        // TAP-STAR FLOOR: always-on (stars are explicit operator acts). Widens
        // gap for bursts containing a deliberate pin so they accumulate more voice.
        ...(tapStarFloorEventIndexes.length > 0 ? { tapStarFloorEventIndexes } : {}),
        ...(railSealEventIndexes.length > 0 ? { railSealEventIndexes } : {}),
        // AFFINITY FLOOR: host-supplied co-activation scores from the worker. The
        // capture layer only threads the matrix through; scoring remains outside
        // this pure package path.
        ...(options.affinityFloor
            ? {
                affinityFloor: options.affinityFloor,
                affinityGapThreshold: options.affinityGapThreshold,
                affinityGapMultiplier: options.affinityGapMultiplier,
            }
            : {}),
    });
    if (bursts.length === 0)
        return { episodes: [], openBurstStartIndex: null };
    const sealTrailing = options.sealTrailing === true;
    // The trailing burst is normally DEFERRED (it may still be growing) and left
    // for the next epoch to seal once a FOLLOWING burst forms after it. Under
    // high-frequency mid-turn capture (marathon step-fold, live 2026-06-13 15:04)
    // this assumption breaks: continuous work keeps ONE burst perpetually open —
    // no following burst ever forms — so it never seals, the caller's cursor parks
    // at its start, and ALL of its voice (commit/star/chat + narration) is dropped.
    // Fix, symmetric with inter-burst splitting: if the trailing burst is already
    // SETTLED (the window has moved >gapEvents non-touch events past its last
    // touch, or >gapMs of wall-clock has elapsed since it), it will not grow, so
    // seal it now and resume the cursor PAST it instead of deferring forever.
    const lastBurst = bursts[bursts.length - 1];
    const trailingEventGap = messages.length - lastBurst.endEventIndex;
    const trailingMsGap = lastBurst.endedAt !== undefined
        ? Date.parse(identity.nowIso) - Date.parse(lastBurst.endedAt)
        : Number.NaN;
    const trailingRailSeal = railSealEventIndexes.some((idx) => idx > lastBurst.endEventIndex && idx < messages.length);
    const trailingSettled = !sealTrailing
        && (trailingRailSeal
            || trailingEventGap > DEFAULT_EPISODE_GROUPING.gapEvents
            || (Number.isFinite(trailingMsGap) && trailingMsGap > DEFAULT_EPISODE_GROUPING.gapMs));
    const sealAll = sealTrailing || trailingSettled;
    const openBurst = sealAll ? null : lastBurst;
    const sealed = sealAll ? bursts : bursts.slice(0, -1);
    if (sealed.length === 0) {
        return { episodes: [], openBurstStartIndex: openBurst ? openBurst.startEventIndex : null };
    }
    const voiceHorizon = openBurst ? openBurst.startEventIndex : Number.POSITIVE_INFINITY;
    const sealedAnnotated = annotated.filter((a) => a.eventIndex < voiceHorizon);
    if (options.narration !== false) {
        // Narration rides the SAME assignment machinery as tool-mined voice: gap
        // entries attach to the preceding chapter (the closing thought). It never
        // enters `steps`, so traces stay purely structural+deliberate-voice.
        for (let i = 0; i < sealed.length; i++) {
            // scanStart is the burst's FIRST touch — pass 1 of the miner sweeps the
            // WHOLE burst [start, gapEnd) so a deliberate 🏁/⚠️ declared MID-burst is
            // captured in position, not just the closer. burstFinalTouch is the LAST
            // touch (INCLUSIVE): the representation bridge for live capture (a live FC
            // turn glues the closing verdict into the burst-final touch message
            // ([{type:'text',text:'🏁…'},{type:'tool_use'}]) so the prose never lands
            // standalone in the inter-burst gap; the SPLIT rep has a tool_use-only
            // final touch, assistantTextOf()==='' and is skipped for free) AND the
            // start of pass 2's untagged closing-thought window. Per-burst windows
            // stay DISJOINT: burst i scans [startEventIndex(i), startEventIndex(i+1))
            // and burst i+1 scans [startEventIndex(i+1), …), which share no index — so
            // a boundary declaration is assigned to exactly one chapter.
            const burstFinalTouch = sealed[i].endEventIndex;
            const scanStart = sealed[i].startEventIndex;
            const gapEnd = i + 1 < sealed.length
                ? sealed[i + 1].startEventIndex
                : openBurst ? openBurst.startEventIndex : messages.length;
            const narration = mineNarrationForGap(messages, scanStart, burstFinalTouch, gapEnd, options.timestamps, identity.nowIso, syntheticContext);
            const toolStepCount = steps.filter((step) => step.eventIndex >= scanStart && step.eventIndex <= burstFinalTouch).length;
            const narrationText = new Set(narration.map((item) => item.annotation.text.trim().toLowerCase()));
            const process = mineProcessNarrationForBurst(messages, scanStart, burstFinalTouch, options.timestamps, identity.nowIso, syntheticContext, toolStepCount).filter((item) => !narrationText.has(item.annotation.text.trim().toLowerCase()));
            sealedAnnotated.push(...narration, ...process);
        }
    }
    const annotationsPerBurst = assignAnnotationsToBursts(sealed, sealedAnnotated);
    // Voice steps follow the SAME burst-assignment rule as annotations (gap →
    // preceding chapter): an agent's "edit, commit, star it, post it" pattern
    // puts the star/chat AFTER the last file touch, and the trace must keep
    // that closing voice inline. Structural gap steps (pure coordination calls)
    // stay excluded — they belong to no zone.
    const voiceBurstFor = (eventIndex) => {
        let target = 0;
        for (let i = 0; i < sealed.length; i++) {
            if (eventIndex >= sealed[i].startEventIndex)
                target = i;
            else
                break;
        }
        return target;
    };
    const episodes = sealed.map((burst, index) => {
        const burstStepEntries = steps
            .filter((s) => s.step.voice
            ? s.eventIndex < voiceHorizon && voiceBurstFor(s.eventIndex) === index
            : s.eventIndex >= burst.startEventIndex && s.eventIndex <= burst.endEventIndex);
        // One result excerpt is enough to explain the decisive turn. Choose the
        // strongest candidate (latest wins ties), then pin only that excerpt into
        // the structural trace so enrichment stays inside the existing trace cap.
        let keyResultIndex = -1;
        let keyResultScore = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < burstStepEntries.length; i++) {
            const evidence = burstStepEntries[i].evidence;
            if (evidence && evidence.score >= keyResultScore) {
                keyResultIndex = i;
                keyResultScore = evidence.score;
            }
        }
        const burstSteps = burstStepEntries.map((entry, entryIndex) => entryIndex === keyResultIndex && entry.evidence
            ? { ...entry.step, result: entry.evidence.text }
            : entry.step);
        const annotations = annotationsPerBurst[index];
        const railObjective = typeof identity.railObjective === 'string' && identity.railObjective.trim().length > 0
            ? truncateVerbatim(identity.railObjective.trim(), INTENT_TEXT_CAP_CHARS)
            : undefined;
        // Scope the rail objective to its ACTIVE WINDOW — it is burst-independent, so
        // applying it to every burst blankets older/unrelated work (worst under Codex,
        // which re-derives from index 0 each epoch). In-window = a rail seal inside the
        // burst span, or a closing ACK just after the trailing sealed burst; elsewhere
        // the per-burst mined operator ask is preserved (objective never overrides it).
        const burstInRailWindow = railObjective !== undefined
            && railSealEventIndexes.some((idx) => (idx >= burst.startEventIndex && idx <= burst.endEventIndex)
                || (index === sealed.length - 1 && idx > burst.endEventIndex));
        const intent = (burstInRailWindow ? railObjective : undefined)
            ?? mineIntentForBurst(messages, burst.startEventIndex, syntheticContext);
        return {
            workspace: identity.workspace,
            instanceId: identity.instanceId,
            ...(identity.lineageRoot !== undefined ? { lineageRoot: identity.lineageRoot } : {}),
            ...(identity.siloed === true ? { siloed: true } : {}),
            startedAt: burst.startedAt ?? identity.nowIso,
            endedAt: burst.endedAt ?? identity.nowIso,
            closedBy: identity.closedBy,
            summary: deriveEpisodeSummary({ annotations, members: burst.members }),
            ...(intent !== undefined ? { intent } : {}),
            ...(identity.railId !== undefined ? { railId: identity.railId } : {}),
            ...(identity.railStep !== undefined ? { railStep: identity.railStep } : {}),
            members: burst.members,
            trace: buildBranchTrace(burstSteps),
            annotations,
        };
    });
    // When the trailing burst was sealed because it SETTLED (not the one-shot
    // backfill sealTrailing path), resume the caller's capture cursor past the
    // whole consumed window so the next epoch starts on genuinely new work — and
    // so eviction, which is bounded by this same cursor, can finally advance.
    const resumeIndex = openBurst
        ? openBurst.startEventIndex
        : trailingSettled ? messages.length : null;
    return { episodes, openBurstStartIndex: resumeIndex };
}
/**
 * Open-burst boundary for the read-burst fold guard (consumed by FoldSession).
 *
 * Lean sibling of {@link deriveEpisodesFromMessages}: it runs the SAME touch loop
 * (`iterToolCalls` + `extractTouchPaths` + `isEditTool`) and the SAME
 * `groupTouchesIntoEpisodes` + trailing-settled seal, but skips voice mining,
 * narration, and Episode assembly. It answers one question — *which trailing
 * message window is the still-open read-burst that the fold should hold resident?*
 *
 * Empirical basis (rail-f1b6c230, ~90 transcripts / ~900 real bursts): agent
 * read-bursts are inherently multi-directory (79-84%) and multi-cluster (67-74%),
 * so NO topic-shift seal is applied — a directory seal over-fragments 13x
 * (median burst 21-24 touches -> 2) and a cluster seal ~9x. The open burst is the
 * episode co-activation zone, unchanged; the guard simply keeps it unfolded until
 * a following burst forms (retrospective release), it settles, the
 * maxBurstEvents/maxBurstMs backstop caps it, or — in FoldSession — the measured
 * pressure ceiling forces a fold anyway.
 *
 * Pure: zero I/O, deterministic. Safe to call per tool-step on the fold hot path.
 *
 * PARITY CONTRACT: when an open burst exists, `openBurstStartIndex` MUST equal the
 * burst `deriveEpisodesFromMessages` defers (`openBurst.startEventIndex`) for the
 * same inputs. The trailing-settled block below is duplicated from that function
 * deliberately (rather than refactoring load-bearing, byte-parity-mirrored capture
 * code) — keep the two in lockstep. Pinned by test/foldEpisodeCapture.openBurst.test.ts.
 *
 * Called WITHOUT timestamps/nowIso (the FoldSession default), the seal is pure
 * event-count (`trailingEventGap > gapEvents`) — the work-time basis, not wall-clock.
 * Pivots are not mined here (that needs voice mining); pass them only for exact
 * parity testing. task_rail lifecycle boundaries are structural and cheap, so
 * they are mined here too to keep ACK-sealed bursts from being over-held by the
 * fold guard.
 */
export function computeOpenBurst(messages, options = {}) {
    const touches = [];
    const railSealEventIndexes = [];
    for (const call of iterToolCalls(messages, 0)) {
        if (isTaskRailLifecycleBoundary(call))
            railSealEventIndexes.push(call.eventIndex);
        const touched = extractTouchPaths(call.input, options.canon);
        const kind = isEditTool(call.name) ? 'edit' : 'read';
        const ts = options.timestamps?.[call.eventIndex];
        for (const p of touched) {
            touches.push({ eventIndex: call.eventIndex, path: p, kind, ...(ts !== undefined ? { ts } : {}) });
        }
    }
    const bursts = groupTouchesIntoEpisodes(touches, {
        pivots: options.pivots ?? [],
        ...(railSealEventIndexes.length > 0 ? { railSealEventIndexes } : {}),
    });
    if (bursts.length === 0)
        return { openBurstStartIndex: null, heldPaths: [], burstCount: 0 };
    // ── trailing-settled seal — MUST mirror deriveEpisodesFromMessages (the
    //    `trailingSettled` block above). The guard never force-seals the trailing
    //    burst (no sealTrailing), so this is purely: has work moved on past it?
    const lastBurst = bursts[bursts.length - 1];
    const trailingEventGap = messages.length - lastBurst.endEventIndex;
    const trailingMsGap = (options.nowIso !== undefined && lastBurst.endedAt !== undefined)
        ? Date.parse(options.nowIso) - Date.parse(lastBurst.endedAt)
        : Number.NaN;
    const trailingRailSeal = railSealEventIndexes.some((idx) => idx > lastBurst.endEventIndex && idx < messages.length);
    const trailingSettled = trailingRailSeal
        || trailingEventGap > DEFAULT_EPISODE_GROUPING.gapEvents
        || (Number.isFinite(trailingMsGap) && trailingMsGap > DEFAULT_EPISODE_GROUPING.gapMs);
    if (trailingSettled)
        return { openBurstStartIndex: null, heldPaths: [], burstCount: bursts.length };
    return {
        openBurstStartIndex: lastBurst.startEventIndex,
        heldPaths: lastBurst.members.map((m) => m.path),
        burstCount: bursts.length,
    };
}
/**
 * VALUE FLOOR: compute paths that carry forward-reference value for episodic
 * burst grouping. For each touched path, scan DOWNSTREAM tool calls (messages
 * AFTER the first touch) and weight re-references by kind: read=1, claim=3,
 * edit=4. Paths with total downstream weight ≥ minRefCount are returned,
 * highest first, bounded to maxPaths. Pure CPU, no I/O.
 *
 * Used by the session layer to pass valueFloorPaths to groupTouchesIntoEpisodes
 * so high-value bursts hold open longer (see EpisodeGroupingOptions.valueFloorPaths).
 */
export function computeValueFloorPaths(messages, touches, options) {
    const maxPaths = options?.maxPaths ?? 20;
    const minRefCount = options?.minRefCount ?? 1;
    if (touches.length === 0 || messages.length === 0)
        return [];
    // Map each path to its first-touch event index so we only count downstream refs.
    const firstTouchIdx = new Map();
    for (const t of touches) {
        const existing = firstTouchIdx.get(t.path);
        if (existing === undefined || t.eventIndex < existing) {
            firstTouchIdx.set(t.path, t.eventIndex);
        }
    }
    // Tool-call weights align with FidelityValueWeights; rollingFold's userNamed
    // weight applies only to free-form user text, not episode value-floor scans.
    const weights = new Map();
    for (const [path, firstIdx] of firstTouchIdx) {
        weights.set(path, 0);
        // Scan downstream tool calls for re-references to this path.
        for (let i = firstIdx + 1; i < messages.length; i++) {
            const msg = messages[i];
            if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content))
                continue;
            for (const block of msg.content) {
                if (typeof block !== 'object' || block === null)
                    continue;
                const tu = block;
                if (tu.type !== 'tool_use' || typeof tu.name !== 'string' || typeof tu.input !== 'object')
                    continue;
                const touchPaths = extractTouchPaths(tu.input);
                if (touchPaths.includes(path)) {
                    const isEdit = isEditTool(tu.name);
                    const isClaim = shortToolName(tu.name).toLowerCase().includes('claim');
                    const w = isEdit ? 4 : isClaim ? 3 : 1;
                    weights.set(path, (weights.get(path) ?? 0) + w);
                }
            }
        }
    }
    return Array.from(weights.entries())
        .filter(([, w]) => w >= minRefCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxPaths)
        .map(([p]) => p);
}
//# sourceMappingURL=foldEpisodeCapture.js.map