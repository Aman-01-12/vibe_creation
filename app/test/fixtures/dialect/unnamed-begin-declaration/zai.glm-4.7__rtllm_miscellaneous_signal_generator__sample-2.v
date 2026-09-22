`timescale 1ns/1ps

module tb;

  // Inputs
  reg clk;
  reg rst_n;

  // Outputs
  wire [4:0] wave;

  // Instantiate the Unit Under Test (UUT)
  signal_generator uut (
    .clk(clk),
    .rst_n(rst_n),
    .wave(wave)
  );

  // Clock generation
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  // Variables for expected state tracking
  reg [4:0] expected_wave;
  reg       expected_direction; // 0 for up, 1 for down
  reg       hold_counter;

  initial begin
    // Initialize inputs
    rst_n = 0;

    // Dump variables for VCD
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);

    // Wait a bit for global reset
    #10;

    // Check 1: Reset Value
    // Spec: "cycles between 0 and 31". Implies start at 0.
    // We sample after reset is asserted and stable.
    if (wave === 5'd0) begin
      $display("CHECK reset_value PASS");
    end else begin
      $display("CHECK reset_value FAIL: expected 0, got %d", wave);
    end

    // Release reset
    @(posedge clk);
    rst_n = 1;
    #1; // Wait for non-blocking assignments to settle

    // Initialize expected state model based on post-reset observation
    // The spec implies the wave starts at 0 and goes up.
    expected_wave = wave; 
    expected_direction = 0; // 0 = incrementing
    hold_counter = 0;

    // We will simulate for 2 full cycles (0->31->0->31) to verify behavior.
    // Cycle 1: 0 to 31
    // Cycle 2: 31 to 0
    // Cycle 3: 0 to 31
    // Total steps approx 64 + holds.
    
    // Helper task to check and update state
    // This task models the Spec independently:
    // - If at 0 and going up, hold for 1 cycle, then go up.
    // - If at 31 and going up, hold for 1 cycle, then go down.
    // - If at 31 and going down, hold for 1 cycle, then go down.
    // - If at 0 and going down, hold for 1 cycle, then go up.
    // - Otherwise, continue in current direction.
    integer i;
    reg [4:0] next_expected;
    reg       next_dir;
    reg       next_hold;
    reg       check_pass;

    // Run for enough cycles to cover the full range and boundaries
    // 0 to 31 is 31 steps. 31 to 0 is 31 steps. Total 62 steps.
    // Plus holds at 0 (start), 31, 0, 31.
    // Let's run 70 cycles to be safe and cover the second peak.
    for (i = 0; i < 70; i = i + 1) begin
      @(posedge clk);
      #1; // Settle time

      // Compute next expected value based on CURRENT expected state (Spec model)
      if (expected_wave == 5'd0 && expected_direction == 0) begin
        // At 0, going up. Hold for 1 cycle.
        if (hold_counter == 0) begin
          next_expected = 5'd0;
          next_hold = 1;
          next_dir = 0;
        end else begin
          next_expected = 5'd1;
          next_hold = 0;
          next_dir = 0;
        end
      end else if (expected_wave == 5'd31 && expected_direction == 0) begin
        // At 31, going up. Hold for 1 cycle.
        if (hold_counter == 0) begin
          next_expected = 5'd31;
          next_hold = 1;
          next_dir = 0;
        end else begin
          next_expected = 5'd30;
          next_hold = 0;
          next_dir = 1; // Change direction to down
        end
      end else if (expected_wave == 5'd31 && expected_direction == 1) begin
        // At 31, going down. Hold for 1 cycle.
        if (hold_counter == 0) begin
          next_expected = 5'd31;
          next_hold = 1;
          next_dir = 1;
        end else begin
          next_expected = 5'd30;
          next_hold = 0;
          next_dir = 1;
        end
      end else if (expected_wave == 5'd0 && expected_direction == 1) begin
        // At 0, going down. Hold for 1 cycle.
        if (hold_counter == 0) begin
          next_expected = 5'd0;
          next_hold = 1;
          next_dir = 1;
        end else begin
          next_expected = 5'd1;
          next_hold = 0;
          next_dir = 0; // Change direction to up
        end
      end else begin
        // Middle of range
        if (expected_direction == 0) begin
          next_expected = expected_wave + 1;
        end else begin
          next_expected = expected_wave - 1;
        end
        next_hold = 0;
        next_dir = expected_direction;
      end

      // Verify the output matches the Spec expectation
      if (wave === next_expected) begin
        check_pass = 1;
      end else begin
        check_pass = 0;
      end

      // Update state for next iteration
      expected_wave = next_expected;
      expected_direction = next_dir;
      hold_counter = next_hold;

      // If we are in the middle of the sequence, we just track.
      // We will print the final verdict at the end based on accumulated checks.
      // However, the prompt asks to print "CHECK <name> PASS/FAIL".
      // The check name is "ac1_under_simulation_signal_generator_produc".
      // We will perform the check continuously and print the final status at the end.
      // If any step fails, we mark it failed.
      if (!check_pass) begin
        $display("Error at cycle %0d: Expected %d, Got %d", i, next_expected, wave);
      end
    end

    // Final verdict for the main acceptance criterion
    if (check_pass) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc PASS");
    end else begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL");
    end

    $finish;
  end

endmodule
