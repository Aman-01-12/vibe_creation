# Requirements Document

## Introduction

This document specifies the requirements for the **HDL Creation Loop**, the thin end-to-end "hero" slice of the ECE Creation Copilot.
It covers only Milestones **M0 (spine skeleton)** and **M1 (hero loop)** from `product-ece/ECE-PRD-v1.md` Section 17.
Later milestones (M2 multi-module decomposition, M3 make-real/FPGA/Tiny Tapeout, M4 embedded, M5 assisted PCB) are explicitly out of scope for this spec and become separate specs.

The slice delivers the full single-module creation loop for a student's own idea: intent capture and clarification, an approved spec and architecture, agentic Verilog generation, independent (spec-derived) testbench generation, deterministic simulation and verification with Icarus Verilog, waveform and gate/schematic visualization, conversational iteration, and teach-mode explanation.
It also delivers the supporting spine skeleton (browser editor, API layer, one sandboxed backend tool-runner, action-recorder scaffolding) and the eval harness (a VerilogEval/RTLLM subset) wired into CI as a regression gate.

The founding principle is fixed and not re-litigated here: **the language model proposes; the deterministic oracle (Icarus simulator plus an independently derived testbench) decides correctness.**
The system never self-grades.
Only oracle-verified output is presented to the student as correct; everything else is labeled as unverified.
This document grounds those principles in `product-ece/ECE-PHILOSOPHY.md`, `product-ece/ECE-VERIFICATION-METHODOLOGY.md`, and `product-ece/ECE-TECH-DECISIONS.md`, and inherits the non-negotiable security, quality, and resilience constraints from `product-ece/ECE-SECURITY-PERFORMANCE-RESILIENCE.md` and `product-ece/ECE-CODE-QUALITY-STANDARDS.md`.

### Spine stage mapping (for this slice)

The single-module loop maps to the product spine stages as follows.
Multi-unit decomposition (S2), full knowledge grounding (S3), bottom-up integration (S6 composition), and make-real (S9 export) are deferred to later specs; only the parts named below are in scope.

- S0 Intent capture and clarification (Requirement 4)
- S1 Spec and architecture, student-approved (Requirement 5)
- S4 Agentic Verilog generation for one module (Requirement 6)
- S6 Independent, spec-derived testbench generation (Requirement 7)
- S7 Simulate and verify with the Icarus oracle (Requirement 8)
- S8 Waveform and gate/schematic visualization (Requirement 9)
- S9 Conversational iteration (Requirement 10)
- Teach-mode explanation (Requirement 11)
- Cross-cutting: sandboxed tool-runner (Requirement 2), action recorder (Requirement 3), trust labeling (Requirement 14), model router (Requirement 12), knowledge grounding (Requirement 13), eval harness (Requirement 15)

## Glossary

