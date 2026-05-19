mode: ralph

# Fix the flaky `pickNext` integration test

The test `queue/__tests__/pick-next.test.ts:120` fails ~1 in 5 runs. The race
appears between the unified store flipping a row to `in_flight` and the
adapter notifying. We've already burned two attempts on this without a
verifiable fix — the next pass must keep retrying until verify (typecheck +
lint + test, run 5 times) is green.

## Acceptance

- Test passes 5/5 runs in CI.
- No new `setTimeout` / `await delay` in production code — instrument the seam
  instead.
- If the first plan does not produce a green run, the architect must list two
  fallback strategies (e.g. mutex around `pickNext`, or move the flip onto
  the unified store's transaction).
