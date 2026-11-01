import type { ApplyResult, Baseline, CanonicalItem, MutationJournal, PlaylistGateway } from '../../contracts'
import { buildApplyPlan, canonicalEntries } from '../../domain/playlist'
import type { JamifyStorage } from '../../lib/persistence/database'

const equal = (a: CanonicalItem[], b: CanonicalItem[]) => JSON.stringify(a) === JSON.stringify(b)
const rejection = (error: unknown) => error !== null && typeof error === 'object' && 'ambiguous' in error && error.ambiguous === false && 'status' in error && [400, 401, 403, 404, 409, 429].includes(Number(error.status))
const limited = (error: unknown) => error !== null && typeof error === 'object' && 'status' in error && Number(error.status) === 429

// Called only under DurableApplyCoordinator's source-playlist Web Lock. Every
// server write first has its intent committed in the same operation journal.
export class DurableCopyExecutor {
  constructor(private gateway: PlaylistGateway, private storage: JamifyStorage, private clock: () => number) {}

  async defer(journal: MutationJournal, error: unknown): Promise<ApplyResult> { return this.rateLimit(journal, error) }

  async run(journal: MutationJournal, action: 'execute' | 'reconcile'): Promise<ApplyResult> {
    await this.storage.operations.validateFrozenPlan(journal)
    if (journal.retryAt && this.clock() < journal.retryAt) return this.result(journal, 'partial', `Лимит запросов. Подожди ещё ${Math.ceil((journal.retryAt - this.clock()) / 1000)} с перед продолжением.`)
    try { return await (action === 'execute' ? this.execute(journal) : this.reconcile(journal)) }
    catch (error) {
      // A checkpoint can fail after the server has accepted a request. Read the
      // latest durable record, never reconstruct intent from in-memory progress.
      const latest = await this.storage.operations.read(journal.accountId, journal.sourcePlaylistId)
      if (!latest || latest.sessionFinalized) throw error
      if (limited(error)) return this.rateLimit(latest, error)
      return this.stop(latest, 'unknown', error instanceof Error ? error.message : 'Проверка копии недоступна. Запросы автоматически не повторяются.')
    }
  }

  private result(journal: MutationJournal, state: ApplyResult['state'], message: string): ApplyResult {
    return { state, message, ...(journal.targetPlaylistId ? { targetPlaylistId: journal.targetPlaylistId } : {}) }
  }
  private async stop(journal: MutationJournal, state: 'partial' | 'unknown' | 'conflict', message: string): Promise<ApplyResult> {
    if (!journal.sessionFinalized) await this.storage.operations.save({ ...journal, state, message })
    return this.result(journal, state, message)
  }
  private async rateLimit(journal: MutationJournal, error: unknown): Promise<ApplyResult> {
    const seconds = error && typeof error === 'object' && 'retryAfter' in error ? Number(error.retryAfter) : NaN
    return this.stop({ ...journal, retryAt: this.clock() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000 }, 'partial', 'Лимит запросов. Подожди Retry-After; продолжение потребует отдельного действия.')
  }
  private async account(journal: MutationJournal): Promise<void> {
    if (await this.gateway.currentAccount() !== journal.accountId) throw new Error('Аккаунт изменился. Верни исходный аккаунт перед проверкой копии.')
  }
  private async read(journal: MutationJournal, playlistId: string): Promise<Baseline> {
    await this.account(journal)
    const baseline = await this.gateway.loadBaseline(playlistId)
    if (baseline.accountId !== journal.accountId || baseline.playlistId !== playlistId) throw new Error('Прочитан другой аккаунт или плейлист. Операция остановлена.')
    return baseline
  }
  private async source(journal: MutationJournal): Promise<Baseline | null> {
    const source = await this.read(journal, journal.sourcePlaylistId)
    const draft = await this.storage.loadDraft(journal.accountId, journal.sourcePlaylistId)
    if (!draft || (!journal.sessionFinalized && (draft.revision !== journal.plan.draftRevision || draft.session.runId !== journal.plan.runId)) ||
      source.snapshotId !== journal.plan.snapshotId || source.fingerprint !== journal.plan.baselineFingerprint) return null
    // Canonical equality alone does not attest identity/copyability: those flags
    // can change without the playlist contents or snapshot changing.
    const decisions = Object.fromEntries(journal.plan.removeUris.map((uri) => [uri, 'remove' as const]))
    const fresh = buildApplyPlan(source, decisions, 'create-clean-copy', journal.operationId)
    if (fresh.blockedReasons.length || !equal(fresh.expectedCanonical, journal.plan.expectedCanonical)) return null
    return source
  }

