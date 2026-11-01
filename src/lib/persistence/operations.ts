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
  async read(accountId: string, playlistId: string): Promise<MutationJournal | null> {
    const raw = await (await this.database()).get('operations', [accountId, playlistId])
    if (!raw) return null
    const parsed = journalSchema.parse(raw)
    if (parsed.accountId !== accountId || parsed.sourcePlaylistId !== playlistId) throw new Error('Журнал принадлежит другому аккаунту или плейлисту.')
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
        expectedSnapshotId: plan.snapshotId, retryAt: null,
      }
      await tx.objectStore('operations').put(journalSchema.parse(journal), key); await tx.done
      return journal
    } catch (error) { await abortQuietly(tx); throw error }
  }
  async save(journal: MutationJournal): Promise<MutationJournal> {
    const tx = (await this.database()).transaction('operations', 'readwrite')
    const key: [string, string] = [journal.accountId, journal.sourcePlaylistId]
    try {
      const old = journalSchema.parse(await tx.store.get(key))
      if (old.operationId !== journal.operationId || old.revision !== journal.revision || old.sessionFinalized) throw new Error('Версия журнала операции изменилась.')
      const next = journalSchema.parse({ ...journal, revision: journal.revision + 1, updatedAt: this.clock() })
      await tx.store.put(next, key); await tx.done
      return next
    } catch (error) { await abortQuietly(tx); throw error }
  }
  async finish(journal: MutationJournal, after: Baseline): Promise<{ journal: MutationJournal; draft: StoredDraft }> {
    const tx = (await this.database()).transaction(['drafts', 'operations'], 'readwrite')
    const key: [string, string] = [journal.accountId, journal.sourcePlaylistId]
    try {
      const current = journalSchema.parse(await tx.objectStore('operations').get(key))
      const previous = draftSchema.parse(await tx.objectStore('drafts').get(key))
      if (current.operationId !== journal.operationId || current.revision !== journal.revision) throw new Error('Журнал изменился во время финализации.')
      if (current.sessionFinalized) { await tx.done; return { journal: current, draft: previous } }
      if (previous.revision !== current.plan.draftRevision || previous.session.runId !== current.plan.runId || current.pendingBatch ||
        current.confirmedPrefix !== current.plan.removeUris.length || after.snapshotId !== current.expectedSnapshotId || JSON.stringify(canonicalEntries(after.orderedEntries)) !== JSON.stringify(current.plan.expectedCanonical)) {
        throw new Error('Операция не готова к локальной финализации.')
      }
      const draft = draftSchema.parse({ baseline: after, session: finalizeSession(previous.session, after), revision: previous.revision + 1, updatedAt: this.clock() })
      const done = journalSchema.parse({ ...current, state: 'complete', sessionFinalized: true, message: 'Результат проверен, решения сохранены.', revision: current.revision + 1, updatedAt: this.clock() })
      await tx.objectStore('drafts').put(draft, key)
      await tx.objectStore('operations').put(done, key)
      await tx.done
      return { journal: done, draft }
    } catch (error) { await abortQuietly(tx); throw error }
  }
}
