module adder_tb;
  reg [7:0] a = 8'd0;
  reg [7:0] b = 8'd0;
  reg cin = 1'b0;
  reg done = 1'b0;
  reg clk = 1'b0;
  wire [7:0] sum;
  wire cout;
  adder_8bit dut (.a(a), .b(b), .cin(cin), .sum(sum), .cout(cout));
  always #100 clk = ~clk;
  always @(posedge clk) begin a <= a + 8'd1; b <= b + 8'd3; end
  initial begin
    $dumpfile("model.vcd");
    $dumpvars(0, adder_tb);
  end
  initial begin
    wait (done);
    $finish;
  end
endmodule
