module tb_traffic_light;
  reg clk;
  reg rst_n;
  reg pass_request;
  wire [1:0] clock;
  wire red;
  wire yellow;
  wire green;

  // Declare internal variables for state tracking
  reg [1:0] expected_state;
  reg [5:0] expected_count;
  reg expected_red, expected_yellow, expected_green;
  reg [1:0] state_G, state_Y, state_R;
  integer i;

  // Instantiate the design under test
  traffic_light dut (
    .pass_request(pass_request),
    .clock(clock),
    .red(red),
    .yellow(yellow),
    .green(green),
    .clk(clk),
    .rst_n(rst_n)
  );

  // Clock generation
  always begin
    clk = 0; #5;
    clk = 1; #5;
  end

  // State definitions
  initial begin
    state_G = 2'd0;
    state_Y = 2'd1;
    state_R = 2'd2;
  end

  initial begin
    // Dump VCD
    $dumpfile("dump.vcd");
    $dumpvars(0, tb_traffic_light);

    // Initialize inputs
    pass_request = 0;
    rst_n = 0;
    expected_count = 0;
    expected_state = state_G;
    expected_red = 0; expected_yellow = 0; expected_green = 1;

    // Assert reset
    @(posedge clk);
    @(negedge clk);

    // Release reset
    rst_n = 1;
    @(posedge clk);
    @(negedge clk);

    // Check reset release: should be in Green state
    if (red === 1'b0 && yellow === 1'b0 && green === 1'b1) begin
      $display("CHECK ac1_under_simulation_traffic_light_produces PASS");
    end else begin
      $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: after reset, expected green=1, got red=%b yellow=%b green=%b", red, yellow, green);
    end

    // Nominal sequence: stay in Green for 60 cycles
    for (i = 0; i < 59; i = i + 1) begin
      expected_count = i + 1;
      @(posedge clk);
      @(negedge clk);
      if (!(green === 1'b1 && yellow === 1'b0 && red === 1'b0)) begin
        $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: at cycle %d in green phase, lights wrong", i+1);
        break;
      end
    end

    // On 60th cycle, still green
    @(posedge clk);
    @(negedge clk);
    if (green === 1'b1 && yellow === 1'b0 && red === 1'b0) begin
      // Now should transition to Yellow
      expected_state = state_Y;
      expected_green = 0; expected_yellow = 1; expected_red = 0;
      expected_count = 0;
      @(posedge clk);
      @(negedge clk);
      if (yellow === 1'b1 && red === 1'b0 && green === 1'b0) begin
        // Stay in Yellow for 5 cycles
        for (i = 0; i < 4; i = i + 1) begin
          expected_count = i + 1;
          @(posedge clk);
          @(negedge clk);
          if (!(yellow === 1'b1 && red === 1'b0 && green === 1'b0)) begin
            $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: during yellow phase, lights wrong");
            break;
          end
        end
        // Transition to Red
        expected_state = state_R;
        expected_yellow = 0; expected_red = 1; expected_green = 0;
        expected_count = 0;
        @(posedge clk);
        @(negedge clk);
        if (red === 1'b1 && yellow === 1'b0 && green === 1'b0) begin
          // Stay in Red for 10 cycles
          for (i = 0; i < 9; i = i + 1) begin
            expected_count = i + 1;
            @(posedge clk);
            @(negedge clk);
            if (!(red === 1'b1 && yellow === 1'b0 && green === 1'b0)) begin
              $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: during red phase, lights wrong");
              break;
            end
          end
          // After 10 red cycles, should go back to Green
          expected_state = state_G;
          expected_red = 0; expected_yellow = 0; expected_green = 1;
          expected_count = 0;
          @(posedge clk);
          @(negedge clk);
          if (green === 1'b1 && red === 1'b0 && yellow === 1'b0) begin
            $display("CHECK ac1_under_simulation_traffic_light_produces PASS");
          end else begin
            $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: after red, expected green");
          end
        end else begin
          $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: expected red after yellow");
        end
      end else begin
        $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: expected yellow after green");
      end
    end else begin
      $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: expected green for 60 cycles");
    end

    // Test pedestrian button: press during green when more than 10 cycles remain
    // Reset and go to green
    rst_n = 0;
    @(posedge clk); @(negedge clk);
    rst_n = 1;
    @(posedge clk); @(negedge clk);

    // Advance 45 cycles into green (15 remain)
    for (i = 0; i < 45; i = i + 1) begin
      @(posedge clk); @(negedge clk);
    end

    // Press pass_request for one cycle
    pass_request = 1;
    @(posedge clk); @(negedge clk);
    pass_request = 0;

    // Now should shorten green to 10 more cycles total
    // So we should see green for 9 more cycles, then yellow
    expected_state = state_G;
    for (i = 0; i < 9; i = i + 1) begin
      @(posedge clk); @(negedge clk);
      if (!(green === 1'b1 && yellow === 1'b0 && red === 1'b0)) begin
        $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: after button press with >10 left, green phase broken");
        break;
      end
    end

    // Then transition to yellow
    @(posedge clk); @(negedge clk);
    if (yellow === 1'b1 && red === 1'b0 && green === 1'b0) begin
      $display("CHECK ac1_under_simulation_traffic_light_produces PASS");
    end else begin
      $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: after button press, expected yellow");
    end

    // Now test button press when less than 10 cycles remain in green
    // Reset and go to green
    rst_n = 0;
    @(posedge clk); @(negedge clk);
    rst_n = 1;
    @(posedge clk); @(negedge clk);

    // Advance 55 cycles into green (5 remain)
    for (i = 0; i < 55; i = i + 1) begin
      @(posedge clk); @(negedge clk);
    end

    // Press pass_request
    pass_request = 1;
    @(posedge clk); @(negedge clk);
    pass_request = 0;

    // Should still go to yellow after 5 more green cycles
    for (i = 0; i < 5; i = i + 1) begin
      @(posedge clk); @(negedge clk);
      if (!(green === 1'b1 && yellow === 1'b0 && red === 1'b0)) begin
        $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: after button with <10 left, green phase broken");
        break;
      end
    end

    // Then to yellow
    @(posedge clk); @(negedge clk);
    if (yellow === 1'b1 && red === 1'b0 && green === 1'b0) begin
      $display("CHECK ac1_under_simulation_traffic_light_produces PASS");
    end else begin
      $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: after button with <10 left, expected yellow");
    end

    // Now test known_answer_counter_increments
    // We observe the clock output as a counter
    // Reset
    rst_n = 0;
    @(posedge clk); @(negedge clk);
    if (clock === 2'd0) begin
      $display("CHECK known_answer_counter_increments PASS");
    end else begin
      $display("CHECK known_answer_counter_increments FAIL: reset value not 0");
    end

    rst_n = 1;
    // Observe 4 increments
    expected_count = 0;
    for (i = 0; i < 4; i = i + 1) begin
      expected_count = expected_count + 1;
      @(posedge clk); @(negedge clk);
      if (clock === expected_count) begin
        $display("CHECK known_answer_counter_increments PASS");
      } else begin
        $display("CHECK known_answer_counter_increments FAIL: expected %d, got %d", expected_count, clock);
      end
    end

    // Let it wrap: assume modulus is 4 from observation
    // After 3, next should be 0
    @(posedge clk); @(negedge clk);
    if (clock === 2'd0) begin
      $display("CHECK known_answer_counter_increments PASS");
    } else begin
      $display("CHECK known_answer_counter_increments FAIL: wrap failed, expected 0, got %d", clock);
    end

    // Additional test: ensure pass_request is sampled correctly on clock edge
    // Test that pass_request during red has no effect
    rst_n = 0;
    @(posedge clk); @(negedge clk);
    rst_n = 1;
    @(posedge clk); @(negedge clk);

    // Fast forward to red state: 60 (green) + 5 (yellow) = 65 cycles
    for (i = 0; i < 65; i = i + 1) begin
      @(posedge clk); @(negedge clk);
    end

    // Now in red; press pass_request
    pass_request = 1;
    @(posedge clk); @(negedge clk);
    pass_request = 0;

    // Should remain in red for the full 10 cycles
    for (i = 0; i < 9; i = i + 1) begin
      @(posedge clk); @(negedge clk);
      if (!(red === 1'b1 && yellow === 1'b0 && green === 1'b0)) begin
        $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: during red phase with button press, lights wrong");
        break;
      end
    end

    // Then transition to green
    @(posedge clk); @(negedge clk);
    if (green === 1'b1 && red === 1'b0 && yellow === 1'b0) begin
      $display("CHECK ac1_under_simulation_traffic_light_produces PASS");
    end else begin
      $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: after red with button press, expected green");
    end

    $finish;
  end
endmodule