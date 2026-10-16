module tb_accu;

  // Inputs
  reg clk;
  reg rst_n;
  reg [7:0] data_in;
  reg valid_in;

  // Outputs
  wire [9:0] data_out;
  wire valid_out;

  // Test variables
  integer i;
  integer test_case;
  integer error_count;
  reg [9:0] expected_accu;
  reg [9:0] observed_data;
  integer valid_count;

  // Instantiate the Unit Under Test (UUT)
  accu uut (
    .clk(clk),
    .rst_n(rst_n),
    .data_in(data_in),
    .valid_in(valid_in),
    .data_out(data_out),
    .valid_out(valid_out)
  );

  // Clock generation: 10ns period
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  // Test stimulus
  initial begin
    // Initialize Inputs
    rst_n = 0;
    data_in = 0;
    valid_in = 0;
    error_count = 0;

    // Wait for global reset
    #10;

    // Release reset
    rst_n = 1;
    #10; // Wait for reset to settle

    $display("Starting Testbench for accu module");

    // -----------------------------------------------------------
    // Test Case 1: Basic Accumulation (Small values)
    // -----------------------------------------------------------
    $display("Test Case 1: Basic Accumulation");
    expected_accu = 0;

    // Drive 4 valid inputs
    // 1. data_in = 10
    data_in = 8'd10; valid_in = 1; expected_accu = expected_accu + 10;
    #10;
    valid_in = 0;
    #10;

    // 2. data_in = 20
    data_in = 8'd20; valid_in = 1; expected_accu = expected_accu + 20;
    #10;
    valid_in = 0;
    #10;

    // 3. data_in = 30
    data_in = 8'd30; valid_in = 1; expected_accu = expected_accu + 30;
    #10;
    valid_in = 0;
    #10;

    // 4. data_in = 40
    data_in = 8'd40; valid_in = 1; expected_accu = expected_accu + 40;
    #10;
    valid_in = 0;

    // Wait for valid_out
    wait(valid_out == 1);
    observed_data = data_out;
    #1; // Small delay for sampling
    if (observed_data !== expected_accu) begin
      $display("Error: Expected %d, Got %d", expected_accu, observed_data);
      error_count = error_count + 1;
    end
    #10;

    // -----------------------------------------------------------
    // Test Case 2: Boundary Values (Max values)
    // -----------------------------------------------------------
    $display("Test Case 2: Boundary Values");
    expected_accu = 0;

    // 1. data_in = 255
    data_in = 8'd255; valid_in = 1; expected_accu = expected_accu + 255;
    #10;
    valid_in = 0;
    #10;

    // 2. data_in = 255
    data_in = 8'd255; valid_in = 1; expected_accu = expected_accu + 255;
    #10;
    valid_in = 0;
    #10;

    // 3. data_in = 255
    data_in = 8'd255; valid_in = 1; expected_accu = expected_accu + 255;
    #10;
    valid_in = 0;
    #10;

    // 4. data_in = 255
    data_in = 8'd255; valid_in = 1; expected_accu = expected_accu + 255;
    #10;
    valid_in = 0;

    // Wait for valid_out
    wait(valid_out == 1);
    observed_data = data_out;
    #1;
    if (observed_data !== expected_accu) begin
      $display("Error: Expected %d, Got %d", expected_accu, observed_data);
      error_count = error_count + 1;
    end
    #10;

    // -----------------------------------------------------------
    // Test Case 3: Zero Values
    // -----------------------------------------------------------
    $display("Test Case 3: Zero Values");
    expected_accu = 0;

    // 1. data_in = 0
    data_in = 8'd0; valid_in = 1; expected_accu = expected_accu + 0;
    #10;
    valid_in = 0;
    #10;

    // 2. data_in = 0
    data_in = 8'd0; valid_in = 1; expected_accu = expected_accu + 0;
    #10;
    valid_in = 0;
    #10;

    // 3. data_in = 0
    data_in = 8'd0; valid_in = 1; expected_accu = expected_accu + 0;
    #10;
    valid_in = 0;
    #10;

    // 4. data_in = 0
    data_in = 8'd0; valid_in = 1; expected_accu = expected_accu + 0;
    #10;
    valid_in = 0;

    // Wait for valid_out
    wait(valid_out == 1);
    observed_data = data_out;
    #1;
    if (observed_data !== expected_accu) begin
      $display("Error: Expected %d, Got %d", expected_accu, observed_data);
      error_count = error_count + 1;
    end
    #10;

    // -----------------------------------------------------------
    // Test Case 4: Mixed Values
    // -----------------------------------------------------------
    $display("Test Case 4: Mixed Values");
    expected_accu = 0;

    // 1. data_in = 1
    data_in = 8'd1; valid_in = 1; expected_accu = expected_accu + 1;
    #10;
    valid_in = 0;
    #10;

    // 2. data_in = 128
    data_in = 8'd128; valid_in = 1; expected_accu = expected_accu + 128;
    #10;
    valid_in = 0;
    #10;

    // 3. data_in = 127
    data_in = 8'd127; valid_in = 1; expected_accu = expected_accu + 127;
    #10;
    valid_in = 0;
    #10;

    // 4. data_in = 254
    data_in = 8'd254; valid_in = 1; expected_accu = expected_accu + 254;
    #10;
    valid_in = 0;

    // Wait for valid_out
    wait(valid_out == 1);
    observed_data = data_out;
    #1;
    if (observed_data !== expected_accu) begin
      $display("Error: Expected %d, Got %d", expected_accu, observed_data);
      error_count = error_count + 1;
    end
    #10;

    // -----------------------------------------------------------
    // Test Case 5: Reset Behavior
    // -----------------------------------------------------------
    $display("Test Case 5: Reset Behavior");
    
    // Apply reset
    rst_n = 0;
    #10;
    rst_n = 1;
    #10;

    // Check if outputs are cleared (assuming 0 for data_out and 0 for valid_out)
    if (valid_out !== 0) begin
      $display("Error: valid_out not cleared after reset");
      error_count = error_count + 1;
    end
    if (data_out !== 0) begin
      $display("Error: data_out not cleared after reset");
      error_count = error_count + 1;
    end

    // -----------------------------------------------------------
    // Test Case 6: Valid_in Low (Ignore Input)
    // -----------------------------------------------------------
    $display("Test Case 6: Valid_in Low");
    expected_accu = 0;

    // Drive input with valid_in = 0 (should be ignored)
    data_in = 8'd100; valid_in = 0;
    #10;
    #10;

    // Drive 4 valid inputs
    data_in = 8'd5; valid_in = 1; expected_accu = expected_accu + 5;
    #10;
    valid_in = 0;
    #10;

    data_in = 8'd10; valid_in = 1; expected_accu = expected_accu + 10;
    #10;
    valid_in = 0;
    #10;

    data_in = 8'd15; valid_in = 1; expected_accu = expected_accu + 15;
    #10;
    valid_in = 0;
    #10;

    data_in = 8'd20; valid_in = 1; expected_accu = expected_accu + 20;
    #10;
    valid_in = 0;

    // Wait for valid_out
    wait(valid_out == 1);
    observed_data = data_out;
    #1;
    if (observed_data !== expected_accu) begin
      $display("Error: Expected %d, Got %d", expected_accu, observed_data);
      error_count = error_count + 1;
    end
    #10;

    // -----------------------------------------------------------
    // Final Check
    // -----------------------------------------------------------
    if (error_count == 0) begin
      $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS");
    end else begin
      $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL");
    end

    $finish;
  end

endmodule