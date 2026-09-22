`timescale 1ns/1ps

module tb_signal_generator;
  // Clock and reset signals
  reg clk;
  reg rst_n;

  // Output wave signal (5-bit: [5:0] per interface)
  wire [5:0] wave;

  // Instantiate the design under test
  signal_generator uut (
    .clk(clk),
    .rst_n(rst_n),
    .wave(wave)
  );

  // Clock generation: 10ns period (50MHz)
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  // Test variables
  reg [5:0] expected_wave;
  integer i;
  integer test_passed;
  integer total_tests;

  // Helper to compute expected wave value based on cycle count
  // The waveform: 0 (hold 2 cycles), 1..30 (1 cycle each), 31 (hold 2 cycles)
  // Total period = 2 + 30 + 2 = 34 cycles
  // Cycle 0: wave=0
  // Cycle 1: wave=0 (hold)
  // Cycle 2: wave=1
  // ...
  // Cycle 31: wave=30
  // Cycle 32: wave=31
  // Cycle 33: wave=31 (hold)
  // Cycle 34: wave=30 (start descending)
  // ...
  // Cycle 65: wave=1
  // Cycle 66: wave=0
  // Cycle 67: wave=0 (hold)
  // etc.
  // We'll compute expected_wave based on cycle count modulo 68 (full up+down cycle)
  // Full cycle: 0->0->1->...->30->31->31->30->...->1->0->0 (68 cycles)
  // But we'll compute incrementally in the test to avoid complex modulo math.

  // Main test sequence
  initial begin
    // Initialize
    rst_n = 0;
    #20; // Wait for reset to be stable

    // Release reset
    rst_n = 1;

    // Wait for reset to take effect (one clock cycle after release)
    @(posedge clk);
    #1; // Sample after edge

    // Expected value after reset: 0 (since reset should initialize to 0)
    expected_wave = 6'd0;
    if (wave !== expected_wave) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: wave after reset is %0d, expected %0d", wave, expected_wave);
    end else begin
      $display("CHECK ac1_under_simulation_signal_generator_produc PASS");
    end

    // Run through one full cycle (up and down) and verify each step
    // We'll verify the first 34 cycles (0->31 up phase) and then 34 cycles (31->0 down phase)
    // Total 68 cycles for full period

    // Up phase: 0,0,1,2,...,30,31,31
    // Cycle 0: wave=0 (after reset)
    // Cycle 1: wave=0 (hold at 0)
    // Cycle 2: wave=1
    // ...
    // Cycle 31: wave=30
    // Cycle 32: wave=31
    // Cycle 33: wave=31 (hold at 31)

    // Verify up phase
    for (i = 0; i < 34; i = i + 1) begin
      @(posedge clk);
      #1; // Sample after edge

      // Compute expected value for cycle i
      if (i == 0 || i == 1) begin
        expected_wave = 6'd0;
      end else if (i >= 2 && i <= 31) begin
        expected_wave = 6'd( i - 1 );
      end else if (i == 32 || i == 33) begin
        expected_wave = 6'd31;
      end

      if (wave !== expected_wave) begin
        $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: cycle %0d, wave=%0d, expected=%0d", i, wave, expected_wave);
        // Continue to print all checks
      end
    end

    // Down phase: 31,30,29,...,1,0,0
    // Cycle 34: wave=30 (start descending)
    // Cycle 35: wave=29
    // ...
    // Cycle 64: wave=1
    // Cycle 65: wave=0
    // Cycle 66: wave=0 (hold at 0)
    // Cycle 67: wave=1 (next up phase starts)

    // Actually, after holding at 31 for 2 cycles (cycles 32,33), next cycle (34) should be 30
    // So down phase: 31 (hold at 31 done), then 30,29,...,1,0,0
    // Cycle 34: wave=30
    // Cycle 35: wave=29
    // ...
    // Cycle 63: wave=1
    // Cycle 64: wave=0
    // Cycle 65: wave=0 (hold at 0)
    // Cycle 66: wave=1

    // Verify down phase (cycles 34 to 65)
    for (i = 34; i < 66; i = i + 1) begin
      @(posedge clk);
      #1; // Sample after edge

      // Compute expected value for cycle i
      if (i == 34) begin
        expected_wave = 6'd30;
      end else if (i >= 35 && i <= 63) begin
        expected_wave = 6'd( 64 - i );
      end else if (i == 64 || i == 65) begin
        expected_wave = 6'd0;
      end

      if (wave !== expected_wave) begin
        $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: cycle %0d, wave=%0d, expected=%0d", i, wave, expected_wave);
      end
    end

    // Verify next up phase starts correctly
    @(posedge clk);
    #1;
    expected_wave = 6'd1;
    if (wave !== expected_wave) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: cycle 66, wave=%0d, expected=%0d", wave, expected_wave);
    end

    // Verify boundary: max value 31
    // Run until we hit 31 again
    // From cycle 66: 1,2,...,30,31,31
    for (i = 66; i < 98; i = i + 1) begin
      @(posedge clk);
      #1;

      if (i == 66) begin
        expected_wave = 6'd1;
      end else if (i >= 67 && i <= 96) begin
        expected_wave = 6'd( i - 65 );
      end else if (i == 97 || i == 98) begin
        expected_wave = 6'd31;
      end

      if (wave !== expected_wave) begin
        $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: cycle %0d, wave=%0d, expected=%0d", i, wave, expected_wave);
      end
    end

    // Final verification: after holding at 31 for 2 cycles, should go to 30
    @(posedge clk);
    #1;
    expected_wave = 6'd30;
    if (wave !== expected_wave) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: cycle 99, wave=%0d, expected=%0d", wave, expected_wave);
    end

    // All checks done
    $finish;
  end

  // VCD dump
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb_signal_generator);
  end

endmodule
