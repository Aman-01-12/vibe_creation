module tb;

  // Module interface
  reg clk;
  reg [1:0] d;
  wire [8:0] q;

  // Instantiate the module under test
  right_shifter uut (
    .q(q),
    .d(d),
    .clk(clk)
  );

  // Testbench signals
  reg [7:0] expected_q;
  integer i;

  // Initialize simulation
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);

    // Initialize inputs
    clk = 0;
    d = 0;

    // Initialize expected_q
    expected_q = 0;

    // Drive clock
    forever #5 clk = ~clk;

    // Test cases
    // Test 1: Basic right shift with alternating bits
    d = 1;  // First bit in
    #10;    // Wait for clock edge
    expected_q = {1'b1, expected_q[7:1]};
    if (q != expected_q) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: Expected %b, got %b", expected_q, q);
      $finish;
    end

    d = 0;  // Second bit in
    #10;
    expected_q = {1'b0, expected_q[7:1]};
    if (q != expected_q) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: Expected %b, got %b", expected_q, q);
      $finish;
    end

    d = 1;  // Third bit in
    #10;
    expected_q = {1'b1, expected_q[7:1]};
    if (q != expected_q) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: Expected %b, got %b", expected_q, q);
      $finish;
    end

    d = 0;  // Fourth bit in
    #10;
    expected_q = {1'b0, expected_q[7:1]};
    if (q != expected_q) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: Expected %b, got %b", expected_q, q);
      $finish;
    end

    // Test 2: All zeros
    d = 0;
    #10;
    expected_q = {1'b0, expected_q[7:1]};
    if (q != expected_q) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: Expected %b, got %b", expected_q, q);
      $finish;
    end

    d = 0;
    #10;
    expected_q = {1'b0, expected_q[7:1]};
    if (q != expected_q) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: Expected %b, got %b", expected_q, q);
      $finish;
    end

    // Test 3: All ones
    d = 1;
    #10;
    expected_q = {1'b1, expected_q[7:1]};
    if (q != expected_q) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: Expected %b, got %b", expected_q, q);
      $finish;
    end

    d = 1;
    #10;
    expected_q = {1'b1, expected_q[7:1]};
    if (q != expected_q) begin
      $display("CHECK ac1_under_simulation_right_shifter_produces FAIL: Expected %b, got %b", expected_q, q);
      $finish;
    end

    // Final check
    CHECK ac1_under_simulation_right_shifter_produces PASS;
    $finish;
  end

endmodule