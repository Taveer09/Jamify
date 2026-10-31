import { z } from 'zod'
import { fingerprint, uniqueReviewEntries } from '../../domain/playlist'
import { SESSION_SIZE } from '../../domain/session'

const nullableText = z.string().nullable()
const entry = z.object({
  entryKey: z.string(), originalIndex: z.number().int().nonnegative(), observedUri: nullableText,
  sourceUri: nullableText, playbackUri: nullableText, identityConfidence: z.enum(['confirmed', 'ambiguous', 'opaque']),
  kind: z.enum(['track', 'episode', 'local', 'unavailable']), title: z.string(), artist: z.string(),
  imageUrl: nullableText, spotifyUrl: nullableText, durationMs: z.number().nonnegative().nullable(),
  canPlay: z.boolean(), canCopy: z.boolean(), canRemove: z.boolean(),
})
export const baselineSchema = z.object({
  accountId: z.string(), playlistId: z.string(), playlistName: z.string(), snapshotId: z.string(),
  orderedEntries: z.array(entry).max(10_000), fingerprint: z.string(),
}).refine((value) => value.fingerprint === fingerprint(value.orderedEntries), 'Несогласованное содержимое плейлиста.')
const decision = z.enum(['keep', 'remove', 'skip'])
export const sessionSchema = z.object({
  schemaVersion: z.literal(1), accountId: z.string(), playlistId: z.string(), runId: z.string(),
  reviewedUris: z.array(z.string()).max(10_000), baselineSnapshotId: z.string(), baselineFingerprint: z.string(),
  seed: z.number().int(), queue: z.array(z.string()).max(10_000), cursor: z.number().int().nonnegative().max(SESSION_SIZE),
  decisions: z.record(z.string(), decision),
  history: z.array(z.object({ uri: z.string(), before: decision.optional(), after: decision })).max(SESSION_SIZE),
}).superRefine((value, context) => {
  const replay: Record<string, z.infer<typeof decision>> = {}
  let historyValid = true
  for (const item of value.history) {
    if (item.before !== replay[item.uri]) historyValid = false
    if (item.after === 'skip') delete replay[item.uri]
    else replay[item.uri] = item.after
  }
  const keys = new Set([...Object.keys(replay), ...Object.keys(value.decisions)])
  const reviewed = new Set(value.reviewedUris)
  if (value.cursor > value.queue.length || value.cursor !== value.history.length || new Set(value.queue).size !== value.queue.length ||
    reviewed.size !== value.reviewedUris.length || value.queue.some((uri) => reviewed.has(uri)) || !historyValid ||
    [...keys].some((uri) => replay[uri] !== value.decisions[uri]) || value.history.some((item, i) => item.uri !== value.queue[i])) {
    context.addIssue({ code: 'custom', message: 'Черновик содержит несогласованную очередь.' })
  }
})
export const draftSchema = z.object({
  baseline: baselineSchema, session: sessionSchema, revision: z.number().int().positive(), updatedAt: z.number(),
}).superRefine(({ baseline, session }, context) => {
  const known = new Set(uniqueReviewEntries(baseline.orderedEntries).map((entry) => entry.sourceUri))
  const covered = new Set([...session.queue, ...session.reviewedUris])
  if (session.accountId !== baseline.accountId || session.playlistId !== baseline.playlistId ||
    session.baselineFingerprint !== baseline.fingerprint || session.baselineSnapshotId !== baseline.snapshotId || session.queue.some((uri) => !known.has(uri)) || [...known].some((uri) => !covered.has(uri!))) {
    context.addIssue({ code: 'custom', message: 'Черновик не соответствует аккаунту или исходному плейлисту.' })
  }
})
export type StoredDraft = z.infer<typeof draftSchema>
