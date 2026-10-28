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
function automatic [13:0] ece_stimulus(input [31:0] step);
  reg [13:0] v;
  begin
    v[13:0] = ece_mix(32'd0, step);
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
  reg [13:0] ece_in_bits;
  reg [9:0] ece_exp_bits;
  reg [9:0] ece_exp_reg_bits;
  wire wclk;
  wire rclk;
  wire wrstn;
  wire rrstn;
  wire winc;
  wire rinc;
  wire [7:0] wdata;
  wire wfull;
  wire rempty;
  wire [7:0] rdata;
  assign wclk = ece_in_bits[0:0];
  assign rclk = ece_in_bits[1:1];
  assign wrstn = ece_in_bits[2:2];
  assign rrstn = ece_in_bits[3:3];
  assign winc = ece_in_bits[4:4];
  assign rinc = ece_in_bits[5:5];
  assign wdata = ece_in_bits[13:6];
  asyn_fifo ece_candidate (.wclk(wclk), .rclk(rclk), .wrstn(wrstn), .rrstn(rrstn), .winc(winc), .rinc(rinc), .wdata(wdata), .wfull(wfull), .rempty(rempty), .rdata(rdata));
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
      ece_exp_reg_bits = ece_expect(ece_state, {14{1'b0}});
      if (ece_exp_reg_bits[0:0] === wfull)
        $display("CHECK %0s PASS", "legacygold_wfull");
      else
        $display("CHECK %0s FAIL: expected %0h, got %0h", "legacygold_wfull", ece_exp_reg_bits[0:0], wfull);
      if (ece_exp_reg_bits[1:1] === rempty)
        $display("CHECK %0s PASS", "legacygold_rempty");
      else
        $display("CHECK %0s FAIL: expected %0h, got %0h", "legacygold_rempty", ece_exp_reg_bits[1:1], rempty);
      if (ece_exp_reg_bits[9:2] === rdata)
        $display("CHECK %0s PASS", "legacygold_rdata");
      else
        $display("CHECK %0s FAIL: expected %0h, got %0h", "legacygold_rdata", ece_exp_reg_bits[9:2], rdata);
      $display("ECE_SAMPLE legacygold %0d %0h %0h %0h", step, wfull, rempty, rdata);
      ece_state = ece_next_state(ece_state, ece_in_bits);
    end
    $display("ECE_SAMPLE_END legacygold %0d", ECE_SAMPLE_BUDGET);
    $finish;
  end
endmodule
