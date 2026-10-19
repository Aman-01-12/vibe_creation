// The reviewed per-port timing Ground_Truth: for every declared output port of every
// design in the Derivation_Population, whether that port settles combinationally or on
// a clock edge, read by hand from the reference source.
//
// WHY THIS IS A COMMITTED CONSTANT RATHER THAN A COMPUTED RESULT
//   The cross-check exists to catch the derivation being wrong, and a second reader of
//   the same sources cannot do that: two dependency-graph walks over one semantic
//   question share a conceptual error class, so a shared mistake passes the check
//   undetected. An earlier draft did specify such a reader, deciding timing from the
//   ASSIGNMENT CONTEXT of the source, and it is measured wrong - see `traffic_light`'s
//   `clock` below. So the outcome is RECORDED here, authored from the reference source
//   and committed BEFORE the derivation is run over the corpus, because a manifest
//   written after seeing the derivation's output is confirmation bias with a filename.
//   The cross-check then asserts that a real run reproduces this list EXACTLY, in both
//   directions: a newly disagreeing port fails, and a port that starts agreeing where
//   `expected` says `refused` also fails. It is a ratchet, the same discipline
//   `stage0-quarantine.ts` uses for its exclusion list.
//
// THE ONE QUESTION EVERY ENTRY ANSWERS
//   `combinational` when a path from a declared DATA input port reaches the output port
//   crossing no sequential element; `registered` when no such path exists and the port
//   depends on retained state. The clock and the reset are NOT data inputs, and the KIND
//   OF BLOCK that assigns the port is NOT the question. Two anchors for that: this
//   corpus's `traffic_light` drives `output wire [7:0] clock` with `assign clock = cnt`
//   off a register - a continuous assignment whose answer is `registered` - and `fsm` is
//   Mealy, a clocked design whose `MATCH` reads the data input `IN` inside `always @(*)`
//   and is therefore `combinational`.
//
// WHAT `expected` ADDS
//   A port no bit of which has any driver is expected to be REFUSED rather than scored.
//   `alu` declares `carry`, `negative` and `overflow` and assigns none of them; those
//   are the first three such entries.
//
// NOTE: nothing here imports any part of the derivation and nothing is computed at
// module load. Independence is a property of PROVENANCE, not of a second algorithm.

import type { PortTiming } from '@app/core';

/** One declared output port's reviewed Ground_Truth timing. */
export interface TimingGroundTruthEntry {
  /** The design's `designName`: its directory name under the RTLLM checkout. */
  readonly design: string;
  readonly port: string;
  readonly timing: PortTiming;
  /**
   * The reviewed expectation for this port's comparison: `agrees` where the derivation
   * is expected to reproduce `timing`, `refused` where it is expected to refuse the
   * port. Recorded so the ratchet works in both directions.
   */
  readonly expected: 'agrees' | 'refused';
  /** The engineering reason, recorded so the entry is reviewable rather than asserted. */
  readonly rationale: string;
}

/**
 * Every declared output port of every design in the Derivation_Population: the 48
 * reference designs that elaborate under Yosys, which is all 50 under `.eval-corpus`
 * minus `synchronizer` and `float_multi`.
 *
 * `radix2_div`, `ring_counter`, `freq_divbyeven` and `clkgenerator` are present despite
 * being Stage-0 quarantined: Stage 0 is about their golden testbench being an unusable
 * judge, which has nothing to do with deriving a contract from a netlist.
 */
