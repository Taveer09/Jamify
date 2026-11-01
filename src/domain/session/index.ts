import type { Baseline, Decision, ReviewSession } from '../../contracts'
import { shuffled, uniqueReviewEntries } from '../playlist'

export const SESSION_SIZE = 25
export function createSession(baseline: Baseline, seed: number, runId = crypto.randomUUID()): ReviewSession {
  return {
    schemaVersion: 1, accountId: baseline.accountId, playlistId: baseline.playlistId, runId,
    reviewedUris: [], baselineSnapshotId: baseline.snapshotId, baselineFingerprint: baseline.fingerprint,
    seed, queue: shuffled(uniqueReviewEntries(baseline.orderedEntries).map((entry) => entry.sourceUri!), seed),
    cursor: 0, decisions: {}, history: [],
  }
}
export function currentUri(session: ReviewSession): string | null {
  return session.cursor < Math.min(SESSION_SIZE, session.queue.length) ? session.queue[session.cursor] : null
}
export function decide(session: ReviewSession, expectedUri: string, decision: Decision): ReviewSession {
  if (currentUri(session) !== expectedUri) return session
  const decisions = { ...session.decisions }
  const before = decisions[expectedUri]
  if (decision === 'skip') delete decisions[expectedUri]
  else decisions[expectedUri] = decision
  return { ...session, cursor: session.cursor + 1, decisions,
    history: [...session.history, { uri: expectedUri, before, after: decision }] }
}
export function undo(session: ReviewSession): ReviewSession {
  const last = session.history.at(-1)
  if (!last) return session
  const decisions = { ...session.decisions }
  if (last.before === undefined) delete decisions[last.uri]
  else decisions[last.uri] = last.before
  return { ...session, cursor: session.cursor - 1, decisions, history: session.history.slice(0, -1) }
}
export function assertBaseline(session: ReviewSession, baseline: Baseline): void {
  if (session.accountId !== baseline.accountId || session.playlistId !== baseline.playlistId) throw new Error('Черновик принадлежит другому аккаунту или плейлисту.')
  if (session.baselineSnapshotId !== baseline.snapshotId || session.baselineFingerprint !== baseline.fingerprint) throw new Error('Плейлист изменился после начала разбора. Решения требуют нового предпросмотра.')
}
export function finalizeSession(session: ReviewSession, after: Baseline): ReviewSession {
  if (session.accountId !== after.accountId || session.playlistId !== after.playlistId) throw new Error('Результат относится к другому аккаунту или плейлисту.')
  const reviewedUris = [...new Set([...session.reviewedUris, ...session.queue.slice(0, session.cursor)])]
  const reviewed = new Set(reviewedUris)
  const available = new Set(uniqueReviewEntries(after.orderedEntries).map((entry) => entry.sourceUri!))
  const remaining = session.queue.slice(session.cursor).filter((uri) => available.has(uri) && !reviewed.has(uri))
  const known = new Set([...session.queue, ...reviewedUris])
  const added = uniqueReviewEntries(after.orderedEntries).map((entry) => entry.sourceUri!).filter((uri) => !known.has(uri))
  return { ...session, baselineSnapshotId: after.snapshotId, baselineFingerprint: after.fingerprint,
    reviewedUris, queue: [...remaining, ...shuffled(added, session.seed)], cursor: 0, decisions: {}, history: [] }
}
