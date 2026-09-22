module tb;
  reg clk;
  reg rst_n;
  reg pass_request;
  wire [8:0] clock;
  wire red;
  wire yellow;
  wire green;

  // State tracking
  reg [2:0] state;  // 0: GREEN, 1: YELLOW, 2: RED
  reg [8:0] countdown;
  reg expected_red, expected_yellow, expected_green;
  integer cycle;
  integer pass_request_active_cycle;

  // Constants
  parameter GREEN_TIME = 60;
  parameter YELLOW_TIME = 5;
  parameter RED_TIME = 10;
  parameter THRESHOLD = 10;

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
  always begin
    clk = 0; #5;
    clk = 1; #5;
  end

  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);

    // Initialize variables
    pass_request = 0;
    rst_n = 0;
    cycle = 0;
    state = 0;
    countdown = 0;
    pass_request_active_cycle = -1;

    // Reset assertion
    @(posedge clk);
    @(negedge clk);
    rst_n = 1;

    // Wait a few cycles after reset
    @(posedge clk); @(negedge clk);
    @(posedge clk); @(negedge clk);

    // Reset state: should be RED
    expected_red = 1;
    expected_yellow = 0;
    expected_green = 0;

    if (!(red == expected_red && yellow == expected_yellow && green == expected_green)) begin
      $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: after reset, expected RED=1, YELLOW=0, GREEN=0");
    end else begin
      $display("CHECK ac1_under_simulation_traffic_light_produces PASS");
    end

    // Start nominal sequence: GREEN for 60 cycles
    state = 0;
    countdown = GREEN_TIME;

    repeat(GREEN_TIME - 1) begin
      @(posedge clk);
      cycle = cycle + 1;
      countdown = countdown - 1;
      expected_red = 0;
      expected_yellow = 0;
      expected_green = 1;

      if (!(red == expected_red && yellow == expected_yellow && green == expected_green)) begin
        $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: at cycle %d, expected GREEN=1", cycle);
        break;
      end
    end

    // Press pedestrian button when >10 cycles left in green
    pass_request = 1;
    @(posedge clk);
    cycle = cycle + 1;
    pass_request_active_cycle = cycle;
    pass_request = 0;

    // Now countdown should be shortened to 10
    countdown = THRESHOLD;

    repeat(THRESHOLD - 1) begin
      @(posedge clk);
      cycle = cycle + 1;
      countdown = countdown - 1;
      expected_red = 0;
      expected_yellow = 0;
      expected_green = 1;

      if (!(red == expected_red && yellow == expected_yellow && green == expected_green)) begin
        $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: after button press, expected GREEN=1 for 10 cycles");
        break;
      end
    end

    // Transition to YELLOW
    state = 1;
    countdown = YELLOW_TIME;

    repeat(YELLOW_TIME) begin
      @(posedge clk);
      cycle = cycle + 1;
      countdown = countdown - 1;
      expected_red = 0;
      expected_yellow = 1;
      expected_green = 0;

      if (!(red == expected_red && yellow == expected_yellow && green == expected_green)) begin
        $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: expected YELLOW=1");
        break;
      end
    end

    // Transition to RED
    state = 2;
    countdown = RED_TIME;

    repeat(RED_TIME) begin
      @(posedge clk);
      cycle = cycle + 1;
      countdown = countdown - 1;
      expected_red = 1;
      expected_yellow = 0;
      expected_green = 0;

      if (!(red == expected_red && yellow == expected_yellow && green == expected_green)) begin
        $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: expected RED=1");
        break;
      end
    end

    // Now test button press when <10 cycles left in green
    // Let it go back to green
    state = 0;
    countdown = GREEN_TIME;

    repeat(GREEN_TIME - 15) begin
      @(posedge clk);
      cycle = cycle + 1;
      countdown = countdown - 1;
      expected_red = 0;
      expected_yellow = 0;
      expected_green = 1;

      if (!(red == expected_red && yellow == expected_yellow && green == expected_green)) begin
        $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: during normal green");
        break;
      end
    end

    // Now less than 10 cycles left, press button
    pass_request = 1;
    @(posedge clk);
    cycle = cycle + 1;
    pass_request_active_cycle = cycle;
    pass_request = 0;

    // Countdown should remain unchanged
    // Continue green
    repeat(14) begin
      @(posedge clk);
      cycle = cycle + 1;
      countdown = countdown - 1;
      expected_red = 0;
      expected_yellow = 0;
      expected_green = 1;

      if (!(red == expected_red && yellow == expected_yellow && green == expected_green)) begin
        $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: after late button press, green should continue");
        break;
      end
    end

    // Transition to yellow
    state = 1;
    countdown = YELLOW_TIME;

    repeat(YELLOW_TIME) begin
      @(posedge clk);
      cycle = cycle + 1;
      countdown = countdown - 1;
      expected_red = 0;
      expected_yellow = 1;
      expected_green = 0;

      if (!(red == expected_red && yellow == expected_yellow && green == expected_green)) begin
        $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: expected YELLOW=1");
        break;
      end
    end

    // Transition to red
    state = 2;
    countdown = RED_TIME;

    repeat(RED_TIME) begin
      @(posedge clk);
      cycle = cycle + 1;
      countdown = countdown - 1;
      expected_red = 1;
      expected_yellow = 0;
      expected_green = 0;

      if (!(red == expected_red && yellow == expected_yellow && green == expected_green)) begin
        $display("CHECK ac1_under_simulation_traffic_light_produces FAIL: expected RED=1");
        break;
      end
    end

    // If we got here without failing, the behavior is correct
    $display("CHECK ac1_under_simulation_traffic_light_produces PASS");

    // Now check known_answer_counter_increments
    // The 'clock' output is a 9-bit counter that should increment every cycle
    // Reset again to observe counter
    rst_n = 0;
    @(posedge clk); @(negedge clk);
    rst_n = 1;

    // Sample clock output over several cycles
    reg [8:0] expected_clock;
    expected_clock = 0;

    repeat(5) begin
      @(posedge clk);
      expected_clock = expected_clock + 1;
      if (clock !== expected_clock) begin
        $display("CHECK known_answer_counter_increments FAIL: expected clock=%d, got %d", expected_clock, clock);
        break;
      end
    end

    // Check wraparound at 2^9 - 1
    expected_clock = 500;  // Fast forward conceptually
    repeat(500 - 5) begin
      @(posedge clk);
      expected_clock = expected_clock + 1;
    end

    // Now at 500
    if (clock !== 500) begin
      $display("CHECK known_answer_counter_increments FAIL: expected clock=500");
    end else begin
      @(posedge clk);
      expected_clock = expected_clock + 1;
      if (clock !== 501) begin
        $display("CHECK known_answer_counter_increments FAIL: expected clock=501");
      end else begin
        // Wrap at 511
        repeat(10) begin
          @(posedge clk);
          expected_clock = expected_clock + 1;
          if (expected_clock > 511) expected_clock = 0;
          if (clock !== expected_clock) begin
            $display("CHECK known_answer_counter_increments FAIL: expected clock=%d after wrap", expected_clock);
            break;
          end
        end
        $display("CHECK known_answer_counter_increments PASS");
      end
    end

    $finish;
  end
endmodule