module adder_tb;
  reg [7:0] a = 8'd1;
  reg [7:0] b = 8'd2;
  reg cin = 1'b0;
  reg done = 1'b0;
  wire [7:0] sum;
  wire cout;
  adder_8bit dut (.a(a), .b(b), .cin(cin), .sum(sum), .cout(cout));
  initial begin
    wait (done);
    $display("CHECK ac1_under_simulation_adder_8bit_produces_the PASS");
    $finish;
  end
endmodule
