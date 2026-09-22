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

    // Test nominal operation
    repeat (60) begin
      #10;
      expected_secs = (expected_secs + 1) % 60;
      if (Secs !== expected_secs) begin
        $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Secs mismatch at time %0t", $time);
        $finish;
      end
    end

    // Test minute rollover
    #10;
    expected_secs = 0;
    expected_mins = 1;
    if (Secs !== expected_secs || Mins !== expected_mins) begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Minute rollover incorrect");
      $finish;
    end

    // Test hour rollover
    repeat (59) begin
      #10;
      expected_secs = (expected_secs + 1) % 60;
      if (Secs !== expected_secs) begin
        $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Secs mismatch during hour rollover prep");
        $finish;
      end
    end

    #10;
    expected_secs = 0;
    expected_mins = 0;
    expected_hours = 1;
    if (Secs !== expected_secs || Mins !== expected_mins || Hours !== expected_hours) begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Hour rollover incorrect");
      $finish;
    end

    // Test 24-hour rollover
    repeat (23) begin
      repeat (60) begin
        repeat (60) begin
          #10;
          expected_secs = (expected_secs + 1) % 60;
          if (Secs !== expected_secs) begin
            $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Secs mismatch during 24-hour test");
            $finish;
          end
        end
        #10;
        expected_secs = 0;
        expected_mins = (expected_mins + 1) % 60;
        if (Secs !== expected_secs || Mins !== expected_mins) begin
          $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Minute rollover incorrect during 24-hour test");
          $finish;
        end
      end
      #10;
      expected_secs = 0;
      expected_mins = 0;
      expected_hours = (expected_hours + 1) % 24;
      if (Secs !== expected_secs || Mins !== expected_mins || Hours !== expected_hours) begin
        $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: Hour rollover incorrect during 24-hour test");
        $finish;
      end
    end

    // Final check after full 24-hour cycle
    if (Hours === 0 && Mins === 0 && Secs === 0) begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b PASS");
    end else begin
      $display("CHECK ac1_under_simulation_calendar_produces_the_b FAIL: 24-hour rollover incorrect");
    end

    $finish;
  end

endmodule
