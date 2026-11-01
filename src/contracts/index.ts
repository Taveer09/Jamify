export type Entry = {
  entryKey: string
  originalIndex: number
  observedUri: string | null
  sourceUri: string | null
  playbackUri: string | null
  identityConfidence: 'confirmed' | 'ambiguous' | 'opaque'
  kind: 'track' | 'episode' | 'local' | 'unavailable'
  title: string
  artist: string
  imageUrl: string | null
  spotifyUrl: string | null
  durationMs: number | null
  canPlay: boolean
  canCopy: boolean
  canRemove: boolean
}
export type CanonicalItem = { kind: Entry['kind']; identity: string | null; visibility: 'identified' | 'opaque' }
export type Baseline = {
  accountId: string; playlistId: string; playlistName: string; snapshotId: string
  orderedEntries: Entry[]; fingerprint: string
}
export type PlaylistSummary = { id: string; name: string; count: number }
export type Decision = 'keep' | 'remove' | 'skip'
export type ReviewSession = {
  schemaVersion: 1; accountId: string; playlistId: string; runId: string
  reviewedUris: string[]; baselineSnapshotId: string; baselineFingerprint: string
  seed: number; queue: string[]; cursor: number; decisions: Record<string, Decision>
  history: Array<{ uri: string; before?: Decision; after: Decision }>
}
export type ApplyPlan = {
  operationId: string; accountId: string; playlistId: string; playlistName: string
  baselineFingerprint: string; snapshotId: string
  mode: 'remove-uri-groups' | 'create-clean-copy'; removeUris: string[]
  expectedOrderedEntries: Entry[]; expectedCanonical: CanonicalItem[]
  removedOccurrences: number; blockedReasons: string[]
  draftRevision: number | null; runId: string | null
}
export type ApplyState = 'idle' | 'preflight' | 'applying' | 'reconciling' | 'complete' | 'conflict' | 'partial' | 'unknown'
export type ApplyResult = { state: ApplyState; baseline?: Baseline; targetBaseline?: Baseline; message: string; targetPlaylistId?: string; session?: ReviewSession; draftRevision?: number }
export type MutationJournal = {
  schemaVersion: 1; operationId: string; accountId: string; sourcePlaylistId: string
  plan: ApplyPlan; state: ApplyState; confirmedPrefix: number
  pendingBatch: { uris: string[]; snapshotId: string; before: CanonicalItem[]; after: CanonicalItem[] } | null
  sessionFinalized: boolean; revision: number; updatedAt: number; message: string
  targetPlaylistId: string | null; pendingCreate: boolean
  expectedSnapshotId: string
  retryAt: number | null
}
export interface PlaylistGateway {
  currentAccount(): Promise<string>
  listPlaylists(): Promise<PlaylistSummary[]>
  loadBaseline(playlistId: string): Promise<Baseline>
  removeUriGroups(playlistId: string, uris: string[], snapshotId: string): Promise<void>
  createPrivatePlaylist(name: string): Promise<string>
  appendItems(playlistId: string, uris: string[]): Promise<void>
}
export interface ApplyCoordinator {
  apply(plan: ApplyPlan): Promise<ApplyResult>
}
export type PlaybackState = {
  requestedUri: string | null; actualUri: string | null; generation: number
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error'
  positionMs: number; durationMs: number; message?: string
}
export interface PlaybackGateway {
  select(entry: Entry): void
  play(): Promise<void>
  pause(): void | Promise<void>
  seek(positionMs: number): void | Promise<void>
  subscribe(listener: (state: PlaybackState) => void): () => void
  dispose(): void
}
