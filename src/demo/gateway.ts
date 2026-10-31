import type { ApplyCoordinator, ApplyPlan, ApplyResult, Baseline, PlaylistGateway } from '../contracts'
import { fingerprint } from '../domain/playlist'
import { demoFixtures } from './fixtures'

export class DemoPlaylistGateway implements PlaylistGateway {
  private playlists = new Map(demoFixtures().map((baseline) => [baseline.playlistId, baseline]))
  async currentAccount() { return 'demo-account' }
  async listPlaylists() { return [...this.playlists.values()].map((b) => ({ id: b.playlistId, name: b.playlistName, count: b.orderedEntries.length })) }
  async loadBaseline(playlistId: string): Promise<Baseline> {
    const baseline = this.playlists.get(playlistId)
    if (!baseline) throw new Error('Демо-плейлист не найден.')
    return structuredClone(baseline)
  }
  async removeUriGroups(playlistId: string, uris: string[], snapshotId: string): Promise<void> {
    const baseline = await this.loadBaseline(playlistId)
    if (baseline.snapshotId !== snapshotId) throw new Error('Версия плейлиста изменилась.')
    const remove = new Set(uris)
    this.store({ ...baseline, orderedEntries: baseline.orderedEntries.filter((entry) => !entry.sourceUri || !remove.has(entry.sourceUri)) })
  }
  async createPrivatePlaylist(name: string): Promise<string> {
    const id = `demo-copy-${crypto.randomUUID()}`
    this.store({ accountId: 'demo-account', playlistId: id, playlistName: name, snapshotId: '0', orderedEntries: [], fingerprint: '[]' })
    return id
  }
  async appendItems(playlistId: string, uris: string[]): Promise<void> {
    const baseline = await this.loadBaseline(playlistId)
    const known = [...this.playlists.values()].flatMap((b) => b.orderedEntries)
    const entries = uris.map((uri) => {
      const entry = known.find((item) => item.sourceUri === uri)
      if (!entry?.canCopy) throw new Error('Демо-запись нельзя скопировать.')
      return entry
    })
    this.store({ ...baseline, orderedEntries: [...baseline.orderedEntries, ...entries] })
  }
  private store(baseline: Baseline) {
    const orderedEntries = baseline.orderedEntries.map((entry, index) => ({ ...entry, originalIndex: index, entryKey: `${baseline.playlistId}:${index}` }))
    this.playlists.set(baseline.playlistId, { ...baseline, orderedEntries, fingerprint: fingerprint(orderedEntries), snapshotId: crypto.randomUUID() })
  }
}

// S1 only: the in-memory adapter has no network uncertainty. The durable live
// coordinator and its mutation journal are implemented separately at S4.
export class DemoApplyCoordinator implements ApplyCoordinator {
  constructor(private gateway: PlaylistGateway) {}
  async apply(plan: ApplyPlan): Promise<ApplyResult> {
    if (plan.blockedReasons.length) return { state: 'conflict', message: plan.blockedReasons.join(' ') }
    if (await this.gateway.currentAccount() !== plan.accountId) return { state: 'conflict', message: 'Аккаунт изменился.' }
    const before = await this.gateway.loadBaseline(plan.playlistId)
    if (before.fingerprint !== plan.baselineFingerprint || before.snapshotId !== plan.snapshotId) return { state: 'conflict', message: 'Плейлист изменился. Обнови предпросмотр.' }
    if (plan.mode === 'create-clean-copy') return { state: 'conflict', message: 'Демо S1 проверяет удаление; создание очищенной копии появится на S6.' }
    await this.gateway.removeUriGroups(plan.playlistId, plan.removeUris, plan.snapshotId)
    const after = await this.gateway.loadBaseline(plan.playlistId)
    if (after.fingerprint !== fingerprint(plan.expectedOrderedEntries)) return { state: 'unknown', message: 'Результат не совпал с планом.' }
    return { state: 'complete', baseline: after, message: 'Демо-изменения проверены повторным чтением.' }
  }
}
