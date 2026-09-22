`timescale 1ns/1ps

module tb;
  // Clock and reset signals
  reg clk;
  reg rst_n;

  // DUT interface
  wire [64:0] Q;

  // Instantiate the device under test
  JC_counter #(
    .WIDTH(64)
  ) dut (
    .Q(Q),
    .clk(clk),
    .rst_n(rst_n)
  );

  // Clock generation: 10ns period (5ns high, 5ns low)
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  // Stimulus and verification
  initial begin
    integer i;
    reg [64:0] expected_state;
    reg [64:0] observed_state;
    integer check_passed;

    // Initialize
    rst_n = 0;
    #10;

    // Assert reset for several cycles to ensure clean reset
    for (i = 0; i < 5; i = i + 1) begin
      @(posedge clk);
    end

    // Deassert reset
    rst_n = 1;
    @(posedge clk);

    // Expected Johnson counter sequence for 64-bit:
    // The pattern is: start with all zeros, then shift in 1s from the left,
    // then shift in 0s from the left (complement of the complemented bit fed back).
    // For a Johnson counter, the feedback is the complement of the MSB.
    // Sequence for 4-bit: 0000, 1000, 1100, 1110, 1111, 0111, 0011, 0001, 0000
    // So for 64-bit:
    //   Phase 1: 000...0 (64 zeros) -> 65 zeros? No: Q is [64:0] => 65 bits.
    // Wait! Interface says: output Q: [64] => 65 bits (indices 64 down to 0).
    // But the spec says "64-bit Johnson counter".
    // The 4-bit example has 4 bits: 0000, 1000, ..., 0001, 0000.
    // So the counter should be 64 bits, but the interface declares Q as [64] (65 bits).
    // This is ambiguous, but the spec says "64-bit Johnson counter".
    // The example: 4-bit counter has 4-bit state (0000, etc.), so likely Q should be [63:0] for 64 bits.
    // However, the interface explicitly says: `output [64] Q`.
    // In Verilog, `[64]` means 65 bits (indices 64 down to 0).
    // But the spec says "64-bit Johnson counter".
    // This is a conflict.
    // Let's re-read the spec: "Implement a 64-bit Johnson counter (torsional ring counter), and the state of the similar 4-bit Johnson counter example is as follows: 0000, 1000, 1100, 1110, 1111, 0111, 0011, 0001, 0000."
    // The 4-bit example has 4 bits, so the counter is 4 bits.
    // Therefore, the interface `Q: output [64]` is likely a typo and should be `[63:0]` for 64 bits.
    // But the problem says: "You are given ONLY the approved Spec, the intent, and OKF hints."
    // The spec says "64-bit Johnson counter" and gives a 4-bit example with 4 bits.
    // The interface says `[64]`, which is 65 bits.
    // Since the testbench must be derived from the spec, and the spec says 64-bit, we assume the counter is 64 bits.
    // However, the interface declares 65 bits. This is a discrepancy.
    // But the problem says: "do NOT assume one" (no RTL), and "compute every expected value independently from the Spec".
    // The spec says 64-bit, so we will treat the counter as 64 bits, and assume the interface is `[63:0]`.
    // But wait: the interface is given as `output [64] Q`. In Verilog, `[64]` is equivalent to `[64:0]` (65 bits).
    // This is a problem.
    // Let's look at the 4-bit example: 0000 (4 bits), so the counter width is 4.
    // Therefore, for 64-bit, the state should be 64 bits.
    // Since the interface declares `[64]`, which is 65 bits, and the spec says 64-bit, we must assume the interface is wrong or mis-specified.
    // However, the problem says: "You are given ONLY the approved Spec, the intent, and OKF hints."
    // The spec says "64-bit Johnson counter", so we will use 64 bits for the expected sequence.
    // But the DUT has 65-bit Q. How to resolve?
    // The OKF hints mention: "Synchronous counter (up, with reset and enable)" and "two-block Moore FSM".
    // The Johnson counter is a FSM with 2N states for N bits.
    // For 4 bits: 8 states (0000, 1000, ..., 0001, then back to 0000).
    // So for 64 bits: 128 states.
    // The state width is 64 bits.
    // Therefore, the interface `Q: [64]` is likely a typo and should be `[63:0]`.
    // Since the problem says the spec is authoritative, and the spec says 64-bit, we will assume the DUT is implemented with 64 bits, and the interface declaration `[64]` is a mistake.
    // But the testbench must instantiate the module as given, with `Q: [64]`.
    // So Q is 65 bits, but the Johnson counter is 64 bits. How?
    // One possibility: the MSB (bit 64) is unused, and bits [63:0] are the counter.
    // Another: the counter is 65 bits, but the spec says 64-bit by mistake.
    // Given the 4-bit example has 4 bits, and the spec says 64-bit, we assume the counter is 64 bits, and bit 64 is tied to 0 or is unused.
    // However, the problem says: "do NOT assume one" (no RTL), and "compute every expected value independently from the Spec".
    // The spec says 64-bit, so the expected state is 64 bits.
    // But the DUT has 65 bits. We must derive the expected value for 65 bits.
    // Since the spec says 64-bit, and the 4-bit example has 4 bits, we assume the counter is in bits [63:0], and bit 64 is 0.
    // This is consistent with the 4-bit example: if the interface were [3:0], it would be 4 bits.
    // Here, [64] is 65 bits, so likely bit 64 is unused (0), and [63:0] is the counter.
    // We will assume that.
    // So expected_state[63:0] follows the Johnson counter sequence, and expected_state[64] = 0.

    // Let's generate the expected sequence for 64-bit Johnson counter:
    // Phase 1: 000...0 (64 zeros) -> 000...00 (65 bits: bit64=0, bits63:0=0)
    // Then: shift in 1s from the left: 100...0, 110...0, ..., 111...1 (64 ones)
    // Then: shift in 0s from the left: 011...1, 001...1, ..., 000...1, then back to 000...0
    // Total states: 128 (2*64)

    // For the test, we will check the first few states and the wrap-around.
    // Since 128 states is too many to hardcode, we will compute expected_state on the fly.

    // Reset state: all zeros
    expected_state = 65'b0;  // 65 bits: bit64=0, bits63:0=0
    observed_state = Q;
    if (observed_state == expected_state) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS");
    end else begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: expected %b, got %b", expected_state, observed_state);
    end

    // Now run through the sequence for 128 cycles (2*64) and check each state.
    // But we can't hardcode 128 states, so we compute expected_state for each cycle.
    // We'll do a loop for 128 cycles and check.
    // However, the spec says "CHECK ac1_under_simulation_jc_counter_produces_the" is one check.
    // We must print exactly one PASS/FAIL for this check.
    // So we'll run the sequence and set a flag.

    check_passed = 1;
    expected_state = 65'b0;  // initial state after reset

    // We'll check the first 10 states to cover the pattern, and the wrap-around.
    // But to be thorough, we check all 128 states.
    // Since 128 is manageable, we do a loop.

    for (i = 0; i < 128; i = i + 1) begin
      // Sample at posedge clk (after the reset deassertion, we are at cycle 0)
      // We are at the start of the loop, so we sample the current state (which is expected_state for cycle i)
      observed_state = Q;
      if (observed_state != expected_state) begin
        check_passed = 0;
        $display("State mismatch at cycle %0d: expected %b, got %b", i, expected_state, observed_state);
      end

      // Compute next expected state for Johnson counter
      // Johnson counter: shift left, feed back ~MSB (complement of MSB)
      // But note: the 4-bit example: 0000 -> 1000 (MSB becomes 1, fed back is ~0=1)
      // 1000 -> 1100 (MSB stays 1, fed back ~1=0? No, wait: 1000 -> 1100 means the new MSB is 1, and the rest shift left.
      // How is it implemented?
      // Standard Johnson counter: shift register with feedback = complement of the last bit.
      // For 4-bit: Q[3], Q[2], Q[1], Q[0]
      // Next state: Q[3] = ~Q[0], Q[2] = Q[3], Q[1] = Q[2], Q[0] = Q[1]
      // Let's verify:
      // Start: 0000
      // Next: Q[3] = ~0 = 1, Q[2]=0, Q[1]=0, Q[0]=0 -> 1000
      // Next: Q[3]=~0=1, Q[2]=1, Q[1]=0, Q[0]=0 -> 1100
      // Next: Q[3]=~0=1, Q[2]=1, Q[1]=1, Q[0]=0 -> 1110
      // Next: Q[3]=~0=1, Q[2]=1, Q[1]=1, Q[0]=1 -> 1111
      // Next: Q[3]=~1=0, Q[2]=1, Q[1]=1, Q[0]=1 -> 0111
      // Next: Q[3]=~1=0, Q[2]=0, Q[1]=1, Q[0]=1 -> 0011
      // Next: Q[3]=~1=0, Q[2]=0, Q[1]=0, Q[0]=1 -> 0001
      // Next: Q[3]=~1=0, Q[2]=0, Q[1]=0, Q[0]=0 -> 0000
      // Yes! So feedback is ~Q[0] (complement of LSB), and shift right? No, shift left in the sense that MSB gets new value, and bits shift left (Q[3] new, Q[2]=old Q[3], etc.)
      // In Verilog, for a register Q[3:0], next state:
      // Q[3] <= ~Q[0];
      // Q[2] <= Q[3];
      // Q[1] <= Q[2];
      // Q[0] <= Q[1];
      // But this is a shift register with feedback to MSB.
      // For 64-bit, we have Q[63:0].
      // Next state: Q[63] <= ~Q[0]; Q[62] <= Q[63]; ... Q[0] <= Q[1];
      // But our DUT has Q[64:0] (65 bits). We assume bits [63:0] are the counter, and bit 64 is 0.
      // So for expected_state, we compute for bits [63:0], and set bit 64=0.

      // Compute next expected_state for bits [63:0]
      reg [63:0] next_64;
      next_64 = {expected_state[63:1], ~expected_state[0]};
      expected_state = {1'b0, next_64};  // bit 64 = 0
    end

    if (check_passed) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS");
    end else begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL");
    end

    // Now for CHECK known_answer_counter_increments
    // The Johnson counter is not a simple increment counter, but the spec says:
    // "the count follows the reference increment sequence and wraps at its modulus"
    // This is a bit misleading, but the Johnson counter has a fixed sequence of 2N states.
    // We'll interpret this as: the counter cycles through its states and wraps after 2N states.
    // We already checked the sequence and wrap-around in the previous check.
    // But to be explicit, we'll check the modulus: after 128 cycles, it should return to 0.
    // We did that implicitly in the loop (i=127 is the last state, then next would be i=0).
    // However, the problem requires a separate check named "known_answer_counter_increments".
    // Let's do a simpler check: reset to 0, then after 1 cycle, it should be 100...0 (for 64 bits).
    // But we already did that.
    // Alternatively, we can check that the counter increments (in the Johnson sense) correctly.
    // Since the spec says "the count follows the reference increment sequence", and the reference is the Johnson sequence, we've covered it.
    // But to satisfy the requirement, we'll do a separate check for the modulus wrap.

    // Re-run reset and check the first few states explicitly.
    rst_n = 0;
    #10;
    for (i = 0; i < 3; i = i + 1) begin
      @(posedge clk);
    end
    rst_n = 1;
    @(posedge clk);

    // Check state 0: 000...0
    observed_state = Q;
    expected_state = 65'b0;
    if (observed_state == expected_state) begin
      // Check state 1: 100...0
      @(posedge clk);
      observed_state = Q;
      expected_state = {1'b0, 64'b1000000000000000000000000000000000000000000000000000000000000000};
      if (observed_state == expected_state) begin
        // Check state 2: 110...0
        @(posedge clk);
        observed_state = Q;
        expected_state = {1'b0, 64'b1100000000000000000000000000000000000000000000000000000000000000};
        if (observed_state == expected_state) begin
          // Check state 64: 111...1 (64 ones)
          // We'll skip to cycle 63 (0-indexed, so 64th state is index 63)
          for (i = 0; i < 60; i = i + 1) begin
            @(posedge clk);
          end
          observed_state = Q;
          expected_state = {1'b0, 64'hFFFFFFFFFFFFFFFF};  // 64 ones
          if (observed_state == expected_state) begin
            // Check state 65: 011...1
            @(posedge clk);
            observed_state = Q;
            expected_state = {1'b0, 64'h7FFFFFFFFFFFFFFF};  // 0 followed by 63 ones
            if (observed_state == expected_state) begin
              // Check wrap-around: after 128 states, back to 0
              for (i = 0; i < 62; i = i + 1) begin
                @(posedge clk);
              end
              observed_state = Q;
              expected_state = 65'b0;
              if (observed_state == expected_state) begin
                $display("CHECK known_answer_counter_increments PASS");
              end else begin
                $display("CHECK known_answer_counter_increments FAIL: expected %b after wrap, got %b", expected_state, observed_state);
              end
            end else begin
              $display("CHECK known_answer_counter_increments FAIL: expected %b at state 65, got %b", expected_state, observed_state);
            end
          end else begin
            $display("CHECK known_answer_counter_increments FAIL: expected %b at state 64, got %b", expected_state, observed_state);
          end
        end else begin
          $display("CHECK known_answer_counter_increments FAIL: expected %b at state 2, got %b", expected_state, observed_state);
        end
      end else begin
        $display("CHECK known_answer_counter_increments FAIL: expected %b at state 1, got %b", expected_state, observed_state);
      end
    end else begin
      $display("CHECK known_answer_counter_increments FAIL: expected %b at state 0, got %b", expected_state, observed_state);
    end

    // VCD dump
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);

    $finish;
  end
endmodule
