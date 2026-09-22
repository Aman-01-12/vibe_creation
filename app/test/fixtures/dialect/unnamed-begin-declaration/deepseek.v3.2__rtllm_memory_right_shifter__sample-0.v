module tb_right_shifter;
  // Declarations at module scope
  reg clk;
  reg d;
  wire [7:0] q;
  
  // Testbench variables
  reg [7:0] expected_q;
  reg [7:0] shadow_q;
  integer i;
  integer j;
  integer k;
  
  // Instantiate the design under test
  right_shifter dut (
    .q(q),
    .d(d),
    .clk(clk)
  );
  
  // Clock generation
  always #5 clk = ~clk;
  
  // Dump waveform
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb_right_shifter);
  end
  
  // Main test sequence
  initial begin
    // Initialize
    clk = 0;
    d = 0;
    expected_q = 8'b00000000;
    shadow_q = 8'b00000000;
    
    // Wait a bit for initial state
    #10;
    
    // Check 1: Initial state after power-up (no reset, but spec says q initializes to 0)
    // According to spec: "first initializing the q register to 0"
    // We need to check that q starts at 0
    if (q === 8'b00000000) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces PASS: Initial q is 0");
    end else begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: Initial q is %b, expected 00000000", q);
    end
    
    // Test 2: Shift in a single '1' bit
    // Drive input and check after clock edge
    d = 1'b1;
    #10; // Wait for next posedge (clk period is 10)
    // Expected: shift right and insert d at MSB
    // q was 00000000, shift right -> 00000000, insert 1 at MSB -> 10000000
    expected_q = 8'b10000000;
    if (q === expected_q) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces PASS: After first shift with d=1, q=%b", q);
    end else begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: After first shift with d=1, q=%b, expected %b", q, expected_q);
    end
    
    // Test 3: Shift in a '0' bit
    d = 1'b0;
    #10;
    // Expected: shift right 10000000 -> 01000000, insert 0 at MSB -> 00100000
    // Wait, careful: shifting right means LSB is lost, MSB gets d
    // Actually: q = {d, q[7:1]}
    // So 10000000 -> {0, 1000000} = 01000000
    expected_q = 8'b01000000;
    if (q === expected_q) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces PASS: After second shift with d=0, q=%b", q);
    end else begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: After second shift with d=0, q=%b, expected %b", q, expected_q);
    end
    
    // Test 4: Shift in alternating pattern
    d = 1'b1;
    #10;
    // q was 01000000 -> {1, 0100000} = 10100000
    expected_q = 8'b10100000;
    if (q === expected_q) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces PASS: After third shift with d=1, q=%b", q);
    end else begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: After third shift with d=1, q=%b, expected %b", q, expected_q);
    end
    
    d = 1'b0;
    #10;
    // q was 10100000 -> {0, 1010000} = 01010000
    expected_q = 8'b01010000;
    if (q === expected_q) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces PASS: After fourth shift with d=0, q=%b", q);
    end else begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: After fourth shift with d=0, q=%b, expected %b", q, expected_q);
    end
    
    // Test 5: Shift in all ones for 8 cycles to fill register
    for (i = 0; i < 8; i = i + 1) begin
      d = 1'b1;
      #10;
      // Compute expected based on previous observed q
      // We can't use a model, so we'll compute from the spec formula: {d, q[7:1]}
      // But we need to use the ACTUAL q from previous cycle
      // We'll store it in shadow_q
      if (i == 0) begin
        // First iteration: q is currently 01010000
        // Expected: {1, 01010000[7:1]} = {1, 00101000} = 10010100
        // Actually wait, we need to use the q value from BEFORE this clock edge
        // At this point in code, q has already updated from the previous #10
        // So we need to track expected differently
        // Let's restart with a clean approach
      end
    end
    
    // Let's do a more systematic test: track observed q and compute next expected
    // Reset test by letting many zeros shift through
    d = 1'b0;
    for (j = 0; j < 10; j = j + 1) begin
      #10;
    end
    // Now q should be all zeros or mostly zeros
    
    // Now do a sequence where we can independently verify
    // We'll drive specific d values and compute expected using the spec formula
    // But we must compute from OBSERVED q, not from our own model
    
    // Start fresh observation
    $display("Starting systematic test...");
    
    // Record initial state
    shadow_q = q;
    
    // Test sequence: 1, 0, 1, 1, 0, 0, 1, 0
    reg [7:0] test_pattern = 8'b10110010;
    reg [7:0] expected_history [0:7];
    
    for (k = 0; k < 8; k = k + 1) begin
      d = test_pattern[7-k]; // Drive MSB first
      #10; // Wait for clock edge
      // Compute expected: {d, shadow_q[7:1]}
      expected_q = {d, shadow_q[7:1]};
      if (q === expected_q) begin
        $display("CHECK ac1_under_simulation_right_shifter_produces PASS: Cycle %0d, d=%b, q=%b, expected=%b", k, d, q, expected_q);
      end else begin
        $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: Cycle %0d, d=%b, q=%b, expected=%b", k, d, q, expected_q);
      end
      // Update shadow_q with observed value for next iteration
      shadow_q = q;
    end
    
    // Boundary test: all ones then all zeros
    // First, fill with ones
    d = 1'b1;
    for (i = 0; i < 8; i = i + 1) begin
      #10;
      expected_q = {1'b1, shadow_q[7:1]};
      if (q === expected_q) begin
        $display("CHECK ac1_under_simulation_right_shifter_produces PASS: Fill ones cycle %0d, q=%b", i, q);
      end else begin
        $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: Fill ones cycle %0d, q=%b, expected=%b", i, q, expected_q);
      end
      shadow_q = q;
    end
    
    // Now shift in zeros
    d = 1'b0;
    for (i = 0; i < 8; i = i + 1) begin
      #10;
      expected_q = {1'b0, shadow_q[7:1]};
      if (q === expected_q) begin
        $display("CHECK ac1_under_simulation_right_shifter_produces PASS: Shift zeros cycle %0d, q=%b", i, q);
      end else begin
        $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: Shift zeros cycle %0d, q=%b, expected=%b", i, q, expected_q);
      end
      shadow_q = q;
    end
    
    // Final check: after many zeros, q should be all zeros
    if (q === 8'b00000000) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces PASS: Final q is all zeros");
    end else begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: Final q is %b, expected all zeros", q);
    end
    
    $display("All tests completed");
    $finish;
  end
endmodule