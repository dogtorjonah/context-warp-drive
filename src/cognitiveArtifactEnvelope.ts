import { createHash } from 'node:crypto';

export const COGNITIVE_ARTIFACT_ENVELOPE_VERSION = 'cognitive-artifact-envelope/v1' as const;

export const COGNITIVE_ARTIFACT_TYPES = ['star', 'rail', 'atlas', 'chat', 'glyph'] as const;
export type CognitiveArtifactType = (typeof COGNITIVE_ARTIFACT_TYPES)[number];

export type CognitiveArtifactAuthorityClass =
  | 'pointer'
  | 'historical_observation'
  | 'evidence'
  | 'review_verdict'
  | 'authoritative_source';

export type CognitiveArtifactCurrentStatus = 'current' | 'superseded' | 'unresolved';

export type CognitiveArtifactDriftStatus =
  | 'current'
  | 'modified_since_record'
  | 'missing'
  | 'unknown'
  | 'not_applicable';

export interface CognitiveArtifactEnvelope {
  artifactId: string;
  sourceIdentity: string;
  sourceTime: string;
  authorityClass: CognitiveArtifactAuthorityClass;
  completionSupport: 'insufficient_alone';
  currentStatus: CognitiveArtifactCurrentStatus;
  supersededBy: string | null;
  driftStatus: CognitiveArtifactDriftStatus;
}

type RawSourceTime = string | number | null | undefined;

export type CognitiveArtifactSource =
  | { family: 'star'; instanceId: string; category: string; note: string; sourceTime: RawSourceTime }
  | { family: 'rail-state'; railId: string; state: string; sourceTime: RawSourceTime }
  | { family: 'rail-step'; railId: string; stepId: string; sourceTime: RawSourceTime }
  | { family: 'atlas'; workspace?: string | null; instanceId: string; changelogId: number; sourceTime: RawSourceTime }
  | { family: 'chat'; roomId: string; messageId: string; sourceTime: RawSourceTime }
  | { family: 'glyph'; messageId: string; sourceTime: RawSourceTime };

export interface CognitiveArtifactEnvelopeInput {
  source: CognitiveArtifactSource;
  authorityClass: CognitiveArtifactAuthorityClass;
  driftStatus?: CognitiveArtifactDriftStatus;
}

const SQLITE_UTC_SOURCE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const QUALIFIED_ISO_SOURCE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** Normalize explicit ISO, SQLite UTC, and epoch-millisecond clocks without inventing time. */
export function normalizeCognitiveSourceTime(raw: RawSourceTime): string | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = raw.trim();
  if (!text) return null;

  const sqliteMatch = SQLITE_UTC_SOURCE_TIME_RE.exec(text);
  const qualified = sqliteMatch ? `${text.replace(' ', 'T')}Z` : text;
  const match = QUALIFIED_ISO_SOURCE_TIME_RE.exec(qualified);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00', , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  if (zone !== 'Z') {
    const [offsetHour, offsetMinute] = zone.slice(1).split(':').map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }

  // Date.parse normalizes impossible calendar dates (for example February 31),
  // so validate the written wall-clock components against an explicit UTC view
  // before applying the declared zone offset.
  const calendar = new Date(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.000Z`);
  if (
    Number.isNaN(calendar.getTime())
    || calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() + 1 !== month
    || calendar.getUTCDate() !== day
    || calendar.getUTCHours() !== hour
    || calendar.getUTCMinutes() !== minute
    || calendar.getUTCSeconds() !== second
  ) return null;

  const date = new Date(qualified);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sourceType(source: CognitiveArtifactSource): CognitiveArtifactType {
  if (source.family === 'rail-state' || source.family === 'rail-step') return 'rail';
  return source.family;
}

function rootSourceIdentity(source: CognitiveArtifactSource, sourceTime: string): string {
  switch (source.family) {
    case 'star':
      return `instance:${source.instanceId}/star:${sourceTime}/${source.category}/${source.note}`;
    case 'rail-state':
      return `rail:${source.railId}/state:${source.state}`;
    case 'rail-step':
      return `rail:${source.railId}/step:${source.stepId}`;
    case 'atlas':
      return source.workspace
        ? `workspace:${source.workspace}/changelog:${source.changelogId}`
        : `instance:${source.instanceId}/atlas-changelog:${source.changelogId}`;
    case 'chat':
      return `room:${source.roomId}/message:${source.messageId}`;
    case 'glyph':
      return `message:${source.messageId}`;
  }
}

/**
 * Create the immutable common envelope shared by every Rolodex collector.
 * Invalid or absent source time fails closed; callers skip the source row.
 */
export function createCognitiveArtifactEnvelope(
  input: CognitiveArtifactEnvelopeInput,
): CognitiveArtifactEnvelope | null {
  const sourceTime = normalizeCognitiveSourceTime(input.source.sourceTime);
  if (!sourceTime) return null;
  const type = sourceType(input.source);
  const sourceIdentity = rootSourceIdentity(input.source, sourceTime);
  const digest = createHash('sha256').update(`${type}\u0000${sourceIdentity}`, 'utf8').digest('hex');
  return {
    artifactId: `${type}:${digest}`,
    sourceIdentity,
    sourceTime,
    authorityClass: input.authorityClass,
    completionSupport: 'insufficient_alone',
    currentStatus: 'unresolved',
    supersededBy: null,
    driftStatus: input.driftStatus ?? 'not_applicable',
  };
}
