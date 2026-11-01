import type { ApplyResult, Baseline, Decision, ReviewSession } from '../../contracts'
import { assertBaseline, createSession, decide, finalizeSession, undo } from '../../domain/session'
import { DraftConflictError } from '../../lib/persistence/database'
import type { JamifyStorage } from '../../lib/persistence/database'

type Storage = Pick<JamifyStorage, 'loadDraft' | 'saveDraft' | 'finalize'>
export type SessionState = { baseline: Baseline | null; session: ReviewSession | null; saving: boolean; persistent: boolean; error: string }
export class SessionController {
  private state: SessionState = { baseline: null, session: null, saving: false, persistent: false, error: '' }
  private listeners = new Set<(state: SessionState) => void>()
  private revision: number | null = null
  private changed = 0
  private saved = 0
  private failed = false
  private pending: Promise<void> = Promise.resolve()
  private writing = false
  private volatileDrafts = new Map<string, { baseline: Baseline; session: ReviewSession }>()
  constructor(private storage: Storage) {}
  snapshot(): SessionState { return this.state }
  subscribe(listener: (state: SessionState) => void): () => void { this.listeners.add(listener); listener(this.state); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<SessionState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(this.state) }
  async open(baseline: Baseline, seed: number, restart = false, memoryOnly = false): Promise<void> {
    await this.flush()
    const previous = this.state
    if (this.failed && previous.baseline && previous.session) {
      this.volatileDrafts.set(JSON.stringify([previous.baseline.accountId, previous.baseline.playlistId]), { baseline: previous.baseline, session: previous.session })
    }
    this.failed = false; this.changed = 0; this.saved = 0; this.revision = null
    const key = JSON.stringify([baseline.accountId, baseline.playlistId])
    const volatile = this.volatileDrafts.get(key)
    if (volatile && !restart) {
      assertBaseline(volatile.session, baseline)
      this.failed = true
      this.publish({ baseline, session: volatile.session, saving: false, persistent: false,
        error: 'Хранилище недоступно. Решения сохранены в памяти этой вкладки, только до перезагрузки.' })
      return
    }
    if (restart) this.volatileDrafts.delete(key)
    if (memoryOnly) {
      this.failed = true
      this.publish({ baseline, session: createSession(baseline, seed), saving: false, persistent: false,
        error: 'Демо-хранилище недоступно. Решения останутся только до перезагрузки.' })
      return
    }
    let draft
    try { draft = await this.storage.loadDraft(baseline.accountId, baseline.playlistId) }
    catch { this.failed = true }
    if (draft && !restart) assertBaseline(draft.session, baseline)
    const session = draft && !restart ? draft.session : createSession(baseline, seed)
    this.revision = draft?.revision ?? null
    this.publish({ baseline, session, saving: false, persistent: Boolean(draft) && !restart,
      error: this.failed ? 'Не удалось прочитать хранилище. Решения останутся только до перезагрузки.' : '' })
    if (this.failed || (draft && !restart)) return
    if (restart && draft) {
      try {
        const saved = await this.storage.saveDraft(baseline, session, draft.revision, draft.session.runId)
        this.revision = saved.revision; this.publish({ persistent: true })
      } catch (error) { this.persistenceFailed(error) }
    } else { this.queueSave(); await this.flush() }
  }
  choose(expectedUri: string, decision: Decision): void {
    if (!this.state.session) return
    const next = decide(this.state.session, expectedUri, decision)
    if (next === this.state.session) return
    this.publish({ session: next }); this.queueSave()
  }
  undo(): void {
    if (!this.state.session) return
    const next = undo(this.state.session)
    if (next === this.state.session) return
    this.publish({ session: next }); this.queueSave()
  }
  private queueSave(): void {
    this.changed++
    if (this.failed || this.writing) return
    this.writing = true; this.publish({ saving: true, persistent: false })
    this.pending = (async () => {
      while (!this.failed && this.saved !== this.changed) {
        const version = this.changed
        const { baseline, session } = this.state
        if (!baseline || !session) return
        try {
          const draft = await this.storage.saveDraft(baseline, session, this.revision)
          this.revision = draft.revision; this.saved = version
        } catch (error) { this.persistenceFailed(error) }
      }
    })().finally(() => { this.writing = false; this.publish({ saving: false, persistent: !this.failed }) })
  }
  private persistenceFailed(error: unknown) {
    this.failed = true
    this.publish({ persistent: false, saving: false, error: error instanceof DraftConflictError ? error.message
      : 'Не удалось сохранить решения. До перезагрузки они останутся в этой вкладке; сохранение не подтверждено.' })
  }
  async flush(): Promise<void> { await this.pending }
  async ensureCurrentDraft(): Promise<void> {
    await this.flush()
    const { baseline, session } = this.state
    if (!baseline || !session || this.failed || this.revision === null) throw new DraftConflictError()
    try {
      const saved = await this.storage.loadDraft(baseline.accountId, baseline.playlistId)
      if (!saved || saved.revision !== this.revision || saved.session.runId !== session.runId) throw new DraftConflictError()
    } catch (error) { this.persistenceFailed(error); throw error }
  }
  async binding(): Promise<{ draftRevision: number; runId: string }> {
    await this.ensureCurrentDraft()
    return { draftRevision: this.revision!, runId: this.state.session!.runId }
  }
  adoptFinalized(result: ApplyResult): void {
    if (!result.baseline || !result.session || !result.draftRevision || result.state !== 'complete') throw new Error('Операция не вернула финализированный черновик.')
    assertBaseline(result.session, result.baseline)
    if (this.state.session && (this.state.session.accountId !== result.session.accountId || this.state.session.playlistId !== result.session.playlistId)) throw new Error('Результат относится к другой сессии.')
    this.failed = false; this.revision = result.draftRevision; this.changed = 0; this.saved = 0
    this.publish({ baseline: result.baseline, session: result.session, persistent: true, saving: false, error: '' })
  }
  async finalize(after: Baseline): Promise<void> {
    await this.flush()
    const session = this.state.session
    if (!session) throw new Error('Сессия не открыта.')
    if (this.failed || this.revision === null) {
      this.publish({ baseline: after, session: finalizeSession(session, after), persistent: false })
      return
    }
    try {
      const stored = await this.storage.finalize(session.accountId, session.playlistId, this.revision, session.runId, after)
      this.revision = stored.revision
      this.changed = 0; this.saved = 0
      this.publish({ baseline: after, session: stored.session, persistent: true })
    } catch (error) { this.persistenceFailed(error); throw error }
  }
}
