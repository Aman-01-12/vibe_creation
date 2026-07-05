# v1 Feature Spec — "Vibe Engineering" for ECE (Creation-First)

## The principle
NOT a homework tutor that solves textbook exercises (cheatable, already on the web).
It's a **creation tool**: the student brings their OWN idea; the agent removes the
implementation friction so they can actually build it — designed, simulated, verified, and made real.
Same loop as agentic coding (intent → tool-use → verified artifact → iterate), applied to hardware.

## Launch domain: Digital / HDL
The one hardware domain where "prompt → real working artifact" closes *today*:
- symbolic (Verilog = code → LLM-strong)
- cheaply verifiable (run a testbench in Icarus Verilog / Verilator)
- synthesizable (→ FPGA) and **fabricable** (→ Tiny Tapeout = a real chip)

## v1 features
1. **Idea → architecture.** Student describes *their* project; agent asks clarifying Qs (design-partner style) and proposes a block-level architecture + module breakdown.
2. **Agentic HDL generation (tool-use loop).** Writes synthesizable Verilog module-by-module + testbenches via a read/write/run loop (the "run" = HW simulator).
3. **Verification by simulation.** Runs the testbench (Icarus/Verilator), checks against stated intent, renders the waveform. *Proof the student's novel design works.*
4. **Conversational iteration.** "make it 16-bit / add reset / pipeline it" → edits + re-verifies.
5. **Teach-mode toggle.** Explains *why* (pedagogy moat + anti-cheat + curriculum fit).
6. **Path to real.** Export FPGA project (Vivado) OR **Tiny Tapeout submission** → a fabricated chip.

## What the user can CREATE (novel, not textbook)
Their own: custom CPU / instruction set, novel peripheral, hardware game (VGA), gesture/audio coprocessor, PWM/motor controller, custom UART/protocol — as *their* project, verified, and fabricable.

## The value vs. "it's on the web"
Web = generic tutorials for generic exercises. This = **contextual, end-to-end, verified help for the student's OWN specific design**, that iterates with them and produces a **real artifact** (sim → FPGA → chip). Textbook vs. copilot-that-builds-your-idea.

## Honest limits (don't overpromise)
- Handles **student/module-scale** designs; not autonomous complex commercial SoCs (LLM reliability wall at scale = the natural student-segment boundary).
- **Analog/RF + physical PCB layout weaker** (spatial reasoning) → lead with digital/HDL/firmware; expand later.
- **Verification is mandatory** — every design proven by simulation, never just asserted.

## Expansion (earn the platform)
Digital/HDL (v1) → Embedded track (intent → circuit + firmware + sim + debug) → up the chip track (synthesis → Tiny Tapeout → FPGA) → unified AI ECE companion across the degree.


---

## Product scope: PCB / "make the real thing" (per track)
Two different physical outputs — set expectations clearly.

**Chip / HDL track (v1 candidate):** Verilog → simulate → FPGA bitstream / Tiny Tapeout chip. **No PCB** — the chip is the deliverable.

**Embedded / gadget track (phase 2):** the full physical build — and the product CAN generate it:
| Output | Who produces it | Reliability |
|---|---|---|
| Components / BOM + sourcing | agent (cites datasheets) | strong |
| Schematic from intent | agent (NL→netlist) | emerging — needs ERC verification (LLMs hallucinate parts) |
| PCB layout & routing | **autorouter** (Quilter/DeepPCB/KiCad), NOT the LLM | student-scale ok; complex boards limited |
| Assembly / wiring guide | agent (from schematic+BOM) | strong |
| Fab/order | link out to board house | n/a |

So the full vision does deliver: *"exact components + schematic + PCB + firmware + how to wire/assemble + where to order."* Caveats: schematic needs ERC verification; PCB layout via autorouter is student-scale-good; physical soldering is the student's hands.

## v1 emphasis decision (open)
- **Chip/HDL v1** = cleanest verification, → real chip, no PCB. Sharpest, most trustworthy.
- **Embedded/gadget v1** = the "build a real device" excitement (BOM+schematic+PCB+firmware+assembly), but PCB layout is the weakest-verification link → harder, less-trustworthy v1.
Pick based on which "wow" matters more; roadmap includes both regardless.


---

## "Is it real / visual / shareable?" — yes (4 visual layers + real verification)
The deliverable is NOT code — it's demonstrable artifacts:
1. **Circuit/gate diagram** — Yosys `write_json` → **netlistsvg** renders the code as a schematic picture.
2. **Live waveforms** — signals over time, updating as it runs.
3. **Live in-browser behavior (the wow)** — Verilator → WASM runs the design live with visible output. Proof: **VGA Playground** (edit Verilog → live VGA on screen); **Makerchip** (diagrams + waveforms + viz).
4. **Physical chip layout** — Tiny Tapeout **GDS Viewer** renders the actual silicon layout; and Tiny Tapeout **fabricates + mails a real chip** (e.g., a gate-level VGA demo running on a real monitor).

**Real-time simulation:** yes — Verilator→WASM in-browser; waveforms + behavioral output (display/LED/7-seg) render live.

**Verification methods (the oracle — we don't trust the LLM):**
- Chip/HDL: testbenches, **assertions (SVA)**, **coverage**, **formal verification**, **static timing analysis**. (Note industry split: *verification* = matches spec in sim; *validation* = real silicon.)
- PCB: **ERC, DRC, SPICE, signal/power integrity, DFM.**

**"This is my chip" story:** student shows a live browser demo + a silicon-layout render + (eventually) a real chip they hold. Highly shareable → viral/word-of-mouth fuel.
