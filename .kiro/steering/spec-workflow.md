---
inclusion: always
---

# Spec clarification workflow (founder preference)

When working a spec (requirements or design), whenever the analysis produces clarifying questions or open decisions:

1. Write ALL those questions into a markdown file in the SAME spec folder, named clearly, e.g.:
   - `.kiro/specs/<feature>/clarification-questions.md` (for requirements-analysis questions)
   - `.kiro/specs/<feature>/design-questions.md` (for design-phase open decisions)
   Each question: a stable ID, the requirement/section it maps to, the tension/why it matters, and the candidate options (with a recommended option + one-line rationale).
2. Then STOP and let the founder respond with their own answers markdown file (e.g. `clarification-answers.md`) placed in the same folder, where they explain the reasoning behind each answer.
3. Read that answers file and incorporate the decisions into the spec via the correct spec subagent, preferring the founder's suggested wordings where given, in strict EARS.
   The subagent is the default because it keeps the document's own conventions.
   When it is genuinely unavailable (dispatch refuses, or the task tools are not exposed), say so and edit the document directly rather than stalling the spec.
   A direct edit carries two hard rules: do not touch a task's status marker (`- [ ]`, `- [x]`, `- [~]`, or the `*` optional flag) and do not touch a task's title line, because the task tooling reads those as state.
   Change body text only, then re-run `validate_spec_format` on the file.
4. A working questions/answers file may be deleted once its decisions are finalized into the spec (ask or note it, do not silently delete tracked files the founder may want as a record).

Do not skip the questions file: surfacing the questions in a file the founder can annotate is the required handoff, not an inline chat list.
