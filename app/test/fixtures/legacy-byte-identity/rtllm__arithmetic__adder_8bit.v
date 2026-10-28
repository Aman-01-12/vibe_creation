`timescale 1ns/1ps
// Stimulus_Mixer: the splitmix64 finalizer (Req 2.12, 2.13). `lane` keys the 64-bit slice
// of a bundle wider than 64 bits; lane 0 is the expression the probe measured.
function automatic [63:0] ece_mix(input [31:0] lane, input [31:0] step);
  reg [63:0] h;
  begin
    h = {lane, step} + 64'h9E3779B97F4A7C15;
    h = h ^ (h >> 30);
    h = h * 64'hBF58476D1CE4E5B9;
    h = h ^ (h >> 27);
    h = h * 64'h94D049BB133111EB;
    h = h ^ (h >> 31);
    ece_mix = h;
  end
endfunction
// Stimulus_Function: a pure function of step, rendered from the Declared_Interface and the
// Role_Declaration alone (Req 2.1, 2.2, 2.4). Every bit is a Stimulus_Mixer bit unless an
// enable-role port owns it.
function automatic [16:0] ece_stimulus(input [31:0] step);
  reg [16:0] v;
  begin
    v[16:0] = ece_mix(32'd0, step);
    ece_stimulus = v;
  end
endfunction
// Product-written Consensus_Harness: the top module, instantiating the Candidate_Design,
// owning the clock, the Drive_Point, and the Sample_Point, and calling the Reference_Model
// as four functions: ece_stimulus rendered above by this harness, the other three as
// headers the model's bodies implement (C7).
module ece_consensus_harness;
  localparam [63:0] ECE_WATCHDOG_BUDGET_NS = 64'd2000000;
  localparam integer ECE_SAMPLE_BUDGET = 2048;
  localparam integer ECE_PERIOD = 10;
  localparam integer ECE_SKEW = 1;
  integer step;
  reg [127:0] ece_state;
  reg [16:0] ece_in_bits;
  reg [8:0] ece_exp_bits;
  reg [8:0] ece_exp_reg_bits;
  wire [7:0] a;
  wire [7:0] b;
  wire cin;
  wire [7:0] sum;
  wire cout;
  assign a = ece_in_bits[7:0];
  assign b = ece_in_bits[15:8];
  assign cin = ece_in_bits[16:16];
  adder_8bit ece_candidate (.a(a), .b(b), .cin(cin), .sum(sum), .cout(cout));
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, ece_consensus_harness);
  end
  initial begin : ece_cycle
    for (step = 0; step < ECE_SAMPLE_BUDGET; step = step + 1) begin
      if (step == 0) begin
        ece_state = ece_reset_state(1'b0);
      end
      ece_in_bits = ece_stimulus(step);
      #(ECE_SKEW);
      ece_exp_bits = ece_expect(ece_state, ece_in_bits);
      ece_exp_reg_bits = ece_expect(ece_state, {17{1'b0}});
      if (ece_exp_reg_bits[7:0] === sum)
        $display("CHECK %0s PASS", "legacygold_sum");
      else
        $display("CHECK %0s FAIL: expected %0h, got %0h", "legacygold_sum", ece_exp_reg_bits[7:0], sum);
      if (ece_exp_reg_bits[8:8] === cout)
        $display("CHECK %0s PASS", "legacygold_cout");
      else
        $display("CHECK %0s FAIL: expected %0h, got %0h", "legacygold_cout", ece_exp_reg_bits[8:8], cout);
      $display("ECE_SAMPLE legacygold %0d %0h %0h", step, sum, cout);
      ece_state = ece_next_state(ece_state, ece_in_bits);
    end
    $display("ECE_SAMPLE_END legacygold %0d", ECE_SAMPLE_BUDGET);
    $finish;
  end
endmodule
