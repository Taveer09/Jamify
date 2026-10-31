import { z } from 'zod'
import { RequestTimeoutError, withRequestTimeout } from './request'

export const SCOPES = [
  'playlist-read-private', 'playlist-modify-private', 'playlist-modify-public',
  'streaming', 'user-read-playback-state', 'user-modify-playback-state',
  'user-read-private', 'user-read-email',
] as const

const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const TRANSACTION_KEY = 'jamify.oauth.transaction.v1'
const REFRESH_KEY = 'jamify.oauth.refresh.v1'
const transactionSchema = z.object({
  state: z.string(), verifier: z.string(), clientId: z.string(), redirectUri: z.string(),
  createdAt: z.number(),
})
const refreshSchema = z.object({ refreshToken: z.string(), clientId: z.string() })
const tokenSchema = z.object({
  access_token: z.string().min(1), expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(), token_type: z.literal('Bearer'),
  scope: z.string().optional(),
})

export type SpotifyConfig = { clientId: string; redirectUri: string }
type Fetcher = typeof fetch
type AuthOptions = { storage: Storage; fetcher?: Fetcher; clock?: () => number }

export function validateConfig(config: SpotifyConfig, origin: string): SpotifyConfig {
  if (!/^[a-fA-F0-9]{32}$/.test(config.clientId)) {
    throw new Error('Client ID должен содержать 32 символа. Найди его в настройках Spotify-приложения.')
  }
  const url = new URL(config.redirectUri)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.origin !== origin || url.pathname !== '/callback' || url.search || url.hash ||
    url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new Error('Redirect URI должен совпадать с адресом этого сайта и заканчиваться на /callback. Локально используй 127.0.0.1.')
  }
  return { clientId: config.clientId, redirectUri: url.href }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

export class SpotifyAuth {
  private storage: Storage
  private fetcher: Fetcher
  private clock: () => number
  private access: { token: string; expiresAt: number } | null = null
  private refreshing: Promise<string> | null = null
  private generation = 0

  constructor({ storage, fetcher = fetch, clock = Date.now }: AuthOptions) {
    this.storage = storage
    this.fetcher = fetcher
    this.clock = clock
  }

  hasSession(): boolean {
    return Boolean(this.access || this.storage.getItem(REFRESH_KEY))
  }

  async authorize(config: SpotifyConfig, origin: string): Promise<string> {
    const checked = validateConfig(config, origin)
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)))
    const state = base64url(crypto.getRandomValues(new Uint8Array(32)))
    const challenge = await challengeFor(verifier)
    this.storage.setItem(TRANSACTION_KEY, JSON.stringify({ ...checked, state, verifier, createdAt: this.clock() }))
    const url = new URL('https://accounts.spotify.com/authorize')
    url.search = new URLSearchParams({
      client_id: checked.clientId, response_type: 'code', redirect_uri: checked.redirectUri,
      scope: SCOPES.join(' '), state, code_challenge_method: 'S256', code_challenge: challenge,
    }).toString()
    return url.href
  }

  async complete(callbackUrl: string): Promise<void> {
    const raw = this.storage.getItem(TRANSACTION_KEY)
    // Consume the transaction before any network request: callbacks cannot be replayed.
    this.storage.removeItem(TRANSACTION_KEY)
    if (!raw) throw new Error('Вход устарел или уже завершён. Подключи Spotify ещё раз.')
    const transaction = transactionSchema.parse(JSON.parse(raw))
    const url = new URL(callbackUrl)
    const elapsed = this.clock() - transaction.createdAt
    if (elapsed < 0 || elapsed > 10 * 60_000 || url.searchParams.get('state') !== transaction.state ||
      `${url.origin}${url.pathname}` !== transaction.redirectUri) {
      this.logout()
      throw new Error('Не удалось проверить ответ Spotify. Начни вход заново.')
    }
    if (url.searchParams.has('error')) throw new Error('Доступ к Spotify не предоставлен. Можно попробовать ещё раз.')
    const code = url.searchParams.get('code')
    if (!code) throw new Error('Spotify не вернул код входа. Подключись ещё раз.')
    await this.exchange(new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: transaction.redirectUri,
      client_id: transaction.clientId, code_verifier: transaction.verifier,
    }), transaction.clientId)
  }

  async getAccessToken(): Promise<string> {
    if (this.access && this.access.expiresAt > this.clock() + 30_000) return this.access.token
    if (this.refreshing) return this.refreshing
    this.refreshing = this.refresh().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  private async refresh(): Promise<string> {
    const raw = this.storage.getItem(REFRESH_KEY)
    if (!raw) throw new Error('Подключи Spotify, чтобы продолжить.')
    const saved = refreshSchema.parse(JSON.parse(raw))
    return this.exchange(new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: saved.clientId,
    }), saved.clientId, saved.refreshToken)
  }

  private async exchange(body: URLSearchParams, clientId: string, previousRefresh?: string): Promise<string> {
    const generation = this.generation
    let result: { response: Response; body: unknown }
    try {
      result = await withRequestTimeout(async (signal) => {
        const response = await this.fetcher(TOKEN_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal,
        })
        return { response, body: response.ok ? await response.json() : null }
      })
    } catch (error) {
      if (error instanceof RequestTimeoutError) {
        throw new Error('Spotify не ответил за 20 секунд. Начни вход заново. Если это повторяется во встроенном браузере, открой Jamify в Safari или Chrome.', { cause: error })
      }
      if (error instanceof SyntaxError) throw new Error('Spotify вернул ответ в неожиданном формате. Начни вход заново.', { cause: error })
      throw new Error('Браузер не смог выполнить запрос входа к Spotify. Открой Jamify в Safari или Chrome и начни вход заново.', { cause: error })
    }
    const { response } = result
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) this.logout()
      throw new Error(`Spotify не подтвердил вход (HTTP ${response.status}). Подключи аккаунт ещё раз.`)
    }
    const parsed = tokenSchema.safeParse(result.body)
    if (!parsed.success) throw new Error('Spotify вернул неподдерживаемый ответ авторизации.')
    const token = parsed.data
    if (generation !== this.generation) throw new Error('Аккаунт отключён. Начни вход заново.')
    const refreshToken = token.refresh_token ?? previousRefresh
    if (!refreshToken) throw new Error('Spotify не вернул refresh token. Начни вход заново.')
    // Persist first; storage failure must not produce a false successful connection.
    this.storage.setItem(REFRESH_KEY, JSON.stringify({ refreshToken, clientId }))
    this.access = { token: token.access_token, expiresAt: this.clock() + token.expires_in * 1000 }
    return token.access_token
  }

  logout(): void {
    this.generation++
    this.access = null
    this.storage.removeItem(REFRESH_KEY)
    this.storage.removeItem(TRANSACTION_KEY)
  }
}
