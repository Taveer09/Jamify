import { describe, expect, it } from 'vitest'
import { createSession, currentUri, decide, finalizeSession, assertBaseline, undo } from '../../../src/domain/session'
import { demoFixtures } from '../../../src/demo/fixtures'
import { buildApplyPlan } from '../../../src/domain/playlist'
import { DemoApplyCoordinator, DemoPlaylistGateway } from '../../../src/demo/gateway'

describe('review sessions', () => {
  it('keeps the full unique queue and stops at 25 without silently truncating 10,000 entries', () => {
    const baseline = demoFixtures()[3]
    let session = createSession(baseline, 42)
    expect(session.queue).toHaveLength(3200)
    const queue = [...session.queue]
    for (let i = 0; i < 25; i++) session = decide(session, currentUri(session)!, 'keep')
    expect(currentUri(session)).toBeNull()
    expect(decide(session, queue[25], 'remove')).toBe(session)
    expect(session.queue).toEqual(queue)
    expect(baseline.orderedEntries).toHaveLength(10_000)
  })
  it('ignores a duplicate stale action, skips without a decision, and restores the exact card on undo', () => {
    let session = createSession(demoFixtures()[0], 42)
    const first = currentUri(session)!
    session = decide(session, first, 'remove')
    expect(decide(session, first, 'remove')).toBe(session)
    session = undo(session)
    expect(currentUri(session)).toBe(first)
    expect(session.decisions[first]).toBeUndefined()
    session = decide(session, first, 'skip')
    expect(session.decisions[first]).toBeUndefined()
    expect(currentUri(undo(session))).toBe(first)
  })
  it('rejects other accounts and changed baselines before restoring decisions', () => {
    const baseline = demoFixtures()[0]
    const session = createSession(baseline, 42)
    expect(() => assertBaseline(session, { ...baseline, accountId: 'other' })).toThrow('другому аккаунту')
    expect(() => assertBaseline(session, { ...baseline, snapshotId: 'changed' })).toThrow('изменился')
    expect(() => assertBaseline(session, baseline)).not.toThrow()
  })
  it('finalizes applied decisions, retains the shuffle order and never revisits viewed groups', async () => {
    const gateway = new DemoPlaylistGateway()
    const baseline = await gateway.loadBaseline('large')
    let session = createSession(baseline, 42)
    const next = session.queue[25]
    for (let i = 0; i < 25; i++) session = decide(session, currentUri(session)!, i === 0 ? 'remove' : 'keep')
    const plan = buildApplyPlan(baseline, session.decisions, 'remove-uri-groups')
    const result = await new DemoApplyCoordinator(gateway).apply(plan)
    expect(result.state).toBe('complete')
    const finalized = finalizeSession(session, result.baseline!)
    expect(finalized.reviewedUris).toHaveLength(25)
    expect(finalized.queue).toHaveLength(3175)
    expect(currentUri(finalized)).toBe(next)
    expect(finalized.history).toEqual([])
    expect(finalized.decisions).toEqual({})
    expect(undo(finalized)).toBe(finalized)
  })
})
