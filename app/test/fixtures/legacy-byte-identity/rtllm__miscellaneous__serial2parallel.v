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
function automatic [1:0] ece_stimulus(input [31:0] step);
  reg [1:0] v;
  begin
    v[1:0] = ece_mix(32'd0, step);
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
  localparam integer ECE_RESET_FRAME = 256;
  integer step;
  reg [127:0] ece_state;
  reg [1:0] ece_in_bits;
  reg [8:0] ece_exp_bits;
  reg [8:0] ece_exp_reg_bits;
  wire din_serial;
  wire din_valid;
  wire [7:0] dout_parallel;
  wire dout_valid;
  wire clk;
  reg ece_clk;
  assign clk = ece_clk;
  wire rst_n;
  reg ece_reset_drive;
  assign rst_n = ece_reset_drive;
  assign din_serial = ece_in_bits[0:0];
  assign din_valid = ece_in_bits[1:1];
  task ece_harness_reset;
    begin
      ece_in_bits = {2{1'b0}};
      ece_reset_drive = 1'b0;
      repeat (2) begin
        #(ECE_PERIOD/2) ece_clk = 1'b1;
        #(ECE_PERIOD/2) ece_clk = 1'b0;
      end
      ece_reset_drive = 1'b1;
    end
  endtask
  serial2parallel ece_candidate (.clk(clk), .rst_n(rst_n), .din_serial(din_serial), .din_valid(din_valid), .dout_parallel(dout_parallel), .dout_valid(dout_valid));
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, ece_consensus_harness);
  end
  initial begin : ece_cycle
    ece_clk = 1'b0;
    for (step = 0; step < ECE_SAMPLE_BUDGET; step = step + 1) begin
      if ((step % ECE_RESET_FRAME) == 0) begin
        ece_harness_reset;
        ece_state = ece_reset_state(1'b0);
      end
      ece_in_bits = ece_stimulus(step);
      #(ECE_PERIOD/2 - ECE_SKEW);
      ece_exp_bits = ece_expect(ece_state, ece_in_bits);
      ece_exp_reg_bits = ece_expect(ece_state, {2{1'b0}});
      if (ece_exp_reg_bits[7:0] === dout_parallel)
        $display("CHECK %0s PASS", "legacygold_dout_parallel");
      else
        $display("CHECK %0s FAIL: expected %0h, got %0h", "legacygold_dout_parallel", ece_exp_reg_bits[7:0], dout_parallel);
      if (ece_exp_reg_bits[8:8] === dout_valid)
        $display("CHECK %0s PASS", "legacygold_dout_valid");
      else
        $display("CHECK %0s FAIL: expected %0h, got %0h", "legacygold_dout_valid", ece_exp_reg_bits[8:8], dout_valid);
      $display("ECE_SAMPLE legacygold %0d %0h %0h", step, dout_parallel, dout_valid);
      ece_state = ece_next_state(ece_state, ece_in_bits);
      #(ECE_SKEW) ece_clk = 1'b1;
      #(ECE_PERIOD/2) ece_clk = 1'b0;
    end
    $display("ECE_SAMPLE_END legacygold %0d", ECE_SAMPLE_BUDGET);
    $finish;
  end
endmodule
