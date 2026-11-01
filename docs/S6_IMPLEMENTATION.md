# S6 durable demo copy — implementation handoff

2026-11-01, Asia/Oral. This work implements the copy core on the demo gateway. It makes no live Spotify writes and adds no live mutation adapter. The S0 DELETE gate remains open; mock results do not close it.

## Public integration contract

`DurableApplyCoordinator.apply(plan)`, `recover(accountId, sourcePlaylistId)` and `resume(accountId, sourcePlaylistId)` handle both existing modes. They share the source account/playlist Web Lock and the IndexedDB operation store. Recovery only reads remote contents and persists reconciliation; only an explicit apply/resume dispatches a new create/append.

For copy completion, `ApplyResult.baseline` is the **source** baseline. `targetPlaylistId` identifies the created copy and `targetBaseline` contains its fully verified contents. Use `targetBaseline` for result counts. Continue the review with `baseline`, `session` and `draftRevision`; never replace the source draft with the copy target.

`MutationJournal.targetPlaylistId` defaults to `null`, and `pendingCreate` defaults to `false` when loading old removal receipts. `pendingBatch` records append intent with the full before/after canonical prefixes. Copy `confirmedPrefix` counts appended entries; removal continues to count removed unique URIs. `expectedSnapshotId` tracks the copy target once its ID is known.

`OperationStorage.finish(journal, source, target)` verifies source identity/content/version separately from target contents/version. The source draft's `finalizeSession` and completed operation receipt commit in the same IndexedDB transaction. The source playlist stays unchanged; completed decisions and undo are cleared, reviewed URIs/seed/remaining source queue continue.

## Safety and recovery behavior

- Persist create intent before calling `createPrivatePlaylist`. Persist its returned ID before any append. An ambiguous create response or failed ID checkpoint leaves `pendingCreate` with no ID: recovery never creates another playlist.
- Append the first confirmed occurrence of each retained exact source URI in original source order, at most 100 per call. Never dispatch against the source ID, rewrite it, or clean up a partial copy.
- Before each append, recheck account, frozen draft decisions, current source version/content/copyability and the entire target prefix/version. After each append, read the entire target to verify the expected prefix.
- An unchanged ambiguous append remains pending and is never blindly retried. If its successful result can be read, checkpoint it; a remaining suffix needs a separate explicit resume after an ambiguous response. A definite rejection clears only that unsent/rejected intent, with no automatic retry.
- Persist Retry-After from initial account/source reads, create, target/source reads, append and reconciliation reads. Reload and another click respect the saved delay.
- Unsupported retained entries block copying; supported confirmed episodes remain in order. Snapshot-only edits and unexpected target contents cause conflict. Source changes stop the operation without source writes.
- Validate persisted plan entries against canonical contents and append batches against their exact planned prefix. Rebuild every unfinalized plan against the actual frozen draft baseline and decisions before dispatch/reconciliation and inside finalization. Corrupt or substituted journals cannot authorize different writes.

## Verification

`npm run test:copy` selects the real copy failure suite. The current suite covers 46 cases; `npm run test:apply` covers these plus 20 existing removal/migration cases, 66 total. Covered risks include >100 append, source ordering/duplicates, empty/mixed entries, lost create/append responses, crashes before/after checkpoints, reload, account switches, source/target edits, Retry-After phases, malformed/substituted persisted plans and atomic finalization rollback.

`npm run check` passed after the final null-source journal regression: typecheck, lint, 156 tests and production build. `git diff --check` passed. The independent reviewer reported its additional failure suite as 19/19 pass, with no open confirmed finding in its copy/recovery/integrity scope. Root separately reported its initial copy/demo browser run as 18/18 pass; the root final integrated browser suite passed98/98, plus2/2 large-copy browser scenarios on the same source code. Live create/append/read for this S6 implementation remains **not-run**.

## Boundaries

A lost create response without an ID requires manual library inspection; no automatic discovery or deletion is attempted. A conflicting operation intentionally stays blocked rather than rewriting a playlist. Remote reads cannot provide transactional isolation against edits made between requests. These are explicit recovery limits, not a claim of exactly-once Spotify mutation behavior.
