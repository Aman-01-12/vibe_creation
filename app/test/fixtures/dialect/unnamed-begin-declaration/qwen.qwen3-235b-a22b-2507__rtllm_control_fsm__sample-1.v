module tb;
  reg CLK;
  reg RST;
  reg IN;
  wire MATCH;

  // Known answer: the pattern to detect is 10011
  // We compute expected MATCH based on the history of IN
  // Since it's a Mealy FSM, output depends on current state and input
  // We model the expected behavior by tracking the expected state transitions
  // But note: we do NOT build a shadow FSM. Instead, we derive expected MATCH
  // from the sequence of inputs, by checking if the last 5 bits are 10011.

  // However, the spec says "continuous input and loop detection", meaning
  // that after detecting 10011, the FSM may continue to detect overlapping patterns.
  // For example, if input is 100110011, we expect MATCH=1 at the end of first 10011,
  // and then if the next bits are 0011, we may get another MATCH=1 if the FSM allows overlap.

  // But the pattern 10011: let's analyze possible overlap:
  //   10011
  //      10011 -> no overlap because the suffix "11" does not match prefix "10"
  // So no overlapping detection is possible. Thus, after 10011, we start fresh.

  // Therefore, expected MATCH is 1 if and only if the last five bits (including current) are 1,0,0,1,1.

  // We'll keep a 5-bit shift register of past inputs, updated on every clock.
  reg [4:0] expected_history;

  // We compute expected_MATCH at each cycle as (expected_history == 5'b10011)
  reg expected_MATCH;

  // DUT instantiation
  fsm uut (
    .IN(IN),
    .MATCH(MATCH),
    .CLK(CLK),
    .RST(RST)
  );

  // Clock generation
  always begin
    CLK = 1'b0;
    #5;
    CLK = 1'b1;
    #5;
  end

  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);

    // Initialize variables
    IN = 0;
    RST = 1;
    expected_history = 0;

    // Assert reset at time 0
    // According to the spec, RST is active-high and synchronous
    // So we hold RST high for one clock cycle

    @(posedge CLK);
    // On first posedge, RST is high -> should reset
    @(negedge CLK);
    // After first posedge, we are in reset state
    // Now deassert reset
    RST = 0;

    // We need to check that after reset, MATCH is 0
    // But note: since it's a Mealy machine, and we haven't given any input,
    // the state should be reset to initial state, and with no input history, MATCH=0

    // However, we cannot sample MATCH at the same posedge as reset deassertion
    // because the design updates on posedge, and we sample at negedge

    @(negedge CLK);
    expected_MATCH = (expected_history == 5'b10011);
    if (MATCH === 1'b0) begin
      $display("CHECK ac1_under_simulation_fsm_produces_the_behavi PASS");
    end else begin
      $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected 0 after reset");
    end

    // Now apply stimulus

    // We will drive a sequence that includes:
    // - Not the pattern (random)
    // - The pattern 10011
    // - After pattern, continue to see if it resets
    // - Also test boundary: all 0s, all 1s, and the pattern at boundaries

    // Test 1: all zeros for several cycles
    repeat (5) begin
      @(posedge CLK);
      IN = 0;
      expected_history = {expected_history[3:0], IN};
      @(negedge CLK);
      expected_MATCH = (expected_history == 5'b10011);
      if (MATCH !== expected_MATCH) begin
        $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected %b, got %b, history=\"%b\"", expected_MATCH, MATCH, expected_history);
        break;
      end
    end

    // Test 2: all ones
    repeat (5) begin
      @(posedge CLK);
      IN = 1;
      expected_history = {expected_history[3:0], IN};
      @(negedge CLK);
      expected_MATCH = (expected_history == 5'b10011);
      if (MATCH !== expected_MATCH) begin
        $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected %b, got %b, history=\"%b\"", expected_MATCH, MATCH, expected_history);
        break;
      end
    end

    // Test 3: partial pattern that fails at last bit: 10010
    // Drive 1,0,0,1,0
    integer i;
    reg [4:0] seq = 5'b10010;
    for (i = 0; i < 5; i = i+1) begin
      @(posedge CLK);
      IN = seq[4-i]; // first bit is seq[4], then seq[3]...
      expected_history = {expected_history[3:0], IN};
      @(negedge CLK);
      expected_MATCH = (expected_history == 5'b10011);
      if (MATCH !== expected_MATCH) begin
        $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected %b, got %b, history=\"%b\"", expected_MATCH, MATCH, expected_history);
        break;
      end
    end

    // Test 4: correct pattern 10011
    seq = 5'b10011;
    for (i = 0; i < 5; i = i+1) begin
      @(posedge CLK);
      IN = seq[4-i];
      expected_history = {expected_history[3:0], IN};
      @(negedge CLK);
      expected_MATCH = (expected_history == 5'b10011);
      if (i == 4) begin // last bit of pattern
        if (MATCH !== 1'b1) begin
          $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected MATCH=1 after 10011, got %b, history=\"%b\"", MATCH, expected_history);
          break;
        end else begin
          $display("CHECK ac1_under_simulation_fsm_produces_the_behavi PASS");
        end
      end else begin
        if (MATCH !== expected_MATCH) begin
          $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected %b, got %b, history=\"%b\"", expected_MATCH, MATCH, expected_history);
          break;
        end
      end
    end

    // Test 5: after pattern, continue with more bits to test loop and continuity
    // Drive 1,0,0,1,1 again (should get MATCH=1 at the end)
    // But note: after first 10011, the history becomes 10011, then we shift in next bits
    // So if we drive 10011 again, the history will be:
    //   after first 10011: history=10011 -> MATCH=1
    //   then drive 1: history=00111 -> no
    //   then 0: 01110 -> no
    //   then 0: 11100 -> no
    //   then 1: 11001 -> no
    //   then 1: 10011 -> yes
    // So we need 5 more bits to get the next MATCH

    // Let's drive 10011 again
    for (i = 0; i < 5; i = i+1) begin
      @(posedge CLK);
      IN = seq[4-i];
      expected_history = {expected_history[3:0], IN};
      @(negedge CLK);
      expected_MATCH = (expected_history == 5'b10011);
      if (i == 4) begin
        if (MATCH !== 1'b1) begin
          $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected MATCH=1 on second 10011, got %b, history=\"%b\"", MATCH, expected_history);
          break;
        end else begin
          $display("CHECK ac1_under_simulation_fsm_produces_the_behavi PASS");
        end
      end else begin
        if (MATCH !== expected_MATCH) begin
          $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected %b, got %b, history=\"%b\"", expected_MATCH, MATCH, expected_history);
          break;
        end
      end
    end

    // Test 6: test boundary with minimal input: one bit
    @(posedge CLK);
    IN = 1;
    expected_history = {expected_history[3:0], IN};
    @(negedge CLK);
    expected_MATCH = (expected_history == 5'b10011);
    if (MATCH !== expected_MATCH) begin
      $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected %b, got %b, history=\"%b\"", expected_MATCH, MATCH, expected_history);
    end else begin
      $display("CHECK ac1_under_simulation_fsm_produces_the_behavi PASS");
    end

    // Test 7: test a sequence that has 10011 starting at a different phase
    // Drive: 0,1,0,0,1,1 -> so that the last five are 10011
    reg [5:0] seq2 = 6'b010011;
    for (i = 0; i < 6; i = i+1) begin
      @(posedge CLK);
      IN = seq2[5-i];
      expected_history = {expected_history[3:0], IN};
      @(negedge CLK);
      expected_MATCH = (expected_history == 5'b10011);
      if (i == 5) begin // last bit
        if (MATCH !== 1'b1) begin
          $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected MATCH=1 on 010011, got %b, history=\"%b\"", MATCH, expected_history);
        end else begin
          $display("CHECK ac1_under_simulation_fsm_produces_the_behavi PASS");
        end
      end else begin
        if (MATCH !== expected_MATCH) begin
          $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected %b, got %b, history=\"%b\"", expected_MATCH, MATCH, expected_history);
        end
      end
    end

    // Test 8: test a sequence that almost matches but fails at the first bit: 00011
    seq2 = 6'b100011; // so that the last five are 00011
    for (i = 0; i < 6; i = i+1) begin
      @(posedge CLK);
      IN = seq2[5-i];
      expected_history = {expected_history[3:0], IN};
      @(negedge CLK);
      expected_MATCH = (expected_history == 5'b10011);
      if (MATCH !== expected_MATCH) begin
        $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected %b, got %b, history=\"%b\"", expected_MATCH, MATCH, expected_history);
        break;
      end
    end
    // At the end, history is 00011 -> not 10011 -> MATCH=0, which is correct
    $display("CHECK ac1_under_simulation_fsm_produces_the_behavi PASS");

    // Test 9: test a sequence that has 10011 in the middle: 1100110
    reg [6:0] seq3 = 7'b1100110;
    for (i = 0; i < 7; i = i+1) begin
      @(posedge CLK);
      IN = seq3[6-i];
      expected_history = {expected_history[3:0], IN};
      @(negedge CLK);
      expected_MATCH = (expected_history == 5'b10011);
      if (i == 4) begin // after 5th bit: we have driven 1,1,0,0,1 -> history=11001 -> no
        // then i=5: drive 1 -> history=10011 -> MATCH=1
      end else if (i == 5) begin
        if (MATCH !== 1'b1) begin
          $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected MATCH=1 at i=5, got %b, history=\"%b\"", MATCH, expected_history);
          break;
        end else begin
          $display("CHECK ac1_under_simulation_fsm_produces_the_behavi PASS");
        end
      end else begin
        if (MATCH !== expected_MATCH) begin
          $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected %b, got %b, history=\"%b\"", expected_MATCH, MATCH, expected_history);
          break;
        end
      end
    end

    // Test 10: test with alternating 1 and 0: 10101010...
    repeat (10) begin
      @(posedge CLK);
      IN = ~IN; // toggle
      expected_history = {expected_history[3:0], IN};
      @(negedge CLK);
      expected_MATCH = (expected_history == 5'b10011);
      if (MATCH !== expected_MATCH) begin
        $display("CHECK ac1_under_simulation_fsm_produces_the_behavi FAIL: expected %b, got %b, history=\"%b\"", expected_MATCH, MATCH, expected_history);
        break;
      end
    end
    $display("CHECK ac1_under_simulation_fsm_produces_the_behavi PASS");

    // If we get here, all tests passed
    $finish;
  end
endmodule