- **HDL_Creation_Loop**: The overall M0+M1 system that carries a single Verilog module from intent to a verified, visualized artifact.
- **Editor**: The browser-based (React/TypeScript) code and conversation surface the student uses; it never calls model or tool APIs directly.
- **API_Gateway**: The server-side API layer that authenticates, authorizes, rate-limits, validates input, filters prompt injection, tracks cost, and proxies all model and tool calls. The Editor talks only to this layer.
- **Orchestrator**: The backend agent service that runs the spine stages (intent, spec, generation, testbench, verification, iteration, teach) and invokes tools.
- **Model_Router**: The provider-abstraction component that routes each task to a model (DeepSeek V4 for generation and repair, Gemini Flash for orchestration and teaching, Claude class as fallback) behind one interface.
- **Intent_Agent**: The Orchestrator role that captures and clarifies student intent (S0).
- **Spec_Agent**: The Orchestrator role that produces the structured spec and block-level architecture (S1).
- **Generation_Agent**: The Orchestrator role that generates candidate Verilog for one module (S4).
- **Testbench_Agent**: The Orchestrator role that generates the independent, spec-derived testbench (S6). It does not read the generated RTL.
- **Tool_Runner**: The sandboxed backend container that executes generated code (compile and simulate) under resource, time, and network limits.
- **Simulator**: Icarus Verilog (`iverilog` plus `vvp`) running inside the Tool_Runner; the deterministic oracle for compile and functional correctness in this slice.
- **Verification_Loop**: The Orchestrator control loop that runs generate, simulate, read-failure, and fix under an explicit budget until the oracle passes or the budget is exhausted.
- **Spec**: The approved, structured source-of-truth document (goal, constraints, module interface, acceptance criteria) produced at S1.
- **Module_Interface**: The declared ports (name, direction, width) and clocking/reset contract for the single module under construction.
- **Testbench**: The independently generated Verilog or simulation stimulus and checks derived from the Spec, used to decide correctness.
- **Waveform**: The value-change dump (VCD) produced by a simulation run, rendered as a timing diagram.
- **Schematic_View**: The gate/schematic diagram rendered from the verified netlist via Yosys `write_json` piped to netlistsvg.
- **Live_Run**: The optional in-browser behavioral view produced by compiling the design with Verilator to WebAssembly (WASM). See Requirement 9 for its M1-lite/deferred scope.
- **Action_Recorder**: The cross-cutting component that records every step as a replayable, ordered trace span (tool, sanitized inputs, outputs, exit code, timing, retries, cost).
- **Trace**: The ordered set of recorded spans for one session.
- **Knowledge_Retriever**: The single `retrieve` tool that serves the curated OKF bundle first and falls back to gap-driven web search for grounding (S3, scoped subset for this slice).
- **OKF_Bundle**: The curated Open Knowledge Format knowledge store (HDL patterns, verification recipes, toolchain notes) traversed by the Knowledge_Retriever.
- **Eval_Harness**: The regression test system that runs a fixed subset of VerilogEval and RTLLM problems through the loop and reports pass@k, iterations-to-pass, and cost per problem.
- **Trust_Tier**: The label describing how strongly a deterministic oracle proved an output. Values in this slice are `Verified` (oracle passed), `Unverified` (no oracle passed yet), and `Not_Applicable` (input or pedagogy stage).
- **Trust_Labeler**: The component that assigns and surfaces the Trust_Tier on every artifact shown to the student.
- **Display_Layer**: The Editor-side rendering component that applies the per-Trust_Tier visual treatment to an artifact before the Student sees it. It validates a label's oracle provenance but never re-derives correctness.
- **Cited**: A presentation treatment for an external fact shown together with its attributed source. `Cited` is distinct from the Trust_Tier scale: a cited fact is neither labeled `Verified` (a citation is attribution, not a Simulator verdict) nor labeled `Unverified` (it is grounded by its source). An external fact that cannot be cited is labeled `Unverified` rather than `Cited`.
- **Teach_Mode**: The Orchestrator role that explains design choices, waveform readings, and verification results in plain language grounded in the session's actual artifacts.
- **Iteration_Agent**: The Orchestrator role that applies a Student's requested change to the source and re-runs the Verification_Loop (S9).
- **Waveform_Viewer**: The Editor component that renders a Waveform (VCD) as a timing diagram.
- **Project_Store**: The persistence component that saves and reopens a project (Spec, sources, testbench, results, Trace) durably.
- **Session_Budget**: The hard cap on agentic iterations, tokens, wall-clock time, and cost for one loop run.
- **Student**: The authenticated end user who brings their own idea and approves at checkpoints.

## Requirements

### Requirement 1: Spine skeleton (browser editor, API layer, oracle path proof)

**User Story:** As a Student, I want a browser editor connected through a secure API layer to a backend that can compile and simulate a Verilog module and testbench, so that the end-to-end oracle path is proven before the full loop is built.

#### Acceptance Criteria

1. THE Editor SHALL run in the browser and SHALL send all model and tool requests to the API_Gateway rather than to any model or tool provider directly.
2. WHEN the Editor submits a request to the API_Gateway, THE API_Gateway SHALL authenticate the Student and authorize the request before performing any action.
3. IF an unauthenticated or unauthorized request reaches the API_Gateway, THEN THE API_Gateway SHALL reject the request with a sanitized error that excludes internal hosts, stack traces, and file paths.
4. WHEN a Student submits a Verilog module and a matching testbench through the Editor for the skeleton path, THE HDL_Creation_Loop SHALL compile and simulate them in the Tool_Runner and SHALL return a pass or fail result within the Session_Budget time limit.
5. WHEN a skeleton compile-and-simulate request completes, THE HDL_Creation_Loop SHALL report the result as exactly one of `pass`, `fail`, or `error`, with `error` reserved for tool or infrastructure failures distinct from a functional `fail`.
6. THE API_Gateway SHALL validate every inbound payload (size, type, and schema) before forwarding it to the Orchestrator or Tool_Runner.

### Requirement 2: Sandboxed tool-runner (Icarus Verilog oracle)

**User Story:** As a platform operator, I want all generated code to execute only inside a resource-capped, network-isolated sandbox, so that untrusted generated code cannot compromise the system.

#### Acceptance Criteria

