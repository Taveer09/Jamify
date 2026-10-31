# Jamify

Read docs/SPEC.md, docs/PLAN.md, docs/TASKS.md and docs/STATUS.md before changes.
Stack: React, TypeScript, Vite. Current work: S0 foundation and capability probe.

- All Spotify writes must be explicit user actions. S0 may only write to a disposable test playlist created by its own probe; never accept an arbitrary mutation target from a URL/input.
- OAuth PKCE; never introduce Client Secret, passwords, persistent access tokens, or credentials in logs, screenshots, reports, fixtures or git.
- Mock checks are not proof of live API/playback. Preserve pass/fail/not-run distinctions.
- Missing linked_from/product fields are expected for new Development Mode apps. Do not invent source track identity or infer Premium from a missing product field.
- No automatic retries of ambiguous Spotify mutations. Stop and reconcile; no automatic cleanup by rewriting playlists.
- Run npm run check and relevant Playwright checks before reporting a step ready.
- Do not publish/push/deploy unless the user requests it. Local commits are allowed after checks; no commit is required per step.
- Future test scripts must select meaningful tests; never add success-only placeholders. Full live S0 remains open until interactive probes are actually performed.
- Frontend skills available locally: design-taste-frontend, ui-ux-pro-max. Verification: verify; independent mutation reviews: hard-review.
