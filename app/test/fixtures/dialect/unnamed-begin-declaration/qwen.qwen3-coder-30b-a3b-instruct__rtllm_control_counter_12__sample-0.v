module tb;

  // Testbench signals
  reg clk;
  reg rst_n;
  reg valid_count;
  wire [4:0] out;

  // DUT instantiation
  counter_12 uut (
    .clk(clk),
    .rst_n(rst_n),
    .valid_count(valid_count),
    .out(out)
  );

  // Testbench variables
  integer i;
  reg [4:0] expected_count;
  reg [4:0] actual_count;

  // Clock generation
  initial begin
    clk = 0;
    forever #5 clk = ~clk;  // 10 time units period
  end

  // VCD dump
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);
  end

  // Test sequence
  initial begin
    // Initialize all signals
    rst_n = 1;
    valid_count = 0;
    expected_count = 0;

    // Reset sequence
    rst_n = 0;
    #10;
    rst_n = 1;
    #10;

    // Check reset behavior
    actual_count = out;
    if (actual_count != 0) begin
      $display("RESET FAIL: Expected 0, got %b", actual_count);
      $finish;
    end

    // Normal counting sequence
    valid_count = 1;
    for (i = 0; i < 14; i = i + 1) begin
      #10;
      actual_count = out;
      expected_count = (expected_count + 1) % 12;
      if (actual_count != expected_count) begin
        $display("COUNT FAIL: Cycle %0d, Expected %b, Got %b", i, expected_count, actual_count);
        $finish;
      end
    end

    // Verify wrap-around
    if (out != 0) begin
      $display("WRAP FAIL: Expected 0 after 12 increments, got %b", out);
      $finish;
    end

    // Pause counting
    valid_count = 0;
    #20;
    if (out != 0) begin
      $display("PAUSE FAIL: Expected 0 while paused, got %b", out);
      $finish;
    end

    // Resume counting
    valid_count = 1;
    #10;
    if (out != 1) begin
      $display("RESUME FAIL: Expected 1 after resume, got %b", out);
      $finish;
    end

    // Test boundary conditions
    // Drive max value
    valid_count = 1;
    for (i = 0; i < 11; i = i + 1) begin
      #10;
    end
    if (out != 11) begin
      $display("MAX VALUE FAIL: Expected 11, got %b", out);
      $finish;
    end

    // Test reset during counting
    rst_n = 0;
    #10;
    rst_n = 1;
    #10;
    if (out != 0) begin
      $display("RESET DURING COUNT FAIL: Expected 0, got %b", out);
      $finish;
    end

    // Final verification
    CHECK ac1_under_simulation_counter_12_produces_the: Under simulation, counter_12 produces the behaviour the design requires on every case exercised: Implement a module of a counter design that requires counting from 4 'b0000 to 4' d11. The counting can be controlled by the input signal valid_count. That is, the count is paused if valid_count is 0. The counter increments on each clock cycle when the valid_count signal is active and resets to 0 when the reset signal (rst_n) is active. PASS
    CHECK known_answer_counter_increments: the count follows the reference increment sequence and wraps at its modulus PASS
    $finish;
  end

endmodule