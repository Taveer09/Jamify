import { z } from 'zod'
import type { SpotifyApi } from '../spotify/api'

interface SdkPlayer {
  addListener(event: string, callback: (value: unknown) => void): boolean
  connect(): Promise<boolean>
  disconnect(): void
  activateElement(): Promise<void>
  pause(): Promise<void>
}
interface Sdk {
  Player: new (options: { name: string; getOAuthToken: (callback: (token: string) => void) => void; volume: number }) => SdkPlayer
}
declare global {
  interface Window {
    Spotify?: Sdk
    onSpotifyWebPlaybackSDKReady?: () => void
  }
}
export type PlayerNotice = { state: 'idle' | 'ready' | 'playing' | 'paused' | 'error'; uri?: string; message?: string }
let sdkPromise: Promise<Sdk> | null = null

function loadSdk(): Promise<Sdk> {
  if (window.Spotify) return Promise.resolve(window.Spotify)
  if (sdkPromise) return sdkPromise
  sdkPromise = new Promise<Sdk>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Плеер Spotify не загрузился. Проверь браузер и подключение.')), 20_000)
    window.onSpotifyWebPlaybackSDKReady = () => {
      window.clearTimeout(timer)
      if (window.Spotify) resolve(window.Spotify)
      else reject(new Error('Spotify SDK недоступен.'))
    }
    const script = document.createElement('script')
    script.src = 'https://sdk.scdn.co/spotify-player.js'
    script.onerror = () => { window.clearTimeout(timer); reject(new Error('Не удалось загрузить Spotify SDK.')) }
    document.head.append(script)
  }).catch((error: unknown) => { sdkPromise = null; throw error })
  return sdkPromise
}

export class BrowserPlayer {
  private player: SdkPlayer | null = null
  private deviceId: string | null = null
  private disposed = false
  private cancelConnect: (() => void) | null = null
  constructor(private token: () => Promise<string>, private notify: (notice: PlayerNotice) => void) {}

  async connect(): Promise<void> {
    const sdk = await loadSdk()
    if (this.disposed) return
    const player = new sdk.Player({
      name: 'Jamify — проверка подключения', volume: 0.3,
      getOAuthToken: (callback) => {
        if (this.disposed) return
        void this.token().then((token) => { if (!this.disposed) callback(token) })
          .catch(() => { if (!this.disposed) this.notify({ state: 'error', message: 'Подключи аккаунт заново.' }) })
      },
    })
    this.player = player
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Spotify не подключил плеер. Проверь Premium и браузер.')), 20_000)
      this.cancelConnect = () => {
        window.clearTimeout(timer)
        reject(new Error('Подключение плеера отменено.'))
      }
      player.addListener('ready', (value) => {
        if (this.disposed) return
        const data = z.object({ device_id: z.string() }).safeParse(value)
        if (!data.success) return
        window.clearTimeout(timer)
        this.cancelConnect = null
        this.deviceId = data.data.device_id
        this.notify({ state: 'ready' })
        resolve()
      })
      player.addListener('not_ready', () => {
        if (this.disposed) return
        this.deviceId = null
        this.notify({ state: 'error', message: 'Устройство Spotify отключено.' })
      })
      for (const event of ['initialization_error', 'authentication_error', 'account_error', 'playback_error', 'autoplay_failed']) {
        player.addListener(event, () => {
          window.clearTimeout(timer)
          const error = new Error(event === 'account_error' ? 'Для плеера нужен Spotify Premium.' : 'Spotify не смог запустить плеер. Попробуй подключить его заново.')
          if (!this.disposed) this.notify({ state: 'error', message: error.message })
          reject(error)
        })
      }
      player.addListener('player_state_changed', (value) => {
        if (this.disposed) return
        const data = z.object({ paused: z.boolean(), track_window: z.object({ current_track: z.object({ uri: z.string() }) }) }).safeParse(value)
        if (data.success) this.notify({ state: data.data.paused ? 'paused' : 'playing', uri: data.data.track_window.current_track.uri })
        else this.notify({ state: 'idle' })
      })
      void player.connect().then((connected) => {
        if (!connected) { window.clearTimeout(timer); reject(new Error('Spotify не подключил устройство.')) }
      }).catch((error: unknown) => { window.clearTimeout(timer); reject(error) })
    }).catch((error: unknown) => { this.disconnect(); throw error })
  }

  async play(uri: string, api: SpotifyApi): Promise<void> {
    if (!this.player || !this.deviceId) throw new Error('Сначала подключи плеер.')
    // Called synchronously from a click, before the first await (browser autoplay policy).
    const activation = this.player.activateElement()
    await activation
    if (this.disposed || !this.player || !this.deviceId) throw new Error('Плеер отключён. Подключи его заново.')
    await api.request(`me/player/play?device_id=${encodeURIComponent(this.deviceId)}`, 'PUT', { uris: [uri] })
  }
  async pause(): Promise<void> { await this.player?.pause() }
  disconnect(): void {
    this.disposed = true
    this.cancelConnect?.(); this.cancelConnect = null
    this.player?.disconnect(); this.player = null; this.deviceId = null
  }
}
