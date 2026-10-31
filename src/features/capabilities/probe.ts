import { z } from 'zod'
import { canonical, SpotifyApi, SpotifyError } from '../../lib/spotify/api'

const KEY = 'jamify.capability.probe.v1'
const uriSchema = z.string().regex(/^spotify:track:[A-Za-z0-9]{22}$/)
const stateSchema = z.object({
  operationId: z.string(), accountId: z.string(), playlistId: z.string().nullable(),
  status: z.enum(['creating', 'seeding', 'seeded', 'deleting', 'verified', 'unknown']),
  uris: z.array(uriSchema).length(3), snapshotId: z.string().nullable(),
})
export type ProbeState = z.infer<typeof stateSchema>
export function trackUri(value: string): string {
  return uriSchema.parse(value.trim())
}

export class CapabilityProbe {
  constructor(private api: SpotifyApi, private storage: Storage) {}
  state(): ProbeState | null {
    const raw = this.storage.getItem(KEY)
    return raw ? stateSchema.parse(JSON.parse(raw)) : null
  }
  private save(state: ProbeState): void { this.storage.setItem(KEY, JSON.stringify(state)) }
  private async lock<T>(job: () => Promise<T>): Promise<T> {
    if (!navigator.locks) throw new Error('Для тестовой записи нужен браузер с Web Locks. Открой Jamify в Chrome.')
    return navigator.locks.request('jamify.capability-probe', { ifAvailable: true }, (lock) => {
      if (!lock) throw new Error('Проверка уже запущена в другой вкладке.')
      return job()
    })
  }

  async create(accountId: string, values: string[]): Promise<ProbeState> {
    const uris = z.array(uriSchema).length(3).parse(values.map((value) => value.trim()))
    if (new Set(uris).size !== 3) throw new Error('Для проверки выбери три разных трека.')
    return this.lock(async () => {
      if (this.state()) throw new Error('Тестовый плейлист уже создавался. Проверь его состояние; повторное создание отключено.')
      const user = await this.api.currentUser()
      if (user.id !== accountId) throw new Error('Аккаунт изменился. Начни подключение заново.')
      let state: ProbeState = { operationId: crypto.randomUUID(), accountId, playlistId: null, status: 'creating', uris, snapshotId: null }
      this.save(state)
      try {
        const created = z.object({ id: z.string(), snapshot_id: z.string() }).parse(await this.api.request('me/playlists', 'POST', {
          name: `Jamify — тест ${state.operationId.slice(0, 8)}`, public: false,
          description: 'Одноразовая проверка Jamify. Этот плейлист можно удалить после теста.',
        }))
        state = { ...state, playlistId: created.id, snapshotId: created.snapshot_id, status: 'seeding' }
        this.save(state)
        await this.api.request(`playlists/${encodeURIComponent(created.id)}/items`, 'POST', { uris: [uris[0], uris[1], uris[0], uris[2]] })
        const snapshot = await this.api.stableSnapshot(created.id, accountId)
        if (JSON.stringify(snapshot.items.map((item) => item.uri)) !== JSON.stringify([uris[0], uris[1], uris[0], uris[2]])) {
          throw new Error('Spotify вернул другие URI: возможно, сработала замена треков. Удаление теста заблокировано.')
        }
        state = { ...state, status: 'seeded', snapshotId: snapshot.playlist.snapshot_id }
        this.save(state)
        return state
      } catch (error) {
        this.save({ ...state, status: 'unknown' })
        throw error instanceof SpotifyError ? error : new Error('Проверка остановлена. Посмотри созданный тестовый плейлист в Spotify; повторная запись отключена.')
      }
    })
  }

  async removeDuplicateGroup(accountId: string): Promise<ProbeState> {
    return this.lock(async () => {
      const state = this.state()
      if (!state || state.status !== 'seeded' || !state.playlistId || state.accountId !== accountId) {
        throw new Error('Удаление доступно только для подготовленного тестового плейлиста этой вкладки.')
      }
      if ((await this.api.currentUser()).id !== accountId) throw new Error('Аккаунт изменился.')
      const before = await this.api.stableSnapshot(state.playlistId, accountId)
      const [a, b, c] = state.uris
      if (before.playlist.snapshot_id !== state.snapshotId || JSON.stringify(before.items.map((item) => item.uri)) !== JSON.stringify([a, b, a, c])) {
        throw new Error('Тестовый плейлист изменился. Удаление отменено.')
      }
      this.save({ ...state, status: 'deleting' })
      try {
        await this.api.request(`playlists/${encodeURIComponent(state.playlistId)}/items`, 'DELETE', {
          items: [{ uri: a }], snapshot_id: state.snapshotId,
        })
        const after = await this.api.stableSnapshot(state.playlistId, accountId)
        const expected = before.items.filter((item) => item.uri !== a)
        if (canonical(after.items) !== canonical(expected) || JSON.stringify(after.items.map((item) => item.uri)) !== JSON.stringify([b, c])) {
          throw new Error('Семантика удаления не совпала с ожидаемой. Проверь результат в Spotify.')
        }
        const done: ProbeState = { ...state, status: 'verified', snapshotId: after.playlist.snapshot_id }
        this.save(done)
        return done
      } catch (error) {
        this.save({ ...state, status: 'unknown' })
        if (error instanceof SpotifyError) throw error
        throw new Error('Результат тестовой записи требует проверки в Spotify. Автоматический повтор отключён.', { cause: error })
      }
    })
  }
}
