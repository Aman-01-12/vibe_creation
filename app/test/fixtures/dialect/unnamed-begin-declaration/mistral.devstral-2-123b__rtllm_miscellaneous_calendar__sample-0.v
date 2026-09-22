`timescale 1ns/1ps

module tb;
  reg CLK;
  reg RST;
  wire [5:0] Hours;
  wire [5:0] Mins;
  wire [5:0] Secs;

  // Instantiate the design
  calendar uut (
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
    // Initialize dump
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);

    // Reset
    RST = 1;
    #10;
    RST = 0;

    // Expected values
    integer expected_secs = 0;
    integer expected_mins = 0;
    integer expected_hours = 0;

    // Check reset values
    if (Hours === 0 && Mins === 0 && Secs === 0) begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b PASS");
    end else begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: expected Hours=0, Mins=0, Secs=0");
    end

    // Run for 24 hours to test all boundaries
    for (integer i = 0; i < 24*60*60; i = i + 1) begin
      // Compute expected values
      expected_secs = (expected_secs + 1) % 60;
      if (expected_secs == 0) begin
        expected_mins = (expected_mins + 1) % 60;
        if (expected_mins == 0) begin
          expected_hours = (expected_hours + 1) % 24;
        end
      end

      // Wait for next clock edge
      @(posedge CLK);

      // Check outputs
      if (Secs !== expected_secs || Mins !== expected_mins || Hours !== expected_hours) begin
        $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: expected Secs=%0d, Mins=%0d, Hours=%0d", expected_secs, expected_mins, expected_hours);
        $finish;
      end
    end

    // If we get here, all checks passed
    $display("CHECK ac1_under_simulation_calendar_produces_the_b PASS");
    $finish;
  end

endmodule
