import { describe, expect, it } from 'vitest'
import { buildApplyPlan, fingerprint, shuffled, uniqueReviewEntries } from '../../src/domain/playlist'
import { demoFixtures } from '../../src/demo/fixtures'
import { DemoApplyCoordinator, DemoPlaylistGateway } from '../../src/demo/gateway'

const base = () => demoFixtures()[0]
describe('playlist review contracts', () => {
  it('shuffles once deterministically without dropping or duplicating any of 10,000 entries', () => {
    const items = Array.from({ length: 10_000 }, (_, index) => index)
    const queue = shuffled(items, 42)
    expect(queue).toEqual(shuffled(items, 42))
    expect(queue).not.toEqual(shuffled(items, 43))
    expect(new Set(queue).size).toBe(items.length)
    expect([...queue].sort((a, b) => a - b)).toEqual(items)
    expect(items[0]).toBe(0)
  })
  it('reviews URI groups once while keeping all original occurrences in the baseline', () => {
    const baseline = base()
    expect(uniqueReviewEntries(baseline.orderedEntries)).toHaveLength(6)
    expect(baseline.orderedEntries).toHaveLength(8)
  })
  it('removes every occurrence and preserves the original order of all other entries', () => {
    const baseline = base()
    const uri = baseline.orderedEntries[0].sourceUri!
    const plan = buildApplyPlan(baseline, { [uri]: 'remove' }, 'remove-uri-groups')
    expect(plan.removedOccurrences).toBe(2)
    expect(plan.expectedOrderedEntries).toEqual(baseline.orderedEntries.filter((entry) => entry.sourceUri !== uri))
    expect(plan.blockedReasons).toEqual([])
  })
  it('keeps undecided and skipped tracks, including unavailable and local entries', () => {
    const mixed = demoFixtures()[1]
    const uri = mixed.orderedEntries[0].sourceUri!
    const plan = buildApplyPlan(mixed, { [uri]: 'skip' }, 'remove-uri-groups')
    expect(plan.expectedOrderedEntries).toEqual(mixed.orderedEntries)
    expect(buildApplyPlan(mixed, {}, 'create-clean-copy').blockedReasons.length).toBeGreaterThan(0)
  })
  it('blocks the entire operation if any occurrence has ambiguous identity', () => {
    const baseline = base()
    const uri = baseline.orderedEntries[0].sourceUri!
    baseline.orderedEntries[2].identityConfidence = 'ambiguous'
    expect(buildApplyPlan(baseline, { [uri]: 'remove' }, 'remove-uri-groups').blockedReasons).not.toEqual([])
  })
  it('does not confuse changing row indices or titles with a content conflict', () => {
    const baseline = base()
    const edited = baseline.orderedEntries.map((entry, index) => ({ ...entry, entryKey: `new-${index}`, originalIndex: index + 1, title: 'Renamed' }))
    expect(fingerprint(edited)).toBe(baseline.fingerprint)
    expect(fingerprint(edited.slice(1))).not.toBe(baseline.fingerprint)
  })
  it('preserves opaque entry counts and kinds in canonical comparisons', () => {
    const mixed = demoFixtures()[1].orderedEntries
    expect(fingerprint(mixed)).not.toBe(fingerprint(mixed.filter((entry) => entry.kind !== 'unavailable')))
  })
  it('keeps the first occurrence in a copy and honors removals before deduplication', () => {
    const baseline = base()
    const remove = baseline.orderedEntries[1].sourceUri!
    const plan = buildApplyPlan(baseline, { [remove]: 'remove' }, 'create-clean-copy')
    expect(plan.expectedOrderedEntries.map((e) => e.sourceUri)).toEqual(['demo:track:0', 'demo:track:2', 'demo:track:3', 'demo:track:4', 'demo:track:5'])
  })
  it('rejects a stale plan before mutation and verifies successful demo apply by reading back', async () => {
    const gateway = new DemoPlaylistGateway()
    const coordinator = new DemoApplyCoordinator(gateway)
    const baseline = await gateway.loadBaseline('night-drive')
    const plan = buildApplyPlan(baseline, { 'demo:track:0': 'remove' }, 'remove-uri-groups')
    const result = await coordinator.apply(plan)
    expect(result.state).toBe('complete')
    expect(result.baseline?.orderedEntries).toHaveLength(6)
    expect((await coordinator.apply(plan)).state).toBe('conflict')
  })
})