1. WHERE code is executed, THE Tool_Runner SHALL run that code inside an isolated container that has no access to secrets and no default outbound network access.
2. THE Tool_Runner SHALL enforce a maximum wall-clock time limit on every compile and simulation invocation.
3. THE Tool_Runner SHALL enforce memory and CPU resource caps on every invocation.
4. WHEN a compile or simulation invocation exceeds its time limit, THE Tool_Runner SHALL terminate the invocation and SHALL return a timeout result classified as `error`.
5. WHEN the Simulator finishes a run, THE Tool_Runner SHALL capture the exit code, standard output, standard error, and any produced Waveform artifact.
6. IF generated code attempts a file-system or network operation outside its allotted sandbox workspace, THEN THE Tool_Runner SHALL deny the operation and SHALL record the denial in the Trace.
7. THE Tool_Runner SHALL treat all generated code and all student-supplied source as untrusted input and SHALL validate file names and paths before writing them into the sandbox workspace.
8. WHEN two invocations run the same source inputs, THE Simulator SHALL produce the same pass or fail verdict, so that the oracle result is reproducible.
9. IF the Tool_Runner cannot capture an output that the invocation is required to produce (standard output, standard error, exit code, or the expected Waveform artifact), THEN THE Tool_Runner SHALL classify the entire invocation as `error` rather than returning a partially captured result.

### Requirement 3: Action recorder (replayable trace)

**User Story:** As a developer and as a Student, I want every step of a session recorded as a replayable trace, so that failures can be diagnosed, regressions detected, and the process explained.

#### Acceptance Criteria

1. WHEN any spine stage or tool invocation runs, THE Action_Recorder SHALL append an ordered span capturing the stage or tool name, sanitized inputs, outputs, exit code, start time, duration, retry count, and cost.
2. THE Action_Recorder SHALL exclude secrets and credentials from every recorded span.
3. THE Action_Recorder SHALL redact personally identifiable information from recorded spans before persistence.
4. WHEN a tool invocation fails, THE Action_Recorder SHALL record the failure classification and any recovery attempt as spans in the same Trace.
5. THE Action_Recorder SHALL persist the Trace so that the ordered sequence of a completed session can be replayed after the session ends.
6. WHEN a Student requests the session history, THE HDL_Creation_Loop SHALL present the Trace as an ordered, human-readable list of steps and their results.

### Requirement 4: Intent capture and clarification (S0)

**User Story:** As a Student, I want to describe my own hardware idea and be asked focused clarifying questions, so that ambiguity is removed before any code is generated.

#### Acceptance Criteria

1. WHEN a Student submits a natural-language description of a single-module idea, THE Intent_Agent SHALL produce a structured restatement of the intent and its constraints.
2. WHEN the restated intent contains ambiguity or missing constraints, THE Intent_Agent SHALL ask focused clarifying questions before generation begins.
3. THE Intent_Agent SHALL limit clarification to a bounded maximum number of question rounds, and after that bound THE Intent_Agent SHALL propose a default scope for the Student to adjust.
4. IF the described idea exceeds single-module student scope for this slice, THEN THE Intent_Agent SHALL state that the scope exceeds the current slice and SHALL propose a single-module reduction.
5. THE HDL_Creation_Loop SHALL require explicit Student confirmation of the restated intent before proceeding to spec generation.
6. WHILE the Student has not confirmed the restated intent, THE HDL_Creation_Loop SHALL NOT start generation and SHALL NOT invoke the Generation_Agent, so that intent confirmation is a blocking precondition for generation.
7. THE Intent_Agent output SHALL carry the Trust_Tier `Not_Applicable`, because intent capture is an input stage and not a correctness claim.

### Requirement 5: Spec and architecture approval (S1)

**User Story:** As a Student, I want the clarified intent turned into a structured spec and block-level architecture that I approve, so that a single source of truth drives generation and verification.

#### Acceptance Criteria

1. WHEN the Student confirms the restated intent, THE Spec_Agent SHALL produce a Spec containing the module goal, constraints, the Module_Interface, and testable acceptance criteria.
2. THE Spec_Agent SHALL produce a block-level architecture description for the single module alongside the Spec.
3. THE Spec_Agent SHALL define every signal in the Module_Interface with a name, a direction, and a positive bit width.
4. IF an acceptance criterion in the Spec is not measurable or not verifiable by any rigorous method (simulation, formal verification, or manual inspection), THEN THE Spec_Agent SHALL flag that criterion and SHALL request a measurable replacement.
5. THE HDL_Creation_Loop SHALL require explicit Student approval of the Spec before proceeding to generation.
6. WHILE the Spec is not approved by the Student, THE HDL_Creation_Loop SHALL NOT invoke the Generation_Agent.
7. WHEN the Student approves the Spec, THE HDL_Creation_Loop SHALL persist the approved Spec as the source of truth for generation and verification via the Project_Store.
8. WHEN the Student edits the Spec before approval, THE Spec_Agent SHALL incorporate the edits and SHALL re-present the updated Spec for approval.
9. IF a Module_Interface signal is declared with a zero-width or otherwise non-positive bit width, THEN THE Spec_Agent SHALL reject that declaration and SHALL request a positive bit width before the Spec can be approved.

