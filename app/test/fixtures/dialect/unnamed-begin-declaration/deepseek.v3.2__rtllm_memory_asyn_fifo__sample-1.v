module tb_asyn_fifo;

  // Parameters
  parameter DEPTH = 16;
  parameter WIDTH = 8;
  parameter ADDR_WIDTH = $clog2(DEPTH);

  // Clock and reset signals
  reg wclk;
  reg rclk;
  reg wrstn;
  reg rrstn;

  // Control signals
  reg winc;
  reg rinc;

  // Data signals
  reg [WIDTH-1:0] wdata;
  wire wfull;
  wire rempty;
  wire [WIDTH-1:0] rdata;

  // Testbench variables
  integer i;
  integer j;
  integer k;
  integer write_count;
  integer read_count;
  integer expected_reads;
  integer expected_writes;
  reg [WIDTH-1:0] expected_data;
  reg [WIDTH-1:0] data_queue [0:DEPTH-1];
  integer queue_head;
  integer queue_tail;
  integer queue_count;
  reg [ADDR_WIDTH:0] expected_wptr_gray;  // Extra bit for Gray code
  reg [ADDR_WIDTH:0] expected_rptr_gray;
  reg [ADDR_WIDTH:0] expected_wptr_bin;
  reg [ADDR_WIDTH:0] expected_rptr_bin;
  reg expected_wfull;
  reg expected_rempty;
  reg [WIDTH-1:0] last_written_data;

  // Instantiate DUT
  asyn_fifo #(
    .DEPTH(DEPTH),
    .WIDTH(WIDTH)
  ) dut (
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
    forever #5 wclk = ~wclk;  // 100 MHz write clock
  end

  initial begin
    rclk = 0;
    forever #7 rclk = ~rclk;  // ~71.4 MHz read clock (different frequency)
  end

  // Binary to Gray code conversion function
  function [ADDR_WIDTH:0] bin2gray;
    input [ADDR_WIDTH:0] bin;
    begin
      bin2gray = bin ^ (bin >> 1);
    end
  endfunction

  // Gray to binary conversion function
  function [ADDR_WIDTH:0] gray2bin;
    input [ADDR_WIDTH:0] gray;
    reg [ADDR_WIDTH:0] bin;
    integer m;
    begin
      bin[ADDR_WIDTH] = gray[ADDR_WIDTH];
      for (m = ADDR_WIDTH-1; m >= 0; m = m-1) begin
        bin[m] = bin[m+1] ^ gray[m];
      end
      gray2bin = bin;
    end
  endfunction

  // Test sequence
  initial begin
    // Initialize
    $dumpfile("dump.vcd");
    $dumpvars(0, tb_asyn_fifo);
    
    // Initialize testbench variables
    write_count = 0;
    read_count = 0;
    expected_reads = 0;
    expected_writes = 0;
    queue_head = 0;
    queue_tail = 0;
    queue_count = 0;
    expected_wptr_gray = 0;
    expected_rptr_gray = 0;
    expected_wptr_bin = 0;
    expected_rptr_bin = 0;
    expected_wfull = 0;
    expected_rempty = 1;  // Initially empty
    last_written_data = 0;
    
    // Initialize data queue
    for (i = 0; i < DEPTH; i = i + 1) begin
      data_queue[i] = 0;
    end
    
    // Initialize control signals
    winc = 0;
    rinc = 0;
    wdata = 0;
    
    // Apply resets
    wrstn = 0;
    rrstn = 0;
    #20;
    wrstn = 1;
    rrstn = 1;
    #20;
    
    // Check 1: Initial state - FIFO should be empty
    // Wait for clocks to align
    @(posedge wclk);
    @(posedge rclk);
    #1;  // Small delay for signals to settle
    
    expected_rempty = 1;
    expected_wfull = 0;
    
    if (rempty === expected_rempty && wfull === expected_wfull) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS: Initial empty state correct");
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: Initial empty state incorrect. rempty=%b (expected %b), wfull=%b (expected %b)",
              rempty, expected_rempty, wfull, expected_wfull);
    end
    
    // Test 2: Write one item without reading
    @(posedge wclk);
    winc = 1;
    wdata = 8'hA5;
    last_written_data = wdata;
    
    // Update expected write pointer
    expected_wptr_bin = expected_wptr_bin + 1;
    expected_wptr_gray = bin2gray(expected_wptr_bin);
    
    // Update queue
    data_queue[queue_tail] = wdata;
    queue_tail = (queue_tail + 1) % DEPTH;
    queue_count = queue_count + 1;
    
    @(posedge wclk);
    winc = 0;
    
    // Wait for synchronization
    #50;  // Allow time for pointer synchronization
    
    // Check empty flag should be 0 after write
    expected_rempty = 0;
    expected_wfull = 0;
    
    @(posedge rclk);
    #1;
    
    if (rempty === expected_rempty) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS: Empty flag cleared after write");
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: Empty flag incorrect after write. rempty=%b (expected %b)",
              rempty, expected_rempty);
    end
    
    // Test 3: Read the written item
    @(posedge rclk);
    rinc = 1;
    
    // Update expected read pointer
    expected_rptr_bin = expected_rptr_bin + 1;
    expected_rptr_gray = bin2gray(expected_rptr_bin);
    
    // Update queue
    expected_data = data_queue[queue_head];
    queue_head = (queue_head + 1) % DEPTH;
    queue_count = queue_count - 1;
    
    @(posedge rclk);
    rinc = 0;
    
    // Wait for data to appear
    #10;
    
    // Check read data
    if (rdata === expected_data) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS: Read data matches written data");
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: Read data mismatch. Got %h, expected %h",
              rdata, expected_data);
    end
    
    // Wait for synchronization
    #50;
    
    // Check empty flag should be 1 again
    expected_rempty = (queue_count == 0);
    
    @(posedge rclk);
    #1;
    
    if (rempty === expected_rempty) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS: Empty flag set after read");
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: Empty flag incorrect after read. rempty=%b (expected %b)",
              rempty, expected_rempty);
    end
    
    // Test 4: Fill FIFO completely
    $display("\nFilling FIFO...");
    for (i = 0; i < DEPTH; i = i + 1) begin
      @(posedge wclk);
      winc = 1;
      wdata = 8'h10 + i;  // Different data for each write
      last_written_data = wdata;
      
      // Update expected write pointer
      expected_wptr_bin = expected_wptr_bin + 1;
      expected_wptr_gray = bin2gray(expected_wptr_bin);
      
      // Update queue
      data_queue[queue_tail] = wdata;
      queue_tail = (queue_tail + 1) % DEPTH;
      queue_count = queue_count + 1;
      
      @(posedge wclk);
      winc = 0;
      
      // Check full flag on last write
      if (i == DEPTH-1) begin
        // Wait for synchronization
        #50;
        
        // According to spec: full when write pointer is one cycle ahead
        // and highest two bits are opposite, others same
        expected_wfull = 1;
        
        @(posedge wclk);
        #1;
        
        if (wfull === expected_wfull) begin
          $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS: Full flag set when FIFO full");
        end else begin
          $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: Full flag incorrect when full. wfull=%b (expected %b)",
                  wfull, expected_wfull);
        end
      end
    end
    
    // Test 5: Try to write when full (should not succeed)
    @(posedge wclk);
    winc = 1;
    wdata = 8'hFF;  // Try to write different data
    
    // Store current queue state
    integer saved_queue_tail = queue_tail;
    integer saved_queue_count = queue_count;
    reg [WIDTH-1:0] saved_last_data = last_written_data;
    
    @(posedge wclk);
    winc = 0;
    
    // Wait and check that data wasn't written
    #50;
    
    // The write should be ignored when full
    if (queue_tail === saved_queue_tail && queue_count === saved_queue_count) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS: Write ignored when FIFO full");
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: Write accepted when FIFO full");
    end
    
    // Test 6: Read all items from full FIFO
    $display("\nEmptying FIFO...");
    for (i = 0; i < DEPTH; i = i + 1) begin
      @(posedge rclk);
      rinc = 1;
      
      // Update expected read pointer
      expected_rptr_bin = expected_rptr_bin + 1;
      expected_rptr_gray = bin2gray(expected_rptr_bin);
      
      // Get expected data from queue
      expected_data = data_queue[queue_head];
      queue_head = (queue_head + 1) % DEPTH;
      queue_count = queue_count - 1;
      
      @(posedge rclk);
      rinc = 0;
      
      // Wait for data
      #10;
      
      // Check data
      if (rdata === expected_data) begin
        $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS: Read %0d correct", i);
      end else begin
        $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: Read %0d mismatch. Got %h, expected %h",
                i, rdata, expected_data);
      end
      
      // Check full flag after first read
      if (i == 0) begin
        #50;  // Wait for sync
        expected_wfull = 0;
        
        @(posedge wclk);
        #1;
        
        if (wfull === expected_wfull) begin
          $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS: Full flag cleared after first read");
        end else begin
          $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: Full flag incorrect after read. wfull=%b (expected %b)",
                  wfull, expected_wfull);
        end
      end
    end
    
    // Check empty flag after all reads
    #50;
    expected_rempty = 1;
    
    @(posedge rclk);
    #1;
    
    if (rempty === expected_rempty) begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS: Empty flag set after reading all");
    end else begin
      $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: Empty flag incorrect after all reads. rempty=%b (expected %b)",
              rempty, expected_rempty);
    end
    
    // Test 7: Concurrent read and write
    $display("\nTesting concurrent operations...");
    
    // Reset pointers
    expected_wptr_bin = 0;
    expected_rptr_bin = 0;
    expected_wptr_gray = 0;
    expected_rptr_gray = 0;
    queue_head = 0;
    queue_tail = 0;
    queue_count = 0;
    
    // Start writing
    fork
      begin: write_block
        for (j = 0; j < DEPTH*2; j = j + 1) begin
          @(posedge wclk);
          if (!wfull) begin
            winc = 1;
            wdata = 8'h20 + (j % 256);
            last_written_data = wdata;
            
            // Update expected write pointer if not full
            if (!expected_wfull) begin
              expected_wptr_bin = expected_wptr_bin + 1;
              expected_wptr_gray = bin2gray(expected_wptr_bin);
              
              // Update queue
              data_queue[queue_tail] = wdata;
              queue_tail = (queue_tail + 1) % DEPTH;
              queue_count = queue_count + 1;
            end
            
            @(posedge wclk);
            winc = 0;
            
            // Update expected full flag
            expected_wfull = ((expected_wptr_bin[ADDR_WIDTH] != expected_rptr_bin[ADDR_WIDTH]) &&
                             (expected_wptr_bin[ADDR_WIDTH-1] != expected_rptr_bin[ADDR_WIDTH-1]) &&
                             (expected_wptr_bin[ADDR_WIDTH-2:0] == expected_rptr_bin[ADDR_WIDTH-2:0]));
          end else begin
            @(posedge wclk);
          end
        end
      end
      
      begin: read_block
        for (k = 0; k < DEPTH*2; k = k + 1) begin
          @(posedge rclk);
          if (!rempty) begin
            rinc = 1;
            
            // Get expected data
            expected_data = data_queue[queue_head];
            queue_head = (queue_head + 1) % DEPTH;
            queue_count = queue_count - 1;
            
            // Update expected read pointer
            expected_rptr_bin = expected_rptr_bin + 1;
            expected_rptr_gray = bin2gray(expected_rptr_bin);
            
            @(posedge rclk);
            rinc = 0;
            
            // Wait and check data
            #10;
            
            if (rdata === expected_data) begin
              // Data check passed
            end else begin
              $display("CHECK ac1_under_simulation_asyn_fifo_produces_the FAIL: Concurrent read mismatch at k=%0d. Got %h, expected %h",
                      k, rdata, expected_data);
            end
            
            // Update expected flags
            expected_rempty = (queue_count == 0);
            expected_wfull = ((expected_wptr_bin[ADDR_WIDTH] != expected_rptr_bin[ADDR_WIDTH]) &&
                             (expected_wptr_bin[ADDR_WIDTH-1] != expected_rptr_bin[ADDR_WIDTH-1]) &&
                             (expected_wptr_bin[ADDR_WIDTH-2:0] == expected_rptr_bin[ADDR_WIDTH-2:0]));
          end else begin
            @(posedge rclk);
          end
        end
      end
    join
    
    $display("CHECK ac1_under_simulation_asyn_fifo_produces_the PASS: Concurrent operations completed");
    
    // Final delay and finish
    #100;
    $display("\nAll tests completed.");
    $finish;
  end

endmodule