  private async reconcile(journal: MutationJournal): Promise<ApplyResult> {
    await this.account(journal)
    if (journal.pendingCreate && !journal.targetPlaylistId) return this.stop(journal, 'unknown', 'Ответ создания потерян: ID копии неизвестен. Новая копия автоматически не создаётся; проверь библиотеку вручную.')
    const source = await this.source(journal)
    if (!source) return this.stop(journal, 'conflict', 'Исходный плейлист, черновик или идентичность записей изменились. Копирование остановлено.')
    if (!journal.targetPlaylistId) return this.stop(journal, 'partial', 'Создание ещё не подтверждено и не отправлено. Продолжение требует отдельного действия.')
    const target = await this.read(journal, journal.targetPlaylistId)
    const actual = canonicalEntries(target.orderedEntries)
    if (journal.sessionFinalized) {
      if (!equal(actual, journal.plan.expectedCanonical) || target.snapshotId !== journal.expectedSnapshotId) return this.result(journal, 'conflict', 'Созданная копия была изменена после завершения. Предыдущие запросы не повторяются.')
      const draft = await this.storage.loadDraft(journal.accountId, journal.sourcePlaylistId)
      return { ...this.result(journal, 'complete', journal.message), baseline: source, targetBaseline: target, session: draft?.session, draftRevision: draft?.revision }
    }
    if (journal.pendingBatch) {
      if (equal(actual, journal.pendingBatch.after)) {
        journal = await this.storage.operations.save({ ...journal, expectedSnapshotId: target.snapshotId, confirmedPrefix: journal.confirmedPrefix + journal.pendingBatch.uris.length, pendingBatch: null, retryAt: null, state: 'reconciling', message: 'Отправленный пакет копии подтверждён полным чтением.' })
      } else if (equal(actual, journal.pendingBatch.before)) {
        return this.stop(journal, 'unknown', 'Пакет пока не виден в копии, но результат запроса неизвестен. Повтор не выполняется.')
      } else return this.stop(journal, 'conflict', 'Копия содержит посторонние изменения. Продолжение заблокировано.')
    }
    if (!equal(actual, journal.plan.expectedCanonical.slice(0, journal.confirmedPrefix)) ||
      (journal.expectedSnapshotId && target.snapshotId !== journal.expectedSnapshotId)) return this.stop(journal, 'conflict', 'Состав или версия копии не совпадает с подтверждённым префиксом.')
    if (!journal.expectedSnapshotId) journal = await this.storage.operations.save({ ...journal, expectedSnapshotId: target.snapshotId, retryAt: null })
    if (journal.confirmedPrefix === journal.plan.expectedCanonical.length) return this.finish(journal, source, target)
    return this.stop(journal, 'partial', `Проверено ${journal.confirmedPrefix} из ${journal.plan.expectedCanonical.length} записей копии. Продолжение требует отдельного действия.`)
  }

