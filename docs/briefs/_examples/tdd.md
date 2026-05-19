mode: tdd

# Add `parseDuration("90s") → 90_000` helper

Add `parseDuration(input: string): number` to `src/utils/duration.ts`. Accepts
`Ns`, `Nm`, `Nh`, returns milliseconds. Throws on invalid input.

Write failing tests **first** in `src/utils/__tests__/duration.test.ts` for:

1. Whole seconds: `parseDuration('90s')` → `90_000`.
2. Whole minutes: `parseDuration('5m')` → `300_000`.
3. Whole hours: `parseDuration('2h')` → `7_200_000`.
4. Invalid input throws: `parseDuration('90x')`.

Confirm tests fail, then implement the helper. The reviewer must verify the
tests existed BEFORE the implementation commit.

## Acceptance

- Tests written and confirmed failing in the first commit.
- Implementation commit makes them pass.
- No defensive validation for hypothetical inputs beyond the cases listed.
