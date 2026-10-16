`timescale 1ns / 1ps

module tb_adder_16bit;

  // Inputs
  reg [15:0] a;
  reg [15:0] b;
  reg Cin;

  // Outputs
  wire [15:0] y;
  wire Co;

  // Expected values
  reg [16:0] expected_full_sum;
  reg [15:0] expected_y;
  reg expected_Co;

  // Test result tracking
  integer pass_count;
  integer fail_count;

  // Instantiate the Device Under Test (DUT)
  adder_16bit dut (
    .a(a),
    .b(b),
    .Cin(Cin),
    .y(y),
    .Co(Co)
  );

  // Task to check and report result
  task check_result;
    input [15:0] exp_y;
    input exp_Co;
    input [15:0] act_y;
    input act_Co;
    input [255:0] test_name;
    begin
      if (exp_y === act_y && exp_Co === act_Co) begin
        $display("CHECK %s PASS", test_name);
        pass_count = pass_count + 1;
      end else begin
        $display("CHECK %s FAIL: expected y=%h, Co=%b; got y=%h, Co=%b", test_name, exp_y, exp_Co, act_y, act_Co);
        fail_count = fail_count + 1;
      end
    end
  endtask

  initial begin
    // Initialize tracking
    pass_count = 0;
    fail_count = 0;

    // Setup VCD dumping
    begin end
    begin end

    // Wait for combinational logic to settle
    #1;

    // Test 1: Zero inputs (0 + 0 + 0 = 0)
    a = 16'h0000;
    b = 16'h0000;
    Cin = 1'b0;
    #1;
    expected_full_sum = {1'b0, a} + {1'b0, b} + Cin;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    check_result(expected_y, expected_Co, y, Co, "ac1_under_simulation_adder_16bit_produces_th_zero");

    // Test 2: Simple addition without carry (1 + 2 + 0 = 3)
    a = 16'h0001;
    b = 16'h0002;
    Cin = 1'b0;
    #1;
    expected_full_sum = {1'b0, a} + {1'b0, b} + Cin;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    check_result(expected_y, expected_Co, y, Co, "ac1_under_simulation_adder_16bit_produces_th_simple_add");

    // Test 3: Addition with carry in (1 + 2 + 1 = 4)
    a = 16'h0001;
    b = 16'h0002;
    Cin = 1'b1;
    #1;
    expected_full_sum = {1'b0, a} + {1'b0, b} + Cin;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    check_result(expected_y, expected_Co, y, Co, "ac1_under_simulation_adder_16bit_produces_th_with_cin");

    // Test 4: Maximum value without overflow (0xFFFF + 0 + 0 = 0xFFFF)
    a = 16'hFFFF;
    b = 16'h0000;
    Cin = 1'b0;
    #1;
    expected_full_sum = {1'b0, a} + {1'b0, b} + Cin;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    check_result(expected_y, expected_Co, y, Co, "ac1_under_simulation_adder_16bit_produces_th_max_no_overflow");

    // Test 5: Maximum value with overflow (0xFFFF + 0xFFFF + 1 = 0xFFFF with carry out)
    a = 16'hFFFF;
    b = 16'hFFFF;
    Cin = 1'b1;
    #1;
    expected_full_sum = {1'b0, a} + {1'b0, b} + Cin;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    check_result(expected_y, expected_Co, y, Co, "ac1_under_simulation_adder_16bit_produces_th_max_overflow");

    // Test 6: Half maximum values (0x8000 + 0x8000 + 0 = 0x0000 with carry out)
    a = 16'h8000;
    b = 16'h8000;
    Cin = 1'b0;
    #1;
    expected_full_sum = {1'b0, a} + {1'b0, b} + Cin;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    check_result(expected_y, expected_Co, y, Co, "ac1_under_simulation_adder_16bit_produces_th_half_max");

    // Test 7: Boundary - minimum values (0x0000 + 0x0000 + 1 = 0x0001)
    a = 16'h0000;
    b = 16'h0000;
    Cin = 1'b1;
    #1;
    expected_full_sum = {1'b0, a} + {1'b0, b} + Cin;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    check_result(expected_y, expected_Co, y, Co, "ac1_under_simulation_adder_16bit_produces_th_min_with_cin");

    // Test 8: Random values - test sensitivity to all bits
    a = 16'hAAAA;
    b = 16'h5555;
    Cin = 1'b0;
    #1;
    expected_full_sum = {1'b0, a} + {1'b0, b} + Cin;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    check_result(expected_y, expected_Co, y, Co, "ac1_under_simulation_adder_16bit_produces_th_alternating_bits");

    // Test 9: Carry propagation test (0xFFFF + 0x0001 + 0 = 0x0000 with carry out)
    a = 16'hFFFF;
    b = 16'h0001;
    Cin = 1'b0;
    #1;
    expected_full_sum = {1'b0, a} + {1'b0, b} + Cin;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    check_result(expected_y, expected_Co, y, Co, "ac1_under_simulation_adder_16bit_produces_th_carry_prop");

    // Test 10: Large values without overflow (0x7FFF + 0x7FFF + 0 = 0xFFFE)
    a = 16'h7FFF;
    b = 16'h7FFF;
    Cin = 1'b0;
    #1;
    expected_full_sum = {1'b0, a} + {1'b0, b} + Cin;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    check_result(expected_y, expected_Co, y, Co, "ac1_under_simulation_adder_16bit_produces_th_large_no_overflow");

    // Test 11: Just enough to overflow (0xFFFF + 0x0000 + 1 = 0x0000 with carry out)
    a = 16'hFFFF;
    b = 16'h0000;
    Cin = 1'b1;
    #1;
    expected_full_sum = {1'b0, a} + {1'b0, b} + Cin;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    check_result(expected_y, expected_Co, y, Co, "ac1_under_simulation_adder_16bit_produces_th_just_overflow");

    // Test 12: Neighbor of zero (0x0001 + 0xFFFE + 0 = 0xFFFF)
    a = 16'h0001;
    b = 16'hFFFE;
    Cin = 1'b0;
    #1;
    expected_full_sum = {1'b0, a} + {1'b0, b} + Cin;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    check_result(expected_y, expected_Co, y, Co, "ac1_under_simulation_adder_16bit_produces_th_neighbor_zero");

    // Final summary
    $display("Test completed: %d passed, %d failed", pass_count, fail_count);
    
    // Emit the required check name as specified
    // The main check combines all sub-tests
    if (fail_count == 0) begin
      $display("CHECK ac1_under_simulation_adder_16bit_produces_th PASS");
    end else begin
      $display("CHECK ac1_under_simulation_adder_16bit_produces_th FAIL: %d tests failed", fail_count);
    end

    $finish;
  end

endmodule
