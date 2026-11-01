import type { ApplyCoordinator, ApplyPlan, ApplyResult, Baseline, CanonicalItem, MutationJournal, PlaylistGateway } from '../../contracts'
import { buildApplyPlan, canonicalEntries } from '../../domain/playlist'
import type { JamifyStorage } from '../../lib/persistence/database'
import { DurableCopyExecutor } from './copy'

export type ExclusiveLock = <T>(name: string, job: () => Promise<T>) => Promise<T>
export const browserApplyLock: ExclusiveLock = async (name, job) => {
  if (!globalThis.navigator?.locks) throw new Error('Для применения нужен браузер с Web Locks.')
  return navigator.locks.request(name, { ifAvailable: true }, (lock) => {
    if (!lock) throw new Error('Применение уже выполняется в другой вкладке.')
    return job()
  })
}
const equal = (a: CanonicalItem[], b: CanonicalItem[]) => JSON.stringify(a) === JSON.stringify(b)
function removable(baseline: Baseline, uris: string[]): boolean {
  return uris.every((uri) => {
    const group = baseline.orderedEntries.filter((entry) => entry.sourceUri === uri || entry.observedUri === uri)
    return group.length > 0 && group.every((entry) => entry.sourceUri === uri && entry.kind === 'track' && entry.identityConfidence === 'confirmed' && entry.canRemove)
  })
}
function definiteRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error) || !('ambiguous' in error)) return false
  return error.ambiguous === false && [400, 401, 403, 404, 409, 429].includes(Number(error.status))
}
export class DurableApplyCoordinator implements ApplyCoordinator {
  private running = new Map<string, Promise<ApplyResult>>()
  private copy: DurableCopyExecutor
  constructor(private gateway: PlaylistGateway, private storage: JamifyStorage, private lock: ExclusiveLock = browserApplyLock, private clock = () => Date.now()) { this.copy = new DurableCopyExecutor(gateway, storage, clock) }
  apply(plan: ApplyPlan): Promise<ApplyResult> { return this.dispatch(plan.accountId, plan.playlistId, plan.operationId, () => this.start(plan)) }
  recover(accountId: string, playlistId: string): Promise<ApplyResult> {
    return this.dispatch(accountId, playlistId, 'recovery', async () => {
      const journal = await this.storage.operations.read(accountId, playlistId)
      if (!journal) return { state: 'conflict', message: 'Незавершённая операция не найдена.' }
      return this.reconcile(journal)
    })
  }
  resume(accountId: string, playlistId: string): Promise<ApplyResult> {
    return this.dispatch(accountId, playlistId, 'resume', async () => {
      const journal = await this.storage.operations.read(accountId, playlistId)
      if (!journal) return { state: 'conflict', message: 'Операция не найдена.' }
      if (journal.retryAt && this.clock() < journal.retryAt) return this.retryWait(journal)
      // Unknown pending writes are reconciled, never sent again.
      if (journal.pendingBatch || journal.pendingCreate || journal.sessionFinalized) return this.reconcile(journal)
      return this.execute(journal)
    })
  }
  private dispatch(accountId: string, playlistId: string, action: string, job: () => Promise<ApplyResult>): Promise<ApplyResult> {
    const key = JSON.stringify([accountId, playlistId, action])
    const current = this.running.get(key)
    if (current) return current
    const result = this.lock(`jamify.apply:${JSON.stringify([accountId, playlistId])}`, job)
      .catch((error: unknown): ApplyResult => ({ state: 'unknown', message: error instanceof Error ? error.message : 'Операция остановлена. Проверь сохранённый журнал; запись автоматически не повторяется.' }))
      .finally(() => { this.running.delete(key) })
    this.running.set(key, result)
    return result
  }
  private async account(accountId: string): Promise<void> {
    if (await this.gateway.currentAccount() !== accountId) throw new Error('Аккаунт изменился. Операция остановлена.')
  }
  private async read(journal: MutationJournal): Promise<Baseline> {
    await this.account(journal.accountId)
    const baseline = await this.gateway.loadBaseline(journal.sourcePlaylistId)
    if (baseline.accountId !== journal.accountId || baseline.playlistId !== journal.sourcePlaylistId) throw new Error('Плейлист принадлежит другому аккаунту.')
    return baseline
  }
  private async start(plan: ApplyPlan): Promise<ApplyResult> {
    if (plan.blockedReasons.length) return { state: 'conflict', message: plan.blockedReasons.join(' ') }
    const existing = await this.storage.operations.read(plan.accountId, plan.playlistId)
    if (existing?.retryAt && this.clock() < existing.retryAt) return this.retryWait(existing)
    if (existing && existing.operationId === plan.operationId) return this.reconcile(existing)
    if (existing && !existing.sessionFinalized) return { state: existing.state, message: 'Сначала проверь результат предыдущей операции.' }
    let before: Baseline
    try {
      await this.account(plan.accountId)
      before = await this.gateway.loadBaseline(plan.playlistId)
    } catch (error) {
      if (plan.mode === 'create-clean-copy' && error && typeof error === 'object' && 'status' in error && Number(error.status) === 429) {
        // Persist even a preflight read's Retry-After. Reload and another click
        // must not bypass the same server-requested delay.
        return this.copy.defer(await this.storage.operations.begin(plan), error)
      }
      throw error
    }
    if (before.accountId !== plan.accountId || before.playlistId !== plan.playlistId || before.snapshotId !== plan.snapshotId || before.fingerprint !== plan.baselineFingerprint) {
      return { state: 'conflict', message: 'Плейлист изменился после предпросмотра. Новая запись не выполнялась.' }
    }
    if (!removable(before, plan.removeUris)) return { state: 'conflict', message: 'Идентичность выбранных треков больше не подтверждена. Удаление заблокировано.' }
    if (plan.mode === 'create-clean-copy') {
      const fresh = buildApplyPlan(before, Object.fromEntries(plan.removeUris.map((uri) => [uri, 'remove' as const])), plan.mode, plan.operationId)
      if (fresh.blockedReasons.length || !equal(fresh.expectedCanonical, plan.expectedCanonical)) return { state: 'conflict', message: 'Сохраняемые записи нельзя безопасно скопировать. Обнови предпросмотр.' }
    }
    const journal = await this.storage.operations.begin(plan)
    return this.execute(journal)
  }
  private async stop(journal: MutationJournal, state: 'unknown' | 'conflict' | 'partial', message: string): Promise<ApplyResult> {
    await this.storage.operations.save({ ...journal, state, message })
    return { state, message }
  }
  private async reconcile(journal: MutationJournal): Promise<ApplyResult> {
    await this.storage.operations.validateFrozenPlan(journal)
    if (journal.plan.mode === 'create-clean-copy') return this.copy.run(journal, 'reconcile')
    if (journal.retryAt && this.clock() < journal.retryAt) return this.retryWait(journal)
    const observed = await this.read(journal)
    const actual = canonicalEntries(observed.orderedEntries)
    if (journal.sessionFinalized) {
      if (!equal(actual, journal.plan.expectedCanonical)) return { state: 'conflict', message: 'После завершения плейлист был изменён. Предыдущие запросы не повторяются.' }
      const draft = await this.storage.loadDraft(journal.accountId, journal.sourcePlaylistId)
      return { state: 'complete', baseline: observed, message: journal.message, session: draft?.session, draftRevision: draft?.revision }
    }
    if (journal.pendingBatch) {
      if (equal(actual, journal.pendingBatch.after)) {
        journal = await this.storage.operations.save({ ...journal, expectedSnapshotId: observed.snapshotId, confirmedPrefix: journal.confirmedPrefix + journal.pendingBatch.uris.length, pendingBatch: null, state: 'reconciling', message: 'Неоднозначный ответ проверен чтением.' })
      } else if (equal(actual, journal.pendingBatch.before)) {
        return this.stop(journal, 'unknown', 'Плейлист пока не изменился, но результат отправленного запроса неизвестен. Повтор не выполняется.')
      } else return this.stop(journal, 'conflict', 'Состав плейлиста не совпал с ожидаемым. Запись остановлена.')
    }
    if (journal.confirmedPrefix === journal.plan.removeUris.length && equal(actual, journal.plan.expectedCanonical)) {
      if (observed.snapshotId !== journal.expectedSnapshotId) return this.stop(journal, 'conflict', 'Версия плейлиста изменилась после подтверждения записи.')
      return this.finish(journal, observed)
    }
    const draft = await this.storage.loadDraft(journal.accountId, journal.sourcePlaylistId)
    const removed = new Set(journal.plan.removeUris.slice(0, journal.confirmedPrefix))
    if (!draft || !equal(actual, canonicalEntries(draft.baseline.orderedEntries.filter((entry) => !entry.sourceUri || !removed.has(entry.sourceUri))))) {
      return this.stop(journal, 'conflict', 'Состав плейлиста изменился после остановки операции.')
    }
    return this.stop(journal, 'partial', 'Подтверждена только часть изменений. Продолжение требует отдельного действия.')
  }
  private async execute(journal: MutationJournal): Promise<ApplyResult> {
    await this.storage.operations.validateFrozenPlan(journal)
    if (journal.plan.mode === 'create-clean-copy') return this.copy.run(journal, 'execute')
    if (journal.pendingBatch) return this.reconcile(journal)
    while (journal.confirmedPrefix < journal.plan.removeUris.length) {
      const before = await this.read(journal)
      const draft = await this.storage.loadDraft(journal.accountId, journal.sourcePlaylistId)
      if (!draft || draft.revision !== journal.plan.draftRevision || draft.session.runId !== journal.plan.runId) return this.stop(journal, 'conflict', 'Черновик операции изменился.')
      const removed = new Set(journal.plan.removeUris.slice(0, journal.confirmedPrefix))
      const expectedBefore = canonicalEntries(draft.baseline.orderedEntries.filter((entry) => !entry.sourceUri || !removed.has(entry.sourceUri)))
      if (!equal(canonicalEntries(before.orderedEntries), expectedBefore)) return this.stop(journal, 'conflict', 'Плейлист изменён вне этой операции. Новая запись не выполнялась.')
      const uris = journal.plan.removeUris.slice(journal.confirmedPrefix, journal.confirmedPrefix + 100)
      if (before.snapshotId !== journal.expectedSnapshotId) return this.stop(journal, 'conflict', 'Версия плейлиста изменилась перед записью.')
      if (!removable(before, uris)) return this.stop(journal, 'conflict', 'Идентичность выбранных треков больше не подтверждена. Удаление заблокировано.')
      const set = new Set(uris)
      const expectedAfter = canonicalEntries(before.orderedEntries.filter((entry) => !entry.sourceUri || !set.has(entry.sourceUri)))
      journal = await this.storage.operations.save({ ...journal, state: 'applying', pendingBatch: { uris, snapshotId: before.snapshotId, before: expectedBefore, after: expectedAfter }, message: 'Пакет записан в журнал до отправки.' })
      let failure: unknown
      let dispatched = false
      try {
        await this.account(journal.accountId)
        dispatched = true
        await this.gateway.removeUriGroups(journal.sourcePlaylistId, uris, before.snapshotId)
      } catch (error) { failure = error }
      if (failure && definiteRejection(failure) && 'status' in Object(failure) && Number((failure as { status: number }).status) === 429) {
        const seconds = Number((failure as { retryAfter?: number }).retryAfter)
        const retryAt = this.clock() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000
        return this.stop({ ...journal, pendingBatch: null, retryAt }, 'partial', 'Лимит запросов. Подожди Retry-After перед проверкой или отдельным продолжением.')
      }
      let observed: Baseline
      try { observed = await this.read(journal) }
      catch {
        if (!dispatched) return this.stop({ ...journal, pendingBatch: null }, 'partial', 'Аккаунт изменился до отправки запроса. Запись не выполнялась; верни исходный аккаунт и отдельно продолжи.')
        if (failure && definiteRejection(failure)) return this.stop({ ...journal, pendingBatch: null }, 'partial', 'Запрос отклонён, но чтение сейчас недоступно. Подключи исходный аккаунт и отдельно продолжи операцию.')
        return this.stop(journal, 'unknown', 'Не удалось прочитать результат записи. Повтор не выполняется.')
      }
      const actual = canonicalEntries(observed.orderedEntries)
      if (equal(actual, expectedAfter)) {
        journal = await this.storage.operations.save({ ...journal, expectedSnapshotId: observed.snapshotId, state: 'reconciling', confirmedPrefix: journal.confirmedPrefix + uris.length, pendingBatch: null, message: 'Пакет подтверждён повторным чтением.' })
      } else if (equal(actual, expectedBefore)) {
        if (!dispatched || (failure && definiteRejection(failure))) return this.stop({ ...journal, pendingBatch: null }, 'partial', 'Пакет не отправлен или отклонён. Автоматического повтора нет; продолжение требует отдельного действия.')
        return this.stop(journal, 'unknown', 'Изменения не подтверждены. Результат запроса неизвестен, автоматического повтора нет.')
      } else return this.stop(journal, 'conflict', 'После записи обнаружен другой состав плейлиста. Операция остановлена.')
    }
    const after = await this.read(journal)
    if (after.snapshotId !== journal.expectedSnapshotId || !equal(canonicalEntries(after.orderedEntries), journal.plan.expectedCanonical)) return this.stop(journal, 'conflict', 'Итоговая сверка или версия плейлиста не совпала с планом.')
    return this.finish(journal, after)
  }
  private async finish(journal: MutationJournal, after: Baseline): Promise<ApplyResult> {
    const done = await this.storage.operations.finish(journal, after)
    return { state: 'complete', baseline: after, message: done.journal.message, session: done.draft.session, draftRevision: done.draft.revision }
  }
  private retryWait(journal: MutationJournal): ApplyResult {
    return { state: 'partial', message: `Лимит запросов. Подожди ещё ${Math.ceil((journal.retryAt! - this.clock()) / 1000)} с перед продолжением.` }
  }
}
