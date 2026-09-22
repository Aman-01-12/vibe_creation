`timescale 1ns/1ps

module tb;
  reg CLK;
  reg RST;
  wire [5:0] Hours;
  wire [5:0] Mins;
  wire [5:0] Secs;

  // Instantiate the design under test
  calendar dut (
    .CLK(CLK),
    .RST(RST),
    .Hours(Hours),
    .Mins(Mins),
    .Secs(Secs)
  );

  // Clock generation
  initial begin
    CLK = 0;
    forever #5 CLK = ~CLK;
  end

  // Test sequence
  initial begin
    // Initialize dump file
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);

    // Reset sequence
    RST = 1;
    #10;
    RST = 0;
    #10;

    // Expected values
    integer expected_secs = 0;
    integer expected_mins = 0;
    integer expected_hours = 0;

    // Check reset values
    if (Hours === 0 && Mins === 0 && Secs === 0) begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b PASS");
    end else begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Reset values incorrect");
    end

    // Run simulation for a full day (24 hours)
    for (integer i = 0; i < 86400; i = i + 1) begin
      #10;

      // Compute expected values
      expected_secs = (expected_secs + 1) % 60;
      if (expected_secs == 0) begin
        expected_mins = (expected_mins + 1) % 60;
        if (expected_mins == 0) begin
          expected_hours = (expected_hours + 1) % 24;
        end
      end

      // Check current values
      if (Secs !== expected_secs || Mins !== expected_mins || Hours !== expected_hours) begin
        $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Time mismatch at cycle %0d", i);
        $display("Expected: %0d:%0d:%0d, Got: %0d:%0d:%0d",
                 expected_hours, expected_mins, expected_secs,
                 Hours, Mins, Secs);
        $finish;
      end
    end

    // Final check after full day
    if (Hours === 0 && Mins === 0 && Secs === 0) begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b PASS");
    end else begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Final values incorrect");
    end

    $finish;
  end

endmodule
