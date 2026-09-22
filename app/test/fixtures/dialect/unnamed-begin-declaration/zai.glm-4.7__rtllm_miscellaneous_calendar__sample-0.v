module tb_calendar;

  // Inputs
  reg CLK;
  reg RST;

  // Outputs
  wire [5:0] Hours;
  wire [5:0] Mins;
  wire [5:0] Secs;

  // Instantiate the Unit Under Test (UUT)
  calendar uut (
    .Hours(Hours),
    .Mins(Mins),
    .Secs(Secs),
    .CLK(CLK),
    .RST(RST)
  );

  // Testbench variables
  integer i;
  reg [5:0] expected_secs;
  reg [5:0] expected_mins;
  reg [5:0] expected_hours;

  // Clock generation
  initial begin
    CLK = 0;
    forever #5 CLK = ~CLK;
  end

  initial begin
    // Initialize Inputs
    RST = 0;

    // Dump waves
    $dumpfile("dump.vcd");
    $dumpvars(0, tb_calendar);

    // 1. Reset Sequence
    // Apply reset to set initial state to 0
    RST = 1;
    #10;
    RST = 0;
    #10;

    // Check Reset Values (Spec: starting value of Secs, Mins, and Hours are all 0)
    if (Hours == 6'd0 && Mins == 6'd0 && Secs == 6'd0) begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b PASS");
    end else begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Reset state incorrect");
      $finish;
    end

    // 2. Nominal Operation Simulation
    // We will simulate enough cycles to cover:
    // - Secs incrementing
    // - Secs rolling over 59 -> 0, Mins incrementing
    // - Mins rolling over 59 -> 0, Hours incrementing
    // - Hours rolling over 23 -> 0
    // Total cycles needed: (24 * 60 * 60) + 1 to see full wrap
    // However, for a testbench, we can verify the behavior at the boundaries.
    // We will run for 24 hours + 1 second to verify the full cycle.

    // Expected values anchored to observed state after reset
    expected_secs = 6'd0;
    expected_mins = 6'd0;
    expected_hours = 6'd0;

    // Run for 24 hours * 60 mins * 60 secs = 86400 cycles
    // We add a few extra cycles to ensure stability after wrap
    for (i = 0; i < 86405; i = i + 1) begin
      // Compute expected values for the NEXT cycle based on CURRENT state
      // Spec: "When Secs=59, Min increases by 1 at the next cycle"
      // Spec: "when Min=59 && Secs=59, Hours increases by 1 at the next cycle"
      // Spec: "Hours is counted from the 0-23 cycle"

      // Note: We compute what the values SHOULD be after the upcoming posedge CLK.
      // We sample the outputs AFTER the posedge CLK (at #10 delay).

      // Update expectations based on the PREVIOUS cycle's state (which is now in expected_*)
      // This logic mirrors the spec's transition rules.
      
      // 1. Determine next Secs
      if (expected_secs == 6'd59) begin
        expected_secs = 6'd0;
      end else begin
        expected_secs = expected_secs + 6'd1;
      end

      // 2. Determine next Mins
      // Mins increases if PREVIOUS Secs was 59
      if (expected_secs == 6'd0 && (expected_mins == 6'd59 || (i > 0 && expected_secs == 6'd0))) begin
         // Logic correction: We need to know if we just wrapped from 59.
         // Since we updated expected_secs above, we can't use it directly to check the "previous" 59 condition easily without a temp.
         // Let's rely on the loop index or restructure.
         // Actually, simpler: The spec defines the transition.
         // If (OldSecs == 59) Mins++.
         // If we just set expected_secs to 0, it means OldSecs was 59.
      end
    end

    // Re-doing the loop with clearer state tracking for verification
    // We will step cycle by cycle and verify.
    
    // Reset expectations to current observed values (0)
    expected_secs = Secs;
    expected_mins = Mins;
    expected_hours = Hours;

    // We will simulate 1 full day + 1 second
    for (i = 0; i < 86401; i = i + 1) begin
      // Apply Clock Edge
      #10;
      
      // Compute Expected Values for THIS cycle (based on previous state)
      // We use the values stored in expected_* from the previous iteration as the "previous state"
      
      // Temporary variables for calculation
      reg [5:0] prev_secs;
      reg [5:0] prev_mins;
      reg [5:0] prev_hours;
      
      prev_secs = expected_secs;
      prev_mins = expected_mins;
      prev_hours = expected_hours;

      // Calculate new expectations based on Spec
      // Secs loops 0-59
      if (prev_secs == 6'd59) begin
        expected_secs = 6'd0;
      end else begin
        expected_secs = prev_secs + 6'd1;
      end

      // Mins increases when prev_secs was 59
      if (prev_secs == 6'd59) begin
        if (prev_mins == 6'd59) begin
          expected_mins = 6'd0;
        end else begin
          expected_mins = prev_mins + 6'd1;
        end
      end else begin
        expected_mins = prev_mins;
      end

      // Hours increases when prev_mins was 59 AND prev_secs was 59
      if (prev_mins == 6'd59 && prev_secs == 6'd59) begin
        if (prev_hours == 6'd23) begin
          expected_hours = 6'd0;
        end else begin
          expected_hours = prev_hours + 6'd1;
        end
      end else begin
        expected_hours = prev_hours;
      end

      // Check Outputs
      if (Secs !== expected_secs || Mins !== expected_mins || Hours !== expected_hours) begin
        $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL at cycle %0d: Expected H=%0d M=%0d S=%0d, Got H=%0d M=%0d S=%0d", 
                 i, expected_hours, expected_mins, expected_secs, Hours, Mins, Secs);
        $finish;
      end
    end

    // If we get here, all checks passed
    $display("CHECK ac1_under_simulation_calendar_produces_the_b PASS");
    $finish;
  end

endmodule