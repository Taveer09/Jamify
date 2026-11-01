import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JamifyStorage, DraftConflictError } from '../../../src/lib/persistence/database'
import { createSession, currentUri, decide } from '../../../src/domain/session'
import { demoFixtures } from '../../../src/demo/fixtures'
import { DemoApplyCoordinator, DemoPlaylistGateway } from '../../../src/demo/gateway'
import { buildApplyPlan } from '../../../src/domain/playlist'

const open: JamifyStorage[] = []
function store(name = crypto.randomUUID(), clock?: () => number) { const storage = new JamifyStorage(name, clock); open.push(storage); return storage }
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(open.splice(0).map((storage) => storage.close())) })
describe('durable session storage', () => {
  it('retains valid decisions when the device clock moves backwards', async () => {
    let now = 100_000
    const storage = store(undefined, () => now)
    const baseline = demoFixtures()[0], session = createSession(baseline, 1)
    const changed = decide(session, currentUri(session)!, 'remove')
    await storage.saveDraft(baseline, changed, null)
    now--
    expect((await storage.loadDraft(baseline.accountId, baseline.playlistId))?.session.cursor).toBe(1)
    now += 2
    expect((await storage.loadDraft(baseline.accountId, baseline.playlistId))?.session.cursor).toBe(1)
  })
  it('rejects silently truncated queues that omit unreviewed tracks', async () => {
    const storage = store(), baseline = demoFixtures()[0]
    await expect(storage.saveDraft(baseline, { ...createSession(baseline, 1), queue: [] }, null)).rejects.toThrow()
    expect(await storage.loadDraft(baseline.accountId, baseline.playlistId)).toBeNull()
  })
  it('restores exact decisions and queue across a database close and reopen', async () => {
    const name = crypto.randomUUID()
    const first = store(name)
    const baseline = demoFixtures()[0]
    const initial = createSession(baseline, 42)
    const session = decide(initial, currentUri(initial)!, 'remove')
    await first.saveDraft(baseline, session, null)
    await first.close()
    expect((await store(name).loadDraft(baseline.accountId, baseline.playlistId))?.session).toEqual(session)
  })
  it('enforces account binding and clears only the requested account', async () => {
    const storage = store()
    const a = demoFixtures()[0]
    const b = { ...a, accountId: 'different-account' }
    await storage.saveDraft(a, createSession(a, 1), null)
    await storage.saveDraft(b, createSession(b, 2), null)
    await storage.clearAccount(a.accountId)
    expect(await storage.loadDraft(a.accountId, a.playlistId)).toBeNull()
    expect((await storage.loadDraft(b.accountId, b.playlistId))?.session.accountId).toBe(b.accountId)
  })
  it('uses optimistic revisions so concurrent tabs cannot overwrite each other', async () => {
    const name = crypto.randomUUID()
    const first = store(name), second = store(name)
    const baseline = demoFixtures()[0], session = createSession(baseline, 1)
    const initial = await first.saveDraft(baseline, session, null)
    const results = await Promise.allSettled([
      first.saveDraft(baseline, decide(session, currentUri(session)!, 'keep'), initial.revision),
      second.saveDraft(baseline, decide(session, currentUri(session)!, 'remove'), initial.revision),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason).toBeInstanceOf(DraftConflictError)
  })
  it('expires drafts after 30 days and rejects inconsistent content', async () => {
    let now = 10_000
    const storage = store(undefined, () => now)
    const baseline = demoFixtures()[0], session = createSession(baseline, 1)
    await expect(storage.saveDraft({ ...baseline, fingerprint: 'wrong' }, session, null)).rejects.toThrow()
    await storage.saveDraft(baseline, session, null)
    now += 31 * 24 * 60 * 60_000
    expect(await storage.loadDraft(baseline.accountId, baseline.playlistId)).toBeNull()
  })
  it('finalizes baseline, reviewed groups, cursor and undo in one durable update; card 26 survives reload', async () => {
    const storage = store(), gateway = new DemoPlaylistGateway(), coordinator = new DemoApplyCoordinator(gateway)
    const baseline = await gateway.loadBaseline('large')
    let session = createSession(baseline, 7)
    const nextUri = session.queue[25]
    for (let i = 0; i < 25; i++) session = decide(session, currentUri(session)!, i === 0 ? 'remove' : 'keep')
    const saved = await storage.saveDraft(baseline, session, null)
    const first = await coordinator.apply(buildApplyPlan(baseline, session.decisions, 'remove-uri-groups'))
    const finalized = await storage.finalize(baseline.accountId, baseline.playlistId, saved.revision, session.runId, first.baseline!)
    await expect(storage.finalize(baseline.accountId, baseline.playlistId, saved.revision, session.runId, first.baseline!)).rejects.toBeInstanceOf(DraftConflictError)
    const restored = await storage.loadDraft(baseline.accountId, baseline.playlistId)
    expect(currentUri(restored!.session)).toBe(nextUri)
    expect(restored!.session.history).toEqual([])
    expect(restored!.baseline.fingerprint).toBe(first.baseline!.fingerprint)
    const nextSession = decide(finalized.session, nextUri, 'remove')
    const secondPlan = buildApplyPlan(finalized.baseline, nextSession.decisions, 'remove-uri-groups')
    expect(secondPlan.removeUris).toEqual([nextUri])
    expect((await coordinator.apply(secondPlan)).state).toBe('complete')
  })
  it('reports unavailable browser storage without claiming a saved draft', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const baseline = demoFixtures()[0]
    await expect(store().saveDraft(baseline, createSession(baseline, 1), null)).rejects.toThrow()
  })
})

describe('persistent demo library isolation', () => {
  it('keeps mutations across gateway instances and rejects stale snapshots in another tab', async () => {
    const name = crypto.randomUUID()
    const first = new DemoPlaylistGateway(store(name)), second = new DemoPlaylistGateway(store(name))
    const baseline = await first.loadBaseline('night-drive')
    const stale = await second.loadBaseline('night-drive')
    await first.removeUriGroups('night-drive', ['demo:track:0'], baseline.snapshotId)
    const reloaded = new DemoPlaylistGateway(store(name))
    expect((await reloaded.loadBaseline('night-drive')).orderedEntries).toHaveLength(6)
    await expect(second.removeUriGroups('night-drive', ['demo:track:1'], stale.snapshotId)).rejects.toThrow('изменилась')
    expect((await reloaded.loadBaseline('night-drive')).orderedEntries).toHaveLength(6)
  })
})
