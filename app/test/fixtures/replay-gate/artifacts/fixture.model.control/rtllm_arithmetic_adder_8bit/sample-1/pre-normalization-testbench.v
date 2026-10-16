module adder_tb;
  reg [7:0] a = 8'd0;
  reg [7:0] b = 8'd0;
  reg cin = 1'b0;
  wire [7:0] sum;
  wire cout;
  adder_8bit dut (.a(a), .b(b), .cin(cin), .sum(sum), .cout(cout));
  initial begin
    $dumpfile("model.vcd");
    $dumpvars(0, adder_tb);
  end
  initial begin
    a = 8'd7; b = 8'd9; cin = 1'b0;
    #10;
    if (sum === 8'd17) $display("CHECK ac1_under_simulation_adder_8bit_produces_the PASS");
    else $display("CHECK ac1_under_simulation_adder_8bit_produces_the FAIL");
    $finish;
  end
endmodule
