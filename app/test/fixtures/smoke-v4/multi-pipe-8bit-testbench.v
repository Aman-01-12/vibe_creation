module tb;
  // Clock and reset
  reg clk;
  reg rst_n;
  
  // DUT inputs
  reg [7:0] mul_a;
  reg [7:0] mul_b;
  reg mul_en_in;
  
  // DUT outputs
  wire mul_en_out;
  wire [15:0] mul_out;
  
  // Instantiate DUT
  multi_pipe_8bit dut (
    .clk(clk),
    .rst_n(rst_n),
    .mul_a(mul_a),
    .mul_b(mul_b),
    .mul_en_in(mul_en_in),
    .mul_en_out(mul_en_out),
    .mul_out(mul_out)
  );
  
  // Clock generation: 10ns period
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end
  
  // Test variables
  integer test_num;
  reg [15:0] expected_out;
  reg expected_en_out;
  reg [15:0] expected_pipeline[0:3];
  reg expected_en_pipeline[0:3];
  integer i;
  
  // Main test sequence
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);
    
    // Initialize
    mul_a = 8'd0;
    mul_b = 8'd0;
    mul_en_in = 1'b0;
    test_num = 0;
    
    // Initialize pipeline tracking
    for (i = 0; i < 4; i = i + 1) begin
      expected_pipeline[i] = 16'd0;
      expected_en_pipeline[i] = 1'b0;
    end
    
    // Apply reset
    rst_n = 1'b0;
    repeat(3) @(posedge clk);
    #1;
    
    // Check reset state
    if (mul_en_out !== 1'b0 || mul_out !== 16'd0) begin
      $display("CHECK ac1_under_simulation_multi_pipe_8bit_produce FAIL: Reset state incorrect");
    end else begin
      $display("CHECK ac1_under_simulation_multi_pipe_8bit_produce PASS");
    end
    
    rst_n = 1'b1;
    @(posedge clk);
    #1;
    
    // Test 1: Basic multiplication - small values
    test_num = 1;
    mul_a = 8'd3;
    mul_b = 8'd5;
    mul_en_in = 1'b1;
    expected_pipeline[0] = 16'd15;
    expected_en_pipeline[0] = 1'b1;
    @(posedge clk);
    #1;
    
    // Test 2: Another value while first propagates
    test_num = 2;
    mul_a = 8'd10;
    mul_b = 8'd10;
    mul_en_in = 1'b1;
    expected_pipeline[0] = 16'd100;
    expected_en_pipeline[0] = 1'b1;
    // Shift previous
    expected_pipeline[1] = 16'd15;
    expected_en_pipeline[1] = 1'b1;
    @(posedge clk);
    #1;
    
    // Test 3: Boundary - maximum values (255 * 255 = 65025)
    test_num = 3;
    mul_a = 8'd255;
    mul_b = 8'd255;
    mul_en_in = 1'b1;
    expected_pipeline[0] = 16'd65025;
    expected_en_pipeline[0] = 1'b1;
    expected_pipeline[1] = 16'd100;
    expected_en_pipeline[1] = 1'b1;
    expected_pipeline[2] = 16'd15;
    expected_en_pipeline[2] = 1'b1;
    @(posedge clk);
    #1;
    
    // Test 4: Zero multiplication
    test_num = 4;
    mul_a = 8'd0;
    mul_b = 8'd100;
    mul_en_in = 1'b1;
    expected_pipeline[0] = 16'd0;
    expected_en_pipeline[0] = 1'b1;
    expected_pipeline[1] = 16'd65025;
    expected_en_pipeline[1] = 1'b1;
    expected_pipeline[2] = 16'd100;
    expected_en_pipeline[2] = 1'b1;
    expected_pipeline[3] = 16'd15;
    expected_en_pipeline[3] = 1'b1;
    @(posedge clk);
    #1;
    
    // Test 5: Disable input, let pipeline flush
    test_num = 5;
    mul_a = 8'd50;
    mul_b = 8'd50;
    mul_en_in = 1'b0;
    expected_pipeline[0] = 16'd0; // disabled
    expected_en_pipeline[0] = 1'b0;
    expected_pipeline[1] = 16'd0; // from test 4
    expected_en_pipeline[1] = 1'b1;
    expected_pipeline[2] = 16'd65025;
    expected_en_pipeline[2] = 1'b1;
    expected_pipeline[3] = 16'd100;
    expected_en_pipeline[3] = 1'b1;
    @(posedge clk);
    #1;
    
    // Continue flushing pipeline
    test_num = 6;
    mul_en_in = 1'b0;
    expected_pipeline[0] = 16'd0;
    expected_en_pipeline[0] = 1'b0;
    expected_pipeline[1] = 16'd0;
    expected_en_pipeline[1] = 1'b0;
    expected_pipeline[2] = 16'd0;
    expected_en_pipeline[2] = 1'b1;
    expected_pipeline[3] = 16'd65025;
    expected_en_pipeline[3] = 1'b1;
    @(posedge clk);
    #1;
    
    test_num = 7;
    mul_en_in = 1'b0;
    expected_pipeline[0] = 16'd0;
    expected_en_pipeline[0] = 1'b0;
    expected_pipeline[1] = 16'd0;
    expected_en_pipeline[1] = 1'b0;
    expected_pipeline[2] = 16'd0;
    expected_en_pipeline[2] = 1'b0;
    expected_pipeline[3] = 16'd0;
    expected_en_pipeline[3] = 1'b1;
    @(posedge clk);
    #1;
    
    // Pipeline should be empty now
    test_num = 8;
    mul_en_in = 1'b0;
    expected_pipeline[0] = 16'd0;
    expected_en_pipeline[0] = 1'b0;
    expected_pipeline[1] = 16'd0;
    expected_en_pipeline[1] = 1'b0;
    expected_pipeline[2] = 16'd0;
    expected_en_pipeline[2] = 1'b0;
    expected_pipeline[3] = 16'd0;
    expected_en_pipeline[3] = 1'b0;
    @(posedge clk);
    #1;
    
    // Test 9: Re-enable with new data
    test_num = 9;
    mul_a = 8'd17;
    mul_b = 8'd17;
    mul_en_in = 1'b1;
    expected_pipeline[0] = 16'd289;
    expected_en_pipeline[0] = 1'b1;
    @(posedge clk);
    #1;
    
    // Test 10: Boundary - one operand zero
    test_num = 10;
    mul_a = 8'd0;
    mul_b = 8'd255;
    mul_en_in = 1'b1;
    expected_pipeline[0] = 16'd0;
    expected_en_pipeline[0] = 1'b1;
    expected_pipeline[1] = 16'd289;
    expected_en_pipeline[1] = 1'b1;
    @(posedge clk);
    #1;
    
    // Test 11: Boundary - one operand max, other 1
    test_num = 11;
    mul_a = 8'd1;
    mul_b = 8'd255;
    mul_en_in = 1'b1;
    expected_pipeline[0] = 16'd255;
    expected_en_pipeline[0] = 1'b1;
    expected_pipeline[1] = 16'd0;
    expected_en_pipeline[1] = 1'b1;
    expected_pipeline[2] = 16'd289;
    expected_en_pipeline[2] = 1'b1;
    @(posedge clk);
    #1;
    
    // Test 12: Random values
    test_num = 12;
    mul_a = 8'd123;
    mul_b = 8'd45;
    mul_en_in = 1'b1;
    expected_pipeline[0] = 16'd5535;
    expected_en_pipeline[0] = 1'b1;
    expected_pipeline[1] = 16'd255;
    expected_en_pipeline[1] = 1'b1;
    expected_pipeline[2] = 16'd0;
    expected_en_pipeline[2] = 1'b1;
    expected_pipeline[3] = 16'd289;
    expected_en_pipeline[3] = 1'b1;
    @(posedge clk);
    #1;
    
    // Flush and check final
    test_num = 13;
    mul_en_in = 1'b0;
    expected_pipeline[0] = 16'd0;
    expected_en_pipeline[0] = 1'b0;
    expected_pipeline[1] = 16'd5535;
    expected_en_pipeline[1] = 1'b1;
    expected_pipeline[2] = 16'd255;
    expected_en_pipeline[2] = 1'b1;
    expected_pipeline[3] = 16'd0;
    expected_en_pipeline[3] = 1'b1;
    @(posedge clk);
    #1;
    
    test_num = 14;
    mul_en_in = 1'b0;
    expected_pipeline[0] = 16'd0;
    expected_en_pipeline[0] = 1'b0;
    expected_pipeline[1] = 16'd0;
    expected_en_pipeline[1] = 1'b0;
    expected_pipeline[2] = 16'd5535;
    expected_en_pipeline[2] = 1'b1;
    expected_pipeline[3] = 16'd255;
    expected_en_pipeline[3] = 1'b1;
    @(posedge clk);
    #1;
    
    test_num = 15;
    mul_en_in = 1'b0;
    expected_pipeline[0] = 16'd0;
    expected_en_pipeline[0] = 1'b0;
    expected_pipeline[1] = 16'd0;
    expected_en_pipeline[1] = 1'b0;
    expected_pipeline[2] = 16'd0;
    expected_en_pipeline[2] = 1'b0;
    expected_pipeline[3] = 16'd5535;
    expected_en_pipeline[3] = 1'b1;
    @(posedge clk);
    #1;
    
    test_num = 16;
    mul_en_in = 1'b0;
    expected_pipeline[0] = 16'd0;
    expected_en_pipeline[0] = 1'b0;
    expected_pipeline[1] = 16'd0;
    expected_en_pipeline[1] = 1'b0;
    expected_pipeline[2] = 16'd0;
    expected_en_pipeline[2] = 1'b0;
    expected_pipeline[3] = 16'd0;
    expected_en_pipeline[3] = 1'b0;
    @(posedge clk);
    #1;
    
    // Final check - outputs should be zero
    if (mul_en_out !== 1'b0 || mul_out !== 16'd0) begin
      $display("CHECK ac1_under_simulation_multi_pipe_8bit_produce FAIL: Final state incorrect");
    end else begin
      $display("CHECK ac1_under_simulation_multi_pipe_8bit_produce PASS");
    end
    
    $finish;
  end
  
  // Monitor and check outputs
  // Pipeline depth is typically 4 stages for 8-bit multiplier
  // We track expected values through the pipeline
  
  reg [15:0] pipe_data[0:3];
  reg pipe_en[0:3];
  integer stage;
  
  initial begin
    for (stage = 0; stage < 4; stage = stage + 1) begin
      pipe_data[stage] = 16'd0;
      pipe_en[stage] = 1'b0;
    end
  end
  
  // Pipeline tracking - update on each clock
  always @(posedge clk) begin
    if (!rst_n) begin
      for (stage = 0; stage < 4; stage = stage + 1) begin
        pipe_data[stage] <= 16'd0;
        pipe_en[stage] <= 1'b0;
      end
    end else begin
      // Shift pipeline
      pipe_data[3] <= pipe_data[2];
      pipe_en[3] <= pipe_en[2];
      pipe_data[2] <= pipe_data[1];
      pipe_en[2] <= pipe_en[1];
      pipe_data[1] <= pipe_data[0];
      pipe_en[1] <= pipe_en[0];
      // Load new data
      if (mul_en_in) begin
        pipe_data[0] <= mul_a * mul_b;
        pipe_en[0] <= 1'b1;
      end else begin
        pipe_data[0] <= 16'd0;
        pipe_en[0] <= 1'b0;
      end
    end
  end
  
  // Check outputs after clock edge
  always @(negedge clk) begin
    if (rst_n) begin
      // Check mul_en_out matches expected pipeline enable
      if (mul_en_out !== pipe_en[3]) begin
        $display("Time %0t: mul_en_out mismatch, expected %b, got %b", $time, pipe_en[3], mul_en_out);
      end
      // Check mul_out matches expected pipeline data when enabled
      if (mul_en_out && (mul_out !== pipe_data[3])) begin
        $display("Time %0t: mul_out mismatch, expected %d, got %d", $time, pipe_data[3], mul_out);
      end
      // When not enabled, output should be 0
      if (!mul_en_out && (mul_out !== 16'd0)) begin
        $display("Time %0t: mul_out should be 0 when disabled, got %d", $time, mul_out);
      end
    end
  end

endmodule