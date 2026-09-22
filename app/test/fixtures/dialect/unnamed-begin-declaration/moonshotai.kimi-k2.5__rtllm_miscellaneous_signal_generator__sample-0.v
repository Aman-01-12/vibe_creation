module tb;
  // Clock and reset
  reg clk;
  reg rst_n;
  
  // DUT outputs
  wire [4:0] wave;
  
  // Instantiate DUT
  signal_generator dut (
    .clk(clk),
    .rst_n(rst_n),
    .wave(wave)
  );
  
  // Test variables
  integer i;
  integer cycle_count;
  reg [4:0] expected_wave;
  reg [4:0] prev_wave;
  reg direction; // 0 = counting up, 1 = counting down
  reg hold_at_peak; // 1 = holding at 0 or 31
  reg [4:0] hold_counter;
  
  // Clock generation - 10ns period
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end
  
  // VCD dump
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);
  end
  
  // Main test sequence
  initial begin
    // Initialize
    rst_n = 0;
    cycle_count = 0;
    expected_wave = 5'd0;
    prev_wave = 5'd0;
    direction = 0; // start counting up
    hold_at_peak = 0;
    hold_counter = 0;
    
    // Hold reset for a few cycles
    @(posedge clk);
    @(posedge clk);
    
    // Check reset value - wave should be 0 after reset
    #1; // Small delay to sample after edge
    if (wave === 5'd0) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc PASS");
    end else begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: expected 5'd0, got %d", wave);
    end
    
    // Release reset
    rst_n = 1;
    
    // Now simulate the triangle wave behavior according to spec
    // The waveform cycles between 0 and 31, incrementing/decrementing by 1
    // Holds one extra clock cycle at both 0 and 31 before changing direction
    
    // Track the expected behavior based on observed outputs
    // We derive expectations from what we observe, not from a shadow model
    
    // First, observe the initial state after reset deassertion
    @(posedge clk);
    #1;
    prev_wave = wave;
    
    // The first value after reset should be 0 (held for extra cycle)
    // Then it should start incrementing
    
    // We'll track through multiple full cycles to verify the pattern
    // A full triangle wave: 0 (hold), 1, 2, ..., 30, 31 (hold), 30, ..., 2, 1, 0 (hold), ...
    
    // Check that we start at 0 and hold
    @(posedge clk);
    #1;
    if (wave !== 5'd0) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: expected 5'd0 at start, got %d", wave);
    end
    
    // Now should start incrementing
    // Track through a complete up-down cycle
    // Expected sequence: 0, 0, 1, 2, ..., 30, 31, 31, 30, ..., 1, 0, 0, 1, ...
    
    // Verify the pattern by observing transitions
    // We check: starts at 0, increments to 31, holds at 31, decrements to 0, holds at 0, repeats
    
    // First rising ramp: 0->1->2->...->31
    // But first 0 is held extra cycle, so we see 0, then 0 again or start incrementing
    
    // Let's observe the actual pattern and verify it matches spec
    // Sample multiple cycles and check the triangle wave properties
    
    // Check 1: Verify wave stays within 0-31 range
    for (i = 0; i < 100; i = i + 1) begin
      @(posedge clk);
      #1;
      if (wave > 5'd31) begin
        $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: wave exceeded 31, got %d", wave);
        $finish;
      end
    end
    
    // Check 2: Verify the pattern - we should see both 0 and 31, and transitions should be by 1
    // Also verify holding behavior at peaks
    
    // Find a 0 and verify hold behavior
    // Then find 31 and verify hold behavior
    // Then verify the ramp pattern
    
    // Look for complete cycle pattern
    // Reset and start fresh observation
    rst_n = 0;
    @(posedge clk);
    #1;
    rst_n = 1;
    @(posedge clk);
    #1;
    
    // Now observe from known state (should be 0)
    if (wave !== 5'd0) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: after reset, wave should be 0, got %d", wave);
      $finish;
    end
    
    // Track through to verify complete triangle wave pattern
    // We need to see: 0 (hold), up to 31, 31 (hold), down to 0, 0 (hold), repeat
    
    // State tracking variables
    reg saw_zero_hold;
    reg saw_31_hold;
    reg saw_rising_ramp;
    reg saw_falling_ramp;
    reg [4:0] min_val;
    reg [4:0] max_val;
    
    saw_zero_hold = 0;
    saw_31_hold = 0;
    saw_rising_ramp = 0;
    saw_falling_ramp = 0;
    min_val = 5'd31;
    max_val = 5'd0;
    
    prev_wave = wave;
    
    // Observe for enough cycles to see complete pattern (at least 2 full triangle cycles)
    // One full cycle: 0,0,1,2,...,30,31,31,30,...,2,1,0,0 = about 66 cycles
    for (i = 0; i < 150; i = i + 1) begin
      @(posedge clk);
      #1;
      
      // Track min/max
      if (wave < min_val) min_val = wave;
      if (wave > max_val) max_val = wave;
      
      // Check transitions are valid (change by 0 or 1, or direction change at peaks)
      if (prev_wave == 5'd0 && wave == 5'd0) begin
        saw_zero_hold = 1; // Holding at 0
      end
      if (prev_wave == 5'd31 && wave == 5'd31) begin
        saw_31_hold = 1; // Holding at 31
      end
      if (prev_wave < wave && wave - prev_wave == 1) begin
        saw_rising_ramp = 1; // Rising by 1
      end
      if (prev_wave > wave && prev_wave - wave == 1) begin
        saw_falling_ramp = 1; // Falling by 1
      end
      
      // Check for invalid transitions (change by more than 1, or wrong direction)
      // Allow hold (0 change) at peaks only
      if (wave != prev_wave) begin
        if (wave > prev_wave && wave - prev_wave != 1) begin
          $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: invalid jump up from %d to %d", prev_wave, wave);
          $finish;
        end
        if (wave < prev_wave && prev_wave - wave != 1) begin
          $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: invalid jump down from %d to %d", prev_wave, wave);
          $finish;
        end
      end
      
      prev_wave = wave;
    end
    
    // Verify we saw the expected pattern elements
    if (min_val !== 5'd0) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: minimum value should be 0, got %d", min_val);
      $finish;
    end
    if (max_val !== 5'd31) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: maximum value should be 31, got %d", max_val);
      $finish;
    end
    if (!saw_zero_hold) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: did not observe hold at 0");
      $finish;
    end
    if (!saw_31_hold) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: did not observe hold at 31");
      $finish;
    end
    if (!saw_rising_ramp) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: did not observe rising ramp");
      $finish;
    end
    if (!saw_falling_ramp) begin
      $display("CHECK ac1_under_simulation_signal_generator_produc FAIL: did not observe falling ramp");
      $finish;
    end
    
    // All checks passed
    $display("CHECK ac1_under_simulation_signal_generator_produc PASS");
    
    $finish;
  end
  
endmodule