### Requirement 6: Agentic Verilog generation (S4)

**User Story:** As a Student, I want the system to generate synthesizable Verilog for my approved module, so that I get a working implementation of my idea.

#### Acceptance Criteria

1. WHEN the Student has approved the Spec, THE Generation_Agent SHALL generate candidate Verilog that implements the Module_Interface exactly as defined in the Spec.
2. THE Generation_Agent SHALL route its generation requests through the Model_Router.
3. WHEN generated Verilog fails to compile in the Simulator, THE Generation_Agent SHALL read the compiler errors and SHALL produce a revised candidate, within the Session_Budget.
4. THE Generation_Agent SHALL derive the generated module port list from the Spec Module_Interface and SHALL NOT introduce ports that are absent from the Spec.
5. IF generation reaches the Session_Budget without a compiling candidate, THEN THE HDL_Creation_Loop SHALL present the last failing candidate and its compiler errors to the Student and SHALL label the output Trust_Tier `Unverified`.
6. THE HDL_Creation_Loop SHALL NOT present a generated module as correct until the Verification_Loop reports a pass from the Simulator.
7. WHILE generation is in progress, THE HDL_Creation_Loop SHALL stream progress to the Editor without blocking the interface.

### Requirement 7: Independent testbench generation (S6, anti-circular)

**User Story:** As a Student, I want the testbench derived independently from my spec rather than from the generated code, so that the test cannot silently agree with a bug in the implementation.

#### Acceptance Criteria

1. WHEN the Spec is approved, THE Testbench_Agent SHALL generate the Testbench from the Spec and the intent, in a step separate from RTL generation.
2. THE Testbench_Agent SHALL NOT receive the generated RTL as input under any circumstances, including during development and debugging, so that verification can never become circular.
3. THE Testbench SHALL exercise the acceptance criteria defined in the Spec.
4. THE Testbench_Agent SHALL include stimulus covering boundary and error inputs defined or implied by the Spec, not only nominal inputs.
5. WHERE the Spec describes a standard block with a known reference behavior, THE Testbench_Agent SHALL include known-answer checks derived from that reference.
6. THE Testbench SHALL emit an unambiguous per-check pass or fail signal that the Simulator run can report.
7. THE Testbench_Agent output SHALL be recorded in the Trace with its source attributed to the Spec.

### Requirement 8: Simulation and verification loop (S7, the oracle decides)

**User Story:** As a Student, I want the deterministic simulator plus the independent testbench to decide whether my module is correct, so that a "working" claim is always backed by a real tool.

#### Acceptance Criteria

1. WHEN a candidate module and its Testbench are ready, THE Verification_Loop SHALL compile and simulate them together in the Tool_Runner using the Simulator.
2. THE Verification_Loop SHALL treat the Simulator result as the sole authority on functional correctness and SHALL NOT use model output to judge correctness.
3. WHEN the Simulator reports all Testbench checks passing, THE HDL_Creation_Loop SHALL mark the module Trust_Tier `Verified`.
4. WHEN the Simulator reports one or more failing checks, THE Verification_Loop SHALL provide the failing case and simulator output to the Generation_Agent and SHALL iterate generate-simulate-fix within the Session_Budget.
5. IF the Verification_Loop reaches the Session_Budget without a passing result, THEN THE HDL_Creation_Loop SHALL present the failing case to the Student, SHALL label the module Trust_Tier `Unverified`, and SHALL hand off to Teach_Mode for coaching.
6. THE HDL_Creation_Loop SHALL NOT report a module as working when no passing Simulator result exists for it.
7. WHEN a simulation run exceeds the Tool_Runner time limit, THE Verification_Loop SHALL classify the run as `error`, distinct from a functional `fail`, and SHALL record the classification in the Trace.
8. WHEN the Verification_Loop completes a run, THE HDL_Creation_Loop SHALL record the pass or fail verdict, the iteration count, and the cost in the Trace.
9. WHEN the Simulator reports all Testbench checks passing, THE HDL_Creation_Loop SHALL mark the module `Verified` based solely on that passing result, regardless of the Session_Budget status at the start of the run.
10. THE Verification_Loop SHALL record a passing verdict for a module only when all completion criteria are satisfied (every Testbench check derived from the Spec acceptance criteria passes), and SHALL NOT record a passing verdict on a merely completed or partially passing simulation run.

