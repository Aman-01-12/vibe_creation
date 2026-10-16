`timescale 1ns/1ps

module tb;
    // Inputs
    reg clk;
    reg rst_n;
    reg [7:0] data_in;
    reg valid_in;

    // Outputs
    wire valid_out;
    wire [10:0] data_out;

    // Expected values
    reg [10:0] expected_data_out;
    reg expected_valid_out;

    // Test control
    integer test_count;
    integer pass_count;
    integer fail_count;
    integer i;
    reg [7:0] test_data [0:3];
    reg [10:0] calc_sum;

    // Instantiate the Unit Under Test
    accu uut (
        .clk(clk),
        .rst_n(rst_n),
        .data_in(data_in),
        .valid_in(valid_in),
        .valid_out(valid_out),
        .data_out(data_out)
    );

    // Clock generation: 10ns period
    initial begin
        clk = 0;
        forever #5 clk = ~clk;
    end

    // Test sequence
    initial begin
        // Initialize
        begin end
        begin end

        rst_n = 0;
        data_in = 0;
        valid_in = 0;
        expected_data_out = 0;
        expected_valid_out = 0;
        test_count = 0;
        pass_count = 0;
        fail_count = 0;

        // Reset phase
        #20;
        @(negedge clk);
        rst_n = 1;
        #1;

        // Check 1: Basic accumulation with non-zero values
        // Values: 10, 20, 30, 40 -> Sum = 100
        test_count = test_count + 1;
        $display("Test 1: Basic accumulation 10+20+30+40");
        test_data[0] = 8'd10;
        test_data[1] = 8'd20;
        test_data[2] = 8'd30;
        test_data[3] = 8'd40;
        calc_sum = test_data[0] + test_data[1] + test_data[2] + test_data[3];
        fork
            begin
                for (i = 0; i < 4; i = i + 1) begin
                    @(negedge clk);
                    data_in = test_data[i];
                    valid_in = 1;
                    #1;
                end
                @(negedge clk);
                valid_in = 0;
                data_in = 8'd0;
            end
            begin
                @(posedge uut.valid_out);
                #1;
                expected_data_out = calc_sum;
                expected_valid_out = 1;
                if (uut.data_out !== expected_data_out) begin
                    $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL: data_out mismatch, got %d, expected %d", uut.data_out, expected_data_out);
                    fail_count = fail_count + 1;
                end else begin
                    $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS: data_out = %d", uut.data_out);
                    pass_count = pass_count + 1;
                end
                @(negedge clk);
                #1;
                if (uut.valid_out !== 0) begin
                    $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL: valid_out did not deassert, got %b", uut.valid_out);
                    fail_count = fail_count + 1;
                end else begin
                    $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS: valid_out deasserted correctly");
                    pass_count = pass_count + 1;
                end
            end
        join

        // Wait for settling
        repeat(5) @(negedge clk);

        // Check 2: Maximum boundary values
        // Values: 255, 255, 255, 255 -> Sum = 1020
        test_count = test_count + 1;
        $display("Test 2: Maximum values 255+255+255+255");
        test_data[0] = 8'd255;
        test_data[1] = 8'd255;
        test_data[2] = 8'd255;
        test_data[3] = 8'd255;
        calc_sum = test_data[0] + test_data[1] + test_data[2] + test_data[3];
        fork
            begin
                for (i = 0; i < 4; i = i + 1) begin
                    @(negedge clk);
                    data_in = test_data[i];
                    valid_in = 1;
                    #1;
                end
                @(negedge clk);
                valid_in = 0;
                data_in = 8'd0;
            end
            begin
                @(posedge uut.valid_out);
                #1;
                expected_data_out = calc_sum;
                if (uut.data_out !== expected_data_out) begin
                    $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL: data_out mismatch, got %d, expected %d", uut.data_out, expected_data_out);
                    fail_count = fail_count + 1;
                end else begin
                    $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS: data_out = %d", uut.data_out);
                    pass_count = pass_count + 1;
                end
            end
        join

        repeat(5) @(negedge clk);

        // Check 3: Minimum boundary values
        // Values: 0, 0, 0, 0 -> Sum = 0
        test_count = test_count + 1;
        $display("Test 3: Minimum values 0+0+0+0");
        test_data[0] = 8'd0;
        test_data[1] = 8'd0;
        test_data[2] = 8'd0;
        test_data[3] = 8'd0;
        calc_sum = test_data[0] + test_data[1] + test_data[2] + test_data[3];
        fork
            begin
                for (i = 0; i < 4; i = i + 1) begin
                    @(negedge clk);
                    data_in = test_data[i];
                    valid_in = 1;
                    #1;
                end
                @(negedge clk);
                valid_in = 0;
                data_in = 8'd0;
            end
            begin
                @(posedge uut.valid_out);
                #1;
                expected_data_out = calc_sum;
                if (uut.data_out !== expected_data_out) begin
                    $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL: data_out mismatch, got %d, expected %d", uut.data_out, expected_data_out);
                    fail_count = fail_count + 1;
                end else begin
                    $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS: data_out = %d", uut.data_out);
                    pass_count = pass_count + 1;
                end
            end
        join

        repeat(5) @(negedge clk);

        // Check 4: Mixed values with sensitivity check
        // Values: 1, 2, 4, 8 -> Sum = 15
        test_count = test_count + 1;
        $display("Test 4: Mixed values 1+2+4+8");
        test_data[0] = 8'd1;
        test_data[1] = 8'd2;
        test_data[2] = 8'd4;
        test_data[3] = 8'd8;
        calc_sum = test_data[0] + test_data[1] + test_data[2] + test_data[3];
        fork
            begin
                for (i = 0; i < 4; i = i + 1) begin
                    @(negedge clk);
                    data_in = test_data[i];
                    valid_in = 1;
                    #1;
                end
                @(negedge clk);
                valid_in = 0;
                data_in = 8'd0;
            end
            begin
                @(posedge uut.valid_out);
                #1;
                expected_data_out = calc_sum;
                if (uut.data_out !== expected_data_out) begin
                    $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL: data_out mismatch, got %d, expected %d", uut.data_out, expected_data_out);
                    fail_count = fail_count + 1;
                end else begin
                    $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS: data_out = %d", uut.data_out);
                    pass_count = pass_count + 1;
                end
            end
        join

        repeat(5) @(negedge clk);

        // Check 5: Reset behavior - valid_out should be 0 after reset
        test_count = test_count + 1;
        $display("Test 5: Reset behavior");
        @(negedge clk);
        rst_n = 0;
        #1;
        repeat(3) @(negedge clk);
        #1;
        if (uut.valid_out !== 0) begin
            $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL: valid_out not 0 during reset");
            fail_count = fail_count + 1;
        end else begin
            $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS: valid_out = 0 during reset");
            pass_count = pass_count + 1;
        end

        // Release reset
        @(negedge clk);
        rst_n = 1;
        #1;

        repeat(5) @(negedge clk);

        // Check 6: No output when fewer than 4 valid inputs
        test_count = test_count + 1;
        $display("Test 6: No output with fewer than 4 inputs");
        fork
            begin
                for (i = 0; i < 3; i = i + 1) begin
                    @(negedge clk);
                    data_in = 8'd100;
                    valid_in = 1;
                    #1;
                end
                @(negedge clk);
                valid_in = 0;
                data_in = 8'd0;
            end
            begin
                // Wait and check that valid_out does not go high
                repeat(10) @(negedge clk);
                #1;
                if (uut.valid_out !== 0) begin
                    $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL: valid_out asserted with only 3 inputs");
                    fail_count = fail_count + 1;
                end else begin
                    $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS: valid_out correctly stays 0 with only 3 inputs");
                    pass_count = pass_count + 1;
                end
            end
        join

        repeat(10) @(negedge clk);

        // Check 7: valid_in gating - data should not be accumulated when valid_in=0
        test_count = test_count + 1;
        $display("Test 7: valid_in gating");
        // First send 2 valid inputs
        for (i = 0; i < 2; i = i + 1) begin
            @(negedge clk);
            data_in = 8'd50;
            valid_in = 1;
            #1;
        end
        // Send 2 inputs with valid_in=0 (should be ignored)
        for (i = 0; i < 2; i = i + 1) begin
            @(negedge clk);
            data_in = 8'd200;
            valid_in = 0;
            #1;
        end
        // Send 2 more valid inputs to complete the 4
        for (i = 0; i < 2; i = i + 1) begin
            @(negedge clk);
            data_in = 8'd50;
            valid_in = 1;
            #1;
        end
        @(negedge clk);
        valid_in = 0;
        data_in = 8'd0;

        // Expected: 50+50+50+50 = 200 (the 200s with valid_in=0 should be ignored)
        calc_sum = 50 + 50 + 50 + 50;
        wait(uut.valid_out == 1);
        #1;
        if (uut.data_out !== calc_sum) begin
            $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL: data_out mismatch with valid_in gating, got %d, expected %d", uut.data_out, calc_sum);
            fail_count = fail_count + 1;
        end else begin
            $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS: data_out = %d with valid_in gating", uut.data_out);
            pass_count = pass_count + 1;
        end

        repeat(10) @(negedge clk);

        // Summary
        $display("========================================");
        $display("Test Summary: %0d tests", test_count);
        $display("Pass: %0d, Fail: %0d", pass_count, fail_count);
        $display("========================================");

        $finish;
    end

endmodule
