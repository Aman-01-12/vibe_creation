module tb;

  // Testbench signals
  reg clk;
  reg rst_n;
  reg [7:0] mul_a;
  reg [7:0] mul_b;
  reg mul_en_in;
  wire [7:0] mul_a_obs;
  wire [7:0] mul_b_obs;
  wire mul_en_in_obs;
  wire [15:0] mul_out;
  wire mul_en_out;

  // Instantiate the DUT
  multi_pipe_8bit uut (
    .mul_a(mul_a),
    .mul_b(mul_b),
    .mul_en_in(mul_en_in),
    .mul_en_out(mul_en_out),
    .mul_out(mul_out),
    .clk(clk),
    .rst_n(rst_n)
  );

  // Clock generation
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  // Dump waves
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);
  end

  // Test sequence
  initial begin
    // Initialize all signals
    rst_n = 1;
    mul_a = 0;
    mul_b = 0;
    mul_en_in = 0;

    // Apply reset
    #10 rst_n = 0;
    #10 rst_n = 1;

    // Wait for reset to settle
    #10;

    // Check reset state
    if (mul_en_out !== 1'b0) begin
      $display("RESET STATE ERROR: mul_en_out = %b", mul_en_out);
      $finish;
    end

    // Nominal test cases
    // Case 1: 0 * 0 = 0
    mul_a = 8'd0;
    mul_b = 8'd0;
    mul_en_in = 1'b1;
    #10;
    if (mul_en_out !== 1'b1) begin
      $display("ERROR: mul_en_out should be high for valid output");
      $finish;
    end
    #10;
    if (mul_out !== 16'd0) begin
      $display("ERROR: Expected 0, got %d", mul_out);
      $finish;
    end
    mul_en_in = 1'b0;
    #10;

    // Case 2: 1 * 1 = 1
    mul_a = 8'd1;
    mul_b = 8'd1;
    mul_en_in = 1'b1;
    #10;
    if (mul_en_out !== 1'b1) begin
      $display("ERROR: mul_en_out should be high for valid output");
      $finish;
    end
    #10;
    if (mul_out !== 16'd1) begin
      $display("ERROR: Expected 1, got %d", mul_out);
      $finish;
    end
    mul_en_in = 1'b0;
    #10;

    // Case 3: 255 * 255 = 65025
    mul_a = 8'd255;
    mul_b = 8'd255;
    mul_en_in = 1'b1;
    #10;
    if (mul_en_out !== 1'b1) begin
      $display("ERROR: mul_en_out should be high for valid output");
      $finish;
    end
    #10;
    if (mul_out !== 16'd65025) begin
      $display("ERROR: Expected 65025, got %d", mul_out);
      $finish;
    end
    mul_en_in = 1'b0;
    #10;

    // Boundary test cases
    // Case 4: 1 * 255 = 255
    mul_a = 8'd1;
    mul_b = 8'd255;
    mul_en_in = 1'b1;
    #10;
    if (mul_en_out !== 1'b1) begin
      $display("ERROR: mul_en_out should be high for valid output");
      $finish;
    end
    #10;
    if (mul_out !== 16'd255) begin
      $display("ERROR: Expected 255, got %d", mul_out);
      $finish;
    end
    mul_en_in = 1'b0;
    #10;

    // Case 5: 255 * 1 = 255
    mul_a = 8'd255;
    mul_b = 8'd1;
    mul_en_in = 1'b1;
    #10;
    if (mul_en_out !== 1'b1) begin
      $display("ERROR: mul_en_out should be high for valid output");
      $finish;
    end
    #10;
    if (mul_out !== 16'd255) begin
      $display("ERROR: Expected 255, got %d", mul_out);
      $finish;
    end
    mul_en_in = 1'b0;
    #10;

    // Error case: invalid input (should not produce output)
    mul_a = 8'd100;
    mul_b = 8'd100;
    mul_en_in = 1'b0; // Not enabled
    #10;
    if (mul_en_out !== 1'b0) begin
      $display("ERROR: mul_en_out should be low when not enabled");
      $finish;
    end
    #10;

    // Final check
    CHECK ac1_under_simulation_multi_pipe_8bit_produce PASS;
    $finish;
  end

endmodule