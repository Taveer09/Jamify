import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDB } from 'idb'
import type { Baseline, Entry } from '../../src/contracts'
import { demoEntry } from '../../src/demo/fixtures'
import { DemoPlaylistGateway } from '../../src/demo/gateway'
import { buildApplyPlan, canonicalEntries, fingerprint } from '../../src/domain/playlist'
import { createSession, currentUri, decide } from '../../src/domain/session'
import { DurableApplyCoordinator } from '../../src/features/apply/coordinator'
import type { ExclusiveLock } from '../../src/features/apply/coordinator'
import { JamifyStorage } from '../../src/lib/persistence/database'
import type { JamifyDatabase } from '../../src/lib/persistence/database'
import { SpotifyError } from '../../src/lib/spotify/api'

const stores: JamifyStorage[] = []
const lock: ExclusiveLock = async (_name, job) => job()
async function setup(entries: Entry[] = [demoEntry(0), demoEntry(1), demoEntry(0), demoEntry(2), demoEntry(1)], remove = false) {
  const name = crypto.randomUUID(), storage = new JamifyStorage(name)
  stores.push(storage)
  const gateway = new DemoPlaylistGateway(storage)
  await gateway.listPlaylists()
  const baseline: Baseline = { accountId: 'demo-account', playlistId: `copy-source-${crypto.randomUUID()}`, playlistName: 'Source', snapshotId: 'source-v1', orderedEntries: entries, fingerprint: fingerprint(entries) }
  await storage.saveDemoPlaylist(baseline, null)
  const initial = createSession(baseline, 42)
  const session = remove ? decide(initial, currentUri(initial)!, 'remove') : initial
  const draft = await storage.saveDraft(baseline, session, null)
  const plan = { ...buildApplyPlan(baseline, session.decisions, 'create-clean-copy'), draftRevision: draft.revision, runId: session.runId }
  const coordinator = new DurableApplyCoordinator(gateway, storage, lock)
  return { name, storage, gateway, baseline, session, plan, coordinator, create: vi.spyOn(gateway, 'createPrivatePlaylist'), append: vi.spyOn(gateway, 'appendItems'), remove: vi.spyOn(gateway, 'removeUriGroups') }
}
async function reload(name: string) {
  const storage = new JamifyStorage(name); stores.push(storage)
  const gateway = new DemoPlaylistGateway(storage)
  return { storage, gateway, coordinator: new DurableApplyCoordinator(gateway, storage, lock), create: vi.spyOn(gateway, 'createPrivatePlaylist'), append: vi.spyOn(gateway, 'appendItems') }
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map((storage) => storage.close())) })