  private async execute(journal: MutationJournal): Promise<ApplyResult> {
    if (journal.pendingCreate || journal.pendingBatch || journal.sessionFinalized) return this.reconcile(journal)
    if (!await this.source(journal)) return this.stop(journal, 'conflict', 'Исходный плейлист, черновик или идентичность записей изменились. Новая запись не выполнялась.')
    if (!journal.targetPlaylistId) {
      journal = await this.storage.operations.save({ ...journal, pendingCreate: true, state: 'applying', retryAt: null, message: 'Создание приватной копии записано в журнал до отправки.' })
      let targetId: string
      let dispatched = false
      try {
        await this.account(journal)
        dispatched = true
        targetId = await this.gateway.createPrivatePlaylist(`${journal.plan.playlistName} — очищенная копия`)
      } catch (error) {
        if (!dispatched || rejection(error)) {
          const clear = { ...journal, pendingCreate: false }
          if (limited(error)) return this.rateLimit(clear, error)
          return this.stop(clear, 'partial', 'Создание не отправлено или отклонено. Автоматического повтора нет; верни доступ и отдельно продолжи.')
        }
        return this.stop(journal, 'unknown', 'Ответ создания потерян: ID копии неизвестен. Повторное создание запрещено; проверь библиотеку вручную.')
      }
      if (!targetId || targetId === journal.sourcePlaylistId) return this.stop(journal, 'unknown', 'Создание не вернуло безопасный ID новой копии. Запись остановлена.')
      journal = await this.storage.operations.save({ ...journal, targetPlaylistId: targetId, pendingCreate: false, expectedSnapshotId: '', state: 'reconciling', message: 'ID новой приватной копии сохранён.' })
    }
    while (journal.confirmedPrefix < journal.plan.expectedCanonical.length) {
      if (!await this.source(journal)) return this.stop(journal, 'conflict', 'Исходник или возможность копирования изменились. Следующий пакет не отправлен.')
      const before = await this.read(journal, journal.targetPlaylistId!)
      const expectedBefore = journal.plan.expectedCanonical.slice(0, journal.confirmedPrefix)
      if (!equal(canonicalEntries(before.orderedEntries), expectedBefore) || (journal.expectedSnapshotId && before.snapshotId !== journal.expectedSnapshotId)) return this.stop(journal, 'conflict', 'Копия изменена вне операции. Следующий пакет не отправлен.')
      const entries = journal.plan.expectedOrderedEntries.slice(journal.confirmedPrefix, journal.confirmedPrefix + 100)
      const uris = entries.map((entry) => entry.sourceUri!)
      const expectedAfter = journal.plan.expectedCanonical.slice(0, journal.confirmedPrefix + uris.length)
      journal = await this.storage.operations.save({ ...journal, expectedSnapshotId: before.snapshotId, state: 'applying', retryAt: null, pendingBatch: { uris, snapshotId: before.snapshotId, before: expectedBefore, after: expectedAfter }, message: 'Пакет копии записан в журнал до отправки.' })
      let failure: unknown
      let dispatched = false
      try {
        await this.account(journal)
        dispatched = true
        await this.gateway.appendItems(journal.targetPlaylistId!, uris)
      } catch (error) { failure = error }
      if (failure && limited(failure) && rejection(failure)) return this.rateLimit({ ...journal, pendingBatch: null }, failure)
      let observed: Baseline
      try { observed = await this.read(journal, journal.targetPlaylistId!) }
      catch (error) {
        if (!dispatched || (failure && rejection(failure))) journal = await this.storage.operations.save({ ...journal, pendingBatch: null })
        if (limited(error)) return this.rateLimit(journal, error)
        return this.stop(journal, journal.pendingBatch ? 'unknown' : 'partial', 'Результат копирования сейчас нельзя прочитать. Запрос автоматически не повторяется.')
      }
      const actual = canonicalEntries(observed.orderedEntries)
      if (equal(actual, expectedAfter)) {
        journal = await this.storage.operations.save({ ...journal, expectedSnapshotId: observed.snapshotId, state: 'reconciling', confirmedPrefix: journal.confirmedPrefix + uris.length, pendingBatch: null, message: 'Полный префикс копии подтверждён повторным чтением.' })
        // Even a lost successful response stops this invocation at its verified
        // prefix. A subsequent append needs an explicit resume by the user.
        if (failure && journal.confirmedPrefix < journal.plan.expectedCanonical.length) return this.stop(journal, 'partial', 'Отправленный пакет подтверждён. Для оставшейся части отдельно продолжи копирование.')
      } else if (equal(actual, expectedBefore)) {
        if (!dispatched || (failure && rejection(failure))) return this.stop({ ...journal, pendingBatch: null }, 'partial', 'Пакет не отправлен или отклонён. Продолжение требует отдельного действия.')
        return this.stop(journal, 'unknown', 'Добавление не подтверждено. Результат запроса неизвестен, автоматического повтора нет.')
      } else return this.stop(journal, 'conflict', 'После добавления копия не совпала с планом. Операция остановлена.')
    }
    const source = await this.source(journal)
    if (!source) return this.stop(journal, 'conflict', 'Исходник изменился до итоговой сверки. Завершение не подтверждено.')
    const target = await this.read(journal, journal.targetPlaylistId!)
    if (!equal(canonicalEntries(target.orderedEntries), journal.plan.expectedCanonical) || (journal.expectedSnapshotId && target.snapshotId !== journal.expectedSnapshotId)) return this.stop(journal, 'conflict', 'Итоговый состав или версия копии не совпала с планом.')
    if (!journal.expectedSnapshotId) journal = await this.storage.operations.save({ ...journal, expectedSnapshotId: target.snapshotId })
    return this.finish(journal, source, target)
  }

  private async finish(journal: MutationJournal, source: Baseline, target: Baseline): Promise<ApplyResult> {
    const done = await this.storage.operations.finish(journal, source, target)
    return { ...this.result(done.journal, 'complete', done.journal.message), baseline: source, targetBaseline: target, session: done.draft.session, draftRevision: done.draft.revision }
  }
}
