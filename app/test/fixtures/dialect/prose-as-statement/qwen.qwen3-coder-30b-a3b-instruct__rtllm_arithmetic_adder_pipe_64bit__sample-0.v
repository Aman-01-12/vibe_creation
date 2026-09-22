module tb;

  // Testbench signals
  reg clk;
  reg rst_n;
  reg [1:0] i_en;
  reg [63:0] adda;
  reg [63:0] addb;
  wire [64:0] result;
  wire o_en;

  // DUT instantiation
  adder_pipe_64bit uut (
    .clk(clk),
    .rst_n(rst_n),
    .i_en(i_en),
    .adda(adda),
    .addb(addb),
    .result(result),
    .o_en(o_en)
  );

  // Testbench variables
  integer i;
  reg [63:0] expected_result;
  reg expected_o_en;

  // Clock generation
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  // Dump waves
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);
    // ... stimulus and CHECK lines ...
    $finish;
  end

  // Test sequence
  initial begin
    // Initialize all signals
    rst_n = 1;
    i_en = 2'b00;
    adda = 64'h0;
    addb = 64'h0;

    // Apply reset
    rst_n = 0;
    #10;
    rst_n = 1;
    #10;

    // Check reset behavior
    if (o_en == 1'b0) begin
      $display("Reset behavior: o_en is 0 as expected");
      CHECK ac1_under_simulation_adder_pipe_64bit_produc PASS;
    end else begin
      $display("Reset behavior: o_en is not 0 as expected");
      CHECK ac1_under_simulation_adder_pipe_64bit_produc FAIL;
    end

    // Nominal test cases
    for (i = 0; i < 10; i = i + 1) begin
      // Drive inputs
      adda = $random % 2**64;
      addb = $random % 2**64;
      i_en = 2'b11;
      #10;

      // Sample outputs after settling
      #10;

      // Compute expected result
      expected_result = adda + addb;
      expected_o_en = 1'b1;

      // Verify outputs
      if (result == expected_result && o_en == expected_o_en) begin
        $display("Nominal test case %0d passed", i);
      end else begin
        $display("Nominal test case %0d failed", i);
        $display("Expected result: %0h, Got: %0h", expected_result, result);
        $display("Expected o_en: %0b, Got: %0b", expected_o_en, o_en);
        CHECK ac1_under_simulation_adder_pipe_64bit_produc FAIL;
      end
    end

    // Boundary test cases
    // Zero inputs
    adda = 64'h0;
    addb = 64'h0;
    i_en = 2'b11;
    #10;
    #10;
    expected_result = 65'h0;
    expected_o_en = 1'b1;
    if (result == expected_result && o_en == expected_o_en) begin
      $display("Zero inputs test passed");
    end else begin
      $display("Zero inputs test failed");
      CHECK ac1_under_simulation_adder_pipe_64bit_produc FAIL;
    end

    // Max inputs
    adda = 64'hFFFFFFFFFFFFFFFF;
    addb = 64'hFFFFFFFFFFFFFFFF;
    i_en = 2'b11;
    #10;
    #10;
    expected_result = 65'h1FFFFFFFFFFFFFFFE;
    expected_o_en = 1'b1;
    if (result == expected_result && o_en == expected_o_en) begin
      $display("Max inputs test passed");
    end else begin
      $display("Max inputs test failed");
      CHECK ac1_under_simulation_adder_pipe_64bit_produc FAIL;
    end

    // Single bit set
    adda = 64'h1;
    addb = 64'h1;
    i_en = 2'b11;
    #10;
    #10;
    expected_result = 65'h2;
    expected_o_en = 1'b1;
    if (result == expected_result && o_en == expected_o_en) begin
      $display("Single bit test passed");
    end else begin
      $display("Single bit test failed");
      CHECK ac1_under_simulation_adder_pipe_64bit_produc FAIL;
    end

    // Enable disable test
    i_en = 2'b00;
    #10;
    #10;
    if (o_en == 1'b0) begin
      $display("Disable test passed");
    end else begin
      $display("Disable test failed");
      CHECK ac1_under_simulation_adder_pipe_64bit_produc FAIL;
    end

    // Final check
    CHECK ac1_under_simulation_adder_pipe_64bit_produc PASS;
  end

endmodule