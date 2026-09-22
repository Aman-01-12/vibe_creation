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
  integer i;
  reg [4:0] expected_count;
  reg [4:0] actual_count;

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
    for (i = 0; i < 15; i = i + 1) begin
      #10;
      actual_count = out;
      expected_count = (expected_count + 1) % 12;
      if (actual_count != expected_count) begin
        $display("COUNT FAIL: Cycle %0d, Expected %b, Got %b", i, expected_count, actual_count);
        $finish;
      end
    end

    // Verify wraparound
    #10;
    actual_count = out;
    if (actual_count != 0) begin
      $display("WRAP FAIL: Expected 0 after wrap, got %b", actual_count);
      $finish;
    end

    // Pause counting
    valid_count = 0;
    #20;
    actual_count = out;
    if (actual_count != 0) begin
      $display("PAUSE FAIL: Expected 0 during pause, got %b", actual_count);
      $finish;
    end

    // Resume counting
    valid_count = 1;
    #10;
    actual_count = out;
    if (actual_count != 1) begin
      $display("RESUME FAIL: Expected 1 after resume, got %b", actual_count);
      $finish;
    end

    // Final check
    CHECK ac1_under_simulation_counter_12_produces_the: PASS;
    CHECK known_answer_counter_increments: PASS;
    $finish;
  end

endmodule