describe('durable private cleaned copy', () => {
  it('copies only the first confirmed URI in source order and never mutates the source', async () => {
    const { coordinator, plan, baseline, gateway, storage, create, append, remove } = await setup()
    const result = await coordinator.apply(plan)
    expect(result.state).toBe('complete')
    expect(create).toHaveBeenCalledExactlyOnceWith('Source — очищенная копия')
    expect(append).toHaveBeenCalledExactlyOnceWith(result.targetPlaylistId, ['demo:track:0', 'demo:track:1', 'demo:track:2'])
    expect(remove).not.toHaveBeenCalled()
    expect(await gateway.loadBaseline(baseline.playlistId)).toEqual(baseline)
    expect(result.baseline).toEqual(baseline)
    expect(result.targetBaseline?.playlistId).toBe(result.targetPlaylistId)
    expect(canonicalEntries(result.targetBaseline!.orderedEntries)).toEqual(plan.expectedCanonical)
    expect(await storage.operations.read(plan.accountId, plan.playlistId)).toMatchObject({ sessionFinalized: true, state: 'complete', confirmedPrefix: 3, targetPlaylistId: result.targetPlaylistId, pendingCreate: false, pendingBatch: null })
    expect((await storage.loadDraft(plan.accountId, plan.playlistId))?.baseline).toEqual(baseline)
    expect((await coordinator.apply(plan)).targetPlaylistId).toBe(result.targetPlaylistId)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('omits selected URI groups from the copy and atomically continues the source review', async () => {
    const { coordinator, plan, storage, session, baseline, remove } = await setup(undefined, true)
    const result = await coordinator.apply(plan)
    expect(result.state).toBe('complete')
    expect(result.targetBaseline?.orderedEntries.map((entry) => entry.sourceUri)).toEqual(plan.expectedOrderedEntries.map((entry) => entry.sourceUri))
    expect(result.targetBaseline?.orderedEntries.some((entry) => plan.removeUris.includes(entry.sourceUri!))).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    const draft = await storage.loadDraft(plan.accountId, plan.playlistId)
    expect(draft?.baseline).toEqual(baseline)
    expect(draft?.session).toMatchObject({ decisions: {}, history: [], cursor: 0, reviewedUris: [session.queue[0]], queue: session.queue.slice(1), baselineSnapshotId: baseline.snapshotId })
  })

  it('appends more than 100 tracks as sequential bounded batches with durable target identity', async () => {
    const entries = [...Array.from({ length: 205 }, (_, i) => demoEntry(i)), demoEntry(3), demoEntry(99)]
    const { coordinator, plan, append, create, gateway, baseline, remove } = await setup(entries)
    const result = await coordinator.apply(plan)
    expect(result.state).toBe('complete')
    expect(append.mock.calls.map(([, uris]) => uris.length)).toEqual([100, 100, 5])
    expect(append.mock.calls.flatMap(([, uris]) => uris)).toEqual(Array.from({ length: 205 }, (_, i) => `demo:track:${i}`))
    expect(result.targetBaseline?.orderedEntries).toHaveLength(205)
    expect(create).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    expect(await gateway.loadBaseline(baseline.playlistId)).toEqual(baseline)
  })

  it('creates and verifies an empty copy without sending an empty append', async () => {
    const { coordinator, plan, append, create } = await setup([])
    const result = await coordinator.apply(plan)
    expect(result.state).toBe('complete')
    expect(result.targetBaseline?.orderedEntries).toEqual([])
    expect(create).toHaveBeenCalledTimes(1)
    expect(append).not.toHaveBeenCalled()
  })

  it('reloads a definite partial result, reads the whole prefix and only resumes on an explicit action', async () => {
    const { coordinator, plan, name, append, gateway, baseline } = await setup(Array.from({ length: 205 }, (_, i) => demoEntry(i)))
    const send = DemoPlaylistGateway.prototype.appendItems.bind(gateway)
    append.mockImplementationOnce(send).mockRejectedValueOnce(new SpotifyError(401, null, false))
    const first = await coordinator.apply(plan)
    expect(first.state).toBe('partial')
    expect(append).toHaveBeenCalledTimes(2)
    const next = await reload(name)
    expect((await next.coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('partial')
    expect(next.append).not.toHaveBeenCalled()
    const result = await next.coordinator.resume(plan.accountId, plan.playlistId)
    expect(result.state).toBe('complete')
    expect(next.create).not.toHaveBeenCalled()
    expect(next.append.mock.calls.map(([, uris]) => uris.length)).toEqual([100, 5])
    expect(result.targetPlaylistId).toBe(first.targetPlaylistId)
    expect(await next.gateway.loadBaseline(baseline.playlistId)).toEqual(baseline)
  })

  it.each([null, 500])('never repeats create after a lost response (%s), even when the playlist was created', async (status) => {
    const { coordinator, plan, name, gateway, create, append, storage } = await setup()
    const send = DemoPlaylistGateway.prototype.createPrivatePlaylist.bind(gateway)
    create.mockImplementationOnce(async (name) => { await send(name); throw new SpotifyError(status, null, true) })
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect(await storage.operations.read(plan.accountId, plan.playlistId)).toMatchObject({ pendingCreate: true, targetPlaylistId: null })
    const next = await reload(name)
    expect((await next.coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('unknown')
    expect((await next.coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('unknown')
    expect((await next.coordinator.apply(plan)).state).toBe('unknown')
    expect(create).toHaveBeenCalledTimes(1)
    expect(next.create).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(next.append).not.toHaveBeenCalled()
    await expect(storage.clearAccount(plan.accountId)).rejects.toThrow('незавершённая операция')
  })

  it('does not repeat creation when saving the returned target ID fails', async () => {
    const { coordinator, plan, storage, create, append } = await setup()
    const save = storage.operations.save.bind(storage.operations)
    let failed = false
    vi.spyOn(storage.operations, 'save').mockImplementation(async (journal) => {
      if (!failed && journal.targetPlaylistId) { failed = true; throw new Error('ID checkpoint lost') }
      return save(journal)
    })
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect((await coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('unknown')
    expect((await coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('unknown')
    expect(create).toHaveBeenCalledTimes(1)
    expect(append).not.toHaveBeenCalled()
  })

  it('sends no create if persisting its intent failed and permits explicit resume after recovery', async () => {
    const { coordinator, plan, storage, create } = await setup()
    vi.spyOn(storage.operations, 'save').mockRejectedValueOnce(new Error('intent unavailable'))
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect(create).not.toHaveBeenCalled()
    expect((await coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('partial')
    expect(create).not.toHaveBeenCalled()
    expect((await coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('complete')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('sends no append if persisting the append intent failed, preserving the known copy ID', async () => {
    const { coordinator, plan, storage, create, append } = await setup()
    const save = storage.operations.save.bind(storage.operations)
    let failed = false
    vi.spyOn(storage.operations, 'save').mockImplementation(async (journal) => {
      if (!failed && journal.pendingBatch) { failed = true; throw new Error('append intent unavailable') }
      return save(journal)
    })
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect(append).not.toHaveBeenCalled()
    const receipt = await storage.operations.read(plan.accountId, plan.playlistId)
    expect(receipt?.targetPlaylistId).toBeTruthy()
    expect(receipt?.pendingBatch).toBeNull()
    expect((await coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('partial')
    expect((await coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('complete')
    expect(create).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('keeps an unchanged ambiguous append pending and never resends it after reload', async () => {
    const { coordinator, plan, append, name } = await setup()
    append.mockRejectedValueOnce(new SpotifyError(null, null, true))
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    const next = await reload(name)
    expect((await next.coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('unknown')
    expect((await next.coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('unknown')
    expect(next.append).not.toHaveBeenCalled()
    expect(next.create).not.toHaveBeenCalled()
  })

  it('confirms a lost successful append by full read, then stops before further batches', async () => {
    const { coordinator, plan, append, gateway } = await setup(Array.from({ length: 102 }, (_, i) => demoEntry(i)))
    const send = DemoPlaylistGateway.prototype.appendItems.bind(gateway)
    append.mockImplementationOnce(async (...args) => { await send(...args); throw new SpotifyError(null, null, true) })
    expect((await coordinator.apply(plan)).state).toBe('partial')
    expect(append).toHaveBeenCalledTimes(1)
    expect((await coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('partial')
    expect(append).toHaveBeenCalledTimes(1)
    expect((await coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('complete')
    expect(append.mock.calls.map(([, uris]) => uris.length)).toEqual([100, 2])
  })

  it('reconciles a crash after append but before checkpoint without sending that batch again', async () => {
    const { coordinator, plan, append, storage, name } = await setup(Array.from({ length: 102 }, (_, i) => demoEntry(i)))
    const save = storage.operations.save.bind(storage.operations)
    let failed = false
    vi.spyOn(storage.operations, 'save').mockImplementation(async (journal) => {
      if (!failed && journal.confirmedPrefix > 0 && !journal.pendingBatch) { failed = true; throw new Error('post-append crash') }
      return save(journal)
    })
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect(append).toHaveBeenCalledTimes(1)
    const next = await reload(name)
    expect((await next.coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('partial')
    expect(next.append).not.toHaveBeenCalled()
    expect((await next.storage.operations.read(plan.accountId, plan.playlistId))?.confirmedPrefix).toBe(100)
    expect((await next.coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('complete')
    expect(next.append).toHaveBeenCalledExactlyOnceWith(expect.any(String), ['demo:track:100', 'demo:track:101'])
  })
})

describe('copy preflight and external changes', () => {
  it.each(['unavailable', 'local', 'ambiguous', 'not-copyable'] as const)('blocks a retained %s entry without creating a target', async (kind) => {
    const entry = demoEntry(0)
    const unsupported: Entry = kind === 'unavailable' ? { ...entry, kind, sourceUri: null, observedUri: null, identityConfidence: 'opaque', canCopy: false }
      : kind === 'local' ? { ...entry, kind, sourceUri: null, observedUri: 'spotify:local:example', canCopy: false }
        : kind === 'ambiguous' ? { ...entry, identityConfidence: 'ambiguous' }
          : { ...entry, canCopy: false }
    const { coordinator, plan, create, append, remove } = await setup([unsupported])
    expect((await coordinator.apply(plan)).state).toBe('conflict')
    expect(create).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('copies confirmed supported episodes in place rather than silently dropping them', async () => {
    const episode: Entry = { ...demoEntry(4), kind: 'episode', observedUri: 'demo:episode:1', sourceUri: 'demo:episode:1', canPlay: false }
    const { coordinator, plan } = await setup([demoEntry(0), episode, demoEntry(0)])
    const result = await coordinator.apply(plan)
    expect(result.state).toBe('complete')
    expect(result.targetBaseline?.orderedEntries.map((entry) => [entry.kind, entry.sourceUri])).toEqual([['track', 'demo:track:0'], ['episode', 'demo:episode:1']])
  })

  it('rejects stale preview and forged expected contents before any create', async () => {
    const { coordinator, plan, gateway, baseline, create, append } = await setup()
    expect((await coordinator.apply({ ...plan, expectedOrderedEntries: [], expectedCanonical: [] })).state).toBe('conflict')
    await gateway.appendItems(plan.playlistId, ['demo:track:0'])
    expect((await coordinator.apply(plan)).state).toBe('conflict')
    expect((await gateway.loadBaseline(plan.playlistId)).snapshotId).not.toBe(baseline.snapshotId)
    expect(create).not.toHaveBeenCalled()
    expect(append).toHaveBeenCalledTimes(1) // The simulated external edit only.
  })

  it.each(['canCopy', 'identityConfidence'] as const)('rechecks fresh %s even when snapshot and canonical contents are unchanged', async (field) => {
    const { coordinator, plan, gateway, storage, create, append } = await setup()
    const read = gateway.loadBaseline.bind(gateway)
    let unsafe = false
    vi.spyOn(gateway, 'loadBaseline').mockImplementation(async (id) => {
      const baseline = await read(id)
      if (!unsafe || id !== plan.playlistId) return baseline
      return { ...baseline, orderedEntries: baseline.orderedEntries.map((entry) => ({ ...entry, ...(field === 'canCopy' ? { canCopy: false } : { identityConfidence: 'ambiguous' as const }) })) }
    })
    const begin = storage.operations.begin.bind(storage.operations)
    vi.spyOn(storage.operations, 'begin').mockImplementationOnce(async (plan) => { const journal = await begin(plan); unsafe = true; return journal })
    expect((await coordinator.apply(plan)).state).toBe('conflict')
    expect(create).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
  })

  it.each(['extra', 'reorder', 'snapshot-only'] as const)('rejects a target %s edit after partial progress and never rewrites it', async (edit) => {
    const { coordinator, plan, gateway, append, storage, create } = await setup(Array.from({ length: 102 }, (_, i) => demoEntry(i)))
    const send = DemoPlaylistGateway.prototype.appendItems.bind(gateway)
    append.mockImplementationOnce(send).mockRejectedValueOnce(new SpotifyError(403, null, false))
    const partial = await coordinator.apply(plan)
    expect(partial.state).toBe('partial')
    const target = await gateway.loadBaseline(partial.targetPlaylistId!)
    const orderedEntries = edit === 'extra' ? [...target.orderedEntries, demoEntry(101)] : edit === 'reorder' ? [...target.orderedEntries].reverse() : target.orderedEntries
    await storage.saveDemoPlaylist({ ...target, orderedEntries, fingerprint: fingerprint(orderedEntries), snapshotId: 'external-version' }, target.snapshotId)
    expect((await coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('conflict')
    expect((await coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('conflict')
    expect(append).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('rechecks the source before each append and leaves it unchanged by this operation', async () => {
    const { coordinator, plan, gateway, append, storage, baseline, remove } = await setup(Array.from({ length: 102 }, (_, i) => demoEntry(i)))
    const send = DemoPlaylistGateway.prototype.appendItems.bind(gateway)
    append.mockImplementationOnce(async (...args) => {
      await send(...args)
      await storage.saveDemoPlaylist({ ...baseline, snapshotId: 'external-source-version' }, baseline.snapshotId)
    })
    expect((await coordinator.apply(plan)).state).toBe('conflict')
    expect(append).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    expect((await gateway.loadBaseline(plan.playlistId)).orderedEntries).toEqual(baseline.orderedEntries)
  })

  it('refuses a create response pointing to the source instead of appending to it', async () => {
    const { coordinator, plan, create, append, gateway, baseline } = await setup()
    create.mockResolvedValueOnce(plan.playlistId)
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect((await coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('unknown')
    expect(create).toHaveBeenCalledTimes(1)
    expect(append).not.toHaveBeenCalled()
    expect(await gateway.loadBaseline(plan.playlistId)).toEqual(baseline)
  })

  it('stops an account switch between durable intent and create, allowing resume with the original account', async () => {
    const { coordinator, plan, gateway, storage, create } = await setup()
    let account = plan.accountId
    vi.spyOn(gateway, 'currentAccount').mockImplementation(async () => account)
    const save = storage.operations.save.bind(storage.operations)
    vi.spyOn(storage.operations, 'save').mockImplementationOnce(async (journal) => { const saved = await save(journal); account = 'other-account'; return saved })
    expect((await coordinator.apply(plan)).state).toBe('partial')
    expect(create).not.toHaveBeenCalled()
    expect(await storage.operations.read(plan.accountId, plan.playlistId)).toMatchObject({ pendingCreate: false, targetPlaylistId: null })
    account = plan.accountId
    expect((await coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('complete')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('stops an account switch after a successful append and reconciles without resending', async () => {
    const { coordinator, plan, gateway, append } = await setup()
    let account = plan.accountId
    vi.spyOn(gateway, 'currentAccount').mockImplementation(async () => account)
    const send = DemoPlaylistGateway.prototype.appendItems.bind(gateway)
    append.mockImplementationOnce(async (...args) => { await send(...args); account = 'other-account' })
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    account = plan.accountId
    expect((await coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('complete')
    expect(append).toHaveBeenCalledTimes(1)
  })
})

describe('copy Retry-After and local atomic finalization', () => {
  it.each(['preflight-read', 'account-read', 'create', 'target-read', 'append', 'append-read'] as const)('persists Retry-After from %s and does no calls until the delay expires', async (phase) => {
    const { coordinator, plan, gateway, storage, create, append, name } = await setup()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const limited = new SpotifyError(429, 10, false)
    if (phase === 'create') create.mockRejectedValueOnce(limited)
    if (phase === 'append') append.mockRejectedValueOnce(limited)
    if (phase === 'account-read') vi.spyOn(gateway, 'currentAccount').mockRejectedValueOnce(limited)
    if (phase === 'preflight-read' || phase === 'target-read' || phase === 'append-read') {
      const read = gateway.loadBaseline.bind(gateway)
      let targetReads = 0
      let thrown = false
      vi.spyOn(gateway, 'loadBaseline').mockImplementation(async (id) => {
        const target = id !== plan.playlistId
        if (target) targetReads++
        if (!thrown && ((phase === 'preflight-read' && !target) || (phase === 'target-read' && targetReads === 1) || (phase === 'append-read' && targetReads === 3))) { thrown = true; throw limited }
        return read(id)
      })
    }
    expect((await coordinator.apply(plan)).state).toBe('partial')
    expect((await storage.operations.read(plan.accountId, plan.playlistId))?.retryAt).toBe(now + 10_000)
    const next = await reload(name)
    const reads = vi.spyOn(next.gateway, 'loadBaseline')
    expect((await next.coordinator.recover(plan.accountId, plan.playlistId)).state).toBe('partial')
    expect((await next.coordinator.resume(plan.accountId, plan.playlistId)).state).toBe('partial')
    expect(reads).not.toHaveBeenCalled()
    expect(next.create).not.toHaveBeenCalled()
    expect(next.append).not.toHaveBeenCalled()
    now += 10_001
    const result = await next.coordinator.resume(plan.accountId, plan.playlistId)
    // The successful but unread append is reconciled; other cases explicitly
    // dispatch only after verifying the source and the known complete prefix.
    expect(result.state).toBe('complete')
    if (phase === 'append-read') expect(next.append).not.toHaveBeenCalled()
  })

  it('atomically rolls back the source draft when writing the copy receipt fails, then recovers without writes', async () => {
    const { coordinator, plan, storage, append, create, baseline } = await setup(undefined, true)
    const put = IDBObjectStore.prototype.put
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'operations' && value && typeof value === 'object' && 'state' in value && value.state === 'complete') throw new DOMException('quota', 'QuotaExceededError')
      return put.call(this, value, key)
    })
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect((await storage.loadDraft(plan.accountId, plan.playlistId))?.session.cursor).toBe(1)
    expect((await storage.loadDraft(plan.accountId, plan.playlistId))?.baseline).toEqual(baseline)
    expect((await storage.operations.read(plan.accountId, plan.playlistId))?.sessionFinalized).toBe(false)
    failure.mockRestore()
    const result = await coordinator.recover(plan.accountId, plan.playlistId)
    expect(result.state).toBe('complete')
    expect((await storage.loadDraft(plan.accountId, plan.playlistId))?.session.cursor).toBe(0)
    expect((await storage.loadDraft(plan.accountId, plan.playlistId))?.baseline).toEqual(baseline)
    expect(append).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('untrusted persisted operation integrity', () => {
  it('blocks a null source URI even when observedUri preserves the same canonical identity', async () => {
    const { coordinator, plan, name, create, append, gateway } = await setup()
    create.mockRejectedValueOnce(new SpotifyError(403, null, false))
    expect((await coordinator.apply(plan)).state).toBe('partial')
    const database = await openDB<JamifyDatabase>(name, 2)
    const key: [string, string] = [plan.accountId, plan.playlistId]
    const raw = (await database.get('operations', key))!
    raw.plan.expectedOrderedEntries[0].sourceUri = null
    await database.put('operations', raw, key); database.close()
    create.mockClear()
    const read = vi.spyOn(gateway, 'loadBaseline')
    expect((await coordinator.resume(...key)).state).toBe('unknown')
    expect(create).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['apply', 'recover', 'resume'] as const)('blocks inconsistent copy entries before any gateway call on %s', async (action) => {
    const { coordinator, plan, name, create, append, gateway } = await setup(undefined, true)
    create.mockRejectedValueOnce(new SpotifyError(403, null, false))
    expect((await coordinator.apply(plan)).state).toBe('partial')
    const database = await openDB<JamifyDatabase>(name, 2)
    const key: [string, string] = [plan.accountId, plan.playlistId]
    const raw = (await database.get('operations', key))!
    raw.plan.expectedOrderedEntries[0].sourceUri = plan.removeUris[0]
    await database.put('operations', raw, key); database.close()
    create.mockClear()
    const read = vi.spyOn(gateway, 'loadBaseline')
    const result = action === 'apply' ? await coordinator.apply(plan) : await coordinator[action](...key)
    expect(result.state).toBe('unknown')
    expect(create).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['create-clean-copy', 'remove-uri-groups'] as const)('binds even an internally consistent replacement %s plan to actual frozen decisions', async (mode) => {
    const { coordinator, plan: copyPlan, baseline, session, name, create, append, remove, gateway } = await setup(undefined, true)
    const plan = { ...buildApplyPlan(baseline, session.decisions, mode, copyPlan.operationId), draftRevision: copyPlan.draftRevision, runId: copyPlan.runId }
    const write = mode === 'create-clean-copy' ? create : remove
    write.mockRejectedValueOnce(new SpotifyError(403, null, false))
    expect((await coordinator.apply(plan)).state).toBe('partial')
    const unapprovedUri = baseline.orderedEntries.find((entry) => !plan.removeUris.includes(entry.sourceUri!))!.sourceUri!
    const database = await openDB<JamifyDatabase>(name, 2)
    const key: [string, string] = [plan.accountId, plan.playlistId]
    const raw = (await database.get('operations', key))!
    raw.plan = { ...buildApplyPlan(baseline, { [unapprovedUri]: 'remove' }, mode, plan.operationId), draftRevision: plan.draftRevision, runId: plan.runId }
    await database.put('operations', raw, key); database.close()
    create.mockClear(); remove.mockClear()
    const read = vi.spyOn(gateway, 'loadBaseline')
    expect((await coordinator.resume(...key)).state).toBe('unknown')
    expect((await coordinator.recover(...key)).state).toBe('unknown')
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    expect(create).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(await DemoPlaylistGateway.prototype.loadBaseline.call(gateway, plan.playlistId)).toEqual(baseline)
  })

  it.each(['uris', 'before', 'after', 'snapshot'] as const)('rejects corrupted pending append %s instead of adopting it as confirmed', async (field) => {
    const { coordinator, plan, name, create, append } = await setup()
    append.mockRejectedValueOnce(new SpotifyError(null, null, true))
    expect((await coordinator.apply(plan)).state).toBe('unknown')
    const database = await openDB<JamifyDatabase>(name, 2)
    const key: [string, string] = [plan.accountId, plan.playlistId]
    const raw = (await database.get('operations', key))!
    const pending = raw.pendingBatch!
    if (field === 'uris') pending.uris.reverse()
    else if (field === 'before') pending.before = pending.after
    else if (field === 'after') pending.after = []
    else pending.snapshotId = 'unapproved-version'
    await database.put('operations', raw, key); database.close()
    const next = await reload(name)
    expect((await next.coordinator.recover(...key)).state).toBe('unknown')
    expect((await next.coordinator.resume(...key)).state).toBe('unknown')
    expect(next.create).not.toHaveBeenCalled()
    expect(next.append).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('loads a previous removal receipt with safe defaults for the new copy fields', async () => {
    const { coordinator, plan: copyPlan, baseline, session, name, storage, remove } = await setup(undefined, true)
    const plan = { ...buildApplyPlan(baseline, session.decisions, 'remove-uri-groups', copyPlan.operationId), draftRevision: copyPlan.draftRevision, runId: copyPlan.runId }
    remove.mockRejectedValueOnce(new SpotifyError(403, null, false))
    expect((await coordinator.apply(plan)).state).toBe('partial')
    const database = await openDB<JamifyDatabase>(name, 2)
    const key: [string, string] = [plan.accountId, plan.playlistId]
    const raw = (await database.get('operations', key))! as unknown as Record<string, unknown>
    delete raw.pendingCreate; delete raw.targetPlaylistId
    await database.put('operations', raw as never, key); database.close()
    expect(await storage.operations.read(...key)).toMatchObject({ pendingCreate: false, targetPlaylistId: null })
    expect((await coordinator.resume(...key)).state).toBe('complete')
  })
})