### Requirement 9: Visualization (waveform, gate/schematic, live run)

**User Story:** As a Student, I want to see my module as a waveform and a gate/schematic diagram, so that I can understand and share proof that my design works.

#### Acceptance Criteria

1. WHEN a simulation run produces a Waveform, THE Waveform_Viewer SHALL render the value-change output as a timing diagram in the Editor.
2. WHEN a module reaches Trust_Tier `Verified`, THE Schematic_View SHALL render the gate/schematic diagram from the verified netlist using the Yosys `write_json` to netlistsvg path.
3. THE HDL_Creation_Loop SHALL derive every rendered visualization from an actual simulator or netlist artifact and SHALL NOT render a hand-constructed or unverified result as if it were verified.
4. WHERE a visualization is derived from an `Unverified` artifact, THE Trust_Labeler SHALL mark that visualization as `Unverified`.
5. WHERE the design is too large to render responsively, THE Schematic_View SHALL render the top level with drill-down rather than blocking the interface.
6. WHERE the in-browser Live_Run is enabled for this slice, THE Live_Run SHALL compile the design with Verilator to WASM lazily on the first invocation of the live panel AND SHALL cache the compiled result; THE Live_Run SHALL NOT compile eagerly AND SHALL NOT run on the verification path; and THE HDL_Creation_Loop SHALL NOT treat any Live_Run result as the correctness verdict, which remains the backend Simulator's.
7. THE HDL_Creation_Loop MAY defer the in-browser Live_Run beyond this slice as an M1-lite item; WHERE the Live_Run is deferred, THE HDL_Creation_Loop SHALL still deliver the Waveform and Schematic_View from the backend oracle.
8. THE HDL_Creation_Loop SHALL treat Live_Run for this slice as exactly one of enabled or deferred, never both, as the two outcomes of a single slice-scope decision.
9. WHERE Live_Run is deferred, THE HDL_Creation_Loop SHALL NOT compile the design to WASM, because the capability is out of scope for the slice.
10. THE HDL_Creation_Loop SHALL deliver the Waveform and the Schematic_View independently, each as soon as its source artifact is available, and SHALL NOT block delivery of one on the readiness or success of the other.
11. IF a visualization cannot be produced (tool failure, unsupported construct, or timeout), THEN THE HDL_Creation_Loop SHALL still deliver any available visualization AND SHALL surface an explicit `unavailable` status with a sanitized reason for the missing one, rather than silently omitting it.
12. THE Trust_Labeler SHALL label each visualization independently per its source artifact's Trust_Tier, regardless of whether the other visualization was delivered.

### Requirement 10: Conversational iteration (S9)

**User Story:** As a Student, I want to ask for changes in conversation and have the module re-verified automatically, so that iteration stays trustworthy.

#### Acceptance Criteria

1. WHEN a Student requests a change to a verified module, THE Iteration_Agent SHALL apply the change to the affected source and SHALL re-run the Verification_Loop.
2. WHEN an iteration changes the Module_Interface, THE HDL_Creation_Loop SHALL update the Spec and regenerate the Testbench from the updated Spec before re-verification.
3. THE HDL_Creation_Loop SHALL re-run the full relevant Testbench after each change, so that regressions are detected.
4. WHEN a change causes a previously passing module to fail, THE Iteration_Agent SHALL report the regression and SHALL offer to revert to the last `Verified` state.
5. THE HDL_Creation_Loop SHALL NOT present an iterated module as correct until the Verification_Loop reports a pass on the changed design.
6. WHEN an iteration completes, THE HDL_Creation_Loop SHALL present a diff of the change together with its new verification verdict.
7. WHEN a Student edits a module currently at Trust_Tier `Verified`, THE HDL_Creation_Loop SHALL immediately demote that module to Trust_Tier `Unverified` until the Verification_Loop reports a pass on the changed design.
8. WHILE re-verification of an iterated module is in progress, THE HDL_Creation_Loop SHALL stream progress and MAY display the intermediate module under the `Unverified` tier with a transient `verifying` status.
9. THE Trust_Labeler SHALL render any in-progress or `Unverified` iterated module with the visual treatment reserved for `Unverified` artifacts, visually distinct from `Verified`.

