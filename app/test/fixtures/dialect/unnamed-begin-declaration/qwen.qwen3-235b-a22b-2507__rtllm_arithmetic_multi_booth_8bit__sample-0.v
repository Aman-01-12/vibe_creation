module tb_multi_booth_8bit();
  // Declare signals
  reg clk;
  reg reset;
  reg [8:0] a;  // Extended to 9 bits to allow signed interpretation
  reg [8:0] b;  // Extended to 9 bits to allow signed interpretation
  wire [16:0] p;
  wire rdy;

  // Instantiate the design under test
  multi_booth_8bit dut (
    .p(p),
    .rdy(rdy),
    .a(a[8:0]),
    .b(b[8:0]),
    .clk(clk),
    .reset(reset)
  );

  // Clock generation
  always begin
    clk = 1'b0;
    #5;
    clk = 1'b1;
    #5;
  end

  // Test variables
  reg [16:0] expected_p;
  reg started;
  integer i;

  initial begin
    // Open VCD dump
    $dumpfile("dump.vcd");
    $dumpvars(0, tb_multi_booth_8bit);

    // Initialize inputs
    a = 9'sd0;
    b = 9'sd0;
    reset = 1'b1;
    started = 1'b0;

    // Hold reset for a few cycles
    #15;
    reset = 1'b0;

    // Wait for at least one clock to allow reset release
    #10;

    ////////////////////////////////////////////////////////
    // CHECK: known_answer_counter_increments
    // We model a simple counter that increments every cycle when not reset.
    // But we do NOT model the multiplier's internal state.
    // Instead, we observe rdy and use it to gate our expectations.
    // However, the spec does not mention a counter. This check seems misplaced.
    // But since it's required, we interpret it as checking that the multiplier
    // eventually produces a result (rdy pulses) and that multiple operations
    // can be issued.
    // We'll issue several multiplications and check that rdy becomes high
    // after a fixed number of cycles (latency implied by Radix-4 8-bit: 4 cycles).
    // We'll also check that we can pipeline operations after reset.

    // We'll use a nominal case: 1 * 1, then 2 * 2, etc., and expect rdy to go high
    // after 4 cycles each time.

    // We cannot assume internal pipelining, so we wait for rdy before next input.

    // Operation 1: 1 * 1
    a = 9'sd1;
    b = 9'sd1;
    expected_p = 17'sd1;
    started = 1'b1;
    #20; // Wait one cycle

    // After reset release, we expect rdy to be low initially
    if (rdy !== 1'b0) begin
      $display("CHECK known_answer_counter_increments FAIL: rdy should be 0 after reset");
    end else begin
      // Wait for rdy to go high (should be in 4 cycles)
      #40; // 4 cycles
      if (rdy !== 1'b1) begin
        $display("CHECK known_answer_counter_increments FAIL: rdy did not go high after 4 cycles");
      end else begin
        // Check product
        if (p !== expected_p) begin
          $display("CHECK known_answer_counter_increments FAIL: p = %d, expected %d", p, expected_p);
        end else begin
          $display("CHECK known_answer_counter_increments PASS");
        end
      end
    end

    // If we failed, we still need to emit the other check
    if (rdy !== 1'b1) begin
      // Try to recover timing for next check
      #40;
    end

    ////////////////////////////////////////////////////////
    // CHECK ac1_under_simulation_multi_booth_8bit_produc
    // We must test multiple cases: nominal, boundary, and error (if any)
    // The multiplier should compute p = a * b, signed, 8-bit inputs -> 16-bit output
    // Radix-4 Booth: 8 bits -> 4 iterations (each 2 bits)
    // Latency: 4 cycles (including the cycle inputs are latched?)
    // But spec does not specify latency. We assume 4 cycles after input is accepted.
    // However, the design may latch inputs on the first cycle after reset deassertion.
    // We assume that when reset is low, the next rising edge latches a and b.
    // Then 3 more cycles to complete, so rdy goes high on the 4th cycle.

    // We'll test the following cases:
    // 1. 0 * 0 = 0
    // 2. 1 * 1 = 1
    // 3. 2 * 3 = 6
    // 4. -1 * -1 = 1 (a=255, b=255 in 8-bit two's complement)
    // 5. -1 * 2 = -2 (a=255, b=2)
    // 6. 127 * 1 = 127 (max positive)
    // 7. 127 * 2 = 254
    // 8. -128 * 1 = -128 (min negative)
    // 9. -128 * -1 = 128 (but 128 is not representable in 8-bit signed, but in 16-bit it is)
    // 10. 255 * 255 = 65025, which is -1 * -1 = 1 in signed, but we are doing signed multiplication

    // We assume signed multiplication: inputs are 8-bit two's complement.
    // So we extend a and b to 9 bits for signed arithmetic in testbench.

    // We'll create an array of test cases
    reg [8:0] test_a [0:9];
    reg [8:0] test_b [0:9];
    reg [16:0] test_exp [0:9];

    // Initialize test cases
    test_a[0] = 9'sd0;   test_b[0] = 9'sd0;   test_exp[0] = 17'sd0;
    test_a[1] = 9'sd1;   test_b[1] = 9'sd1;   test_exp[1] = 17'sd1;
    test_a[2] = 9'sd2;   test_b[2] = 9'sd3;   test_exp[2] = 17'sd6;
    test_a[3] = 9'sd255; test_b[3] = 9'sd255; test_exp[3] = 17'sd1;  // -1 * -1 = 1
    test_a[4] = 9'sd255; test_b[4] = 9'sd2;   test_exp[4] = -2; // -1 * 2 = -2
    test_a[5] = 9'sd127; test_b[5] = 9'sd1;   test_exp[5] = 17'sd127;
    test_a[6] = 9'sd127; test_b[6] = 9'sd2;   test_exp[6] = 17'sd254;
    test_a[7] = 9'sd128; test_b[7] = 9'sd1;   test_exp[7] = -128; // -128 * 1
    test_a[8] = 9'sd128; test_b[8] = 9'sd255; test_exp[8] = 128; // -128 * -1 = 128
    test_a[9] = 9'sd255; test_b[9] = 9'sd255; test_exp[9] = 17'sd1;  // -1 * -1 = 1

    // We'll also test boundary values: min and max
    // But we already have 0, 1, 127, 128, 255

    // Reset the design
    reset = 1'b1;
    #20;
    reset = 1'b0;
    #10;

    // We'll run each test case
    for (i = 0; i < 10; i = i + 1) begin
      a = test_a[i];
      b = test_b[i];
      expected_p = test_exp[i];

      // Wait one cycle for inputs to be latched (on next posedge)
      #10;

      // Now wait for 3 more cycles (total 4 from reset or from start) for rdy
      #30;

      // Check rdy and output
      if (rdy !== 1'b1) begin
        $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: rdy not high after 4 cycles for case %d", i);
        break;
      end

      if (p !== expected_p) begin
        $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: case %d: p=%d, expected=%d", i, p, expected_p);
        break;
      end
    end

    // If we completed the loop, then pass
    if (i == 10) begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc PASS");
    end

    // Also, we must check that after reset, outputs are 0
    // But the spec doesn't specify reset state. However, typical.
    // We already did reset at start.

    // End simulation
    #100;
    $finish;
  end
endmodule