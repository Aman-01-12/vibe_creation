module tb_div_16bit;
  // Testbench for div_16bit module
  // Inputs
  reg [15:0] A;
  reg [7:0] B;
  
  // Outputs
  wire [15:0] result;
  wire [15:0] odd;
  
  // Instantiate the module under test
  div_16bit dut (
    .A(A),
    .B(B),
    .result(result),
    .odd(odd)
  );
  
  // Test variables
  reg [15:0] expected_result;
  reg [15:0] expected_odd;
  integer test_num;
  integer pass_count;
  integer fail_count;
  
  // Helper function to compute expected values from spec
  // This implements the algorithm described in the spec:
  // 1. Extract higher bits of dividend matching divisor width (8 bits)
  // 2. Compare with divisor
  // 3. Set quotient bit to 1 if dividend bits >= divisor, else 0
  // 4. Use difference as remainder
  // 5. Concatenate remainder with next dividend bit
  // 6. Repeat for all 16 bits
  task compute_expected;
    input [15:0] dividend;
    input [7:0] divisor;
    output [15:0] quotient;
    output [15:0] remainder;
    
    reg [7:0] current_bits;
    reg [7:0] rem;
    reg [15:0] quot;
    integer i;
    begin
      rem = 8'b0;
      quot = 16'b0;
      
      for (i = 15; i >= 0; i = i - 1) begin
        // Shift remainder left by 1, bring in next dividend bit
        rem = {rem[6:0], dividend[i]};
        
        // Compare
        if (rem >= divisor) begin
          quot[i] = 1'b1;
          rem = rem - divisor;
        end else begin
          quot[i] = 1'b0;
        end
      end
      
      quotient = quot;
      remainder = {8'b0, rem};
    end
  endtask
  
  // Initialize test
  initial begin
    // Initialize test counters
    test_num = 0;
    pass_count = 0;
    fail_count = 0;
    
    // Dump waveform
    begin end
    begin end
    
    // Test 1: Basic division - exact division
    test_num = test_num + 1;
    A = 16'h00FF;  // 255
    B = 8'h0F;     // 15
    compute_expected(A, B, expected_result, expected_odd);
    #10;  // Allow combinational logic to settle
    if (result === expected_result && odd === expected_odd) begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the PASS");
      pass_count = pass_count + 1;
    end else begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the FAIL: Test %0d - A=%h B=%h, expected result=%h odd=%h, got result=%h odd=%h",
              test_num, A, B, expected_result, expected_odd, result, odd);
      fail_count = fail_count + 1;
    end
    
    // Test 2: Division with remainder
    test_num = test_num + 1;
    A = 16'h0100;  // 256
    B = 8'h03;     // 3
    compute_expected(A, B, expected_result, expected_odd);
    #10;
    if (result === expected_result && odd === expected_odd) begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the PASS");
      pass_count = pass_count + 1;
    end else begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the FAIL: Test %0d - A=%h B=%h, expected result=%h odd=%h, got result=%h odd=%h",
              test_num, A, B, expected_result, expected_odd, result, odd);
      fail_count = fail_count + 1;
    end
    
    // Test 3: Division by 1 (identity)
    test_num = test_num + 1;
    A = 16'h1234;
    B = 8'h01;
    compute_expected(A, B, expected_result, expected_odd);
    #10;
    if (result === expected_result && odd === expected_odd) begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the PASS");
      pass_count = pass_count + 1;
    end else begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the FAIL: Test %0d - A=%h B=%h, expected result=%h odd=%h, got result=%h odd=%h",
              test_num, A, B, expected_result, expected_odd, result, odd);
      fail_count = fail_count + 1;
    end
    
    // Test 4: Division by larger number (quotient should be 0)
    test_num = test_num + 1;
    A = 16'h00FF;  // 255
    B = 8'hFF;     // 255
    compute_expected(A, B, expected_result, expected_odd);
    #10;
    if (result === expected_result && odd === expected_odd) begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the PASS");
      pass_count = pass_count + 1;
    end else begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the FAIL: Test %0d - A=%h B=%h, expected result=%h odd=%h, got result=%h odd=%h",
              test_num, A, B, expected_result, expected_odd, result, odd);
      fail_count = fail_count + 1;
    end
    
    // Test 5: Division where divisor > most significant bits initially
    test_num = test_num + 1;
    A = 16'h0010;  // 16
    B = 8'h20;     // 32
    compute_expected(A, B, expected_result, expected_odd);
    #10;
    if (result === expected_result && odd === expected_odd) begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the PASS");
      pass_count = pass_count + 1;
    end else begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the FAIL: Test %0d - A=%h B=%h, expected result=%h odd=%h, got result=%h odd=%h",
              test_num, A, B, expected_result, expected_odd, result, odd);
      fail_count = fail_count + 1;
    end
    
    // Test 6: Maximum dividend, small divisor
    test_num = test_num + 1;
    A = 16'hFFFF;  // 65535
    B = 8'h02;     // 2
    compute_expected(A, B, expected_result, expected_odd);
    #10;
    if (result === expected_result && odd === expected_odd) begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the PASS");
      pass_count = pass_count + 1;
    end else begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the FAIL: Test %0d - A=%h B=%h, expected result=%h odd=%h, got result=%h odd=%h",
              test_num, A, B, expected_result, expected_odd, result, odd);
      fail_count = fail_count + 1;
    end
    
    // Test 7: Minimum dividend
    test_num = test_num + 1;
    A = 16'h0000;
    B = 8'h01;
    compute_expected(A, B, expected_result, expected_odd);
    #10;
    if (result === expected_result && odd === expected_odd) begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the PASS");
      pass_count = pass_count + 1;
    end else begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the FAIL: Test %0d - A=%h B=%h, expected result=%h odd=%h, got result=%h odd=%h",
              test_num, A, B, expected_result, expected_odd, result, odd);
      fail_count = fail_count + 1;
    end
    
    // Test 8: Maximum divisor
    test_num = test_num + 1;
    A = 16'hFFFF;
    B = 8'hFF;     // 255
    compute_expected(A, B, expected_result, expected_odd);
    #10;
    if (result === expected_result && odd === expected_odd) begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the PASS");
      pass_count = pass_count + 1;
    end else begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the FAIL: Test %0d - A=%h B=%h, expected result=%h odd=%h, got result=%h odd=%h",
              test_num, A, B, expected_result, expected_odd, result, odd);
      fail_count = fail_count + 1;
    end
    
    // Test 9: Random test case
    test_num = test_num + 1;
    A = 16'hA5A5;
    B = 8'h1B;
    compute_expected(A, B, expected_result, expected_odd);
    #10;
    if (result === expected_result && odd === expected_odd) begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the PASS");
      pass_count = pass_count + 1;
    end else begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the FAIL: Test %0d - A=%h B=%h, expected result=%h odd=%h, got result=%h odd=%h",
              test_num, A, B, expected_result, expected_odd, result, odd);
      fail_count = fail_count + 1;
    end
    
    // Test 10: Test with remainder equal to divisor-1
    test_num = test_num + 1;
    A = 16'h00FE;  // 254
    B = 8'h0F;     // 15
    compute_expected(A, B, expected_result, expected_odd);
    #10;
    if (result === expected_result && odd === expected_odd) begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the PASS");
      pass_count = pass_count + 1;
    end else begin
      $display("CHECK ac1_under_simulation_div_16bit_produces_the FAIL: Test %0d - A=%h B=%h, expected result=%h odd=%h, got result=%h odd=%h",
              test_num, A, B, expected_result, expected_odd, result, odd);
      fail_count = fail_count + 1;
    end
    
    // Summary
    $display("\nTest Summary: %0d tests run, %0d passed, %0d failed", test_num, pass_count, fail_count);
    
    if (fail_count == 0) begin
      $display("All tests passed!");
    end else begin
      $display("Some tests failed!");
    end
    
    $finish;
  end
endmodule