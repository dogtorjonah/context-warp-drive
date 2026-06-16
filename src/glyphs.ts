export const REGISTER_GLYPHS = {
  in_progress: '🔍',
  verdict: '🏁',
  hazard: '⚠️',
  blocked: '❓',
} as const;

export const ASCII_REGISTER_ALIASES = {
  '[progress]': 'in_progress',
  '[in_progress]': 'in_progress',
  '[verdict]': 'verdict',
  '[hazard]': 'hazard',
  '[blocked]': 'blocked',
  '[question]': 'blocked',
} as const satisfies Record<string, AssistantRegister>;

export type AssistantRegister = keyof typeof REGISTER_GLYPHS;
export type AssistantRegisterGlyph = (typeof REGISTER_GLYPHS)[AssistantRegister];
export type AssistantRegisterTrust = 'transient' | 'durable' | 'blocked' | 'low_trust';
export type AssistantRegisterParseFailureReason =
  | 'empty'
  | 'leading_whitespace'
  | 'markdown_container'
  | 'missing_register'
  | 'duplicate_register';

export interface AssistantRegisterClassification {
  readonly register: AssistantRegister | null;
  readonly trust: AssistantRegisterTrust;
  readonly durable: boolean;
  readonly final: boolean;
}

export interface AssistantRegisterParseOptions {
  /**
   * ASCII aliases are intentionally opt-in so the runtime contract stays
   * glyph-first. Passing true enables the default bracketed aliases.
   */
  readonly asciiAliases?: boolean | Readonly<Record<string, AssistantRegister>>;
}

export type AssistantRegisterParseResult =
  | {
      readonly ok: true;
      readonly register: AssistantRegister;
      readonly glyph: AssistantRegisterGlyph;
      readonly source: 'glyph' | 'ascii_alias';
      readonly rawPrefix: string;
      readonly body: string;
      readonly classification: AssistantRegisterClassification;
    }
  | {
      readonly ok: false;
      readonly reason: AssistantRegisterParseFailureReason;
      readonly body: string;
      readonly classification: AssistantRegisterClassification;
    };

interface PrefixMatch {
  readonly register: AssistantRegister;
  readonly glyph: AssistantRegisterGlyph;
  readonly source: 'glyph' | 'ascii_alias';
  readonly rawPrefix: string;
}

const WARNING_SIGN = '⚠';
const VARIATION_SELECTOR_16 = '\ufe0f';
const KNOWN_GLYPH_PREFIXES: readonly PrefixMatch[] = [
  {
    register: 'hazard',
    glyph: REGISTER_GLYPHS.hazard,
    source: 'glyph',
    rawPrefix: REGISTER_GLYPHS.hazard,
  },
  {
    register: 'in_progress',
    glyph: REGISTER_GLYPHS.in_progress,
    source: 'glyph',
    rawPrefix: REGISTER_GLYPHS.in_progress,
  },
  {
    register: 'verdict',
    glyph: REGISTER_GLYPHS.verdict,
    source: 'glyph',
    rawPrefix: REGISTER_GLYPHS.verdict,
  },
  {
    register: 'blocked',
    glyph: REGISTER_GLYPHS.blocked,
    source: 'glyph',
    rawPrefix: REGISTER_GLYPHS.blocked,
  },
  {
    register: 'hazard',
    glyph: REGISTER_GLYPHS.hazard,
    source: 'glyph',
    rawPrefix: WARNING_SIGN,
  },
];

const MARKDOWN_CONTAINER_PREFIXES = ['```', '~~~', '>', '#', '-', '*', '1.'] as const;

export function parseRegisterGlyph(
  input: string,
  options: AssistantRegisterParseOptions = {},
): AssistantRegisterParseResult {
  if (input.length === 0) return failed('empty', input);
  if (/^\s/u.test(input)) return failed('leading_whitespace', input);
  if (startsWithMarkdownContainer(input)) return failed('markdown_container', input);

  const glyphMatch = matchGlyphPrefix(input);
  if (glyphMatch) return parseMatchedPrefix(input, glyphMatch);

  const aliasMatch = matchAsciiAlias(input, options.asciiAliases);
  if (aliasMatch) return parseMatchedPrefix(input, aliasMatch);

  return failed('missing_register', input);
}

export function classifyAssistantRegister(
  register: AssistantRegister | null,
): AssistantRegisterClassification {
  switch (register) {
    case 'verdict':
    case 'hazard':
      return { register, trust: 'durable', durable: true, final: true };
    case 'blocked':
      return { register, trust: 'blocked', durable: false, final: true };
    case 'in_progress':
      return { register, trust: 'transient', durable: false, final: false };
    default:
      return { register: null, trust: 'low_trust', durable: false, final: false };
  }
}

export function stripRegisterGlyph(
  input: string,
  options: AssistantRegisterParseOptions = {},
): string {
  const parsed = parseRegisterGlyph(input, options);
  return parsed.ok ? parsed.body : input;
}

function parseMatchedPrefix(input: string, match: PrefixMatch): AssistantRegisterParseResult {
  const body = input.slice(match.rawPrefix.length);
  if (startsWithRegisterPrefix(body)) {
    return failed('duplicate_register', input);
  }

  return {
    ok: true,
    register: match.register,
    glyph: match.glyph,
    source: match.source,
    rawPrefix: match.rawPrefix,
    body,
    classification: classifyAssistantRegister(match.register),
  };
}

function matchGlyphPrefix(input: string): PrefixMatch | null {
  for (const candidate of KNOWN_GLYPH_PREFIXES) {
    if (input.startsWith(candidate.rawPrefix)) return candidate;
  }
  return null;
}

function matchAsciiAlias(
  input: string,
  asciiAliases: AssistantRegisterParseOptions['asciiAliases'],
): PrefixMatch | null {
  if (!asciiAliases) return null;
  const aliases = asciiAliases === true ? ASCII_REGISTER_ALIASES : asciiAliases;
  const lowerInput = input.toLowerCase();
  for (const [rawPrefix, register] of Object.entries(aliases)) {
    if (!lowerInput.startsWith(rawPrefix.toLowerCase())) continue;
    return {
      register,
      glyph: REGISTER_GLYPHS[register],
      source: 'ascii_alias',
      rawPrefix: input.slice(0, rawPrefix.length),
    };
  }
  return null;
}

function startsWithRegisterPrefix(input: string): boolean {
  if (matchGlyphPrefix(input)) return true;
  return input.startsWith(VARIATION_SELECTOR_16) && matchGlyphPrefix(input.slice(1)) !== null;
}

function startsWithMarkdownContainer(input: string): boolean {
  return MARKDOWN_CONTAINER_PREFIXES.some((prefix) => input.startsWith(prefix));
}

function failed(reason: AssistantRegisterParseFailureReason, body: string): AssistantRegisterParseResult {
  return {
    ok: false,
    reason,
    body,
    classification: classifyAssistantRegister(null),
  };
}