### Requirement 11: Teach-mode explanation

**User Story:** As a Student, I want plain-language explanations grounded in the actual results, so that I learn from the build and can fix my own errors.

#### Acceptance Criteria

1. WHEN Teach_Mode is enabled, THE Teach_Mode SHALL explain design choices, waveform readings, and verification results in plain language tied to the actual artifacts of the session.
2. THE Teach_Mode SHALL ground each explanatory claim in the grounding type appropriate to that claim: verified tool output for claims about the Student's own design or its results, and a cited knowledge source for general domain facts.
3. IF an explanation refers to a claim that no oracle has verified, THEN THE Teach_Mode SHALL label that claim as `Unverified`.
4. WHEN the Verification_Loop ends without a passing result, THE Teach_Mode SHALL coach the Student toward diagnosing and fixing the failing case rather than hiding the failure.
5. THE Teach_Mode SHALL state the limit of the guarantee, distinguishing simulation-verified behavior from real-hardware validation, whenever it presents a `Verified` result.
6. THE Teach_Mode SHALL NOT teach a fact that the oracle or a cited source did not confirm.
7. THE Teach_Mode SHALL NOT require a citation for a claim whose ground truth is the Student's own verified tool output, and SHALL NOT require tool output for a general domain fact whose ground truth is a cited source.
8. WHERE a single explanation spans both a design-specific claim and a general domain fact, THE Teach_Mode SHALL ground each part in its appropriate source, so both grounding types may appear together.
9. IF a claim has neither appropriate grounding, THEN THE Teach_Mode SHALL label that claim `Unverified` or SHALL NOT teach it.

### Requirement 12: Model router

**User Story:** As a platform operator, I want each task routed to an appropriate model behind one abstraction, so that models are swappable and cost stays controlled.

#### Acceptance Criteria

1. THE Model_Router SHALL expose a single provider-abstracted interface for all model calls made by the Orchestrator.
2. WHEN a generation or repair task is requested, THE Model_Router SHALL route the request to the configured generation model (default DeepSeek V4).
3. WHEN an orchestration or teaching task is requested, THE Model_Router SHALL route the request to the configured orchestration model (default Gemini Flash).
4. IF a hard planning task is flagged for escalation, THEN THE Model_Router SHALL route the request to the configured fallback model (Claude class).
5. IF a routed model call fails or times out, THEN THE Model_Router SHALL apply the configured fallback or retry policy under the Session_Budget and SHALL record the outcome in the Trace.
6. THE Model_Router SHALL NOT expose provider credentials to the Editor or include them in the Trace, logs, or errors.
7. THE Model_Router SHALL confine each provider credential to the vendor adapter that makes the outbound provider call, resolved from the secret manager at the point of use, and SHALL NOT store or pass credentials in shared router or Orchestrator state.
8. THE Model_Router SHALL grant each provider adapter access only to its own provider's credential, so no component holds credentials for providers it does not call, including when multiple models are active simultaneously.
9. THE Model_Router SHALL NOT include any provider credential in a prompt, in a cross-component payload, or in any inter-service message.
10. THE Model_Router SHALL support model selection and routing diagnosis using redacted credential references only, so switching models and diagnosing routing never require exposing a credential value.

### Requirement 13: Knowledge grounding (OKF-first, gap-driven web)

**User Story:** As a Student, I want generation grounded in curated knowledge with citations, so that outputs are less likely to be hallucinated and I can trace claims.

#### Acceptance Criteria

1. WHEN a spine stage needs external knowledge, THE Orchestrator SHALL request it through the single Knowledge_Retriever `retrieve` tool.
2. THE Knowledge_Retriever SHALL consult the curated OKF_Bundle before performing any web search.
3. WHERE the OKF_Bundle does not cover a declared knowledge gap, THE Knowledge_Retriever SHALL perform a targeted web search only for that gap rather than a blind crawl.
4. THE Knowledge_Retriever SHALL treat all retrieved web content as untrusted input and SHALL sanitize it against prompt injection before it reaches the Orchestrator.
5. WHEN retrieved knowledge is used in an output shown to the Student, THE HDL_Creation_Loop SHALL surface the citation for that knowledge.
6. THE HDL_Creation_Loop SHALL use retrieved knowledge only to improve proposals and SHALL NOT use it to override the Simulator verdict.
7. WHERE an external fact is cited, THE HDL_Creation_Loop SHALL present it with its citation as `Cited` and SHALL NOT label it `Unverified`; IF an external fact cannot be cited, THEN THE HDL_Creation_Loop SHALL mark that fact as `Unverified`, even if that fact improved a proposal.
8. THE HDL_Creation_Loop SHALL determine every verification label from what grounds the item, and SHALL NOT let how retrieved knowledge was used affect any label.
9. THE Trust_Labeler SHALL set a design artifact's Trust_Tier from the oracle verdict alone, regardless of whether retrieved knowledge informed its proposal.
10. THE HDL_Creation_Loop SHALL NOT present a cited external fact as oracle-`Verified`, because a citation is attribution, not a Simulator verdict.
11. THE HDL_Creation_Loop SHALL track a fact's citation status independently of whether the fact influenced any proposal, so usefulness never suppresses the `Unverified` label.
12. WHERE an uncited fact is surfaced to the Student in an explanation or claim, THE HDL_Creation_Loop SHALL present it as `Unverified` rather than as certain.

