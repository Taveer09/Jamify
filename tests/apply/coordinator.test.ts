import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DemoPlaylistGateway } from '../../src/demo/gateway'
import { DurableApplyCoordinator } from '../../src/features/apply/coordinator'
import type { ExclusiveLock } from '../../src/features/apply/coordinator'
import { JamifyStorage } from '../../src/lib/persistence/database'
import { buildApplyPlan } from '../../src/domain/playlist'
import { createSession, currentUri, decide } from '../../src/domain/session'
import { SpotifyError } from '../../src/lib/spotify/api'

const stores: JamifyStorage[] = []
function exclusive(): ExclusiveLock {
  const held = new Set<string>()
  return async (name, job) => {
    if (held.has(name)) throw new Error('Занято другой вкладкой.')
    held.add(name)
    try { return await job() } finally { held.delete(name) }
  }
}
async function setup(playlistId = 'night-drive') {
  const storage = new JamifyStorage(crypto.randomUUID()); stores.push(storage)
  const gateway = new DemoPlaylistGateway()
  const baseline = await gateway.loadBaseline(playlistId)
  const initial = createSession(baseline, 42)
  const session = decide(initial, currentUri(initial)!, 'remove')
  const saved = await storage.saveDraft(baseline, session, null)
  const plan = { ...buildApplyPlan(baseline, session.decisions, 'remove-uri-groups'), draftRevision: saved.revision, runId: session.runId }
  const lock = exclusive()
  const coordinator = new DurableApplyCoordinator(gateway, storage, lock)
  const mutation = vi.spyOn(gateway, 'removeUriGroups')
  return { storage, gateway, baseline, session, plan, coordinator, mutation, lock }
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map((store) => store.close())) })

