import type { IDBPDatabase } from 'idb'
import type { ApplyPlan, Baseline, MutationJournal } from '../../contracts'
import { buildApplyPlan, canonicalEntries, fingerprint } from '../../domain/playlist'
import { finalizeSession } from '../../domain/session'
import { draftSchema, journalSchema } from './schema'
import type { StoredDraft } from './schema'
import type { JamifyDatabase } from './database'

async function abortQuietly(tx: { abort: () => void; done: Promise<unknown> }): Promise<void> {
  try { tx.abort() } catch { /* The transaction may already have aborted. */ }
  await tx.done.catch(() => {})
}

export class OperationStorage {
  constructor(private database: () => Promise<IDBPDatabase<JamifyDatabase>>, private clock: () => number) {}
  private assertFrozenPlan(journal: MutationJournal, rawDraft: unknown): void {
    const draft = draftSchema.parse(rawDraft)
    const plan = journal.plan
    const rebuilt = buildApplyPlan(draft.baseline, draft.session.decisions, plan.mode, plan.operationId)
    if (draft.baseline.accountId !== journal.accountId || draft.baseline.playlistId !== journal.sourcePlaylistId ||
      draft.revision !== plan.draftRevision || draft.session.runId !== plan.runId || rebuilt.blockedReasons.length || plan.blockedReasons.length ||
      rebuilt.accountId !== plan.accountId || rebuilt.playlistId !== plan.playlistId || rebuilt.playlistName !== plan.playlistName ||
      rebuilt.baselineFingerprint !== plan.baselineFingerprint || rebuilt.snapshotId !== plan.snapshotId || rebuilt.removedOccurrences !== plan.removedOccurrences ||
      JSON.stringify(rebuilt.removeUris) !== JSON.stringify(plan.removeUris) || JSON.stringify(rebuilt.expectedCanonical) !== JSON.stringify(plan.expectedCanonical) ||
      JSON.stringify(rebuilt.expectedOrderedEntries.map((entry) => entry.sourceUri)) !== JSON.stringify(plan.expectedOrderedEntries.map((entry) => entry.sourceUri)) ||
      fingerprint(rebuilt.expectedOrderedEntries) !== fingerprint(plan.expectedOrderedEntries)) throw new Error('Сохранённый план не соответствует замороженному черновику и решениям.')
  }
  async validateFrozenPlan(journal: MutationJournal): Promise<void> {
    if (!journal.sessionFinalized) this.assertFrozenPlan(journal, await (await this.database()).get('drafts', [journal.accountId, journal.sourcePlaylistId]))
  }
  async read(accountId: string, playlistId: string): Promise<MutationJournal | null> {
    const tx = (await this.database()).transaction(['operations', 'drafts'], 'readonly')
    const raw = await tx.objectStore('operations').get([accountId, playlistId])
    if (!raw) { await tx.done; return null }
    const parsed = journalSchema.parse(raw)
    if (parsed.accountId !== accountId || parsed.sourcePlaylistId !== playlistId) throw new Error('Журнал принадлежит другому аккаунту или плейлисту.')
    if (!parsed.sessionFinalized) this.assertFrozenPlan(parsed, await tx.objectStore('drafts').get([accountId, playlistId]))
    await tx.done
    return parsed
  }
  async begin(plan: ApplyPlan): Promise<MutationJournal> {
    const tx = (await this.database()).transaction(['drafts', 'operations'], 'readwrite')
    const key: [string, string] = [plan.accountId, plan.playlistId]
    try {
      const old = await tx.objectStore('operations').get(key)
      if (old) {
        const parsed = journalSchema.parse(old)
        if (parsed.operationId === plan.operationId) { await tx.done; return parsed }
        if (!parsed.sessionFinalized) throw new Error('Предыдущая операция ещё не проверена. Новая запись заблокирована.')
      }
      const draft = draftSchema.parse(await tx.objectStore('drafts').get(key))
      if (draft.baseline.accountId !== plan.accountId || draft.baseline.playlistId !== plan.playlistId || !plan.runId || !plan.draftRevision || draft.revision !== plan.draftRevision || draft.session.runId !== plan.runId) throw new Error('Черновик изменился перед применением.')
      const rebuilt = buildApplyPlan(draft.baseline, draft.session.decisions, plan.mode, plan.operationId)
      if (rebuilt.blockedReasons.length || draft.baseline.fingerprint !== plan.baselineFingerprint || draft.baseline.snapshotId !== plan.snapshotId ||
        JSON.stringify(rebuilt.removeUris) !== JSON.stringify(plan.removeUris) || JSON.stringify(rebuilt.expectedCanonical) !== JSON.stringify(plan.expectedCanonical) ||
        fingerprint(plan.expectedOrderedEntries) !== fingerprint(rebuilt.expectedOrderedEntries)) throw new Error('Предпросмотр не соответствует сохранённым решениям.')
      const journal: MutationJournal = {
        schemaVersion: 1, operationId: plan.operationId, accountId: plan.accountId, sourcePlaylistId: plan.playlistId, plan,
        state: 'preflight', confirmedPrefix: 0, pendingBatch: null, sessionFinalized: false, revision: 1, updatedAt: this.clock(), message: 'Проверка перед записью.',
        expectedSnapshotId: plan.mode === 'create-clean-copy' ? '' : plan.snapshotId, retryAt: null, targetPlaylistId: null, pendingCreate: false,
      }
      await tx.objectStore('operations').put(journalSchema.parse(journal), key); await tx.done
      return journal
    } catch (error) { await abortQuietly(tx); throw error }
  }
  async save(journal: MutationJournal): Promise<MutationJournal> {
    const tx = (await this.database()).transaction(['operations', 'drafts'], 'readwrite')
    const key: [string, string] = [journal.accountId, journal.sourcePlaylistId]
    try {
      const old = journalSchema.parse(await tx.objectStore('operations').get(key))
      if (old.operationId !== journal.operationId || old.revision !== journal.revision || old.sessionFinalized) throw new Error('Версия журнала операции изменилась.')
      const next = journalSchema.parse({ ...journal, revision: journal.revision + 1, updatedAt: this.clock() })
      this.assertFrozenPlan(next, await tx.objectStore('drafts').get(key))
      await tx.objectStore('operations').put(next, key); await tx.done
      return next
    } catch (error) { await abortQuietly(tx); throw error }
  }
  async finish(journal: MutationJournal, after: Baseline, target?: Baseline): Promise<{ journal: MutationJournal; draft: StoredDraft }> {
    const tx = (await this.database()).transaction(['drafts', 'operations'], 'readwrite')
    const key: [string, string] = [journal.accountId, journal.sourcePlaylistId]
    try {
      const current = journalSchema.parse(await tx.objectStore('operations').get(key))
      const previous = draftSchema.parse(await tx.objectStore('drafts').get(key))
      if (current.operationId !== journal.operationId || current.revision !== journal.revision) throw new Error('Журнал изменился во время финализации.')
      if (current.sessionFinalized) { await tx.done; return { journal: current, draft: previous } }
      this.assertFrozenPlan(current, previous)
      const copy = current.plan.mode === 'create-clean-copy'
      const verified = copy ? target : after
      if (after.accountId !== current.accountId || after.playlistId !== current.sourcePlaylistId ||
        previous.revision !== current.plan.draftRevision || previous.session.runId !== current.plan.runId || current.pendingBatch || current.pendingCreate ||
        current.confirmedPrefix !== (copy ? current.plan.expectedCanonical.length : current.plan.removeUris.length) ||
        !verified || verified.accountId !== current.accountId || verified.playlistId !== (copy ? current.targetPlaylistId : current.sourcePlaylistId) ||
        verified.snapshotId !== current.expectedSnapshotId || JSON.stringify(canonicalEntries(verified.orderedEntries)) !== JSON.stringify(current.plan.expectedCanonical) ||
        (copy && (after.snapshotId !== current.plan.snapshotId || after.fingerprint !== current.plan.baselineFingerprint))) {
        throw new Error('Операция не готова к локальной финализации.')
      }
      const draft = draftSchema.parse({ baseline: after, session: finalizeSession(previous.session, after), revision: previous.revision + 1, updatedAt: this.clock() })
      const done = journalSchema.parse({ ...current, state: 'complete', sessionFinalized: true, message: copy ? 'Приватная копия проверена. Исходный плейлист сохранён, решения завершены.' : 'Результат проверен, решения сохранены.', revision: current.revision + 1, updatedAt: this.clock() })
      await tx.objectStore('drafts').put(draft, key)
      await tx.objectStore('operations').put(done, key)
      await tx.done
      return { journal: done, draft }
    } catch (error) { await abortQuietly(tx); throw error }
  }
}
