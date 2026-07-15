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
import { type Episode, type EpisodePivotMarker } from './foldEpisodes.ts';
import { type CanonContext } from './foldPathCanon.ts';
import { type FoldMessage, type SyntheticContextOptions } from './rollingFold.ts';
export interface EpisodeCaptureIdentity {
    workspace: string;
    instanceId: string;
    lineageRoot?: string;
    closedBy: Episode['closedBy'];
    /** Caller-supplied clock (keeps this module pure and testable). */
    nowIso: string;
    railId?: string;
    railStep?: string;
    /** Active task-rail objective, when the host can supply it cheaply. */
    railObjective?: string;
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
    /**
     * Host-supplied synthetic user-context markers to exclude from operator
     * intent and narration mining. Defaults empty so the standalone package stays
     * host-neutral.
     */
    syntheticContext?: SyntheticContextOptions;
    /**
     * Host-supplied behavioral affinity matrix (path -> neighbor -> score).
     * When present, high-affinity current/incoming path pairs widen the grouping
     * gap via groupTouchesIntoEpisodes. Omitted/empty = byte-identical.
     */
    affinityFloor?: Readonly<Record<string, Record<string, number>>>;
    /** Affinity score threshold above which a gap is widened (default 0.5). */
    affinityGapThreshold?: number;
    /** Multiplier applied to gapMs when affinity >= threshold (default 2.0). */
    affinityGapMultiplier?: number;
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
export declare function deriveEpisodesFromMessages(messages: readonly FoldMessage[], startIndex: number, identity: EpisodeCaptureIdentity, options?: EpisodeCaptureOptions): EpisodeCaptureResult;
/** Result of {@link computeOpenBurst} — the still-open read-burst the fold guard holds. */
export interface OpenBurstResult {
    /**
     * FoldMessage index where the open read-burst begins. The read-burst guard keeps
     * every turn from here onward unfolded (the active window's floor). `null` when
     * nothing is held: no touches at all, or the trailing burst has SETTLED (work
     * moved >gapEvents events / >gapMs past its last touch — it will not grow).
     */
    openBurstStartIndex: number | null;
    /** Member paths of the open burst (the resident co-activation set); empty when none. */
    heldPaths: readonly string[];
    /** Total bursts detected (sealed + open) — diagnostics only. */
    burstCount: number;
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
export declare function computeOpenBurst(messages: readonly FoldMessage[], options?: {
    canon?: CanonContext;
    timestamps?: readonly (string | undefined)[];
    pivots?: readonly EpisodePivotMarker[];
    nowIso?: string;
}): OpenBurstResult;
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
export declare function computeValueFloorPaths(messages: readonly FoldMessage[], touches: readonly {
    eventIndex: number;
    path: string;
    kind: string;
}[], options?: {
    maxPaths?: number;
    minRefCount?: number;
}): string[];
