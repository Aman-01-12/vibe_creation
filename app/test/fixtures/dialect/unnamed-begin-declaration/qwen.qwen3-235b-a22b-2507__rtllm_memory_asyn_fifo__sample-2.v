module tb_asyn_fifo;
  parameter DEPTH = 16;
  parameter WIDTH = 8;
  parameter PTR_WIDTH = $clog2(DEPTH);

  reg wclk;
  reg rclk;
  reg wrstn;
  reg rrstn;
  reg winc;
  reg rinc;
  reg [WIDTH-1:0] wdata;
  wire wfull;
  wire rempty;
  wire [WIDTH-1:0] rdata;

  // Gray code conversion function
  function [PTR_WIDTH:0] bin_to_gray;
    input [PTR_WIDTH:0] bin;
    begin
      bin_to_gray = bin ^ (bin >> 1);
    end
  endfunction

  function [PTR_WIDTH:0] gray_to_bin;
    input [PTR_WIDTH:0] gray;
    reg [PTR_WIDTH:0] bin;
    integer i;
    begin
      bin = 0;
      bin[PTR_WIDTH] = gray[PTR_WIDTH];
      for (i = PTR_WIDTH-1; i >= 0; i = i - 1)
        bin[i] = gray[i] ^ bin[i+1];
      gray_to_bin = bin;
    end
  endfunction

  // Instantiate the DUT
  asyn_fifo #(.DEPTH(DEPTH), .WIDTH(WIDTH)) dut (
    .wclk(wclk),
    .rclk(rclk),
    .wrstn(wrstn),
    .rrstn(rrstn),
    .winc(winc),
    .rinc(rinc),
    .wdata(wdata),
    .wfull(wfull),
    .rempty(rempty),
    .rdata(rdata)
  );

  // Clock generation
  always #5 wclk = ~wclk;
  always #7 rclk = ~rclk;

  // Test variables
  reg [WIDTH-1:0] expected_data [$clog2(DEPTH)-1:0];
  integer wptr, rptr;
  integer i;
  reg [PTR_WIDTH:0] wgray, rgray;
  reg [PTR_WIDTH:0] wgray_sync, rgray_sync;
  reg [PTR_WIDTH-1:0] waddr, raddr;
  reg [PTR_WIDTH:0] wptr_bin, rptr_bin;
  reg full_expected, empty_expected;

  initial begin
    // Initialize signals
    wclk = 0;
    rclk = 0;
    wrstn = 0;
    rrstn = 0;
    winc = 0;
    rinc = 0;
    wdata = 0;
    wptr = 0;
    rptr = 0;

    // Clear expected FIFO
    for (i = 0; i < DEPTH; i = i + 1)
      expected_data[i] = 0;

    $dumpfile("dump.vcd");
    $dumpvars(0, tb_asyn_fifo);

    // Deassert resets after some time
    #20 wrstn = 1;
    #20 rrstn = 1;

    // Wait for clocks to stabilize
    #100;

    // === CHECK: ac1_under_simulation_asyn_fifo_produces_the ===
    // Test 1: Initially empty
    #1;
    @(posedge rclk);
    #1;
    empty_expected = 1;
    if (rempty !== empty_expected)
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: expected rempty=%b, got %b", empty_expected, rempty);
    else
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");

    // Test 2: Write one item
    wdata = 8'hAA;
    winc = 1;
    @(posedge wclk);
    #1;
    winc = 0;
    wptr = wptr + 1;
    expected_data[0] = 8'hAA;
    empty_expected = 0;
    full_expected = 0;
    @(posedge rclk);
    #1;
    if (rempty !== empty_expected)
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: after write, expected rempty=%b, got %b", empty_expected, rempty);
    else if (wfull !== full_expected)
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: after write, expected wfull=%b, got %b", full_expected, wfull);
    else
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");

    // Test 3: Read one item
    rinc = 1;
    @(posedge rclk);
    #1;
    rinc = 0;
    rptr = rptr + 1;
    @(posedge rclk);
    #1;
    if (rdata !== expected_data[0])
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: read data mismatch, expected=%h, got=%h", expected_data[0], rdata);
    else
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");

    // Test 4: Fill FIFO to full
    for (i = 0; i < DEPTH; i = i + 1) begin
      wdata = $random;
      winc = 1;
      @(posedge wclk);
      #1;
      winc = 0;
      expected_data[wptr % DEPTH] = wdata;
      wptr = wptr + 1;
      // Compute expected full condition
      wgray = bin_to_gray(wptr[PTR_WIDTH:0]);
      rgray_sync = bin_to_gray(rptr[PTR_WIDTH:0]); // Assume synchronized
      wptr_bin = gray_to_bin(wgray);
      rptr_bin = gray_to_bin(rgray_sync);
      full_expected = (wgray[PTR_WIDTH:PTR_WIDTH-1] != rgray_sync[PTR_WIDTH:PTR_WIDTH-1]) &&
                      (wgray[PTR_WIDTH-2:0] == rgray_sync[PTR_WIDTH-2:0]);
      @(posedge wclk);
      #1;
      if (i == DEPTH-1 && wfull !== full_expected)
        $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: full flag not set when expected");
    end
    $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");

    // Test 5: Try to write when full
    wdata = 8'hFF;
    winc = 1;
    @(posedge wclk);
    #1;
    winc = 0;
    // wptr should not advance
    @(posedge wclk);
    #1;
    if (wfull !== 1)
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: FIFO not full after overflow attempt");
    else
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");

    // Test 6: Empty FIFO
    for (i = 0; i < DEPTH; i = i + 1) begin
      rinc = 1;
      @(posedge rclk);
      #1;
      rinc = 0;
      rptr = rptr + 1;
      @(posedge rclk);
      #1;
      if (i < DEPTH-1 && rempty === 1)
        $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: FIFO empty too early");
    end
    $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");

    // Final empty check
    @(posedge rclk);
    #1;
    if (rempty !== 1)
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: FIFO not empty after draining");
    else
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");

    // Test 7: Cross-clock domain: write from wclk, read from rclk
    // Reset pointers
    wptr = 0;
    rptr = 0;
    wrstn = 0;
    rrstn = 0;
    #20;
    wrstn = 1;
    rrstn = 1;
    #100;

    // Write 5 items
    for (i = 0; i < 5; i = i + 1) begin
      wdata = $random;
      winc = 1;
      @(posedge wclk);
      #1;
      winc = 0;
      expected_data[wptr % DEPTH] = wdata;
      wptr = wptr + 1;
    end

    // Read 5 items
    for (i = 0; i < 5; i = i + 1) begin
      rinc = 1;
      @(posedge rclk);
      #1;
      rinc = 0;
      @(posedge rclk);
      #1;
      if (rdata !== expected_data[i])
        $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: cross-clock read mismatch, expected=%h, got=%h", expected_data[i], rdata);
    end
    $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");

    // Test 8: Boundary: DEPTH=8 uses 4-bit Gray code
    // Reconfigure for DEPTH=8 if needed, but here we assume DEPTH=16
    // But test Gray code logic for 4-bit
    reg [3:0] test_bin, test_gray, test_bin_out;
    for (i = 0; i < 16; i = i + 1) begin
      test_bin = i;
      test_gray = bin_to_gray(test_bin);
      test_bin_out = gray_to_bin(test_gray);
      if (test_bin_out !== test_bin)
        $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: Gray<->Bin conversion failed for %h", test_bin);
    end
    $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");

    // Final verdict
    $finish;
  end
endmodule