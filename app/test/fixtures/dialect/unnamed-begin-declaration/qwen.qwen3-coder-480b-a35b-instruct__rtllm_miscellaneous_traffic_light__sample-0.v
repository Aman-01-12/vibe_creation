module tb;

  reg clk;
  reg rst_n;
  reg pass_request;
  wire [7:0] clock;
  wire red;
  wire yellow;
  wire green;

  // Internal variables for tracking state
  integer cycle_count;
  integer green_cycles_remaining;
  integer current_state_duration;
  integer i;
  reg check_ac1_passed;
  reg check_known_answer_passed;

  // Instantiate the DUT
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
  initial begin
    clk = 0;
    forever #5 clk = ~clk;  // 10 time units per clock period
  end

  // Main test procedure
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);

    // Initialize signals
    rst_n = 0;
    pass_request = 0;
    cycle_count = 0;
    green_cycles_remaining = 0;
    current_state_duration = 0;
    check_ac1_passed = 1;
    check_known_answer_passed = 1;

    // Apply reset
    #15;
    rst_n = 1;
    #10;

    // Check initial state: should be RED
    if (!(red === 1 && yellow === 0 && green === 0)) begin
      $display("FAIL: Initial state is not RED");
      check_ac1_passed = 0;
    end

    // Wait for GREEN phase (10 cycles of RED)
    for (i = 0; i < 10; i = i + 1) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (!(red === 1 && yellow === 0 && green === 0)) begin
        $display("FAIL: Not in RED during cycle %0d", cycle_count);
        check_ac1_passed = 0;
      end
    end

    // Should now be GREEN
    if (!(red === 0 && yellow === 0 && green === 1)) begin
      $display("FAIL: Expected GREEN after 10 RED cycles");
      check_ac1_passed = 0;
    end

    // Stay in GREEN for 60 cycles unless interrupted
    green_cycles_remaining = 60;
    current_state_duration = 0;
    
    // Drive pass_request when green_cycles_remaining > 10 (e.g., at cycle 50)
    while (green_cycles_remaining > 0) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      current_state_duration = current_state_duration + 1;
      
      if (!(red === 0 && yellow === 0 && green === 1)) begin
        $display("FAIL: Not in GREEN during cycle %0d", cycle_count);
        check_ac1_passed = 0;
      end

      // Press button when there are more than 10 cycles left
      if (green_cycles_remaining == 11 && current_state_duration == 50) begin
        pass_request = 1;
        // Expect green_cycles_remaining to become 10
        green_cycles_remaining = 10;
      end else begin
        green_cycles_remaining = green_cycles_remaining - 1;
      end

      // Deassert pass_request next cycle
      if (pass_request) begin
        @(posedge clk);
        cycle_count = cycle_count + 1;
        current_state_duration = current_state_duration + 1;
        pass_request = 0;
        green_cycles_remaining = green_cycles_remaining - 1;
        if (!(red === 0 && yellow === 0 && green === 1)) begin
          $display("FAIL: Not in GREEN during cycle %0d after button press", cycle_count);
          check_ac1_passed = 0;
        end
        break;
      end
    end

    // Continue counting down green cycles
    while (green_cycles_remaining > 0) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      current_state_duration = current_state_duration + 1;
      green_cycles_remaining = green_cycles_remaining - 1;
      if (!(red === 0 && yellow === 0 && green === 1)) begin
        $display("FAIL: Not in GREEN during cycle %0d", cycle_count);
        check_ac1_passed = 0;
      end
    end

    // Should now be YELLOW
    if (!(red === 0 && yellow === 1 && green === 0)) begin
      $display("FAIL: Expected YELLOW after GREEN");
      check_ac1_passed = 0;
    end

    // Stay in YELLOW for 5 cycles
    for (i = 0; i < 5; i = i + 1) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (!(red === 0 && yellow === 1 && green === 0)) begin
        $display("FAIL: Not in YELLOW during cycle %0d", cycle_count);
        check_ac1_passed = 0;
      end
    end

    // Should now be RED again
    if (!(red === 1 && yellow === 0 && green === 0)) begin
      $display("FAIL: Expected RED after YELLOW");
      check_ac1_passed = 0;
    end

    // Stay in RED for 10 cycles
    for (i = 0; i < 10; i = i + 1) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (!(red === 1 && yellow === 0 && green === 0)) begin
        $display("FAIL: Not in RED during cycle %0d", cycle_count);
        check_ac1_passed = 0;
      end
    end

    // Should now be GREEN again
    if (!(red === 0 && yellow === 0 && green === 1)) begin
      $display("FAIL: Expected GREEN after RED");
      check_ac1_passed = 0;
    end

    // Test known answer counter increments correctly
    // Sample clock output at various points and verify it increments
    reg [7:0] prev_clock;
    prev_clock = clock;
    repeat(5) @(posedge clk);
    if (clock !== (prev_clock + 5)) begin
      $display("FAIL: Known answer counter did not increment properly. Expected %0d, got %0d", (prev_clock + 5), clock);
      check_known_answer_passed = 0;
    end

    // Final verdict
    if (check_ac1_passed)
      $display("CHECK ac1_under_simulation_traffic_light_produces PASS");
    else
      $display("CHECK ac1_under_simulation_traffic_light_produces FAIL");

    if (check_known_answer_passed)
      $display("CHECK known_answer_counter_increments PASS");
    else
      $display("CHECK known_answer_counter_increments FAIL");

    $finish;
  end

endmodule