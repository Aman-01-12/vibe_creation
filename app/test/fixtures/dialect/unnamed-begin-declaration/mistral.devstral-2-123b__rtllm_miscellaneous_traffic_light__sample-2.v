`timescale 1ns/1ps

module traffic_light_tb;

  // Declare signals
  reg clk;
  reg rst_n;
  reg pass_request;
  wire [7:0] clock;
  wire red;
  wire yellow;
  wire green;

  // Instantiate the traffic_light module
  traffic_light uut (
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
    forever #5 clk = ~clk;
  end

  // Testbench variables
  integer cycle_count;
  integer green_cycles;
  integer yellow_cycles;
  integer red_cycles;
  integer pedestrian_press_cycle;
  integer expected_green_cycles;

  // Main test sequence
  initial begin
    // Initialize
    $dumpfile("dump.vcd");
    $dumpvars(0, traffic_light_tb);

    clk = 0;
    rst_n = 0;
    pass_request = 0;

    // Reset sequence
    #10;
    rst_n = 1;
    #10;

    // Initialize counters
    cycle_count = 0;
    green_cycles = 0;
    yellow_cycles = 0;
    red_cycles = 0;
    pedestrian_press_cycle = 0;

    // Test normal operation
    // Green phase (60 cycles)
    while (green_cycles < 60) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (green) green_cycles = green_cycles + 1;
    end

    // Yellow phase (5 cycles)
    while (yellow_cycles < 5) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (yellow) yellow_cycles = yellow_cycles + 1;
    end

    // Red phase (10 cycles)
    while (red_cycles < 10) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (red) red_cycles = red_cycles + 1;
    end

    // Check normal operation
    if (green_cycles == 60 && yellow_cycles == 5 && red_cycles == 10) begin
      $display("CHECK ac1_under_simulation_traffic_light_produces PASS");
    end else begin
      $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: Expected 60 green, 5 yellow, 10 red cycles");
    end

    // Reset counters for pedestrian test
    green_cycles = 0;
    yellow_cycles = 0;
    red_cycles = 0;

    // Test pedestrian button press during green phase
    // Wait for 30 cycles (middle of green phase)
    while (green_cycles < 30) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (green) green_cycles = green_cycles + 1;
    end

    // Press pedestrian button
    pass_request = 1;
    pedestrian_press_cycle = cycle_count;
    expected_green_cycles = 10; // Should be shortened to 10 cycles

    // Continue until green phase ends
    while (green_cycles < 30 + expected_green_cycles) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (green) green_cycles = green_cycles + 1;
    end

    // Release pedestrian button
    pass_request = 0;

    // Check if green phase was shortened to 10 cycles
    if (green_cycles == 30 + expected_green_cycles) begin
      $display("CHECK ac1_under_simulation_traffic_light_produces PASS");
    end else begin
      $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: Expected green phase to be shortened to 10 cycles");
    end

    // Continue to yellow and red phases
    while (yellow_cycles < 5) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (yellow) yellow_cycles = yellow_cycles + 1;
    end

    while (red_cycles < 10) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (red) red_cycles = red_cycles + 1;
    end

    // Test pedestrian button press near end of green phase
    // Reset counters
    green_cycles = 0;
    yellow_cycles = 0;
    red_cycles = 0;

    // Wait for 55 cycles (near end of green phase)
    while (green_cycles < 55) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (green) green_cycles = green_cycles + 1;
    end

    // Press pedestrian button
    pass_request = 1;
    pedestrian_press_cycle = cycle_count;
    expected_green_cycles = 5; // Should remain unchanged (less than 10 cycles)

    // Continue until green phase ends
    while (green_cycles < 55 + expected_green_cycles) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (green) green_cycles = green_cycles + 1;
    end

    // Release pedestrian button
    pass_request = 0;

    // Check if green phase remained unchanged
    if (green_cycles == 55 + expected_green_cycles) begin
      $display("CHECK ac1_under_simulation_traffic_light_produces PASS");
    end else begin
      $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: Expected green phase to remain unchanged");
    end

    // Continue to yellow and red phases
    while (yellow_cycles < 5) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (yellow) yellow_cycles = yellow_cycles + 1;
    end

    while (red_cycles < 10) begin
      @(posedge clk);
      cycle_count = cycle_count + 1;
      if (red) red_cycles = red_cycles + 1;
    end

    // Check known answer counter increments
    // The clock output should increment every cycle
    integer expected_clock;
    expected_clock = 0;
    integer clock_errors;
    clock_errors = 0;

    // Check clock increments for 100 cycles
    for (integer i = 0; i < 100; i = i + 1) begin
      @(posedge clk);
      expected_clock = (expected_clock + 1) % 256;
      if (clock !== expected_clock) begin
        clock_errors = clock_errors + 1;
      end
    end

    if (clock_errors == 0) begin
      $display("CHECK known_answer_counter_increments PASS");
    end else begin
      $display("CHECK known_answer_counter_increments FAIL: Clock did not increment correctly");
    end

    // Finish simulation
    $finish;
  end

endmodule
