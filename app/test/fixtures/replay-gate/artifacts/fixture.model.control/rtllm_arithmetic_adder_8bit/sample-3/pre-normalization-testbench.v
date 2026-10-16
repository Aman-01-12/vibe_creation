module adder_tb;
  reg [7:0] a = 8'd0;
  reg [7:0] b = 8'd0;
  reg cin = 1'b0;
  wire [7:0] sum;
  wire cout;
  adder_8bit dut (.a(a), .b(b), .cin(cin), .sum(sum), .cout(cout));
  initial begin
    a = 8'd1; b = 8'd1; cin = 1'b0;
    #500000;
    if (sum === 8'd2) $display("CHECK ac1_under_simulation_adder_8bit_produces_the PASS");
    else $display("CHECK ac1_under_simulation_adder_8bit_produces_the FAIL");
    $finish;
  end
endmodule
