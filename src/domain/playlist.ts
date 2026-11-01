import type { ApplyPlan, Baseline, CanonicalItem, Decision, Entry } from '../contracts'

export function canonicalEntries(entries: Entry[]): CanonicalItem[] {
  return entries.map((entry) => ({
    kind: entry.kind,
    identity: entry.sourceUri ?? entry.observedUri,
    visibility: entry.sourceUri || entry.observedUri ? 'identified' : 'opaque',
  }))
}
// Exact canonical serialization deliberately avoids hash collisions. Presentation,
// snapshot versions and shifting entry indices do not affect content equality.
export function fingerprint(entries: Entry[]): string { return JSON.stringify(canonicalEntries(entries)) }
export function uniqueReviewEntries(entries: Entry[]): Entry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const uri = entry.sourceUri
    if (!uri || entry.kind !== 'track' || !entry.canPlay || seen.has(uri)) return false
    seen.add(uri)
    return true
  })
}
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    state += 0x6d2b79f5
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    const index = Math.floor(((t ^ (t >>> 14)) >>> 0) / 4294967296 * (i + 1))
    ;[result[i], result[index]] = [result[index], result[i]]
  }
  return result
}
export function buildApplyPlan(baseline: Baseline, decisions: Record<string, Decision>, mode: ApplyPlan['mode'], operationId: string = crypto.randomUUID()): ApplyPlan {
  const blockedReasons = new Set<string>()
  const groups = new Map<string, Entry[]>()
  for (const entry of baseline.orderedEntries) {
    if (!entry.sourceUri) continue
    const group = groups.get(entry.sourceUri)
    if (group) group.push(entry)
    else groups.set(entry.sourceUri, [entry])
  }
  const requested = Object.entries(decisions).filter(([, decision]) => decision === 'remove').map(([uri]) => uri)
  for (const uri of requested) {
    const group = groups.get(uri)
    if (!group || group.some((entry) => entry.identityConfidence !== 'confirmed' || !entry.canRemove)) {
      blockedReasons.add('Удаление заблокировано: исходная идентичность выбранной группы не подтверждена.')
    }
  }
  const removeUris = requested.filter((uri) => groups.has(uri))
  const remove = new Set(removeUris)
  const seen = new Set<string>()
  const kept = baseline.orderedEntries.filter((entry) => {
    if (entry.sourceUri && remove.has(entry.sourceUri)) return false
    if (mode !== 'create-clean-copy') return true
    if (!entry.canCopy || !entry.sourceUri || entry.identityConfidence !== 'confirmed') {
      blockedReasons.add('Копию нельзя создать без потерь: есть локальные, недоступные или неоднозначные записи.')
      return true
    }
    if (seen.has(entry.sourceUri)) return false
    seen.add(entry.sourceUri)
    return true
  })
  return {
    operationId, accountId: baseline.accountId, playlistId: baseline.playlistId, playlistName: baseline.playlistName,
    baselineFingerprint: baseline.fingerprint, snapshotId: baseline.snapshotId, mode, removeUris,
    expectedOrderedEntries: kept, expectedCanonical: canonicalEntries(kept),
    removedOccurrences: baseline.orderedEntries.length - kept.length, blockedReasons: [...blockedReasons],
    draftRevision: null, runId: null,
  }
}
