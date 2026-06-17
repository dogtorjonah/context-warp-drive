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
import {
  assignAnnotationsToBursts,
  buildBranchTrace,
  classifyMessageGlyph,
  DEFAULT_EPISODE_GROUPING,
  deriveEpisodeSummary,
  extractNarrationLines,
  groupTouchesIntoEpisodes,
  isNarrationEligibleGlyph,
  narrationKindForGlyph,
  truncateVerbatim,
  NARRATION_MAX_LINES,
  NARRATION_MAX_LINES_TAGGED,
  VOICE_TEXT_CAP_CHARS,
  type Episode,
  type EpisodeAnnotation,
  type EpisodeAnnotationKind,
  type EpisodePivotMarker,
  type EpisodeTouch,
  type TraceStep,
} from './foldEpisodes.ts';
import { canonicalizeExtractedPaths, type CanonContext } from './foldPathCanon.ts';
import { extractPathsFromBashCommand, extractRecallSignals } from './foldRecall.ts';
import { isSyntheticContextText, type FoldMessage } from './rollingFold.ts';

const EDIT_TOOL_HINTS = ['edit', 'write', 'apply_patch', 'notebookedit', 'str_replace', 'create_file'];
const CHECK_TOOL_RE = /test|typecheck|tsc|vitest|build|lint/i;
const CHAT_VOICE_TAGS = ['#decision', '#blocker', '#discovery'];
const STAR_CATEGORIES = new Set(['decision', 'discovery', 'pivot', 'handoff', 'gotcha', 'result']);
const RESULT_SCAN_AHEAD_MESSAGES = 6;
const RESULT_HEAD_SCAN_CHARS = 400;
const COMMIT_DETAIL_CAP_CHARS = 40;
/**
 * Narration mining scans at most this many non-empty assistant texts per
 * burst-seal gap, FORWARD from the burst's last touch: the reply that closes
 * a work stretch sits immediately after its final tool results. Later gap
 * texts drift toward the next task's openers — bounded out, and the verdict
 * gate rejects opener shapes anyway.
 */
const NARRATION_SCAN_MAX_MESSAGES = 3;

export interface EpisodeCaptureIdentity {
  workspace: string;
  instanceId: string;
  lineageRoot?: string;
  closedBy: Episode['closedBy'];
  /** Caller-supplied clock (keeps this module pure and testable). */
  nowIso: string;
  railId?: string;
  railStep?: string;
  /**
   * When TRUE, derived episodes inherit the siloed tag — recall gate keeps
   * them invisible to unsealed callers. Capture-but-quarantine, not
   * capture-refuse: the memory still forms, the read is gated.
   */
  siloed?: boolean;
}

export interface EpisodeCaptureResult {
  /** Sealed episodes, chronological. The trailing open burst is excluded. */
  episodes: Episode[];
  /** Message index where the open (unrecorded) burst starts; null if none. */
  openBurstStartIndex: number | null;
}

