import { z } from 'zod'
import { withRequestTimeout } from './request'

const API = 'https://api.spotify.com/v1/'
const ownerSchema = z.object({ id: z.string() })
const playlistSchema = z.object({
  id: z.string(), name: z.string(), snapshot_id: z.string(), owner: ownerSchema,
  collaborative: z.boolean(), external_urls: z.object({ spotify: z.string() }).optional(),
})
export type SpotifyPlaylist = z.infer<typeof playlistSchema>
export type ObservedItem = {
  uri: string | null; kind: 'track' | 'episode' | 'unknown'; isLocal: boolean;
  title: string; linkedFromUri: string | null;
  artist?: string; imageUrl?: string | null; durationMs?: number | null; canPlay?: boolean; spotifyUrl?: string | null;
}
export type PlaylistSnapshot = { playlist: SpotifyPlaylist; items: ObservedItem[] }

export class SpotifyError extends Error {
  readonly status: number | null
  readonly retryAfter: number | null
  readonly ambiguous: boolean
  constructor(status: number | null, retryAfter: number | null, ambiguous: boolean) {
    const hint = status === 403 ? 'Проверь Premium, allowlist и разрешения приложения.'
      : status === 429 ? 'Лимит запросов. Повтори проверку позже.'
        : status === 401 ? 'Подключи Spotify ещё раз.'
          : ambiguous ? 'Результат записи неизвестен. Сначала проверь тестовый плейлист в Spotify.'
            : 'Не удалось получить данные Spotify. Попробуй позже.'
    super(`${status ? `Spotify: HTTP ${status}. ` : ''}${hint}`)
    this.status = status
    this.retryAfter = retryAfter
    this.ambiguous = ambiguous
  }
}

export function apiUrl(path: string): string {
  const url = new URL(path, API)
  if (url.origin !== new URL(API).origin || !url.pathname.startsWith('/v1/') || url.username || url.password || url.hash) {
    throw new Error('Неподдерживаемый адрес Spotify API.')
  }
  return url.href
}

function safeHttps(value?: string): string | null { return value?.startsWith('https://') ? value : null }

export type LibraryPlaylist = { id: string; name: string; ownerId: string; collaborative: boolean; imageUrl: string | null; count: number | null; readable: boolean }

export function parseObservedItem(value: unknown): ObservedItem {
  const envelope = z.record(z.string(), z.unknown()).parse(value)
  const raw = Object.hasOwn(envelope, 'item') ? envelope.item : envelope.track
  const item = z.object({
    uri: z.string().nullable().optional(), type: z.string().optional(), name: z.string().optional(),
    artists: z.array(z.object({ name: z.string() })).optional(),
    album: z.object({ images: z.array(z.object({ url: z.string() })).optional() }).optional(),
    images: z.array(z.object({ url: z.string() })).optional(),
    duration_ms: z.number().nonnegative().optional(), is_playable: z.boolean().optional(),
    restrictions: z.object({ reason: z.string() }).optional(),
    external_urls: z.object({ spotify: z.string() }).optional(),
    is_local: z.boolean().optional(), linked_from: z.object({ uri: z.string() }).optional(),
  }).nullable().parse(raw ?? null)
  return {
    uri: item?.uri ?? null,
    kind: item?.type === 'track' || item?.type === 'episode' ? item.type : 'unknown',
    isLocal: Boolean(envelope.is_local || item?.is_local), title: item?.name ?? 'Недоступная запись',
    linkedFromUri: item?.linked_from?.uri ?? null,
    artist: item?.artists?.map((artist) => artist.name).join(', ') || '',
    imageUrl: safeHttps(item?.album?.images?.[0]?.url ?? item?.images?.[0]?.url),
    durationMs: item?.duration_ms ?? null,
    canPlay: Boolean(item?.uri && item.type === 'track' && !envelope.is_local && !item.is_local && item.is_playable !== false && !item.restrictions),
    spotifyUrl: item?.external_urls?.spotify?.startsWith('https://open.spotify.com/') ? item.external_urls.spotify : null,
  }
}

export function canonical(items: ObservedItem[]): string {
  return JSON.stringify(items.map(({ uri, kind, isLocal }) => [kind, uri, isLocal]))
}

