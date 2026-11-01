import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { Baseline, MutationJournal, ReviewSession } from '../../contracts'
import { finalizeSession } from '../../domain/session'
import { baselineSchema, draftSchema, journalSchema } from './schema'
import { OperationStorage } from './operations'
import type { StoredDraft } from './schema'

export interface JamifyDatabase extends DBSchema {
  drafts: { key: [string, string]; value: StoredDraft }
  'demo-playlists': { key: [string, string]; value: Baseline }
  operations: { key: [string, string]; value: MutationJournal }
}
export class DraftConflictError extends Error {
  constructor(message = 'Черновик изменён в другой вкладке. Обнови страницу перед продолжением.') { super(message); this.name = 'DraftConflictError' }
}
const TTL = 30 * 24 * 60 * 60_000
export class JamifyStorage {
  private database: Promise<IDBPDatabase<JamifyDatabase>> | null = null
  readonly operations = new OperationStorage(() => this.db(), () => this.clock())
  constructor(private name = 'jamify.v1', private clock = Date.now) {}
  private db() {
    if (!this.database) this.database = openDB<JamifyDatabase>(this.name, 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts')
        if (!db.objectStoreNames.contains('demo-playlists')) db.createObjectStore('demo-playlists')
        if (!db.objectStoreNames.contains('operations')) db.createObjectStore('operations')
      },
      blocking: () => { void this.close() },
    }).catch((error: unknown) => { this.database = null; throw error })
    return this.database
  }
  async loadDraft(accountId: string, playlistId: string): Promise<StoredDraft | null> {
    const db = await this.db()
    const transaction = db.transaction(['drafts', 'operations'], 'readwrite')
    const store = transaction.objectStore('drafts')
    const key: [string, string] = [accountId, playlistId]
    const raw = await store.get(key)
    if (!raw) { await transaction.done; return null }
    const parsed = draftSchema.safeParse(raw)
    if (!parsed.success || raw.baseline.accountId !== accountId || raw.baseline.playlistId !== playlistId) {
      await transaction.done
      throw new Error('Сохранённый черновик повреждён. Очисти локальные данные для этого аккаунта.')
    }
    const operation = await transaction.objectStore('operations').get(key)
    if (Math.max(0, this.clock() - raw.updatedAt) > TTL && (!operation || journalSchema.parse(operation).sessionFinalized)) {
      await store.delete(key); await transaction.done; return null
    }
    await transaction.done
    return parsed.data
  }
  async saveDraft(baseline: Baseline, session: ReviewSession, expectedRevision: number | null, expectedRunId = session.runId): Promise<StoredDraft> {
    const db = await this.db()
    const transaction = db.transaction(['drafts', 'operations'], 'readwrite')
    const store = transaction.objectStore('drafts')
    const key: [string, string] = [baseline.accountId, baseline.playlistId]
    const operation = await transaction.objectStore('operations').get(key)
    if (operation && !journalSchema.parse(operation).sessionFinalized) {
      transaction.abort(); await transaction.done.catch(() => {}); throw new DraftConflictError('Для плейлиста выполняется или проверяется операция. Решения временно заблокированы.')
    }
    const raw = await store.get(key)
    let old: StoredDraft | undefined
    try { old = raw ? draftSchema.parse(raw) : undefined }
    catch (error) { transaction.abort(); await transaction.done.catch(() => {}); throw error }
    if ((old?.revision ?? null) !== expectedRevision || (old && old.session.runId !== expectedRunId)) {
      transaction.abort(); await transaction.done.catch(() => {}); throw new DraftConflictError()
    }
    let draft: StoredDraft
    try { draft = draftSchema.parse({ baseline, session, revision: (old?.revision ?? 0) + 1, updatedAt: this.clock() }) }
    catch (error) { transaction.abort(); await transaction.done.catch(() => {}); throw error }
    await store.put(draft, key); await transaction.done
    return draft
  }
  async finalize(accountId: string, playlistId: string, expectedRevision: number, expectedRunId: string, after: Baseline): Promise<StoredDraft> {
    const db = await this.db()
    const transaction = db.transaction(['drafts', 'operations'], 'readwrite')
    const store = transaction.objectStore('drafts')
    const key: [string, string] = [accountId, playlistId]
    const operation = await transaction.objectStore('operations').get(key)
    if (operation && !journalSchema.parse(operation).sessionFinalized) {
      transaction.abort(); await transaction.done.catch(() => {}); throw new DraftConflictError('Финализация доступна только вместе с журналом операции.')
    }
    const raw = await store.get(key)
    if (!raw || raw.revision !== expectedRevision || raw.session.runId !== expectedRunId) {
      transaction.abort(); await transaction.done.catch(() => {}); throw new DraftConflictError()
    }
    let draft: StoredDraft
    try {
      const previous = draftSchema.parse(raw)
      const session = finalizeSession(previous.session, after)
      draft = draftSchema.parse({ baseline: after, session, revision: previous.revision + 1, updatedAt: this.clock() })
    } catch (error) { transaction.abort(); await transaction.done.catch(() => {}); throw error }
    await store.put(draft, key); await transaction.done
    return draft
  }
  async clearAccount(accountId: string): Promise<void> {
    const db = await this.db()
    const tx = db.transaction(['drafts', 'demo-playlists', 'operations'], 'readwrite')
    const operations = await tx.objectStore('operations').getAll()
    if (operations.some((operation) => operation.accountId === accountId && !journalSchema.parse(operation).sessionFinalized)) {
      tx.abort(); await tx.done.catch(() => {}); throw new Error('Есть незавершённая операция. Сначала проверь её результат; журнал не удалён.')
    }
    for (const name of ['drafts', 'demo-playlists', 'operations'] as const) {
      let cursor = await tx.objectStore(name).openCursor()
      while (cursor) { if (cursor.key[0] === accountId) await cursor.delete(); cursor = await cursor.continue() }
    }
    await tx.done
  }
  async seedDemoLibrary(baselines: Baseline[]): Promise<void> {
    if (baselines.some((baseline) => baseline.accountId !== 'demo-account')) throw new Error('Демо-хранилище не принимает данные Spotify.')
    const valid = baselines.map((baseline) => baselineSchema.parse(baseline))
    const db = await this.db()
    const tx = db.transaction('demo-playlists', 'readwrite')
    const keys = await tx.store.getAllKeys()
    if (!keys.some((key) => key[0] === 'demo-account')) {
      for (const baseline of valid) await tx.store.put(baseline, ['demo-account', baseline.playlistId])
    }
    await tx.done
  }
  async listDemoLibrary(): Promise<Baseline[]> {
    const raw = await (await this.db()).getAll('demo-playlists')
    return raw.filter((baseline) => baseline.accountId === 'demo-account').map((baseline) => baselineSchema.parse(baseline))
  }
  async loadDemoPlaylist(playlistId: string): Promise<Baseline> {
    const raw = await (await this.db()).get('demo-playlists', ['demo-account', playlistId])
    if (!raw || raw.accountId !== 'demo-account') throw new Error('Демо-плейлист не найден.')
    return baselineSchema.parse(raw)
  }
  async saveDemoPlaylist(baseline: Baseline, expectedSnapshotId: string | null): Promise<void> {
    if (baseline.accountId !== 'demo-account') throw new Error('Демо-хранилище не принимает данные Spotify.')
    const parsed = baselineSchema.parse(baseline)
    const tx = (await this.db()).transaction('demo-playlists', 'readwrite')
    const key: [string, string] = ['demo-account', parsed.playlistId]
    const old = await tx.store.get(key)
    if ((old?.snapshotId ?? null) !== expectedSnapshotId) {
      tx.abort(); await tx.done.catch(() => {}); throw new Error('Демо-плейлист изменён в другой вкладке.')
    }
    await tx.store.put(parsed, key); await tx.done
  }
  async close(): Promise<void> { const pending = this.database; this.database = null; if (pending) (await pending).close() }
}