export interface EpisodeCaptureOptions {
  /**
   * Treat the trailing burst as sealed too (backfill of finished sessions —
   * nothing can still be growing). openBurstStartIndex is null in this mode.
   */
  sealTrailing?: boolean;
  /**
   * Per-message ISO timestamps aligned by message index. When provided,
   * touches carry real time (enabling the 20-minute burst gap), episodes get
   * honest startedAt/endedAt, and — critically — re-derivation produces
   * IDENTICAL dedupe keys, making backfill re-runs idempotent.
   */
  timestamps?: readonly (string | undefined)[];
  /**
   * Canonical path identity context (rail-da5b5e73). When provided, member
   * paths canonicalize to absolute repo-qualified form — relative paths
   * resolve against cwd (live) or unique disk existence (backfill only), and
   * bridged atlas calls re-root via their `workspace` argument. Absent →
   * extraction is byte-identical to legacy behavior.
   */
  canon?: CanonContext;
  /**
   * Tier-B narration mining (burst-final assistant prose → kind 'narration'
   * annotations). Default ON; pass false to disable (sessions wire the
   * WARP_FOLD_EPISODES_NARRATION=0 kill switch through here).
   */
  narration?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

interface ToolCallView {
  eventIndex: number;
  id: string | null;
  name: string;
  input: Record<string, unknown>;
}

/** Yield every tool call across both message shapes, in order. */
function* iterToolCalls(messages: readonly FoldMessage[], startIndex: number): Generator<ToolCallView> {
  for (let i = Math.max(0, startIndex); i < messages.length; i++) {
    const message = messages[i];
    if (Array.isArray(message.content)) {
      for (const rawBlock of message.content) {
        const block = asRecord(rawBlock);
        if (!block || block.type !== 'tool_use') continue;
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
        if (!call) continue;
        const fn = asRecord(call.function);
        if (!fn) continue;
        let input: Record<string, unknown> = {};
        if (typeof fn.arguments === 'string') {
          try { input = asRecord(JSON.parse(fn.arguments)) ?? {}; } catch { input = {}; }
        } else {
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

function resultTextHead(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, RESULT_HEAD_SCAN_CHARS);
  if (Array.isArray(content)) {
    for (const rawPart of content) {
      const part = asRecord(rawPart);
      if (part && typeof part.text === 'string') return part.text.slice(0, RESULT_HEAD_SCAN_CHARS);
    }
  }
  return '';
}

function headLooksLikeError(head: string): boolean {
  return /^\s*(error|✗|failed|exception|traceback)/i.test(head);
}

/** Resolve a tool call's outcome from nearby result messages (both shapes). */
function resolveOutcome(
  messages: readonly FoldMessage[],
  fromIndex: number,
  toolUseId: string | null,
  toolName: string,
): 'ok' | 'error' | undefined {
  if (!toolUseId) return undefined;
  const end = Math.min(messages.length, fromIndex + 1 + RESULT_SCAN_AHEAD_MESSAGES);
  for (let i = fromIndex + 1; i < end; i++) {
    const message = messages[i];
    if (message.role === 'tool' && message.tool_call_id === toolUseId) {
      const isError = headLooksLikeError(resultTextHead(message.content));
      if (isError) return 'error';
      return CHECK_TOOL_RE.test(toolName) ? 'ok' : undefined;
    }
    if (!Array.isArray(message.content)) continue;
    for (const rawBlock of message.content) {
      const block = asRecord(rawBlock);
      if (!block || block.type !== 'tool_result' || block.tool_use_id !== toolUseId) continue;
      if (block.is_error === true || headLooksLikeError(resultTextHead(block.content))) return 'error';
      return CHECK_TOOL_RE.test(toolName) ? 'ok' : undefined;
    }
  }
  return undefined;
}

function shortToolName(name: string): string {
  const lastSegment = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  return lastSegment || name;
}

function isEditTool(name: string): boolean {
  const lower = name.toLowerCase();
  return EDIT_TOOL_HINTS.some((hint) => lower.includes(hint));
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function extractTouchPaths(input: Record<string, unknown>, canon?: CanonContext): string[] {
  const paths = new Set<string>();
  try {
    const signals = extractRecallSignals(input, new Set<string>());
    for (const p of signals.touchedPaths) paths.add(p);
  } catch { /* fail-open per touch */ }
  if (typeof input.command === 'string') {
    try {
      for (const p of extractPathsFromBashCommand(input.command)) paths.add(p);
    } catch { /* fail-open per touch */ }
  }
  const sorted = Array.from(paths).sort();
  if (!canon) return sorted;
  // Bridged atlas calls carry a `workspace` argument — the highest-precision
  // repo signal: relative paths re-root against that workspace's root.
  const workspaceArg = typeof input.workspace === 'string' ? input.workspace : undefined;
  try {
    return canonicalizeExtractedPaths(sorted, workspaceArg, canon).paths;
  } catch {
    return sorted; // fail-open: legacy forms still match via store history
  }
}

function mineVoice(call: ToolCallView): EpisodeAnnotation | null {
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
        kind: `star:${category}` as EpisodeAnnotationKind,
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
  return null;
}

/** Concatenated assistant text blocks of one message ('' for non-assistant). */
function assistantTextOf(message: FoldMessage): string {
  if (message.role !== 'assistant') return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';
  const parts: string[] = [];
  for (const rawBlock of message.content) {
    const block = asRecord(rawBlock);
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
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
function mineNarrationForGap(
  messages: readonly FoldMessage[],
  scanStart: number,
  burstFinalTouch: number,
  gapEndExclusive: number,
  timestamps: readonly (string | undefined)[] | undefined,
  nowIso: string,
): { eventIndex: number; annotation: EpisodeAnnotation }[] {
  const start = Math.max(0, scanStart);
  const end = Math.min(messages.length, gapEndExclusive);

  // PASS 1 — every deliberate 🏁/⚠️ in position across the burst, de-duped,
  // UNCAPPED (selectVoiceInlays bounds display at render, not capture). The
  // declared glyph is the lexical trust signal here, so keep safety gates but do
  // not require a "Fixed/Turns out/Confirmed" opener.
  const deliberate: { eventIndex: number; annotation: EpisodeAnnotation }[] = [];
  const seen = new Set<string>();
  for (let i = start; i < end; i++) {
    const text = assistantTextOf(messages[i]);
    if (text.length === 0) continue;
    const glyph = classifyMessageGlyph(text);
    if (!isNarrationEligibleGlyph(glyph)) continue; // 🔍/▶/❓ self-exclude
    const kind = narrationKindForGlyph(glyph);
    if (kind === 'narration') continue;             // untagged → pass 2 only
    if (isSyntheticContextText(text)) continue;
    const lines = extractNarrationLines(
      text,
      isSyntheticContextText,
      NARRATION_MAX_LINES_TAGGED,
      { requireVerdictShape: false },
    );
    const ts = timestamps?.[i] ?? nowIso;
    for (const line of lines) {
      const key = line.trim().toLowerCase();
      if (seen.has(key)) continue; // within-burst exact-text dedup (hygiene, not a cap)
      seen.add(key);
      deliberate.push({ eventIndex: i, annotation: { ts, kind, text: line } });
    }
  }
  if (deliberate.length > 0) return deliberate;

  // PASS 2 — untagged closing-thought backstop. Identical to the original
  // single-narration miner; only reached when pass 1 found no declared voice.
  let scanned = 0;
  const touchIndex = Math.max(start, burstFinalTouch);
  for (let i = touchIndex; i < end; i++) {
    const text = assistantTextOf(messages[i]);
    if (text.length === 0) continue;
    const isBurstFinalTouch = i === burstFinalTouch;
    const glyph = classifyMessageGlyph(text);
    if (!isNarrationEligibleGlyph(glyph)) {
      // Declared 🔍 in-progress / ▶ executing / ❓ blocked: source-side self-exclusion.
      // Consumes the scan window (except at the burst-final touch) so exclusion
      // never extends reach deeper into next-task territory.
      if (!isBurstFinalTouch) {
        scanned += 1;
        if (scanned >= NARRATION_SCAN_MAX_MESSAGES) break;
      }
      continue;
    }
    if (!isSyntheticContextText(text)) {
      const kind = narrationKindForGlyph(glyph);
      const cap = kind === 'narration' ? NARRATION_MAX_LINES : NARRATION_MAX_LINES_TAGGED;
      const lines = extractNarrationLines(text, isSyntheticContextText, cap);
      if (lines.length > 0) {
        const ts = timestamps?.[i] ?? nowIso;
        return lines.map((line) => ({
          eventIndex: i,
          annotation: { ts, kind, text: line },
        }));
      }
    }
    // Eligible register but no verdict-shaped lines survived (or synthetic):
    // spend a scan unit — except at the burst-final touch, which is free so the
    // gap keeps its full forward reach (see isBurstFinalTouch note above).
    if (!isBurstFinalTouch) {
      scanned += 1;
      if (scanned >= NARRATION_SCAN_MAX_MESSAGES) break;
    }
  }
  return [];
}

function structuralStep(call: ToolCallView, outcome: 'ok' | 'error' | undefined, touched: readonly string[]): TraceStep {
  const shortName = shortToolName(call.name);
  if (shortName.toLowerCase() === 'atlas_commit') {
    const entry = call.input.changelog_entry;
    const head = typeof entry === 'string' ? truncateVerbatim(entry.split('\n')[0].trim(), COMMIT_DETAIL_CAP_CHARS) : '';
    return { tool: 'commit', ...(head ? { detail: head } : {}) };
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
 * Derive sealed episodes from the raw message window starting at startIndex.
 * Touch kinds come from tool names (edit-ish vs read); pivot stars seal
 * bursts; voice annotations attach to their burst (gap annotations attach to
 * the preceding chapter — the closing thought); narration is mined from each
 * sealed burst's gap prose (options.narration !== false); the branch trace
 * replicates the burst's exact tool sequence with outcomes, voice inlaid in
 * position.
 */
export function deriveEpisodesFromMessages(
  messages: readonly FoldMessage[],
  startIndex: number,
  identity: EpisodeCaptureIdentity,
  options: EpisodeCaptureOptions = {},
): EpisodeCaptureResult {
  const touches: EpisodeTouch[] = [];
  const pivots: EpisodePivotMarker[] = [];
  const annotated: { eventIndex: number; annotation: EpisodeAnnotation }[] = [];
  const steps: { eventIndex: number; step: TraceStep }[] = [];

  for (const call of iterToolCalls(messages, startIndex)) {
    const touched = extractTouchPaths(call.input, options.canon);
    const kind = isEditTool(call.name) ? 'edit' as const : 'read' as const;
    const ts = options.timestamps?.[call.eventIndex];
    for (const p of touched) {
      touches.push({ eventIndex: call.eventIndex, path: p, kind, ...(ts !== undefined ? { ts } : {}) });
    }

    const voice = mineVoice(call);
    if (voice) {
      const stamped: EpisodeAnnotation = { ...voice, ts: ts ?? identity.nowIso };
      annotated.push({ eventIndex: call.eventIndex, annotation: stamped });
      if (stamped.kind === 'star:pivot') pivots.push({ eventIndex: call.eventIndex });
      steps.push({ eventIndex: call.eventIndex, step: { tool: shortToolName(call.name), voice: stamped } });
      continue;
    }

    const outcome = resolveOutcome(messages, call.eventIndex, call.id, call.name);
    steps.push({ eventIndex: call.eventIndex, step: structuralStep(call, outcome, touched) });
  }

  const bursts = groupTouchesIntoEpisodes(touches, { pivots });
  if (bursts.length === 0) return { episodes: [], openBurstStartIndex: null };

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
  const trailingSettled = !sealTrailing
    && (trailingEventGap > DEFAULT_EPISODE_GROUPING.gapEvents
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
      sealedAnnotated.push(...mineNarrationForGap(messages, scanStart, burstFinalTouch, gapEnd, options.timestamps, identity.nowIso));
    }
  }
  const annotationsPerBurst = assignAnnotationsToBursts(sealed, sealedAnnotated);

  // Voice steps follow the SAME burst-assignment rule as annotations (gap →
  // preceding chapter): an agent's "edit, commit, star it, post it" pattern
  // puts the star/chat AFTER the last file touch, and the trace must keep
  // that closing voice inline. Structural gap steps (pure coordination calls)
  // stay excluded — they belong to no zone.
  const voiceBurstFor = (eventIndex: number): number => {
    let target = 0;
    for (let i = 0; i < sealed.length; i++) {
      if (eventIndex >= sealed[i].startEventIndex) target = i;
      else break;
    }
    return target;
  };

  const episodes: Episode[] = sealed.map((burst, index) => {
    const burstSteps = steps
      .filter((s) => s.step.voice
        ? s.eventIndex < voiceHorizon && voiceBurstFor(s.eventIndex) === index
        : s.eventIndex >= burst.startEventIndex && s.eventIndex <= burst.endEventIndex)
      .map((s) => s.step);
    const annotations = annotationsPerBurst[index];
    return {
      workspace: identity.workspace,
      instanceId: identity.instanceId,
      ...(identity.lineageRoot !== undefined ? { lineageRoot: identity.lineageRoot } : {}),
      ...(identity.siloed === true ? { siloed: true } : {}),
      startedAt: burst.startedAt ?? identity.nowIso,
      endedAt: burst.endedAt ?? identity.nowIso,
      closedBy: identity.closedBy,
      summary: deriveEpisodeSummary({ annotations, members: burst.members }),
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
