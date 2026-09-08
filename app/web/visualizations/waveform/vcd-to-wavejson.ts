// Pure VCD -> WaveDrom WaveJSON transform (Design: OD-5 Waveform rendering; Req 9.1).
//
// This is the vendor-neutral adapter that sits BEHIND the Waveform_Viewer: it turns
// a simulator's Value Change Dump into the WaveJSON shape WaveDrom renders. It is
// deliberately pure and rendering-free - it never touches the DOM or WaveDrom - so
// it is unit-testable in isolation and a future renderer swap (a Surfer/WASM-class
// viewer, per OD-5) is localized to the rendering surface, not this transform.
//
// Security posture: a VCD is UNTRUSTED input (it is produced from generated RTL and
// arrives across the API boundary). This parser therefore validates the input at
// the boundary: it accepts only a bounded amount of text and a bounded number of
// signals/samples, ignores any line it does not recognize rather than trusting it,
// and never evaluates or echoes raw input. Malformed or empty input yields an
// explicit error result, never a throw and never a partial guess.

/** One WaveDrom signal row: a name, its wave string, and optional multi-bit data. */
export interface WaveJsonSignal {
  readonly name: string;
  readonly wave: string;
  readonly data?: readonly string[];
}

/** The minimal WaveJSON document WaveDrom consumes. */
export interface WaveJson {
  readonly signal: readonly WaveJsonSignal[];
}

/** Why a VCD could not be transformed (sanitized: never carries raw input). */
export type VcdParseErrorCode = 'EMPTY_INPUT' | 'NO_SIGNALS' | 'INPUT_TOO_LARGE';

/** The transform outcome: the WaveJSON, or a classified, sanitized error. */
export type VcdToWaveJsonResult =
  | { readonly ok: true; readonly wave: WaveJson }
  | { readonly ok: false; readonly code: VcdParseErrorCode };

/** Hard input ceilings so an oversized or pathological dump cannot exhaust memory. */
const MAX_VCD_BYTES = 5_000_000;
const MAX_SIGNALS = 512;
const MAX_SAMPLES = 4096;

/** A `$var` declaration parsed from the VCD header. */
interface VcdVar {
  readonly symbol: string;
  readonly name: string;
  readonly width: number;
}

/** Matches `$var <type> <width> <symbol> <name> [range] $end`. */
const VAR_LINE = /^\$var\s+\w+\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+\[[^\]]*\])?\s+\$end$/;

/** Parse one `$var` line into a declaration, or `null` when it is not one. */
function parseVarLine(line: string): VcdVar | null {
  const match = VAR_LINE.exec(line);
  if (match === null) {
    return null;
  }
  const [, widthText, symbol, name] = match;
  const width = Number.parseInt(widthText as string, 10);
  if (!Number.isInteger(width) || width < 1) {
    return null;
  }
  return { symbol: symbol as string, name: name as string, width };
}

/** A single value change applied to a symbol at the current time step. */
interface ValueChange {
  readonly symbol: string;
  readonly value: string;
}

/**
 * Parse a value-change line into a change, or `null` when it is not one.
 *
 * Handles both scalar changes (`0!`, `1"`, `x!`) and vector changes
 * (`b1010 !`, `r3.14 !`). The leading token is normalized to a compact value
 * string; the symbol is the trailing token.
 */
function parseValueChange(line: string): ValueChange | null {
  const first = line[0];
  if (first === 'b' || first === 'B' || first === 'r' || first === 'R') {
    const parts = line.slice(1).trim().split(/\s+/);
    if (parts.length !== 2) {
      return null;
    }
    return { symbol: parts[1] as string, value: parts[0] as string };
  }
  if (
    first === '0' ||
    first === '1' ||
    first === 'x' ||
    first === 'X' ||
    first === 'z' ||
    first === 'Z'
  ) {
    const symbol = line.slice(1).trim();
    return symbol === '' ? null : { symbol, value: first.toLowerCase() };
  }
  return null;
}

/** Mutable accumulator threaded through the value-change scan. */
interface ScanState {
  readonly current: Map<string, string>;
  readonly snapshots: Array<Map<string, string>>;
  pendingTime: number | null;
}

/** Close the currently open time step by snapshotting the accumulated values. */
function closePending(state: ScanState): void {
  if (state.pendingTime !== null && state.snapshots.length < MAX_SAMPLES) {
    state.snapshots.push(new Map(state.current));
  }
}

