module tb_accu;
    // Clock and reset
    reg clk;
    reg rst_n;

    // Module inputs
    reg [7:0] data_in;
    reg valid_in;

    // Module outputs
    wire valid_out;
    wire [9:0] data_out;

    // Testbench variables
    reg [7:0] stimulus_data [0:15]; // Store stimulus values
    integer i;
    integer received_count;
    reg [9:0] expected_accumulation;
    reg [7:0] current_window [0:3];
    integer window_index;
    reg check_passed;

    // Instantiate the design under test
    accu dut (
        .clk(clk),
        .rst_n(rst_n),
        .data_in(data_in),
        .valid_in(valid_in),
        .valid_out(valid_out),
        .data_out(data_out)
    );

    // Clock generation
    always #5 clk = ~clk;

    // Initialize signals and dump waveform
    initial begin
        begin end
        begin end

        // Initialize clock and reset
        clk = 0;
        rst_n = 0;

        // Initialize testbench variables
        for (i = 0; i < 16; i = i + 1) begin
            stimulus_data[i] = 8'h00;
        end
        received_count = 0;
        expected_accumulation = 10'h000;
        window_index = 0;
        check_passed = 1;

        // Apply reset
        #10;
        rst_n = 1;
        #10;

        // Test sequence 1: Four valid inputs, then check output
        // Use values that are non-zero, unequal, and cover boundaries
        stimulus_data[0] = 8'h01;   // Minimum non-zero
        stimulus_data[1] = 8'h7F;   // Mid-range
        stimulus_data[2] = 8'h80;   // High bit set
        stimulus_data[3] = 8'hFF;   // Maximum

        // Drive first four valid inputs
        for (i = 0; i < 4; i = i + 1) begin
            data_in = stimulus_data[i];
            valid_in = 1'b1;
            #10; // Wait one clock cycle
        end

        // After four inputs, wait for valid_out to assert
        // Hold data_in and valid_in stable for one more cycle
        data_in = 8'h00;
        valid_in = 1'b0;
        #10;

        // At this point, valid_out should be 1 for one cycle
        // Compute expected accumulation from the four driven values
        expected_accumulation = stimulus_data[0] + stimulus_data[1] + stimulus_data[2] + stimulus_data[3];

        // Check that valid_out is 1 and data_out matches expected accumulation
        if (valid_out === 1'b1 && data_out === expected_accumulation) begin
            $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS");
        end else begin
            $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL: valid_out=%b, data_out=%0d, expected=%0d",
                     valid_out, data_out, expected_accumulation);
            check_passed = 0;
        end

        // Wait one more cycle to see valid_out deassert
        #10;
        if (valid_out !== 1'b0) begin
            $display("Warning: valid_out did not deassert after one cycle");
        end

        // Test sequence 2: Another four valid inputs with different values
        // Include zero and negative-like values (though input is unsigned)
        stimulus_data[4] = 8'h00;   // Zero
        stimulus_data[5] = 8'h55;   // Pattern
        stimulus_data[6] = 8'hAA;   // Complementary pattern
        stimulus_data[7] = 8'hFE;   // One less than max

        // Drive next four valid inputs
        for (i = 4; i < 8; i = i + 1) begin
            data_in = stimulus_data[i];
            valid_in = 1'b1;
            #10;
        end

        // Wait for valid_out to assert again
        data_in = 8'h00;
        valid_in = 1'b0;
        #10;

        // Compute expected accumulation for second window
        expected_accumulation = stimulus_data[4] + stimulus_data[5] + stimulus_data[6] + stimulus_data[7];

        if (valid_out === 1'b1 && data_out === expected_accumulation) begin
            $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS (second window)");
        end else begin
            $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL (second window): valid_out=%b, data_out=%0d, expected=%0d",
                     valid_out, data_out, expected_accumulation);
            check_passed = 0;
        end

        // Test sequence 3: Interleaved valid and invalid inputs
        // Drive valid_in=0 between some inputs, ensure accumulation only counts valid inputs
        stimulus_data[8]  = 8'h11;
        stimulus_data[9]  = 8'h22;
        stimulus_data[10] = 8'h33;
        stimulus_data[11] = 8'h44;

        // First valid
        data_in = stimulus_data[8];
        valid_in = 1'b1;
        #10;

        // Second valid
        data_in = stimulus_data[9];
        valid_in = 1'b1;
        #10;

        // Invalid cycle (should not be counted)
        data_in = 8'hDE;
        valid_in = 1'b0;
        #10;

        // Third valid
        data_in = stimulus_data[10];
        valid_in = 1'b1;
        #10;

        // Fourth valid (this completes a window of four VALID inputs: 8,9,10,11)
        data_in = stimulus_data[11];
        valid_in = 1'b1;
        #10;

        // Wait for valid_out
        data_in = 8'h00;
        valid_in = 1'b0;
        #10;

        // Expected accumulation is sum of the four VALID inputs (8,9,10,11)
        expected_accumulation = stimulus_data[8] + stimulus_data[9] + stimulus_data[10] + stimulus_data[11];

        if (valid_out === 1'b1 && data_out === expected_accumulation) begin
            $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS (with invalid interleaved)");
        end else begin
            $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL (with invalid interleaved): valid_out=%b, data_out=%0d, expected=%0d",
                     valid_out, data_out, expected_accumulation);
            check_passed = 0;
        end

        // Test sequence 4: Reset during accumulation
        // Start accumulation, then reset, ensure accumulation restarts
        stimulus_data[12] = 8'h10;
        stimulus_data[13] = 8'h20;

        // First valid after previous test
        data_in = stimulus_data[12];
        valid_in = 1'b1;
        #10;

        // Second valid
        data_in = stimulus_data[13];
        valid_in = 1'b1;
        #10;

        // Apply reset (active-low)
        rst_n = 0;
        #10;
        rst_n = 1;
        #10;

        // After reset, we need four new valid inputs to get an output
        stimulus_data[14] = 8'h30;
        stimulus_data[15] = 8'h40;

        // Drive two more valids (total two since reset)
        data_in = stimulus_data[14];
        valid_in = 1'b1;
        #10;

        data_in = stimulus_data[15];
        valid_in = 1'b1;
        #10;

        // We need two more to complete a window of four, but we'll stop here
        // and verify that valid_out is still 0 (since we have only 2 valid inputs since reset)
        data_in = 8'h00;
        valid_in = 1'b0;
        #10;

        if (valid_out !== 1'b0) begin
            $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL (reset test): valid_out should be 0 after reset with <4 inputs");
            check_passed = 0;
        end else begin
            $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS (reset test)");
        end

        // Final summary
        if (check_passed) begin
            $display("All checks passed.");
        end else begin
            $display("Some checks failed.");
        end

        $finish;
    end
endmodule
