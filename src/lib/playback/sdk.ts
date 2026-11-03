import { z } from 'zod'
import { failureFor, PlaybackFailure } from './failure'
import type { SpotifyApi } from '../spotify/api'

interface SdkPlayer {
  addListener(event: string, callback: (value: unknown) => void): boolean
  connect(): Promise<boolean>
  disconnect(): void
  activateElement(): Promise<void>
  pause(): Promise<void>
  getCurrentState?(): Promise<unknown>
  resume?(): Promise<void>
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
type SdkErrorCode = 'initialization_error'|'authentication_error'|'account_error'|'playback_error'|'autoplay_failed'
export type PlayerNotice = { code?: SdkErrorCode; state: 'idle' | 'ready' | 'playing' | 'paused' | 'error'; uri?: string; message?: string; positionMs?: number; durationMs?: number }
async function bounded<T>(promise:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new PlaybackFailure({stage:'sdk',status:null,reason:'SDK_TIMEOUT'})),10_000)})])}
  catch(error){if(error instanceof PlaybackFailure)throw error;throw new PlaybackFailure({stage:'sdk',status:null,reason:'SDK_REJECTED'})}
  finally{clearTimeout(timer)}
}
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
  private active = false
  constructor(private token: () => Promise<string>, private notify: (notice: PlayerNotice) => void) {}

  async connect(): Promise<void> {
    const sdk = await loadSdk()
    if (this.disposed) return
    const player = new sdk.Player({
      name: 'Jamify', volume: 0.3,
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
        if(this.deviceId!==data.data.device_id)this.active=false
        this.deviceId = data.data.device_id
        this.notify({ state: 'ready' })
        resolve()
      })
      player.addListener('not_ready', () => {
        if (this.disposed) return
        this.deviceId = null
        this.active = false
        this.notify({ state: 'error', message: 'Устройство Spotify отключено.' })
      })
      for (const event of ['initialization_error', 'authentication_error', 'account_error', 'playback_error', 'autoplay_failed'] as const) {
        player.addListener(event, () => {
          window.clearTimeout(timer)
          const error = new Error(event === 'account_error' ? 'Для плеера нужен Spotify Premium.' : 'Spotify не смог запустить плеер. Попробуй подключить его заново.')
          if (!this.disposed) this.notify({ state: 'error', code:event, message: event==='autoplay_failed'?'Браузер ждёт нажатия. Нажми «Подключить звук».':error.message })
          reject(error)
        })
      }
      player.addListener('player_state_changed', (value) => {
        if (this.disposed) return
        const data = z.object({ paused: z.boolean(), position: z.number().optional(), duration: z.number().optional(), track_window: z.object({ current_track: z.object({ uri: z.string() }) }) }).safeParse(value)
        if (data.success) this.notify({ state: data.data.paused ? 'paused' : 'playing', uri: data.data.track_window.current_track.uri, ...(data.data.position === undefined ? {} : { positionMs: data.data.position }), ...(data.data.duration === undefined ? {} : { durationMs: data.data.duration }) })
        else this.notify({ state: 'idle' })
      })
      void player.connect().then((connected) => {
        if (!connected) { window.clearTimeout(timer); reject(new Error('Spotify не подключил устройство.')) }
      }).catch((error: unknown) => { window.clearTimeout(timer); reject(error) })
    }).catch((error: unknown) => { this.disconnect(); throw error })
  }

  activate(): Promise<void> { return bounded(this.player?.activateElement() ?? Promise.resolve()) }

  async play(uri: string, api: SpotifyApi, isCurrent: () => boolean = () => true): Promise<void> {
    if (!this.player || !this.deviceId) throw new Error('Сначала подключи плеер.')
    // Called synchronously from a click, before the first await (browser autoplay policy).
    const instance=this.player,deviceId=this.deviceId
    const activation = bounded(instance.activateElement())
    await activation
    const mayDispatch = () => !this.disposed && this.player===instance && this.deviceId===deviceId && isCurrent()
    if (!mayDispatch()) return
    // Local SDK evidence can resume this exact loaded track without another Web API start.
    if (this.player?.getCurrentState && this.player.resume) {
      const local = z.object({paused:z.boolean(),position:z.number().optional(),duration:z.number().optional(),track_window:z.object({current_track:z.object({uri:z.string()})})}).safeParse(await bounded(this.player.getCurrentState()))
      if (!mayDispatch()) return
      if (local.success && local.data.track_window.current_track.uri === uri) {
        if (local.data.paused) await bounded(this.player.resume())
        else this.notify({state:'playing',uri,positionMs:local.data.position,durationMs:local.data.duration})
        return
      }
    }
    const command = async (stage:'transfer'|'state'|'start', path:string, method:string, body?:unknown) => {
      try { return await api.request(path,method,body,mayDispatch) }
      catch(error) {
        if (!mayDispatch()) throw error
        const failure=failureFor(stage,error)
        if(failure.diagnostic.status===404){
          try {
            const result=z.object({devices:z.array(z.object({id:z.string().nullable(),is_restricted:z.boolean().optional()}))}).safeParse(await api.request('me/player/devices','GET',undefined,mayDispatch))
            if(result.success){
              const own=result.data.devices.find(device=>device.id===deviceId)
              throw new PlaybackFailure({...failure.diagnostic,deviceVisible:Boolean(own),deviceRestricted:own?.is_restricted},!own)
            }
          } catch(readError) { if(readError instanceof PlaybackFailure)throw readError }
        }
        throw failure
      }
    }
    if (!this.active) {
      // SDK ready registers a Connect device; transfer makes it the playback target.
      // Transfer once, then poll reads only. Never repeat an uncertain player command.
      await command('transfer','me/player','PUT',{device_ids:[deviceId],play:false})
      for (let attempt = 0; attempt < 6; attempt++) {
        if (!mayDispatch()) return
        const state = z.object({ device: z.object({ id: z.string().nullable(), is_active: z.boolean() }).nullable().optional() }).nullable()
          .safeParse(await command('state','me/player','GET'))
        if (!mayDispatch()) return
        if (state.success && state.data?.device?.id === deviceId && state.data.device.is_active) { this.active = true; break }
        if (attempt < 5) await new Promise<void>((resolve) => window.setTimeout(resolve, 300))
      }
      if (!this.active) throw new Error('Spotify ещё не подключил звук. Нажми «Подключить звук» ещё раз.')
    }
    if (!mayDispatch()) return
    try {
      await command('start',`me/player/play?device_id=${encodeURIComponent(deviceId)}`,'PUT',{uris:[uri]})
    } catch (error) {
      this.active = false
      throw error
    }
  }
  async pause(): Promise<void> { await bounded(this.player?.pause()??Promise.resolve()) }
  disconnect(): void {
    this.disposed = true
    this.cancelConnect?.(); this.cancelConnect = null
    this.player?.disconnect(); this.player = null; this.deviceId = null
    this.active = false
  }
}
