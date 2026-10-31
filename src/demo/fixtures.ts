import type { Baseline, Entry } from '../contracts'
import { fingerprint } from '../domain/playlist'

const tracks = [
  ['After Hours', 'Jamify Lab', 'a', 'slate'],
  ['Open Window', 'Soft Circuit', 'b', 'citrus'],
  ['Slow Motion', 'Paper Satellites', 'c', 'rose'],
  ['City / 04:17', 'Jamify Lab', 'b', 'slate'],
  ['Almost Home', 'Soft Circuit', 'a', 'citrus'],
  ['Low Tide', 'Paper Satellites', 'c', 'rose'],
] as const
export function demoEntry(index: number): Entry {
  const [title, artist, , cover] = tracks[index % tracks.length]
  const uri = `demo:track:${index}`
  return {
    entryKey: `demo:${index}`, originalIndex: index, observedUri: uri, sourceUri: uri, playbackUri: uri,
    identityConfidence: 'confirmed', kind: 'track', title: index < tracks.length ? title : `${title} ${Math.floor(index / tracks.length) + 1}`,
    artist, imageUrl: `/demo/${cover}.svg`, spotifyUrl: null, durationMs: 8000,
    canPlay: true, canCopy: true, canRemove: true,
  }
}
function baseline(id: string, name: string, entries: Entry[]): Baseline {
  const orderedEntries = entries.map((entry, originalIndex) => ({ ...entry, originalIndex, entryKey: `${id}:${originalIndex}` }))
  return { accountId: 'demo-account', playlistId: id, playlistName: name, snapshotId: 'demo-v1', orderedEntries, fingerprint: fingerprint(orderedEntries) }
}
export function demoFixtures(): Baseline[] {
  const entries = tracks.map((_, index) => demoEntry(index))
  const mixed = [entries[0], { ...entries[1], sourceUri: null, observedUri: null, playbackUri: null, kind: 'unavailable' as const, identityConfidence: 'opaque' as const, title: 'Недоступная запись', canPlay: false, canCopy: false, canRemove: false },
    { ...entries[2], kind: 'local' as const, sourceUri: null, observedUri: 'spotify:local:fixture', playbackUri: null, identityConfidence: 'opaque' as const, title: 'Локальная запись', canPlay: false, canCopy: false, canRemove: false },
    { ...entries[3], kind: 'episode' as const, sourceUri: 'demo:episode:1', observedUri: 'demo:episode:1', playbackUri: null, title: 'Эпизод подкаста', canPlay: false }]
  return [
    baseline('night-drive', 'Ночная прогулка', [entries[0], entries[1], entries[0], entries[2], entries[3], entries[1], entries[4], entries[5]]),
    baseline('mixed', 'Особенные записи', mixed),
    baseline('empty', 'Чистый лист', []),
    baseline('large', 'Большая коллекция', Array.from({ length: 10_000 }, (_, index) => demoEntry(index % 3200))),
  ]
}
export function demoSample(entry: Entry): string {
  const index = Number(entry.sourceUri?.split(':').at(-1)) || 0
  return `/demo/${tracks[index % tracks.length][2]}.wav`
}
