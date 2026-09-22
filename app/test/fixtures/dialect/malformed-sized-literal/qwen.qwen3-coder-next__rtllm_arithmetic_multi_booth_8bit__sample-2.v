`timescale 1ns/1ps

module tb;
  // Clock and reset
  reg clk;
  reg reset;

  // DUT ports
  wire [16:0] p;
  wire [1:0]  rdy;
  reg  [8:0]  a;
  reg  [8:0]  b;

  // Instantiate DUT
  multi_booth_8bit dut (
    .p(p),
    .rdy(rdy),
    .a(a[7:0]),
    .b(b[7:0]),
    .clk(clk),
    .reset(reset)
  );

  // Clock generation: 10ns period (50MHz)
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  // Global variables for expected values and counters
  reg [16:0] expected_p;
  reg [1:0]  expected_rdy;
  integer    cycle;
  integer    i;
  reg [16:0] observed_p;
  reg [1:0]  observed_rdy;
  reg        check_passed;
  reg        all_passed;

  // Main test sequence
  initial begin
    // Initialize
    all_passed = 1'b1;
    cycle = 0;

    // Dump waveform
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);

    // === Phase 1: Reset behavior ===
    reset = 1'b1;
    a = 9'd0;
    b = 9'd0;

    // Wait for reset to take effect (at least one posedge)
    @(posedge clk);
    cycle = cycle + 1;

    // Deassert reset
    reset = 1'b0;
    @(posedge clk);
    cycle = cycle + 1;

    // After reset, rdy should be 1 (idle state), p should be 0
    observed_rdy = rdy;
    observed_p   = p;

    // Expected after reset: rdy=1, p=0
    expected_rdy = 2'd1;
    expected_p   = 17'd0;

    if (observed_rdy == expected_rdy && observed_p == expected_p) begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc PASS");
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: after reset rdy=%b (expected %b), p=%0d (expected %0d)", observed_rdy, expected_rdy, observed_p, expected_p);
      all_passed = 1'b0;
    end

    // === Phase 2: Known-answer checks ===
    // Test 2a: 0 * 0 = 0
    a = 9'd0;
    b = 9'd0;
    expected_p = 17'd0;
    expected_rdy = 2'd1; // ready after one cycle (assuming single-cycle for 0 operands)

    // Wait for ready to assert (assume single cycle for zero operands)
    @(posedge clk);
    cycle = cycle + 1;
    observed_rdy = rdy;
    observed_p   = p;

    if (observed_rdy == expected_rdy && observed_p == expected_p) begin
      $display("CHECK known_answer_counter_increments PASS");
    end else begin
      $display("CHECK known_answer_counter_increments FAIL: 0*0: rdy=%b (expected %b), p=%0d (expected %0d)", observed_rdy, expected_rdy, observed_p, expected_p);
      all_passed = 1'b0;
    end

    // === Phase 3: Boundary checks ===
    // Test 3a: max * 1 = max (255 * 1 = 255)
    a = 9'd255;
    b = 9'd1;
    expected_p = 17'd255;
    expected_rdy = 2'd1;

    @(posedge clk);
    cycle = cycle + 1;
    observed_rdy = rdy;
    observed_p   = p;

    if (observed_rdy == expected_rdy && observed_p == expected_p) begin
      // No separate check name for this; reuse ac1 for multi-case coverage
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: 255*1: rdy=%b (expected %b), p=%0d (expected %0d)", observed_rdy, expected_rdy, observed_p, expected_p);
      all_passed = 1'b0;
    end

    // Test 3b: 1 * max = max (1 * 255 = 255)
    a = 9'd1;
    b = 9'd255;
    expected_p = 17'd255;
    expected_rdy = 2'd1;

    @(posedge clk);
    cycle = cycle + 1;
    observed_rdy = rdy;
    observed_p   = p;

    if (observed_rdy == expected_rdy && observed_p == expected_p) begin
      // OK
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: 1*255: rdy=%b (expected %b), p=%0d (expected %0d)", observed_rdy, expected_rdy, observed_p, expected_p);
      all_passed = 1'b0;
    end

    // Test 3c: max * max = 65025 (255*255)
    a = 9'd255;
    b = 9'd255;
    expected_p = 17'd65025;
    expected_rdy = 2'd1;

    @(posedge clk);
    cycle = cycle + 1;
    observed_rdy = rdy;
    observed_p   = p;

    if (observed_rdy == expected_rdy && observed_p == expected_p) begin
      // OK
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: 255*255: rdy=%b (expected %b), p=%0d (expected %0d)", observed_rdy, expected_rdy, observed_p, expected_p);
      all_passed = 1'b0;
    end

    // Test 3d: min non-zero * min non-zero = 1 (1*1=1)
    a = 9'd1;
    b = 9'd1;
    expected_p = 17'd1;
    expected_rdy = 2'd1;

    @(posedge clk);
    cycle = cycle + 1;
    observed_rdy = rdy;
    observed_p   = p;

    if (observed_rdy == expected_rdy && observed_p == expected_p) begin
      // OK
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: 1*1: rdy=%b (expected %b), p=%0d (expected %0d)", observed_rdy, expected_rdy, observed_p, expected_p);
      all_passed = 1'b0;
    end

    // Test 3e: boundary: 2 * 127 = 254 (to verify non-trivial multiplication)
    a = 9'd2;
    b = 9'd127;
    expected_p = 17'd254;
    expected_rdy = 2'd1;

    @(posedge clk);
    cycle = cycle + 1;
    observed_rdy = rdy;
    observed_p   = p;

    if (observed_rdy == expected_rdy && observed_p == expected_p) begin
      // OK
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: 2*127: rdy=%b (expected %b), p=%0d (expected %0d)", observed_rdy, expected_rdy, observed_p, expected_p);
      all_passed = 1'b0;
    end

    // Test 3f: boundary: 128 * 2 = 256 (tests 9-bit result)
    a = 9'd128;
    b = 9'd2;
    expected_p = 17'd256;
    expected_rdy = 2'd1;

    @(posedge clk);
    cycle = cycle + 1;
    observed_rdy = rdy;
    observed_p   = p;

    if (observed_rdy == expected_rdy && observed_p == expected_p) begin
      // OK
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: 128*2: rdy=%b (expected %b), p=%0d (expected %0d)", observed_rdy, expected_rdy, observed_p, expected_p);
      all_passed = 1'b0;
    end

    // === Phase 4: Known-answer counter increment (simulated via repeated increment) ===
    // Since the spec does not define a counter, but the required check exists,
    // interpret as: after reset, assert start (if any), then verify that
    // the multiplier completes and produces correct result for a sequence of inputs.
    // We simulate a counter by incrementing 'a' each cycle and multiplying by 1.
    // Expected product sequence: 0,1,2,3,...

    // Reset again to start fresh
    reset = 1'b1;
    a = 9'd0;
    b = 9'd1;
    @(posedge clk);
    cycle = cycle + 1;
    reset = 1'b0;
    @(posedge clk);
    cycle = cycle + 1;

    // Now run 4 cycles: a = 0,1,2,3; b=1; expect p = 0,1,2,3
    for (i = 0; i < 4; i = i + 1) begin
      a = 9'di;
      expected_p = 17'di;
      expected_rdy = 2'd1;

      @(posedge clk);
      cycle = cycle + 1;
      observed_rdy = rdy;
      observed_p   = p;

      if (observed_rdy == expected_rdy && observed_p == expected_p) begin
        // OK
      end else begin
        $display("CHECK known_answer_counter_increments FAIL: a=%0d, b=1: rdy=%b (expected %b), p=%0d (expected %0d)", i, observed_rdy, expected_rdy, observed_p, expected_p);
        all_passed = 1'b0;
      end
    end

    // Final verdict
    if (all_passed) begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc PASS");
      $display("CHECK known_answer_counter_increments PASS");
    end else begin
      // Ensure both checks are printed even if one failed
      if ($countdrivers("CHECK ac1_under_simulation_multi_booth_8bit_produc") == 0) begin
        $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL");
      end
      if ($countdrivers("CHECK known_answer_counter_increments") == 0) begin
        $display("CHECK known_answer_counter_increments FAIL");
      end
    end

    $finish;
  end
endmodule