### Requirement 14: Trust tiers and labeling

**User Story:** As a Student, I want every artifact clearly labeled by how strongly it was verified, so that I never mistake an unproven output for a proven one.

#### Acceptance Criteria

1. THE Trust_Labeler SHALL assign a Trust_Tier to every artifact presented to the Student.
2. THE Trust_Labeler SHALL derive an artifact's Trust_Tier solely from recorded oracle verdicts, and SHALL label an artifact `Verified` if and only if a passing Simulator verdict exists for the current version of that artifact.
3. WHERE an artifact has no passing oracle verdict, THE Trust_Labeler SHALL label it `Unverified`.
4. WHERE an artifact belongs to an input or pedagogy stage, THE Trust_Labeler SHALL label it `Not_Applicable`.
5. THE HDL_Creation_Loop SHALL make the Trust_Tier visible to the Student wherever the artifact is displayed.
6. THE HDL_Creation_Loop SHALL reserve the `Verified` visual treatment exclusively for artifacts at Trust_Tier `Verified`, and SHALL NOT display an `Unverified` or `Not_Applicable` artifact with that treatment.
7. THE HDL_Creation_Loop SHALL NOT maintain any verification status that can be set by the Model_Router, the Generation_Agent, or any non-oracle component, so that no internal `verified` state can diverge from the oracle.
8. WHEN the Trust_Labeler assigns `Verified`, THE Trust_Labeler SHALL reference the specific oracle Trace span that justifies the label, so a `Verified` label cannot exist without a recorded oracle pass.
9. THE HDL_Creation_Loop SHALL treat any model-produced or self-assessed `verified` signal as untrusted model output (per Requirement 17, item 5) that cannot confer `Verified` status.
10. THE Trust_Labeler SHALL give each Trust_Tier a distinct visual treatment, so that `Verified`, `Unverified`, and `Not_Applicable` are mutually unmistakable to the Student.
11. WHERE a `Not_Applicable` pedagogy artifact references a `Verified` artifact, THE HDL_Creation_Loop SHALL apply the `Verified` treatment only to the referenced `Verified` artifact and SHALL keep the pedagogy artifact's own treatment `Not_Applicable`.
12. THE HDL_Creation_Loop SHALL treat an artifact's Trust_Tier as a claim bound to its evidence, so a `Verified` label SHALL carry a reference to the passing oracle Trace span that justifies it (per item 8).
13. BEFORE applying the `Verified` visual treatment, THE Display_Layer SHALL confirm the label is `Verified` AND its oracle-provenance reference is present and valid, as an integrity check on the label's evidence rather than a re-derivation of correctness.
14. IF a label is missing, malformed, or its provenance cannot be validated, THEN THE Display_Layer SHALL fail closed and render the artifact as `Unverified`, never as `Verified`.
15. WHEN the Display_Layer rejects a `Verified` label for failing its provenance check, THE HDL_Creation_Loop SHALL record the discrepancy in the Trace so that a Trust_Labeler defect is surfaced rather than silently masked.

### Requirement 15: Eval harness as a CI regression gate

**User Story:** As a developer, I want the loop run against a fixed benchmark subset in CI, so that correctness regressions block merges.

#### Acceptance Criteria

