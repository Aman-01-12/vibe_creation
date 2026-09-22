`timescale 1ns/1ps

module tb;

  // Declare signals
  reg clk;
  reg rst_n;
  wire [4:0] wave;

  // Instantiate the design under test
  signal_generator dut (
    .clk(clk),
    .rst_n(rst_n),
    .wave(wave)
  );

  // Clock generation
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  // Test sequence
  initial begin
    // Initialize signals
    rst_n = 0;
    #10;

    // Release reset
    rst_n = 1;
    #10;

    // Expected values
    integer expected_wave;
    integer direction; // 1 for increment, -1 for decrement
    integer hold_count;

    // Initialize expected values
    expected_wave = 0;
    direction = 1;
    hold_count = 0;

    // Check reset value
    if (wave !== 5'b0) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: expected wave=0 at reset");
    end else begin
      $display("CHECK ac1_under_simulation_signal_generator_produc PASS");
    end

    // Main test loop
    for (integer i = 0; i < 100; i = i + 1) begin
      #10;

      // Compute expected wave value
      if (expected_wave === 0 || expected_wave === 31) begin
        if (hold_count === 0) begin
          hold_count = 1;
        end else begin
          hold_count = 0;
          direction = -direction;
          expected_wave = expected_wave + direction;
        end
      end else begin
        expected_wave = expected_wave + direction;
      end

      // Check wave value
      if (wave !== expected_wave) begin
        $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: expected wave=%d, got wave=%d", expected_wave, wave);
        $finish;
      end
    end

    // Final check
    $display("CHECK ac1_under_simulation_signal_generator_produc PASS");
    $finish;
  end

  // Dump waveform for debugging
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);
  end

endmodule