describe('durable removal coordinator', () => {
  it('verifies the exact remaining order and atomically finalizes journal and session', async () => {
    const { coordinator, storage, plan, mutation } = await setup()
    const result = await coordinator.apply(plan)
    expect(result.state).toBe('complete')
    expect(mutation).toHaveBeenCalledTimes(1)
    expect(result.baseline?.orderedEntries.map((entry) => entry.sourceUri)).toEqual(plan.expectedOrderedEntries.map((entry) => entry.sourceUri))
    expect((await storage.operations.read(plan.accountId, plan.playlistId))).toMatchObject({ state: 'complete', sessionFinalized: true, pendingBatch: null })
    const draft = await storage.loadDraft(plan.accountId, plan.playlistId)
    expect(draft?.session.cursor).toBe(0)
    expect(draft?.session.history).toEqual([])
    expect(draft?.session.reviewedUris).toHaveLength(1)
  })
  it('confirms an applied mutation after a lost response without repeating it', async () => {
    const { gateway, coordinator, plan, mutation } = await setup()
    const remove = DemoPlaylistGateway.prototype.removeUriGroups.bind(gateway)
    mutation.mockImplementationOnce(async (...args) => { await remove(...args); throw new SpotifyError(null, null, true) })
    expect((await coordinator.apply(plan)).state).toBe('complete')
    expect(mutation).toHaveBeenCalledTimes(1)
  })
  it('keeps an ambiguous unchanged batch pending and never blindly retries, even after recovery', async () => {
    const { coordinator, storage, plan, mutation, gateway, session, baseline } = await setup()
    mutation.mockRejectedValueOnce(new SpotifyError(null, null, true))
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect((await coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('unknown')
    expect((await new DurableApplyCoordinator(gateway, storage, exclusive()).apply(plan)).state).toBe('unknown')
    expect(mutation).toHaveBeenCalledTimes(1)
    expect((await storage.operations.read(plan.accountId, plan.playlistId))?.pendingBatch).not.toBeNull()
    await expect(storage.saveDraft(baseline, session, plan.draftRevision)).rejects.toThrow('операция')
    await expect(storage.clearAccount(plan.accountId)).rejects.toThrow('незавершённая операция')
  })
  it('allows an explicit resume after a definite 429 rejection, without an automatic retry', async () => {
    const { coordinator, plan, mutation, storage } = await setup()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    mutation.mockRejectedValueOnce(new SpotifyError(429, 10, false))
    expect((await coordinator.apply(plan)).state).toBe('partial')
    expect(mutation).toHaveBeenCalledTimes(1)
    expect((await storage.operations.read(plan.accountId, plan.playlistId))?.pendingBatch).toBeNull()
    expect((await coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('partial')
    expect((await coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('partial')
    expect(mutation).toHaveBeenCalledTimes(1)
    now += 10_001
    expect((await coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('complete')
    expect(mutation).toHaveBeenCalledTimes(2)
  })
  it('sends nothing if the pending journal cannot be saved', async () => {
    const { coordinator, storage, plan, mutation } = await setup()
    vi.spyOn(storage.operations, 'save').mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'))
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect(mutation).not.toHaveBeenCalled()
  })
  it('recovers from a crash after DELETE and before checkpoint, with no duplicate mutation', async () => {
    const { coordinator, storage, plan, mutation, gateway } = await setup()
    const save = storage.operations.save.bind(storage.operations)
    let failed = false
    vi.spyOn(storage.operations, 'save').mockImplementation(async (journal) => {
      if (!failed && journal.confirmedPrefix > 0 && !journal.pendingBatch) { failed = true; throw new Error('simulated local checkpoint crash') }
      return save(journal)
    })
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect((await storage.operations.read(plan.accountId, plan.playlistId))?.pendingBatch).not.toBeNull()
    expect((await new DurableApplyCoordinator(gateway, storage, exclusive()).recover(plan.accountId, plan.playlistId)).state).toBe('complete')
    expect(mutation).toHaveBeenCalledTimes(1)
  })
  it('recovers a crash after final server verification but before the local atomic commit', async () => {
    const { coordinator, storage, plan, mutation } = await setup()
    vi.spyOn(storage.operations, 'finish').mockRejectedValueOnce(new Error('simulated crash before local finalize'))
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect((await storage.loadDraft(plan.accountId, plan.playlistId))?.session.cursor).toBe(1)
    expect((await storage.operations.read(plan.accountId, plan.playlistId))).toMatchObject({ sessionFinalized: false, pendingBatch: null, confirmedPrefix: 1 })
    expect((await coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('complete')
    expect((await storage.loadDraft(plan.accountId, plan.playlistId))?.session.cursor).toBe(0)
    expect((await coordinator.apply(plan)).state).toBe('complete')
    expect(mutation).toHaveBeenCalledTimes(1)
  })
  it('deduplicates double clicks and blocks another tab while the operation is running', async () => {
    const { coordinator, storage, plan, mutation, gateway, lock } = await setup()
    const remove = DemoPlaylistGateway.prototype.removeUriGroups.bind(gateway)
    let release!: () => void, started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pending = new Promise<void>((resolve) => { started = resolve })
    mutation.mockImplementationOnce(async (...args) => { started(); await gate; await remove(...args) })
    const first = coordinator.apply(plan), same = coordinator.apply(plan)
    expect(first).toBe(same)
    await pending
    const other = new DurableApplyCoordinator(gateway, storage, lock)
    expect((await other.apply(plan)).state).toBe('unknown')
    release()
    expect((await first).state).toBe('complete')
    expect(mutation).toHaveBeenCalledTimes(1)
  })
  it('rejects a stale source before creating a journal or issuing a write', async () => {
    const { gateway, coordinator, storage, baseline, plan, mutation } = await setup()
    const other = baseline.orderedEntries.find((entry) => entry.sourceUri !== plan.removeUris[0])!.sourceUri!
    await gateway.removeUriGroups(plan.playlistId, [other], baseline.snapshotId)
    mutation.mockClear()
    expect((await coordinator.apply(plan)).state).toBe('conflict')
    expect(mutation).not.toHaveBeenCalled()
    expect(await storage.operations.read(plan.accountId, plan.playlistId)).toBeNull()
  })
  it('rejects forged expected contents rather than silently discarding unsupported entries', async () => {
    const { coordinator, plan, mutation } = await setup('mixed')
    expect((await coordinator.apply({ ...plan, expectedCanonical: [], expectedOrderedEntries: [] })).state).toBe('unknown')
    expect(mutation).not.toHaveBeenCalled()
  })
  it('preserves local, unavailable and episode entries and ignores shifting UI indices', async () => {
    const { coordinator, plan } = await setup('mixed')
    const result = await coordinator.apply(plan)
    expect(result.state).toBe('complete')
    expect(result.baseline?.orderedEntries.map((entry) => entry.kind)).toEqual(['unavailable', 'local', 'episode'])
  })
  it('stops after an account switch without reconciling with the other account token', async () => {
    const { gateway, coordinator, plan, mutation, storage } = await setup()
    let account = plan.accountId
    vi.spyOn(gateway, 'currentAccount').mockImplementation(async () => account)
    const remove = DemoPlaylistGateway.prototype.removeUriGroups.bind(gateway)
    mutation.mockImplementationOnce(async (...args) => { await remove(...args); account = 'other-account' })
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect(mutation).toHaveBeenCalledTimes(1)
    account = plan.accountId
    expect((await coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('complete')
    expect((await storage.operations.read(plan.accountId, plan.playlistId))?.sessionFinalized).toBe(true)
    expect(mutation).toHaveBeenCalledTimes(1)
  })
})

describe('journal transaction failure boundaries', () => {
  it('makes a pre-send save failure explicitly resumable after read-only recovery', async () => {
    const { coordinator, storage, plan, mutation } = await setup()
    vi.spyOn(storage.operations, 'save').mockRejectedValueOnce(new Error('checkpoint unavailable'))
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect(mutation).not.toHaveBeenCalled()
    expect((await coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('partial')
    expect((await storage.operations.read(plan.accountId, plan.playlistId))?.state).toBe('partial')
    expect((await coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('complete')
    expect(mutation).toHaveBeenCalledTimes(1)
  })
  it('rolls back both local records if the final operation receipt cannot be written', async () => {
    const { coordinator, storage, plan, mutation } = await setup()
    const put = IDBObjectStore.prototype.put
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'operations' && value && typeof value === 'object' && 'state' in value && value.state === 'complete') throw new DOMException('quota', 'QuotaExceededError')
      return put.call(this, value, key)
    })
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect((await storage.loadDraft(plan.accountId, plan.playlistId))?.session.cursor).toBe(1)
    expect((await storage.operations.read(plan.accountId, plan.playlistId))?.sessionFinalized).toBe(false)
    failure.mockRestore()
    expect((await coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('complete')
    expect((await storage.loadDraft(plan.accountId, plan.playlistId))?.session.cursor).toBe(0)
    expect(mutation).toHaveBeenCalledTimes(1)
  })
  it('applies 205 actual reviewed removals in bounded batches after removing the 25-card cap', async () => {
    const { coordinator, gateway, storage, mutation, baseline, session } = await setup('large')
    let reviewed=session
    for(let i=1;i<205;i++)reviewed=decide(reviewed,currentUri(reviewed)!,'remove')
    const previous=await storage.loadDraft(baseline.accountId,baseline.playlistId)
    const saved=await storage.saveDraft(baseline,reviewed,previous!.revision)
    const plan={...buildApplyPlan(baseline,reviewed.decisions,'remove-uri-groups'),draftRevision:saved.revision,runId:reviewed.runId}
    const result=await coordinator.apply(plan)
    expect(result.state).toBe('complete')
    expect(mutation.mock.calls.map(call=>call[1].length)).toEqual([100,100,5])
    expect((await gateway.loadBaseline('large')).orderedEntries.map(entry=>entry.sourceUri)).toEqual(plan.expectedOrderedEntries.map(entry=>entry.sourceUri))
    const resumed=await storage.loadDraft(baseline.accountId,baseline.playlistId)
    expect(resumed?.session.reviewedUris).toHaveLength(205)
    expect(resumed?.session.queue).toHaveLength(2995)
    expect(resumed?.session.history).toEqual([])
  })
  it('rejects batches exceeding the current reviewed-session decisions before any write', async () => {
    const { coordinator, gateway, storage, mutation } = await setup('large')
    const baseline = await gateway.loadBaseline('large')
    const draft = await storage.loadDraft(baseline.accountId, baseline.playlistId)
    const uris = draft!.session.queue.slice(0, 150)
    const forged = { ...buildApplyPlan(baseline, Object.fromEntries(uris.map((uri) => [uri, 'remove'])), 'remove-uri-groups'), draftRevision: draft!.revision, runId: draft!.session.runId }
    expect((await coordinator.apply(forged)).state).toBe('unknown')
    expect(mutation).not.toHaveBeenCalled()
  })
})

describe('fresh identity and version guards', () => {
  it.each(['preflight', 'before-batch'])('blocks deletion when confirmed identity is lost at %s', async (phase) => {
    const { coordinator, storage, gateway, plan, mutation } = await setup()
    let unsafe = phase === 'preflight'
    const read = gateway.loadBaseline.bind(gateway)
    vi.spyOn(gateway, 'loadBaseline').mockImplementation(async (id) => {
      const baseline = await read(id)
      if (!unsafe) return baseline
      return { ...baseline, orderedEntries: baseline.orderedEntries.map((entry) => plan.removeUris.includes(entry.sourceUri ?? '')
        ? { ...entry, sourceUri: null, identityConfidence: 'ambiguous' as const, canRemove: false } : entry) }
    })
    if (phase === 'before-batch') {
      const begin = storage.operations.begin.bind(storage.operations)
      vi.spyOn(storage.operations, 'begin').mockImplementationOnce(async (preview) => { const journal = await begin(preview); unsafe = true; return journal })
    }
    expect((await coordinator.apply(plan)).state).toBe('conflict')
    expect(mutation).not.toHaveBeenCalled()
    expect((await read(plan.playlistId)).orderedEntries).toHaveLength(8)
  })
  it('blocks a snapshot-only edit after preflight before sending any deletion', async () => {
    const { coordinator, storage, gateway, plan, mutation } = await setup()
    const begin = storage.operations.begin.bind(storage.operations)
    vi.spyOn(storage.operations, 'begin').mockImplementationOnce(async (preview) => {
      const journal = await begin(preview)
      await DemoPlaylistGateway.prototype.removeUriGroups.call(gateway, preview.playlistId, [], preview.snapshotId)
      return journal
    })
    expect((await coordinator.apply(plan)).state).toBe('conflict')
    expect(mutation).not.toHaveBeenCalled()
  })
  it('does not leave an ambiguous pending write when the account changed before dispatch', async () => {
    const { coordinator, storage, gateway, plan, mutation } = await setup()
    let account = plan.accountId
    vi.spyOn(gateway, 'currentAccount').mockImplementation(async () => account)
    const save = storage.operations.save.bind(storage.operations)
    vi.spyOn(storage.operations, 'save').mockImplementationOnce(async (journal) => { const stored = await save(journal); account = 'other-account'; return stored })
    expect((await coordinator.apply(plan)).state).toBe('partial')
    expect(mutation).not.toHaveBeenCalled()
    expect((await storage.operations.read(plan.accountId, plan.playlistId))?.pendingBatch).toBeNull()
    account = plan.accountId
    expect((await coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('partial')
    expect(mutation).not.toHaveBeenCalled()
    expect((await coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('complete')
    expect(mutation).toHaveBeenCalledTimes(1)
  })
})