1. THE Eval_Harness SHALL run a fixed subset of VerilogEval and RTLLM problems through the HDL_Creation_Loop.
2. WHEN the Eval_Harness runs, THE Eval_Harness SHALL report pass@k, iterations-to-pass, and cost per problem for the subset.
3. THE Eval_Harness SHALL decide each problem's pass or fail using the Simulator oracle, not model self-assessment.
4. WHEN the Eval_Harness runs in CI, THE CI pipeline SHALL block the merge IF the measured pass@k for the subset drops strictly below the recorded baseline minus an agreed noise tolerance; a pass@k equal to the baseline SHALL NOT block the merge.
5. THE Eval_Harness SHALL record each eval run's results so that pass@k, iterations-to-pass, and cost can be tracked over time.
6. THE Eval_Harness SHALL run each benchmark problem inside the Tool_Runner sandbox under the same time and resource caps as a student session.
7. THE CI pipeline SHALL treat the eval pass@k gate as armed only after a non-zero baseline has been established (at or after M1); WHILE the gate is unarmed, the other CI gates SHALL be the merge authority so that bootstrapping merges are not deadlocked.
8. WHERE the eval pass@k gate is armed, THE CI pipeline SHALL block the merge IF the measured pass@k is 0% or below an agreed absolute floor, regardless of the baseline, so that a catastrophic total-failure state can never merge.
9. THE CI pipeline SHALL treat the recorded baseline as a ratcheting high-water mark, lowered only by an explicit reviewed decision, so that it cannot silently drift down to 0.
10. THE Eval_Harness SHALL run with fixed seeds, temperature, and sample count so that pass@k is reproducible run-to-run, minimizing measurement noise in the comparison.
11. THE CI pipeline SHALL size the noise tolerance to absorb residual measurement variance only, and SHALL rely on the ratcheting baseline (item 9) and the absolute floor (item 8) to prevent slow downward drift within tolerance.

### Requirement 16: Project persistence and durability

**User Story:** As a Student, I want my project saved and reopenable, so that a crash or a return visit does not lose my approved work.

#### Acceptance Criteria

1. WHEN the Student approves a Spec or reaches a `Verified` module, THE Project_Store SHALL persist a durable checkpoint of the project state.
2. THE Project_Store SHALL persist the Spec, the sources, the Testbench, the latest verification result, and the Trace for a project.
3. WHEN a Student reopens a saved project, THE Project_Store SHALL restore the Spec, sources, testbench, results, and Trace.
4. IF the session crashes mid-run, THEN on the Student's next authenticated access THE HDL_Creation_Loop SHALL automatically restore the last durable, consistent checkpoint (approved Spec, sources, Testbench, latest results, and Trace) without losing approved Student work, after verifying its integrity.
5. WHEN a Student accesses a project, THE API_Gateway SHALL verify per-object that the Student owns or is authorized for that project before returning it.
6. THE HDL_Creation_Loop SHALL restore to the last durable checkpoint, never to the partial mid-run state, so that an inconsistent or corrupted in-flight state is never loaded.
7. IF the last checkpoint fails its integrity check, THEN THE HDL_Creation_Loop SHALL fail safe by restoring the previous valid checkpoint AND SHALL surface what could not be recovered, rather than loading a corrupt state.
8. THE HDL_Creation_Loop SHALL NOT automatically re-execute the interrupted run; THE HDL_Creation_Loop SHALL surface the interrupted step from the Trace and let the Student resume it, AND SHALL require explicit Student approval with an idempotency key before re-running any side-effectful step.
9. WHEN restoring a project, THE API_Gateway SHALL enforce per-object authorization (per item 5) so that a Student can automatically restore only their own project.
10. THE HDL_Creation_Loop SHALL preserve the crash Trace separately so that automatic state restoration does not destroy information needed to debug the crash cause.

### Requirement 17: Cross-cutting non-functional constraints

**User Story:** As a platform operator, I want the slice to meet the baseline security, cost, and resilience constraints, so that it is safe and economical to run for a free student tier.

#### Acceptance Criteria

1. THE HDL_Creation_Loop SHALL enforce a Session_Budget that caps agentic iterations, tokens, wall-clock time, and cost for each loop run.
2. WHEN a Session_Budget cap is reached, THE HDL_Creation_Loop SHALL stop the loop, present the best available result with its Trust_Tier, and record the stop reason in the Trace.
3. THE HDL_Creation_Loop SHALL keep the per-session cost on the default models within the pennies range defined by `product-ece/ECE-TECH-STACK.md`.
4. WHEN any component returns an error to the Editor, THE API_Gateway SHALL sanitize the error so that it excludes internal hosts, IP addresses, stack traces, and secrets.
5. THE HDL_Creation_Loop SHALL validate model output as untrusted input before executing it or presenting it as correct.
6. WHILE a long tool run is in progress, THE HDL_Creation_Loop SHALL stream progress to the Editor and SHALL NOT block the interface on the long job.
7. THE HDL_Creation_Loop SHALL NOT place secrets in source, client bundles, prompts, logs, errors, or the Trace.
