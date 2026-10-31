import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionController } from '../../../src/features/session/controller'
import { JamifyStorage } from '../../../src/lib/persistence/database'
import { currentUri } from '../../../src/domain/session'
import { demoFixtures } from '../../../src/demo/fixtures'

const stores: JamifyStorage[] = []
function storage() { const store = new JamifyStorage(crypto.randomUUID()); stores.push(store); return store }
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())) })
describe('session persistence coordination', () => {
  it('retains volatile drafts per playlist when browser storage is blocked', async () => {
    const store = storage(), controller = new SessionController(store)
    vi.spyOn(store, 'loadDraft').mockRejectedValue(new Error('blocked'))
    const [first, second] = demoFixtures()
    await controller.open(first, 1)
    const uri = currentUri(controller.snapshot().session!)!
    controller.choose(uri, 'remove')
    await controller.open(second, 2)
    controller.choose(currentUri(controller.snapshot().session!)!, 'keep')
    await controller.open(first, 99)
    expect(controller.snapshot().session).toMatchObject({ cursor: 1, decisions: { [uri]: 'remove' } })
    expect(controller.snapshot().persistent).toBe(false)
  })
  it('serializes rapid decisions without letting an older save replace the newest cursor', async () => {
    const store = storage(), controller = new SessionController(store), baseline = demoFixtures()[3]
    await controller.open(baseline, 42)
    for (let i = 0; i < 10; i++) controller.choose(currentUri(controller.snapshot().session!)!, 'keep')
    await controller.flush()
    expect(controller.snapshot()).toMatchObject({ persistent: true, saving: false, session: { cursor: 10 } })
    const saved = await store.loadDraft(baseline.accountId, baseline.playlistId)
    expect(saved?.session.cursor).toBe(10)
    expect(Object.keys(saved!.session.decisions)).toHaveLength(10)
  })
  it('keeps newer in-memory decisions after a quota error and stops claiming persistence', async () => {
    const store = storage(), controller = new SessionController(store), baseline = demoFixtures()[0]
    await controller.open(baseline, 42)
    vi.spyOn(store, 'saveDraft').mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'))
    controller.choose(currentUri(controller.snapshot().session!)!, 'remove')
    controller.choose(currentUri(controller.snapshot().session!)!, 'keep')
    await controller.flush()
    expect(controller.snapshot()).toMatchObject({ persistent: false, saving: false, session: { cursor: 2 } })
    expect(controller.snapshot().error).toContain('сохранение не подтверждено')
    expect((await store.loadDraft(baseline.accountId, baseline.playlistId))?.session.cursor).toBe(0)
  })
  it('restores the same draft and only starts a fresh run after an explicit restart', async () => {
    const store = storage(), first = new SessionController(store), baseline = demoFixtures()[0]
    await first.open(baseline, 42)
    first.choose(currentUri(first.snapshot().session!)!, 'remove'); await first.flush()
    const second = new SessionController(store)
    await second.open(baseline, 900)
    expect(second.snapshot().session).toEqual(first.snapshot().session)
    const previousRun = second.snapshot().session!.runId
    await second.open(baseline, 900, true)
    expect(second.snapshot().session!.cursor).toBe(0)
    expect(second.snapshot().session!.runId).not.toBe(previousRun)
    expect((await store.loadDraft(baseline.accountId, baseline.playlistId))?.session.runId).toBe(second.snapshot().session!.runId)
  })
})
