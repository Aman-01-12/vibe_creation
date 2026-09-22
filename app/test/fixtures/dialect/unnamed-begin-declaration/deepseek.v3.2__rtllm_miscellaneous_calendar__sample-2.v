module tb_calendar;
  // Clock and reset signals
  reg CLK;
  reg RST;
  
  // Outputs from the calendar module
  wire [5:0] Hours;
  wire [5:0] Mins;
  wire [5:0] Secs;
  
  // Expected values computed from stimulus
  reg [5:0] expected_Hours;
  reg [5:0] expected_Mins;
  reg [5:0] expected_Secs;
  
  // Testbench state
  integer cycle_count;
  reg test_passed;
  
  // Instantiate the calendar module
  calendar dut (
    .CLK(CLK),
    .RST(RST),
    .Hours(Hours),
    .Mins(Mins),
    .Secs(Secs)
  );
  
  // Clock generation: 10 time units period
  always #5 CLK = ~CLK;
  
  // Initialize signals and start test
  initial begin
    // Initialize VCD dump for waveform viewing
    $dumpfile("dump.vcd");
    $dumpvars(0, tb_calendar);
    
    // Initialize signals
    CLK = 0;
    RST = 1;  // Start with reset asserted
    cycle_count = 0;
    test_passed = 1;  // Assume test passes until proven otherwise
    
    // Expected values at time 0 (reset state)
    expected_Hours = 6'd0;
    expected_Mins = 6'd0;
    expected_Secs = 6'd0;
    
    // Wait a bit, then deassert reset
    #10;
    RST = 0;
    
    // Wait for clock edge to ensure reset is deasserted
    @(posedge CLK);
    
    // Test 1: Verify reset values
    // Check that outputs are all 0 after reset deassertion
    // Wait for outputs to settle (after clock edge)
    #1;  // Small delay to avoid sampling at the active edge
    if (Hours !== 6'd0 || Mins !== 6'd0 || Secs !== 6'd0) begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Reset values incorrect. Hours=%0d, Mins=%0d, Secs=%0d", Hours, Mins, Secs);
      test_passed = 0;
    end else begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b PASS: Reset values correct");
    end
    
    // Test 2: Verify seconds counting from 0 to 59
    // We'll run through a full minute (60 seconds) to verify wrapping
    expected_Secs = 6'd0;
    expected_Mins = 6'd0;
    expected_Hours = 6'd0;
    
    // Run for 60 cycles to see seconds wrap
    for (cycle_count = 0; cycle_count < 60; cycle_count = cycle_count + 1) begin
      // Wait for clock edge
      @(posedge CLK);
      #1;  // Small delay to avoid sampling at the active edge
      
      // First, verify current outputs match expectations
      if (Hours !== expected_Hours || Mins !== expected_Mins || Secs !== expected_Secs) begin
        $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL at cycle %0d: Expected H=%0d M=%0d S=%0d, Got H=%0d M=%0d S=%0d", 
                cycle_count, expected_Hours, expected_Mins, expected_Secs, Hours, Mins, Secs);
        test_passed = 0;
      end
      
      // Now compute next expected values based on current observed outputs
      // This is the independent computation from spec
      if (Secs == 6'd59) begin
        expected_Secs = 6'd0;
        if (Mins == 6'd59) begin
          expected_Mins = 6'd0;
          if (Hours == 6'd23) begin
            expected_Hours = 6'd0;
          end else begin
            expected_Hours = Hours + 1;
          end
        end else begin
          expected_Mins = Mins + 1;
          expected_Hours = Hours;
        end
      end else begin
        expected_Secs = Secs + 1;
        expected_Mins = Mins;
        expected_Hours = Hours;
      end
    end
    
    // Test 3: Verify minutes increment when seconds wrap from 59 to 0
    // We've already tested this in the loop above, but let's explicitly check
    // that after 60 cycles, minutes should be 1
    if (Mins !== 6'd1) begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Minutes didn't increment after 60 seconds. Mins=%0d", Mins);
      test_passed = 0;
    end
    
    // Test 4: Verify hours increment when minutes=59 and seconds=59
    // We need to test the hour boundary cases thoroughly
    // Let's test multiple hour transitions including the 23->0 wrap
    
    // First, let's test a normal hour transition (not 23)
    // We'll run until we get to a state where hours=10, minutes=59, seconds=59
    // Then verify it transitions to 11:00:00
    
    // Run many cycles to potentially reach hour boundary
    // We'll run enough cycles to guarantee we hit at least one hour transition
    // 3600 seconds = 1 hour, but we need to account for current position
    // Let's run 4000 cycles to ensure we hit multiple hour boundaries
    
    // Reset expected values to current observed values
    expected_Hours = Hours;
    expected_Mins = Mins;
    expected_Secs = Secs;
    
    // Track if we've seen an hour transition
    reg seen_hour_transition = 0;
    reg [5:0] prev_hours;
    integer cycles_to_run = 4000;
    
    for (cycle_count = 0; cycle_count < cycles_to_run; cycle_count = cycle_count + 1) begin
      // Store previous hour for transition detection
      prev_hours = Hours;
      
      // Wait for clock edge
      @(posedge CLK);
      #1;
      
      // Verify current outputs match expectations
      if (Hours !== expected_Hours || Mins !== expected_Mins || Secs !== expected_Secs) begin
        $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL at cycle %0d: Expected H=%0d M=%0d S=%0d, Got H=%0d M=%0d S=%0d", 
                cycle_count, expected_Hours, expected_Mins, expected_Secs, Hours, Mins, Secs);
        test_passed = 0;
      end
      
      // Check if we just observed an hour transition
      if (prev_hours == 6'd59 && Mins == 6'd59 && Secs == 6'd59) begin
        // This was a minute:second transition point
        // Next should be hour transition if hours weren't 23
        if (prev_hours != 6'd23 && Hours == prev_hours + 1 && Mins == 6'd0 && Secs == 6'd0) begin
          seen_hour_transition = 1;
          $display("CHECK ac1_under_simulation_calendar_produces_the_b INFO: Observed hour transition from %0d:59:59 to %0d:00:00", prev_hours, Hours);
        end
      end
      
      // Now compute next expected values based on current observed outputs
      if (Secs == 6'd59) begin
        expected_Secs = 6'd0;
        if (Mins == 6'd59) begin
          expected_Mins = 6'd0;
          if (Hours == 6'd23) begin
            expected_Hours = 6'd0;
          end else begin
            expected_Hours = Hours + 1;
          end
        end else begin
          expected_Mins = Mins + 1;
          expected_Hours = Hours;
        end
      end else begin
        expected_Secs = Secs + 1;
        expected_Mins = Mins;
        expected_Hours = Hours;
      end
    end
    
    // Verify we observed at least one hour transition
    if (!seen_hour_transition) begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Did not observe any hour transition in %0d cycles", cycles_to_run);
      test_passed = 0;
    end
    
    // Test 5: Specifically test the 23:59:59 -> 00:00:00 transition
    // We'll run until we reach 23:59:59
    
    // First, let's check if we're already past 23:59:59
    if (Hours == 6'd23 && Mins == 6'd59 && Secs == 6'd59) begin
      // We're exactly at 23:59:59
      @(posedge CLK);
      #1;
      
      // Should transition to 00:00:00
      if (Hours !== 6'd0 || Mins !== 6'd0 || Secs !== 6'd0) begin
        $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: 23:59:59 didn't wrap to 0:0:0. H=%0d M=%0d S=%0d", Hours, Mins, Secs);
        test_passed = 0;
      end else begin
        $display("CHECK ac1_under_simulation_calendar_produces_the_b INFO: Successfully observed 23:59:59 -> 00:00:00 transition");
      end
    end else begin
      // We need to run until we reach 23:59:59
      // This could take many cycles, but we'll run up to 86400 cycles (24 hours worth)
      // to ensure we hit it
      integer max_cycles_to_23_59_59 = 86400;
      reg reached_23_59_59 = 0;
      
      for (cycle_count = 0; cycle_count < max_cycles_to_23_59_59; cycle_count = cycle_count + 1) begin
        // Wait for clock edge
        @(posedge CLK);
        #1;
        
        // Verify current outputs match expectations
        if (Hours !== expected_Hours || Mins !== expected_Mins || Secs !== expected_Secs) begin
          $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL at cycle %0d: Expected H=%0d M=%0d S=%0d, Got H=%0d M=%0d S=%0d", 
                  cycle_count, expected_Hours, expected_Mins, expected_Secs, Hours, Mins, Secs);
          test_passed = 0;
        end
        
        // Check if we've reached 23:59:59
        if (Hours == 6'd23 && Mins == 6'd59 && Secs == 6'd59) begin
          reached_23_59_59 = 1;
          $display("CHECK ac1_under_simulation_calendar_produces_the_b INFO: Reached 23:59:59 at cycle %0d", cycle_count);
          
          // Now check next transition
          @(posedge CLK);
          #1;
          
          // Should transition to 00:00:00
          if (Hours !== 6'd0 || Mins !== 6'd0 || Secs !== 6'd0) begin
            $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: 23:59:59 didn't wrap to 0:0:0. H=%0d M=%0d S=%0d", Hours, Mins, Secs);
            test_passed = 0;
          end else begin
            $display("CHECK ac1_under_simulation_calendar_produces_the_b INFO: Successfully observed 23:59:59 -> 00:00:00 transition");
          end
          
          // Break out of loop since we found what we were looking for
          break;
        end
        
        // Now compute next expected values based on current observed outputs
        if (Secs == 6'd59) begin
          expected_Secs = 6'd0;
          if (Mins == 6'd59) begin
            expected_Mins = 6'd0;
            if (Hours == 6'd23) begin
              expected_Hours = 6'd0;
            end else begin
              expected_Hours = Hours + 1;
            end
          end else begin
            expected_Mins = Mins + 1;
            expected_Hours = Hours;
          end
        end else begin
          expected_Secs = Secs + 1;
          expected_Mins = Mins;
          expected_Hours = Hours;
        end
      end
      
      if (!reached_23_59_59) begin
        $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Never reached 23:59:59 in %0d cycles", max_cycles_to_23_59_59);
        test_passed = 0;
      end
    end
    
    // Final verdict
    if (test_passed) begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b PASS: All tests passed");
    end else begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Some tests failed");
    end
    
    $finish;
  end
endmodule