export class SpotifyApi {
  constructor(private token: () => Promise<string>, private fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const url = apiUrl(path)
    const accessToken = await this.token()
    let result: { response: Response; body: unknown }
    try {
      result = await withRequestTimeout(async (signal) => {
        const response = await this.fetcher(url, {
          method, headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body), signal,
        })
        return { response, body: response.ok && response.status !== 204 ? await response.json() : null }
      })
    } catch {
      throw new SpotifyError(null, null, method !== 'GET')
    }
    const { response } = result
    if (!response.ok) {
      const header = response.headers.get('Retry-After')
      const seconds = header === null ? NaN : Number(header)
      throw new SpotifyError(response.status, Number.isFinite(seconds) ? seconds : null, method !== 'GET' && response.status >= 500)
    }
    return result.body
  }

  async currentUser(): Promise<{ id: string; display_name?: string | null }> {
    return z.object({ id: z.string(), display_name: z.string().nullable().optional() }).parse(await this.request('me'))
  }

  private async collect(path: string): Promise<unknown[]> {
    const all: unknown[] = []
    const visited = new Set<string>()
    let next: string | null = path
    while (next) {
      const url = apiUrl(next)
      if (visited.has(url)) throw new Error('Spotify повторил страницу. Загрузка остановлена.')
      visited.add(url)
      const page = z.object({ items: z.array(z.unknown()), next: z.string().nullable(), total: z.number().int().nonnegative() })
        .parse(await this.request(url))
      if (page.total > 10_000 || all.length + page.items.length > 10_000) {
        throw new Error('Первая версия поддерживает до 10 000 записей. Выбери плейлист поменьше.')
      }
      all.push(...page.items)
      if (page.items.length === 0 && page.next) throw new Error('Spotify вернул пустую промежуточную страницу.')
      next = page.next
      if (!next && all.length !== page.total) throw new Error('Загружены не все записи. Обнови плейлист.')
    }
    return all
  }

  async ownPlaylists(accountId: string): Promise<Array<{ id: string; name: string }>> {
    const summaries = await this.collect('me/playlists?limit=50')
    return summaries.map((raw) => z.object({ id: z.string(), name: z.string(), owner: ownerSchema, collaborative: z.boolean() }).parse(raw))
      .filter((p) => p.owner.id === accountId && !p.collaborative)
  }

  async libraryPlaylists(accountId: string): Promise<LibraryPlaylist[]> {
    const rows = await this.collect('me/playlists?limit=50')
    return rows.map((raw) => {
      const p = z.object({ id: z.string(), name: z.string(), owner: ownerSchema,
        collaborative: z.boolean(), images: z.array(z.object({ url: z.string() })).nullable().optional(),
        items: z.object({ total: z.number().int().nonnegative() }).optional(),
        tracks: z.object({ total: z.number().int().nonnegative() }).optional(),
      }).parse(raw)
      return { id: p.id, name: p.name, ownerId: p.owner.id, collaborative: p.collaborative,
        imageUrl: safeHttps(p.images?.[0]?.url), count: p.items?.total ?? p.tracks?.total ?? null,
        readable: p.owner.id === accountId || p.collaborative }
    })
  }

  async reviewSnapshot(id: string, accountId: string): Promise<PlaylistSnapshot> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await this.playlist(id)
      if (before.owner.id !== accountId && !before.collaborative) throw new Error('Spotify разрешает читать треки только в своих и совместных плейлистах. Этот плейлист виден в медиатеке, но его треки недоступны приложению.')
      const items = (await this.collect(`playlists/${encodeURIComponent(id)}/items?limit=50&additional_types=track,episode`)).map(parseObservedItem)
      const after = await this.playlist(id)
      if (after.owner.id !== accountId && !after.collaborative) throw new Error('Доступ к плейлисту изменился.')
      if (before.snapshot_id === after.snapshot_id) return { playlist: after, items }
    }
    throw new Error('Плейлист меняется во время загрузки. Попробуй ещё раз.')
  }

  async savedTracks(): Promise<ObservedItem[]> {
    return (await this.collect('me/tracks?limit=50')).map(parseObservedItem)
  }

  async playlist(id: string): Promise<SpotifyPlaylist> {
    return playlistSchema.parse(await this.request(`playlists/${encodeURIComponent(id)}`))
  }

  async stableSnapshot(id: string, accountId: string): Promise<PlaylistSnapshot> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await this.playlist(id)
      if (before.owner.id !== accountId || before.collaborative) throw new Error('Доступны только свои плейлисты без совместного редактирования.')
      const items = (await this.collect(`playlists/${encodeURIComponent(id)}/items?limit=50&additional_types=track,episode`)).map(parseObservedItem)
      const after = await this.playlist(id)
      if (after.owner.id !== accountId || after.collaborative) throw new Error('Права плейлиста изменились.')
      if (before.snapshot_id === after.snapshot_id) return { playlist: after, items }
    }
    throw new Error('Плейлист меняется во время загрузки. Попробуй, когда редактирование закончится.')
  }
}
