import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { Baseline, ReviewSession } from '../../contracts'
import { finalizeSession } from '../../domain/session'
import { baselineSchema, draftSchema } from './schema'
import type { StoredDraft } from './schema'

interface JamifyDatabase extends DBSchema {
  drafts: { key: [string, string]; value: StoredDraft }
  'demo-playlists': { key: [string, string]; value: Baseline }
}
export class DraftConflictError extends Error {
  constructor() { super('Черновик изменён в другой вкладке. Обнови страницу перед продолжением.'); this.name = 'DraftConflictError' }
}
const TTL = 30 * 24 * 60 * 60_000
export class JamifyStorage {
  private database: Promise<IDBPDatabase<JamifyDatabase>> | null = null
  constructor(private name = 'jamify.v1', private clock = Date.now) {}
  private db() {
    if (!this.database) this.database = openDB<JamifyDatabase>(this.name, 1, {
      upgrade(db) { db.createObjectStore('drafts'); db.createObjectStore('demo-playlists') },
      blocking: () => { void this.close() },
    }).catch((error: unknown) => { this.database = null; throw error })
    return this.database
  }
  async loadDraft(accountId: string, playlistId: string): Promise<StoredDraft | null> {
    const db = await this.db()
    const transaction = db.transaction('drafts', 'readwrite')
    const key: [string, string] = [accountId, playlistId]
    const raw = await transaction.store.get(key)
    if (!raw) { await transaction.done; return null }
    const parsed = draftSchema.safeParse(raw)
    if (!parsed.success || raw.baseline.accountId !== accountId || raw.baseline.playlistId !== playlistId) {
      await transaction.done
      throw new Error('Сохранённый черновик повреждён. Очисти локальные данные для этого аккаунта.')
    }
    if (Math.max(0, this.clock() - raw.updatedAt) > TTL) {
      await transaction.store.delete(key); await transaction.done; return null
    }
    await transaction.done
    return parsed.data
  }
  async saveDraft(baseline: Baseline, session: ReviewSession, expectedRevision: number | null, expectedRunId = session.runId): Promise<StoredDraft> {
    const db = await this.db()
    const transaction = db.transaction('drafts', 'readwrite')
    const key: [string, string] = [baseline.accountId, baseline.playlistId]
    const raw = await transaction.store.get(key)
    let old: StoredDraft | undefined
    try { old = raw ? draftSchema.parse(raw) : undefined }
    catch (error) { transaction.abort(); await transaction.done.catch(() => {}); throw error }
    if ((old?.revision ?? null) !== expectedRevision || (old && old.session.runId !== expectedRunId)) {
      transaction.abort(); await transaction.done.catch(() => {}); throw new DraftConflictError()
    }
    let draft: StoredDraft
    try { draft = draftSchema.parse({ baseline, session, revision: (old?.revision ?? 0) + 1, updatedAt: this.clock() }) }
    catch (error) { transaction.abort(); await transaction.done.catch(() => {}); throw error }
    await transaction.store.put(draft, key); await transaction.done
    return draft
  }
  async finalize(accountId: string, playlistId: string, expectedRevision: number, expectedRunId: string, after: Baseline): Promise<StoredDraft> {
    const db = await this.db()
    const transaction = db.transaction('drafts', 'readwrite')
    const key: [string, string] = [accountId, playlistId]
    const raw = await transaction.store.get(key)
    if (!raw || raw.revision !== expectedRevision || raw.session.runId !== expectedRunId) {
      transaction.abort(); await transaction.done.catch(() => {}); throw new DraftConflictError()
    }
    let draft: StoredDraft
    try {
      const previous = draftSchema.parse(raw)
      const session = finalizeSession(previous.session, after)
      draft = draftSchema.parse({ baseline: after, session, revision: previous.revision + 1, updatedAt: this.clock() })
    } catch (error) { transaction.abort(); await transaction.done.catch(() => {}); throw error }
    await transaction.store.put(draft, key); await transaction.done
    return draft
  }
  async clearAccount(accountId: string): Promise<void> {
    const db = await this.db()
    const tx = db.transaction(['drafts', 'demo-playlists'], 'readwrite')
    for (const name of ['drafts', 'demo-playlists'] as const) {
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
