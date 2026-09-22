`timescale 1ns/1ps

module tb_asyn_fifo;
  // Parameters matching the spec
  localparam DEPTH = 16;
  localparam WIDTH = 8;
  localparam PTR_WIDTH = $clog2(DEPTH);
  localparam GRAY_PTR_WIDTH = PTR_WIDTH + 1; // Gray code uses one extra bit for full comparison

  // Clock periods: 10ns each (100MHz)
  localparam WCLK_PERIOD = 10;
  localparam RCLK_PERIOD = 10;

  // Interface signals
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
  initial begin
    wclk = 0;
    forever #(WCLK_PERIOD/2) wclk = ~wclk;
  end

  initial begin
    rclk = 0;
    forever #(RCLK_PERIOD/2) rclk = ~RCLK_PERIOD/2;
  end

  // Helper functions for Gray code conversion
  function [GRAY_PTR_WIDTH-1:0] bin2gray;
    input [GRAY_PTR_WIDTH-1:0] bin;
    begin
      bin2gray = bin ^ (bin >> 1);
    end
  endfunction

  function [GRAY_PTR_WIDTH-1:0] gray2bin;
    input [GRAY_PTR_WIDTH-1:0] gray;
    begin
      gray2bin[GRAY_PTR_WIDTH-1] = gray[GRAY_PTR_WIDTH-1];
      genvar i;
      for (i = GRAY_PTR_WIDTH-2; i >= 0; i = i - 1) begin
        gray2bin[i] = gray2bin[i+1] ^ gray[i];
      end
    end
  endfunction

  // Compute expected FIFO state based on Gray pointers
  // Gray pointers are 4-bit for DEPTH=8 (but spec says DEPTH=16, so use 5-bit binary -> 6-bit Gray)
  // However, spec says: "Use 4-bit Gray code as a read/write pointer for a FIFO with depth 8"
  // Since DEPTH=16 in our case, we use 5-bit binary pointers -> 6-bit Gray pointers
  // But the spec explicitly says "4-bit Gray code" for depth 8, and our DEPTH=16, so we use 5-bit binary (log2(16)=4) -> 5-bit Gray
  // Actually: for DEPTH=16, PTR_WIDTH=4, so Gray pointer is 5 bits (to detect full condition)
  // Let's follow the spec: "Use 4-bit Gray code as a read/write pointer for a FIFO with depth 8"
  // Since DEPTH=16, we need 5-bit Gray code (4-bit binary + 1 MSB for full detection)
  // So GRAY_PTR_WIDTH = 5

  // Compute expected empty/full conditions
  // Empty: read pointer == write pointer (in Gray code)
  // Full: (wptr[GRAY_PTR_WIDTH-1:GRAY_PTR_WIDTH-2] == 2'b10 && rptr[GRAY_PTR_WIDTH-1:GRAY_PTR_WIDTH-2] == 2'b01) && (wptr[GRAY_PTR_WIDTH-3:0] == rptr[GRAY_PTR_WIDTH-3:0])
  // i.e., highest and second-highest bits opposite, remaining bits same

  // Variables for expected values
  reg [GRAY_PTR_WIDTH-1:0] expected_wptr_gray;
  reg [GRAY_PTR_WIDTH-1:0] expected_rptr_gray;
  reg [GRAY_PTR_WIDTH-1:0] expected_wptr_gray_synced_to_r;
  reg [GRAY_PTR_WIDTH-1:0] expected_rptr_gray_synced_to_w;
  reg expected_wfull;
  reg expected_rempty;

  // State variables for tracking
  reg [GRAY_PTR_WIDTH-1:0] wptr_gray;  // write pointer in Gray code
  reg [GRAY_PTR_WIDTH-1:0] rptr_gray;  // read pointer in Gray code
  reg [GRAY_PTR_WIDTH-1:0] wptr_gray_synced_to_r;  // write pointer synced to read domain
  reg [GRAY_PTR_WIDTH-1:0] rptr_gray_synced_to_w;  // read pointer synced to write domain

  // RAM contents (for verification)
  reg [WIDTH-1:0] ram [0:DEPTH-1];
  integer i;

  // Initialize RAM
  initial begin
    for (i = 0; i < DEPTH; i = i + 1) begin
      ram[i] = 8'h00;
    end
  end

  // Main test sequence
  initial begin
    // VCD dump
    $dumpfile("dump.vcd");
    $dumpvars(0, tb_asyn_fifo);

    // Initialize all inputs
    wclk = 0;
    rclk = 0;
    wrstn = 0;
    rrstn = 0;
    winc = 0;
    rinc = 0;
    wdata = 8'h00;

    // Wait for several clock cycles to let clocks stabilize
    #20;

    // === RESET PHASE ===
    // Assert resets and wait for them to be effective
    wrstn = 0;
    rrstn = 0;
    
    // Apply reset for several cycles
    repeat (5) @(posedge wclk);
    repeat (5) @(posedge rclk);

    // Deassert resets
    wrstn = 1;
    rrstn = 1;

    // Wait for reset to be fully released
    @(posedge wclk);
    @(posedge rclk);

    // After reset, FIFO should be empty
    // Expected: rempty = 1, wfull = 0
    #1; // Settle after reset
    if (rempty !== 1'b1) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rempty not 1 after reset");
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
    end

    // === CHECK 1: Empty condition ===
    // After reset, FIFO is empty -> rempty=1, wfull=0
    #1;
    if (rempty !== 1'b1 || wfull !== 1'b0) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rempty=%b, wfull=%b after reset", rempty, wfull);
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
    end

    // === CHECK 2: Single write operation ===
    // Write one value, verify FIFO not empty, data correct
    wdata = 8'hAA;
    winc = 1;
    @(posedge wclk);
    winc = 0;
    #1;

    // Expected: rempty=0, wfull=0, rdata=8'hAA (after one read)
    // But we haven't read yet, so rdata may be stale. We'll verify after read.
    if (rempty !== 1'b0 || wfull !== 1'b0) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rempty=%b, wfull=%b after 1 write", rempty, wfull);
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
    end

    // === CHECK 3: Read back the written value ===
    rinc = 1;
    @(posedge rclk);
    rinc = 0;
    #1;

    // Expected rdata = 8'hAA
    if (rdata !== 8'hAA) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rdata=%h expected AA", rdata);
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
    end

    // === CHECK 4: Full condition (write DEPTH values) ===
    // Fill the FIFO completely
    for (i = 0; i < DEPTH; i = i + 1) begin
      wdata = 8'h10 + i;
      winc = 1;
      @(posedge wclk);
      winc = 0;
      #1;
    end

    // Now FIFO should be full
    if (wfull !== 1'b1) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: wfull=%b expected 1 after filling FIFO", wfull);
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
    end

    // === CHECK 5: Cannot write when full ===
    winc = 1;
    @(posedge wclk);
    winc = 0;
    #1;

    // wfull should still be 1
    if (wfull !== 1'b1) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: wfull=%b expected 1 when trying to write to full FIFO", wfull);
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
    end

    // === CHECK 6: Read all values and verify order ===
    for (i = 0; i < DEPTH; i = i + 1) begin
      rinc = 1;
      @(posedge rclk);
      rinc = 0;
      #1;

      // Expected data = 8'h10 + i
      if (rdata !== 8'h10 + i) begin
        $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rdata=%h expected %h at index %d", rdata, 8'h10+i, i);
      end else begin
        if (i == 0) $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
      end
    end

    // === CHECK 7: Empty after reading all ===
    #1;
    if (rempty !== 1'b1) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rempty=%b expected 1 after emptying FIFO", rempty);
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
    end

    // === CHECK 8: Boundary values (min and max) ===
    // Write min value
    wdata = 8'h00;
    winc = 1;
    @(posedge wclk);
    winc = 0;
    #1;

    if (rempty !== 1'b0) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rempty=%b expected 0 after writing 0x00", rempty);
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
    end

    // Read min value
    rinc = 1;
    @(posedge rclk);
    rinc = 0;
    #1;

    if (rdata !== 8'h00) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rdata=%h expected 00", rdata);
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
    end

    // Write max value
    wdata = 8'hFF;
    winc = 1;
    @(posedge wclk);
    winc = 0;
    #1;

    if (rempty !== 1'b0) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rempty=%b expected 0 after writing 0xFF", rempty);
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
    end

    // Read max value
    rinc = 1;
    @(posedge rclk);
    rinc = 0;
    #1;

    if (rdata !== 8'hFF) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rdata=%h expected FF", rdata);
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
    end

    // === CHECK 9: Alternating read/write stress test ===
    // Write 4 values
    for (i = 0; i < 4; i = i + 1) begin
      wdata = 8'h20 + i;
      winc = 1;
      @(posedge wclk);
      winc = 0;
      #1;
    end

    // Read 2 values
    for (i = 0; i < 2; i = i + 1) begin
      rinc = 1;
      @(posedge rclk);
      rinc = 0;
      #1;
    end

    // Write 2 more values
    for (i = 0; i < 2; i = i + 1) begin
      wdata = 8'h30 + i;
      winc = 1;
      @(posedge wclk);
      winc = 0;
      #1;
    end

    // Read remaining 4 values
    for (i = 0; i < 4; i = i + 1) begin
      rinc = 1;
      @(posedge rclk);
      rinc = 0;
      #1;

      // Expected: 8'h22, 8'h23, 8'h30, 8'h31
      case (i)
        0: if (rdata !== 8'h22) $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rdata=%h expected 22", rdata);
           else $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
        1: if (rdata !== 8'h23) $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rdata=%h expected 23", rdata);
           else $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
        2: if (rdata !== 8'h30) $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rdata=%h expected 30", rdata);
           else $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
        3: if (rdata !== 8'h31) $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rdata=%h expected 31", rdata);
           else $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
      endcase
    end

    // === Final check: empty after all reads ===
    #1;
    if (rempty !== 1'b1) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: rempty=%b expected 1 after final emptying", rempty);
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS");
    end

    // Done
    $finish;
  end

endmodule