export const TIMING_GROUND_TRUTH: readonly TimingGroundTruthEntry[] = Object.freeze([
  // --- Arithmetic -----------------------------------------------------------------
  {
    design: 'accu',
    port: 'valid_out',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped in an always @(posedge clk or negedge rst_n) block off end_cnt.',
  },
  {
    design: 'accu',
    port: 'data_out',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'data_in reaches it only through the posedge accumulate flop.',
  },
  {
    design: 'adder_16bit',
    port: 'y',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'Every bit driven by the add8/add4/add2/add1 instance tree of pure assigns.',
  },
  {
    design: 'adder_16bit',
    port: 'Co',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'Carry out of the same assign-only instance tree from a, b, Cin.',
  },
  {
    design: 'adder_32bit',
    port: 'S',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'Driven through CLA_16/adder_4/adder, all continuous assigns off A and B.',
  },
  {
    design: 'adder_32bit',
    port: 'C32',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign C32 = gx2 ^ (px2 && c16), a carry-lookahead net off A and B.',
  },
  {
    design: 'adder_8bit',
    port: 'sum',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'Ripple chain of full_adder instances, each a single assign off a, b, cin.',
  },
  {
    design: 'adder_8bit',
    port: 'cout',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign cout = c[7], the last ripple carry, no sequential element present.',
  },
  {
    design: 'adder_bcd',
    port: 'Sum',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign off corrected_sum, itself an assign off A, B and Cin.',
  },
  {
    design: 'adder_bcd',
    port: 'Cout',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign Cout = carry_out, the (temp_sum > 9) compare off A, B and Cin.',
  },
  {
    design: 'adder_pipe_64bit',
    port: 'result',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign result = {c4, s4, s3_ff1, s2_ff2, s1_ff3}, every term a pipeline flop.',
  },
  {
    design: 'adder_pipe_64bit',
    port: 'o_en',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Last stage of the i_en shift register, flopped on posedge clk.',
  },
  {
    design: 'comparator_3bit',
    port: 'A_greater',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign (A > B), a pure compare of the two data inputs.',
  },
  {
    design: 'comparator_3bit',
    port: 'A_equal',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign (A == B), a pure compare of the two data inputs.',
  },
  {
    design: 'comparator_3bit',
    port: 'A_less',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign (A < B), a pure compare of the two data inputs.',
  },
  {
    design: 'comparator_4bit',
    port: 'A_greater',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign off cout and diff, which come from the A - B subtract assign.',
  },
  {
    design: 'comparator_4bit',
    port: 'A_equal',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign A_equal = (A == B), a pure compare of the two data inputs.',
  },
  {
    design: 'comparator_4bit',
    port: 'A_less',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign A_less = cout, the borrow out of the A - B subtract assign.',
  },
  {
    design: 'div_16bit',
    port: 'result',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign off tmp_a, computed in always @(*) from A and B; the design has no clock.',
  },
  {
    design: 'div_16bit',
    port: 'odd',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign odd = tmp_a[31:16], same level-sensitive restoring loop off A and B.',
  },
  {
    design: 'radix2_div',
    port: 'res_valid',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped on posedge clk off cnt[3] and data_go, no data input reaches it.',
  },
  {
    design: 'radix2_div',
    port: 'result',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'The declared data input sign selects the sign-magnitude correction on the way out.',
  },
  {
    design: 'multi_16bit',
    port: 'yout',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign yout = yout_r, the shift-and-accumulate flop.',
  },
  {
    design: 'multi_16bit',
    port: 'done',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign done = done_r, flopped off the i counter.',
  },
  {
    design: 'multi_8bit',
    port: 'product',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'Unrolled in always @* off A and B; the design declares no clock.',
  },
  {
    design: 'multi_booth_8bit',
    port: 'p',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Accumulated in always @(posedge clk or posedge reset); a and b enter via flops.',
  },
  {
    design: 'multi_booth_8bit',
    port: 'rdy',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Set in the same posedge block once ctr reaches 16.',
  },
  {
    design: 'multi_pipe_4bit',
    port: 'mul_out',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Second pipeline stage: flopped sum of sum_tmp1 and sum_tmp2.',
  },
  {
    design: 'multi_pipe_8bit',
    port: 'mul_en_out',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Last tap of the mul_en_out_reg shift register, flopped on posedge clk.',
  },
  {
    design: 'multi_pipe_8bit',
    port: 'mul_out',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped off mul_out_reg, four pipeline stages away from mul_a and mul_b.',
  },
  {
    design: 'fixed_point_adder',
    port: 'c',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign c = res, res written in the level-sensitive always @(a, b) block.',
  },
  {
    design: 'fixed_point_substractor',
    port: 'c',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign c = res, res written in the level-sensitive always @(a, b) block.',
  },
  {
    design: 'sub_64bit',
    port: 'result',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'result = A - B in always @(*); the design declares no clock.',
  },
  {
    design: 'sub_64bit',
    port: 'overflow',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'Sign compare of A, B and result in the same always @(*) block.',
  },

  // --- Control --------------------------------------------------------------------
  {
    design: 'JC_counter',
    port: 'Q',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'The Johnson counter state itself, flopped on posedge clk; no data input exists.',
  },
  {
    design: 'counter_12',
    port: 'out',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped on posedge clk; valid_count only gates the next value.',
  },
  {
    design: 'ring_counter',
    port: 'out',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign out = state off the rotate register; no data input reaches it.',
  },
  {
    design: 'up_down_counter',
    port: 'count',
    timing: 'registered',
    expected: 'agrees',
    rationale:
      'The counter flop; up_down selects the next value but reaches the port only through it.',
  },
  {
    design: 'fsm',
    port: 'MATCH',
    timing: 'combinational',
    expected: 'agrees',
    rationale:
      'Mealy: reads the data input IN directly as (ST_cr == s4 && IN == 1) in always @(*).',
  },
  {
    design: 'sequence_detector',
    port: 'sequence_detected',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign off curr_state only; data_in reaches it through the state flop.',
  },

  // --- Memory ---------------------------------------------------------------------
  {
    design: 'asyn_fifo',
    port: 'wfull',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign comparing wptr against the synchronised rptr_syn, both flops.',
  },
  {
    design: 'asyn_fifo',
    port: 'rempty',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign rempty = (rptr == wptr_syn), both pointer flops.',
  },
  {
    design: 'asyn_fifo',
    port: 'rdata',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Driven by dual_port_RAM.rdata, a reg loaded on posedge rclk.',
  },
  {
    design: 'LIFObuffer',
    port: 'EMPTY',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Written from SP inside always @(posedge Clk), so it holds across edges.',
  },
  {
    design: 'LIFObuffer',
    port: 'FULL',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Written from SP inside the same posedge Clk block.',
  },
  {
    design: 'LIFObuffer',
    port: 'dataOut',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Loaded from stack_mem inside the posedge Clk block; dataIn enters via the stack.',
  },
  {
    design: 'LFSR',
    port: 'out',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'The shift register itself, assigned in always @(posedge clk, posedge rst).',
  },
  {
    design: 'barrel_shifter',
    port: 'out',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'Three ranks of mux2X1 instances, each one assign off in and ctrl.',
  },
  {
    design: 'right_shifter',
    port: 'q',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Shift register on posedge clk; d lands in q[7] through the flop.',
  },

  // --- Miscellaneous --------------------------------------------------------------
  {
    design: 'freq_div',
    port: 'CLK_50',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Toggled in always @(posedge CLK_in or posedge RST); no data input exists.',
  },
  {
    design: 'freq_div',
    port: 'CLK_10',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Toggled off the cnt_10 flop in a posedge CLK_in block.',
  },
  {
    design: 'freq_div',
    port: 'CLK_1',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Toggled off the cnt_100 flop in a posedge CLK_in block.',
  },
  {
    design: 'freq_divbyeven',
    port: 'clk_div',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Toggled off cnt in a posedge clk block; clk and rst_n are the only inputs.',
  },
  {
    design: 'freq_divbyfrac',
    port: 'clk_div',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign clk_div = clk_adjust_r | clk_ave_r, both flops, no data input in the cone.',
  },
  {
    design: 'freq_divbyodd',
    port: 'clk_div',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign clk_div = clk_div1 | clk_div2, a posedge flop ORed with a negedge flop.',
  },
  {
    design: 'calendar',
    port: 'Hours',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped in always @(posedge CLK or posedge RST); no data input exists.',
  },
  {
    design: 'calendar',
    port: 'Mins',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped in its own posedge CLK block off the Secs rollover.',
  },
  {
    design: 'calendar',
    port: 'Secs',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped in its own posedge CLK block, counting to 59.',
  },
  {
    design: 'edge_detect',
    port: 'rise',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped on posedge clk from a and the delayed a0, so a reaches it through a flop.',
  },
  {
    design: 'edge_detect',
    port: 'down',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped in the same posedge clk block off (~a & a0).',
  },
  {
    design: 'parallel2serial',
    port: 'valid_out',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign valid_out = valid, a flop set on the cnt == 3 reload.',
  },
  {
    design: 'parallel2serial',
    port: 'dout',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign dout = data[3]; d enters the data shift register through the flop.',
  },
  {
    design: 'pulse_detect',
    port: 'data_out',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'always @(*) reads the data input as (pulse_level1 == s2 && data_in == 0).',
  },
  {
    design: 'serial2parallel',
    port: 'dout_parallel',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped from din_tmp on posedge clk when cnt reaches 8.',
  },
  {
    design: 'serial2parallel',
    port: 'dout_valid',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped in the same posedge clk block off the cnt == 8 compare.',
  },
  {
    design: 'traffic_light',
    port: 'clock',
    timing: 'registered',
    expected: 'agrees',
    rationale:
      'assign clock = cnt off the countdown register; pass_request reaches it only via cnt.',
  },
  {
    design: 'traffic_light',
    port: 'red',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped from p_red in always @(posedge clk or negedge rst_n).',
  },
  {
    design: 'traffic_light',
    port: 'yellow',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped from p_yellow in the same posedge clk output block.',
  },
  {
    design: 'traffic_light',
    port: 'green',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped from p_green in the same posedge clk output block.',
  },
  {
    design: 'width_8to16',
    port: 'valid_out',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped on posedge clk off valid_in and the flag flop.',
  },
  {
    design: 'width_8to16',
    port: 'data_out',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped as {data_lock, data_in} on posedge clk, so data_in crosses the flop.',
  },
  {
    design: 'RAM',
    port: 'read_data',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Loaded from RAM[read_addr] inside always @(posedge clk or negedge rst_n).',
  },
  {
    design: 'ROM',
    port: 'dout',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'always @(*) reads mem[addr] directly off the declared data input addr.',
  },
  {
    design: 'alu',
    port: 'r',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign r = res[31:0], res decoded in the level-sensitive always @(a or b or aluc).',
  },
  {
    design: 'alu',
    port: 'zero',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign zero = (res == 0), so it reaches a, b and aluc through the same decode.',
  },
  // `carry`, `negative` and `overflow` are declared and then never assigned anywhere in
  // the file, so no bit of them has a driver and the derivation is expected to refuse
  // them. Their `timing` records the only value the source could imply: the design
  // contains no sequential element at all, so nothing in it could settle on an edge.
  {
    design: 'alu',
    port: 'carry',
    timing: 'combinational',
    expected: 'refused',
    rationale: 'Declared but never assigned; undriven, and the design has no clock to settle on.',
  },
  {
    design: 'alu',
    port: 'negative',
    timing: 'combinational',
    expected: 'refused',
    rationale: 'Declared but never assigned; undriven, and the design has no clock to settle on.',
  },
  {
    design: 'alu',
    port: 'overflow',
    timing: 'combinational',
    expected: 'refused',
    rationale: 'Declared but never assigned; undriven, and the design has no clock to settle on.',
  },
  {
    design: 'alu',
    port: 'flag',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'assign reading aluc, a and b directly through the SLT/SLTU compare mux.',
  },
  // REVIEW: `clkgenerator` has no input ports at all and drives `clk` from a delay loop,
  // `always begin #(PERIOD/2) clk = ~clk; end`, which is simulation-only. The reading
  // below is the semantic one, but a synthesis frontend may drop the delay loop and
  // leave `clk` undriven, in which case the reviewed value becomes `refused`.
  {
    design: 'clkgenerator',
    port: 'clk',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Toggles off its own retained value with no data input anywhere in the module.',
  },
  {
    design: 'instr_reg',
    port: 'ins',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign ins = ins_p1[7:5]; data enters ins_p1 through the posedge clk flop.',
  },
  {
    design: 'instr_reg',
    port: 'ad1',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign ad1 = ins_p1[4:0], the same fetch flop.',
  },
  {
    design: 'instr_reg',
    port: 'ad2',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign ad2 = ins_p2, the second fetch flop.',
  },
  {
    design: 'pe',
    port: 'c',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign c = cc, the MAC accumulator flopped on posedge clk.',
  },
  {
    design: 'signal_generator',
    port: 'wave',
    timing: 'registered',
    expected: 'agrees',
    rationale:
      'Ramp register stepped in always @(posedge clk or negedge rst_n); no data input exists.',
  },
  {
    design: 'square_wave',
    port: 'wave_out',
    timing: 'registered',
    expected: 'agrees',
    rationale:
      'Toggled on posedge clk; freq only gates the count compare, never reaching it directly.',
  },
]);

/** The `design/port` key one entry is looked up by, built the same way on both sides. */
export function timingGroundTruthKey(design: string, port: string): string {
  return `${design}/${port}`;
}

/**
 * The manifest as a lookup, derived from `TIMING_GROUND_TRUTH` so an index can never
 * drift from the entry list.
 *
 * A function rather than a module-level constant: the manifest's independence rests on
 * it computing nothing at load time, and a `Map` rather than an object because a port
 * named `__proto__` would read through an object's prototype chain.
 */
export function timingGroundTruthIndex(): ReadonlyMap<string, TimingGroundTruthEntry> {
  return new Map(
    TIMING_GROUND_TRUTH.map((entry) => [timingGroundTruthKey(entry.design, entry.port), entry]),
  );
}

/** The designs the manifest covers, in first-appearance order and derived from it. */
export function timingGroundTruthDesigns(): readonly string[] {
  return [...new Set(TIMING_GROUND_TRUTH.map((entry) => entry.design))];
}