/** Apply one already-trimmed body line (time marker or value change) to the scan. */
function applyBodyLine(line: string, state: ScanState): void {
  if (line.startsWith('#')) {
    const time = Number.parseInt(line.slice(1), 10);
    if (Number.isInteger(time)) {
      closePending(state);
      state.pendingTime = time;
    }
    return;
  }
  const change = parseValueChange(line);
  if (change !== null) {
    state.current.set(change.symbol, change.value);
  }
}

/** Scan the body lines into an ordered list of per-time value snapshots. */
function collectSnapshots(bodyLines: readonly string[]): Array<Map<string, string>> {
  const state: ScanState = { current: new Map(), snapshots: [], pendingTime: null };
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (line !== '') {
      applyBodyLine(line, state);
    }
  }
  closePending(state);
  return state.snapshots;
}

/** Map a raw scalar value to its WaveDrom character, defaulting unknowns to `x`. */
function scalarChar(value: string | undefined): string {
  if (value === '0' || value === '1') {
    return value;
  }
  return 'x';
}

/** Build the WaveDrom row for a scalar (1-bit) signal across the snapshots. */
function buildScalarSignal(
  v: VcdVar,
  snapshots: ReadonlyArray<Map<string, string>>,
): WaveJsonSignal {
  let wave = '';
  let previous: string | null = null;
  for (const snapshot of snapshots) {
    const char = scalarChar(snapshot.get(v.symbol));
    wave += char === previous ? '.' : char;
    previous = char;
  }
  return { name: v.name, wave: wave === '' ? 'x' : wave };
}

/** Build the WaveDrom row for a vector (multi-bit) signal across the snapshots. */
function buildVectorSignal(
  v: VcdVar,
  snapshots: ReadonlyArray<Map<string, string>>,
): WaveJsonSignal {
  let wave = '';
  const data: string[] = [];
  let previous: string | null = null;
  for (const snapshot of snapshots) {
    const value = snapshot.get(v.symbol) ?? 'x';
    if (value === previous) {
      wave += '.';
      continue;
    }
    wave += '=';
    data.push(value);
    previous = value;
  }
  return { name: v.name, wave: wave === '' ? 'x' : wave, data };
}

/** Build a signal row, dispatching on the declared width. */
function buildSignal(v: VcdVar, snapshots: ReadonlyArray<Map<string, string>>): WaveJsonSignal {
  return v.width === 1 ? buildScalarSignal(v, snapshots) : buildVectorSignal(v, snapshots);
}

/** Split the dump into declared variables and the value-change body lines. */
function parseVarsAndBody(lines: readonly string[]): { vars: VcdVar[]; body: string[] } {
  const vars: VcdVar[] = [];
  const body: string[] = [];
  let inBody = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '$enddefinitions $end') {
      inBody = true;
      continue;
    }
    if (inBody) {
      body.push(raw);
      continue;
    }
    const parsed = parseVarLine(line);
    if (parsed !== null && vars.length < MAX_SIGNALS) {
      vars.push(parsed);
    }
  }
  return { vars, body };
}

/**
 * Transform an untrusted VCD string into WaveDrom WaveJSON.
 *
 * Returns an explicit error result for empty input, oversized input, or a dump
 * that declares no signals; otherwise returns one WaveJSON row per declared
 * signal, sampled at each recorded time step with `.` marking an unchanged slot.
 * Pure and total: it performs no I/O and never throws, so the Waveform_Viewer can
 * degrade to an explicit `unavailable` on any error.
 */
export function vcdToWaveJson(vcd: string): VcdToWaveJsonResult {
  if (vcd.length === 0) {
    return { ok: false, code: 'EMPTY_INPUT' };
  }
  if (vcd.length > MAX_VCD_BYTES) {
    return { ok: false, code: 'INPUT_TOO_LARGE' };
  }
  const lines = vcd.split('\n');
  const { vars, body } = parseVarsAndBody(lines);
  if (vars.length === 0) {
    return { ok: false, code: 'NO_SIGNALS' };
  }
  const snapshots = collectSnapshots(body);
  const signal = vars.map((v) => buildSignal(v, snapshots));
  return { ok: true, wave: { signal } };
}
