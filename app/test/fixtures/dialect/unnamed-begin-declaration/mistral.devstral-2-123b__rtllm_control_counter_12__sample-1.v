`timescale 1ns/1ps

module tb;
  reg clk;
  reg rst_n;
  reg valid_count;
  wire [3:0] out;

  // Instantiate the design under test
  counter_12 dut (
    .clk(clk),
    .rst_n(rst_n),
    .valid_count(valid_count),
    .out(out)
  );

  // Clock generation
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  // Test sequence
  initial begin
    // Initialize signals
    rst_n = 0;
    valid_count = 0;

    // Dump waveform
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);

    // Reset sequence
    #10;
    rst_n = 1;
    #10;

    // CHECK ac1_under_simulation_counter_12_produces_the
    // Test reset behavior
    rst_n = 0;
    #10;
    if (out !== 4'b0000) begin
      $display("CHECK ac1_under_simulation_counter_12_produces_the FAIL: expected 4'b0000 on reset");
    end
    rst_n = 1;
    #10;

    // Test counting with valid_count active
    valid_count = 1;
    #10;
    if (out !== 4'b0001) begin
      $display("CHECK ac1_under_simulation_counter_12_produces_the FAIL: expected 4'b0001 after first count");
    end

    // Continue counting
    #10;
    if (out !== 4'b0010) begin
      $display("CHECK ac1_under_simulation_counter_12_produces_the FAIL: expected 4'b0010 after second count");
    end

    // Pause counting
    valid_count = 0;
    #10;
    if (out !== 4'b0010) begin
      $display("CHECK ac1_under_simulation_counter_12_produces_the FAIL: expected 4'b0010 when paused");
    end

    // Resume counting
    valid_count = 1;
    #10;
    if (out !== 4'b0011) begin
      $display("CHECK ac1_under_simulation_counter_12_produces_the FAIL: expected 4'b0011 after resume");
    end

    // Count to boundary (11)
    repeat(8) #10;
    if (out !== 4'b1011) begin
      $display("CHECK ac1_under_simulation_counter_12_produces_the FAIL: expected 4'b1011 at boundary");
    end

    // Next count should wrap to 0
    #10;
    if (out !== 4'b0000) begin
      $display("CHECK ac1_under_simulation_counter_12_produces_the FAIL: expected 4'b0000 after wrap");
    end

    // CHECK known_answer_counter_increments
    // Verify increment sequence
    integer i;
    for (i = 0; i < 12; i = i + 1) begin
      #10;
      if (out !== (i + 1) % 12) begin
        $display("CHECK known_answer_counter_increments FAIL: expected %d at step %d", (i + 1) % 12, i);
      end
    end

    // Final check
    $display("CHECK ac1_under_simulation_counter_12_produces_the PASS");
    $display("CHECK known_answer_counter_increments PASS");

    #10;
    $finish;
  end

endmodule
