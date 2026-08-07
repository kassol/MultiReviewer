# PROTOTYPE — report_finding spike

Throwaway. Answers one question: can several vendors' models be made to emit
structured Findings through a custom `report_finding` tool, while the tool
allowlist keeps them read-only?

Run: `npm install && node spike.mjs`

## Verdict

Yes, with two conditions.

| Model | Findings | Malformed |
|---|---|---|
| anthropic/claude-haiku-4-5 | 3 | 0 |
| deepseek/deepseek-v4-flash | 5 | 0 |
| openrouter/google/gemini-3-flash-preview | 0 → 4 after fix | 0 |
| openrouter/z-ai/glm-4.6 | 13 | 0 |
| kimi-coding/k3 | failed (402, dead credential) | — |

1. **Enum fields must spell out their allowed values in the field
   `description`.** With a bare `Type.Union` of literals, Gemini invented its own
   vocabulary (`critical`/`major`/`minor`, `reliability`/`logic_error`), Pi
   rejected every call, and four correct findings were lost. The model received
   the validation error four times and never adapted. Adding
   `{ description: "One of exactly: high, medium, low" }` made it use the right
   values natively. A server-side normalisation map is kept as a safety net.
2. **Reviewer failure is silent.** `session.prompt()` resolves normally when the
   model call fails. The failure is visible only in
   `session.agent.state.errorMessage` or the last message's
   `stopReason === "error"`. Rejected tool calls are visible only as
   `tool_execution_end` with `isError`. An orchestrator that checks neither
   loses a whole Reviewer and still reports the run as complete.

Read-only held: only `read, grep, find, ls, report_finding` were ever exposed,
and no fixture file was modified in any run.

Cross-model variance on an identical fixture was 3 / 5 / 4 / 13 findings, which
is the empirical case for the dedup layer. The 13 include a lot of low-severity
subjective noise, which is the cost of the full-review scope.

## Files

- `spike.mjs` — the multi-vendor run
- `debug-silent.mjs` — why two providers returned nothing
- `debug-gemini.mjs` — captures the rejected tool calls
- `debug-gemini-lenient.mjs` — the fix, verified
- `fixture/` — two files with four planted defects
