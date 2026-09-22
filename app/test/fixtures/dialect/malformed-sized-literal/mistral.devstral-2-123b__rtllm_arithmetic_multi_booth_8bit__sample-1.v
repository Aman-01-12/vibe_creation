`timescale 1ns/1ps

module tb;

  // Declare signals
  reg clk;
  reg reset;
  reg [7:0] a;
  reg [7:0] b;
  wire [15:0] p;
  wire rdy;

  // Instantiate the design under test
  multi_booth_8bit dut (
    .clk(clk),
    .reset(reset),
    .a(a),
    .b(b),
    .p(p),
    .rdy(rdy)
  );

  // Clock generation
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  // Test sequence
  initial begin
    // Initialize signals
    reset = 1;
    a = 0;
    b = 0;

    // Dump VCD for waveform viewing
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);

    // Reset phase
    #10;
    reset = 0;
    #10;

    // Test case 1: Basic multiplication (5 * 3 = 15)
    a = 8'd5;
    b = 8'd3;
    #10;
    wait(rdy == 1'b1);
    if (p === 16'd15) begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc PASS");
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: expected 16'd15, got %d", p);
    end

    // Test case 2: Multiplication with negative numbers (-5 * 3 = -15)
    a = 8'd245; // -11 in 8-bit two's complement
    b = 8'd3;
    #10;
    wait(rdy == 1'b1);
    if (p === 16'd-15) begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc PASS");
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: expected 16'd-15, got %d", p);
    end

    // Test case 3: Multiplication with zero (0 * 127 = 0)
    a = 8'd0;
    b = 8'd127;
    #10;
    wait(rdy == 1'b1);
    if (p === 16'd0) begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc PASS");
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: expected 16'd0, got %d", p);
    end

    // Test case 4: Boundary value (127 * 127 = 16129)
    a = 8'd127;
    b = 8'd127;
    #10;
    wait(rdy == 1'b1);
    if (p === 16'd16129) begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc PASS");
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: expected 16'd16129, got %d", p);
    end

    // Test case 5: Boundary value (-128 * -128 = 16384)
    a = 8'd128; // -128 in 8-bit two's complement
    b = 8'd128;
    #10;
    wait(rdy == 1'b1);
    if (p === 16'd16384) begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc PASS");
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: expected 16'd16384, got %d", p);
    end

    // Test case 6: Reset behavior check
    reset = 1;
    #10;
    if (rdy === 1'b0 && p === 16'd0) begin
      $display("CHECK known_answer_counter_increments PASS");
    end else begin
      $display("CHECK known_answer_counter_increments FAIL: expected rdy=0 and p=0 after reset");
    end
    reset = 0;

    // Test case 7: Edge case (1 * 1 = 1)
    a = 8'd1;
    b = 8'd1;
    #10;
    wait(rdy == 1'b1);
    if (p === 16'd1) begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc PASS");
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: expected 16'd1, got %d", p);
    end

    // Test case 8: Edge case (127 * 1 = 127)
    a = 8'd127;
    b = 8'd1;
    #10;
    wait(rdy == 1'b1);
    if (p === 16'd127) begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc PASS");
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: expected 16'd127, got %d", p);
    end

    // Test case 9: Edge case (-128 * 1 = -128)
    a = 8'd128; // -128 in 8-bit two's complement
    b = 8'd1;
    #10;
    wait(rdy == 1'b1);
    if (p === 16'd-128) begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc PASS");
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: expected 16'd-128, got %d", p);
    end

    // Test case 10: Edge case (1 * -128 = -128)
    a = 8'd1;
    b = 8'd128; // -128 in 8-bit two's complement
    #10;
    wait(rdy == 1'b1);
    if (p === 16'd-128) begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc PASS");
    end else begin
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL: expected 16'd-128, got %d", p);
    end

    // Finish simulation
    #10;
    $finish;
  end

endmodule
