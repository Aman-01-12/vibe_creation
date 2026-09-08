// Reading RTLLM's `design_description.txt` as untrusted external input.
//
// The description is the natural-language problem statement a student would be
// given, wrapped in LLM-prompt scaffolding: it opens with "Please act as a
// professional verilog designer.", closes with "Give me the complete code.", and
// carries labeled sections (`Module name:`, `Input ports:`, `Output ports:`,
// `Implementation:`).
//
// What this module takes from it, and what it deliberately does not:
//   TAKEN  the required MODULE NAME, from the labeled `Module name:` field. The
//          golden testbench instantiates exactly this identifier, so it - not the
//          reference RTL's own top-module name, which upstream prefixes with
//          `verified_` and which for three designs differs outright - is what a
//          candidate must be named.
//   TAKEN  the behavioural statement (everything before the first labeled field)
//          as the problem statement, and the `Implementation:` section as the
//          architecture note.
//   NOT TAKEN  the port/width prose under `Input ports:` / `Output ports:`. Those
//          widths are stated in English and vary in phrasing; the reference RTL's
//          declaration is machine-readable and is what the golden testbench
//          connects to, so `verilog-module.ts` owns the interface.
//
// Every field is size-bounded and every failure returns a reason, so a truncated or
// hostile description quarantines a design instead of crashing the import.

/** Longest description this parser will read; bounds work on untrusted input. */
const MAX_DESCRIPTION_CHARS = 20_000;

/** Longest problem statement / architecture note carried into a Spec. */
const MAX_SECTION_CHARS = 4_000;

/** Longest accepted module name; a Verilog identifier, not a paragraph. */
const MAX_MODULE_NAME_CHARS = 128;

/** Matches a Verilog identifier in full. */
const IDENTIFIER_ONLY = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * The prompt scaffolding upstream wraps every description in.
 *
 * These lines address the model, not the designer, so they are not part of the
 * problem statement and must not reach a Spec goal. Matched case-insensitively
 * against the whole trimmed line.
 */
const PROMPT_SCAFFOLDING: readonly RegExp[] = Object.freeze([
  /^please act as a professional\b.*$/i,
  /^give me the complete code\.?$/i,
]);

/**
 * The labeled fields a description may carry, in one place.
 *
 * Any of these ends the section before it, so a description that introduces a new
 * labeled field is read correctly rather than having the new field absorbed into the
 * previous section's text.
 */
const LABELED_FIELD =
  /^\s*(module\s+name|function|input\s+ports?|output\s+ports?|inout\s+ports?|parameter(?:ized)?(?:\s+values?)?|implementation)\s*:/i;

/** Build a matcher for one labeled section, capturing any value on the label's own line. */
function sectionLabel(label: string): RegExp {
  return new RegExp(`^\\s*${label}\\s*:\\s*(.*)$`, 'i');
}

/** Matches the `Module name:` label. */
const MODULE_NAME_LABEL = sectionLabel('module\\s+name');

/**
 * Matches the `Function:` label.
 *
 * Most descriptions state the behaviour as unlabeled prose above `Module name:`, but
 * two put it under an explicit `Function:` heading below the module name. Both are
 * the problem statement, so both are read - the parser follows the format upstream
 * actually uses rather than importing an empty goal.
 */
const FUNCTION_LABEL = sectionLabel('function');

/** Matches the `Implementation:` label. */
const IMPLEMENTATION_LABEL = sectionLabel('implementation');

/** The fields the importer needs out of one design description. */
export interface DesignDescription {
  /** The module name the golden testbench instantiates and a candidate must use. */
  readonly moduleName: string;
  /** The natural-language problem statement, prompt scaffolding removed. */
  readonly statement: string;
  /** The `Implementation:` section, or an empty string when the description has none. */
  readonly implementation: string;
}

/** A parsed description, or a short reason it could not be read. */
export type DescriptionParseResult =
  | { readonly ok: true; readonly description: DesignDescription }
  | { readonly ok: false; readonly reason: string };

/** Whether a line is prompt scaffolding rather than problem content. */
function isScaffolding(line: string): boolean {
  const trimmed = line.trim();
  return PROMPT_SCAFFOLDING.some((pattern) => pattern.test(trimmed));
}

/** Collapse blank-line runs and trim, so a Spec field is compact but readable. */
function normalizeSection(lines: readonly string[]): string {
  return lines
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_SECTION_CHARS);
}

/**
 * Read the `Module name:` value, which upstream writes either inline or on the
 * following line.
 */
function readModuleName(lines: readonly string[]): string | null {
  for (const [index, line] of lines.entries()) {
    const label = MODULE_NAME_LABEL.exec(line);
    if (label === null) {
      continue;
    }
    const inline = (label[1] ?? '').trim();
    if (inline.length > 0) {
      return inline.split(/\s+/)[0] ?? null;
    }
    const following = lines.slice(index + 1).find((next) => next.trim().length > 0);
    return following === undefined ? null : (following.trim().split(/\s+/)[0] ?? null);
  }
  return null;
}

/** Content lines from `startIndex` (exclusive of the label line) up to the next label. */
function collectUntilNextLabel(lines: readonly string[], startIndex: number): readonly string[] {
  const collected: string[] = [];
  for (const line of lines.slice(startIndex)) {
    if (LABELED_FIELD.test(line)) {
      break;
    }
    if (!isScaffolding(line)) {
      collected.push(line);
    }
  }
  return collected;
}

/** The preamble: content lines before the first labeled field. */
function readPreamble(lines: readonly string[]): string {
  return normalizeSection(collectUntilNextLabel(lines, 0));
}

/** One labeled section's text: the label line's own tail plus lines until the next label. */
function readLabeledSection(lines: readonly string[], label: RegExp): string {
  const start = lines.findIndex((line) => label.test(line));
  if (start === -1) {
    return '';
  }
  const inline = (label.exec(lines[start] ?? '')?.[1] ?? '').trim();
  const body = collectUntilNextLabel(lines, start + 1);
  return normalizeSection(inline.length > 0 ? [inline, ...body] : body);
}

/**
 * The behavioural problem statement: the unlabeled preamble plus any `Function:`
 * section.
 *
 * Both carry behaviour, and which one a description uses varies upstream, so both are
 * read and joined rather than one being privileged.
 */
function readStatement(lines: readonly string[]): string {
  const parts = [readPreamble(lines), readLabeledSection(lines, FUNCTION_LABEL)].filter(
    (part) => part.length > 0,
  );
  return parts.join('\n').slice(0, MAX_SECTION_CHARS);
}

/**
 * Parse one `design_description.txt`.
 *
 * Fails closed with a reason on oversized input, a missing or non-identifier module
 * name, or an empty problem statement - each of which would otherwise produce a
 * Spec the loop cannot act on.
 */
export function parseDesignDescription(raw: string): DescriptionParseResult {
  if (raw.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, reason: 'design description exceeded the maximum readable size' };
  }
  const lines = raw.split(/\r?\n/);
  const moduleName = readModuleName(lines);
  if (moduleName === null) {
    return { ok: false, reason: 'design description declares no "Module name:" field' };
  }
  if (moduleName.length > MAX_MODULE_NAME_CHARS || !IDENTIFIER_ONLY.test(moduleName)) {
    return { ok: false, reason: 'the declared module name is not a Verilog identifier' };
  }
  const statement = readStatement(lines);
  if (statement.length === 0) {
    return { ok: false, reason: 'design description carries no problem statement' };
  }
  return {
    ok: true,
    description: {
      moduleName,
      statement,
      implementation: readLabeledSection(lines, IMPLEMENTATION_LABEL),
    },
  };
}
