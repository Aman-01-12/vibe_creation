module tb_right_shifter;
  reg clk;
  reg d;
  wire [7:0] q;

  // Known-answer checks: expected values computed independently
  reg [7:0] expected_q;

  // Stimulus arrays for boundary and error cases
  reg [0:15] d_stim [0:15];
  integer i;

  // Instantiate the design under test
  right_shifter uut (
    .q(q),
    .d(d)
  );

  // Clock generation
  always begin
    #5 clk = ~clk;
  end

  initial begin
    // Initialize all variables
    clk = 0;
    d = 0;
    expected_q = 8'b0;

    // Initialize stimulus
    for (i = 0; i < 16; i = i + 1) begin
      d_stim[i] = i[0];  // Alternate 0,1,0,1,...
    end

    // Dump VCD for visualization
    $dumpfile("dump.vcd");
    $dumpvars(0, tb_right_shifter);

    // Wait for initial delta to settle
    #1;

    // Check initial state
    #1;
    if (q === 8'b0) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces PASS");
    end else begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: q not initialized to 0");
    end

    // Apply alternating pattern to maximize state transitions
    for (i = 0; i < 16; i = i + 1) begin
      d = d_stim[i];
      #5; // Advance to posedge of clk

      // Compute expected_q: right shift, insert d at MSB
      expected_q = {d, expected_q[7:1]};

      // Sample q after posedge (at negedge)
      #5;

      if (q !== expected_q) begin
        $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: at cycle %0d, expected 8'b%b, got 8'b%b", i+1, expected_q, q);
      end
    end

    // Test boundary: shift in all 0s for 8 cycles (should remain 0)
    for (i = 0; i < 8; i = i + 1) begin
      d = 0;
      #5;
      expected_q = {d, expected_q[7:1]};
      #5;
      if (q !== expected_q) begin
        $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: zero sequence at cycle %0d, expected 8'b%b, got 8'b%b", i+1, expected_q, q);
      end
    end

    // Test boundary: shift in all 1s for 8 cycles (should become all 1s)
    for (i = 0; i < 8; i = i + 1) begin
      d = 1;
      #5;
      expected_q = {d, expected_q[7:1]};
      #5;
      if (q !== expected_q) begin
        $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: one sequence at cycle %0d, expected 8'b%b, got 8'b%b", i+1, expected_q, q);
      end
    end

    // Additional test: shift in a known pattern that produces non-trivial intermediate states
    // Pattern: 10110011 to ensure coverage of various bit combinations
    reg [7:0] pattern = 8'b10110011;
    for (i = 0; i < 8; i = i + 1) begin
      d = pattern[7-i]; // Apply bits from MSB to LSB over time
      #5;
      expected_q = {d, expected_q[7:1]};
      #5;
      if (q !== expected_q) begin
        $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: pattern sequence at cycle %0d, expected 8'b%b, got 8'b%b", i+1, expected_q, q);
      end
    end

    // Final check
    if (q === expected_q) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces PASS");
    end

    $finish;
  end
endmodule