// Model_Dump_Task removal (testbench-spec-grounding, C10): the Simulation_Harness owns
// `dump.vcd`, so a model's own dump calls are removed before the run, lexically, on the mask.
//
// `begin end` replaces each call because it is a statement wherever a system-task call can
// stand, which a bare `;` is not (`initial ;` does not parse under iverilog -g2012).

import type { SourceMask } from '@app/tools';

import { lineAt } from './sized-literal.js';
import type { SpanEdit } from './types.js';

/** The waveform-dumping system tasks only the Simulation_Harness may call. */
export const MODEL_DUMP_TASKS = [
  '$dumpfile',
  '$dumpvars',
  '$dumplimit',
  '$dumpoff',
  '$dumpon',
  '$dumpall',
  '$dumpflush',
] as const;

/** The next offset at or after `from` that is code and not whitespace, or `source.length`. */
function nextCodeOffset(source: string, mask: SourceMask, from: number): number {
  let offset = from;
  while (offset < source.length && (mask.code[offset] !== 1 || /\s/u.test(source[offset] ?? ''))) {
    offset += 1;
  }
  return offset;
}

/** The offset of the `)` matching the `(` at `open`, counting code offsets only, or -1. */
function matchingParen(source: string, mask: SourceMask, open: number): number {
  let depth = 0;
  for (let offset = open; offset < source.length; offset += 1) {
    if (mask.code[offset] !== 1) {
      continue;
    }
    if (source[offset] === '(') {
      depth += 1;
    } else if (source[offset] === ')') {
      depth -= 1;
      if (depth === 0) {
        return offset;
      }
    }
  }
  return -1;
}

/** The offset of the call's terminating `;`, or -1 when the call is not a complete statement. */
function statementEnd(source: string, mask: SourceMask, afterName: number): number {
  let offset = nextCodeOffset(source, mask, afterName);
  if (source[offset] === '(') {
    const close = matchingParen(source, mask, offset);
    if (close === -1) {
      return -1;
    }
    offset = nextCodeOffset(source, mask, close + 1);
  }
  return source[offset] === ';' ? offset : -1;
}

/** One SpanEdit per Model_Dump_Task statement at a code offset of `mask` (Req 4.3). */
export function planModelDumpTaskRemovals(input: {
  readonly source: string;
  readonly mask: SourceMask;
}): readonly SpanEdit[] {
  const { source, mask } = input;
  // Constructed per call: a shared module-level /g regex hangs nested scans (vault gotcha).
  const taskPattern = /\$dump(?:file|vars|limit|off|on|all|flush)(?![A-Za-z0-9_$])/gu;
  const edits: SpanEdit[] = [];
  for (const match of source.matchAll(taskPattern)) {
    const start = match.index;
    if (mask.code[start] !== 1) {
      continue;
    }
    const line = lineAt(mask, start);
    const semicolon = statementEnd(source, mask, start + match[0].length);
    if (semicolon === -1) {
      edits.push({
        start,
        end: start + match[0].length,
        replacement: match[0],
        finding: {
          dialectClass: 'model-dump-task',
          line,
          action: 'declined',
          declinedBecause: 'rewrite-context-not-established',
        },
      });
      continue;
    }
    // Keep every newline the call spanned, so later line numbers and diagnostics do not move.
    const newlines = source.slice(start, semicolon + 1).replace(/[^\n]/gu, '');
    edits.push({
      start,
      end: semicolon + 1,
      replacement: `begin end${newlines}`,
      finding: { dialectClass: 'model-dump-task', line, action: 'rewritten' },
    });
  }
  return edits;
}
