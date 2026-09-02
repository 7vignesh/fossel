<!--
Thanks for contributing to Fossel! Please fill this out so review is quick.
Keep the PR focused on one concern.
-->

## What & why

<!-- What does this change do, and why? -->

## Related issue

<!-- e.g. Closes #3. If there's no issue, briefly explain the motivation. -->

Closes #

## How was it tested?

<!-- Which commands did you run? What tests did you add or update? -->

## Checklist

- [ ] `npm run ci` passes locally (typecheck + tests + build + smoke)
- [ ] Added or updated tests for this change
- [ ] The change is focused on one concern (no unrelated refactors/reformatting)
- [ ] For schema changes: added a new migration in `src/db/migrate.ts` (never edited a shipped one)
- [ ] For retrieval/search changes: ran `npm run bench` and included the before/after numbers below

<!-- Paste bench numbers here if applicable -->
