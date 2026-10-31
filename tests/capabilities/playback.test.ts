import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPlayer } from '../../src/lib/playback/sdk'
import type { PlayerNotice } from '../../src/lib/playback/sdk'
import type { SpotifyApi } from '../../src/lib/spotify/api'

class FakePlayer {
  static instances: FakePlayer[] = []
  private listeners = new Map<string, (value: unknown) => void>()
  disconnect = vi.fn()
  activateElement = vi.fn().mockResolvedValue(undefined)
  pause = vi.fn().mockResolvedValue(undefined)
  constructor(public options: { getOAuthToken: (callback: (token: string) => void) => void }) { FakePlayer.instances.push(this) }
  addListener(event: string, callback: (value: unknown) => void) { this.listeners.set(event, callback); return true }
  emit(event: string, value: unknown = {}) { this.listeners.get(event)?.(value) }
  async connect() { queueMicrotask(() => this.emit('ready', { device_id: 'fixture-device' })); return true }
}
beforeEach(() => {
  FakePlayer.instances = []
  vi.stubGlobal('window', { Spotify: { Player: FakePlayer }, setTimeout, clearTimeout })
})
afterEach(() => vi.unstubAllGlobals())

describe('browser playback capability contracts', () => {
  it('does not claim playing just because the SDK is connected', async () => {
    const notices: PlayerNotice[] = []
    const player = new BrowserPlayer(async () => 'fixture-token', (notice) => notices.push(notice))
    await player.connect()
    expect(notices).toEqual([{ state: 'ready' }])
    player.disconnect()
  })
  it('reports the actual URI received from the SDK', async () => {
    const notices: PlayerNotice[] = []
    const player = new BrowserPlayer(async () => 'fixture-token', (notice) => notices.push(notice))
    await player.connect()
    FakePlayer.instances[0].emit('player_state_changed', { paused: false, track_window: { current_track: { uri: 'spotify:track:actual' } } })
    expect(notices.at(-1)).toEqual({ state: 'playing', uri: 'spotify:track:actual' })
    player.disconnect()
  })
  it('ignores late not_ready and playback events from an old disconnected player', async () => {
    const notices: PlayerNotice[] = []
    const first = new BrowserPlayer(async () => 'fixture-token', (notice) => notices.push(notice))
    await first.connect()
    const oldSdk = FakePlayer.instances[0]
    first.disconnect()
    const second = new BrowserPlayer(async () => 'fixture-token', (notice) => notices.push(notice))
    await second.connect()
    const count = notices.length
    oldSdk.emit('not_ready')
    oldSdk.emit('player_state_changed', { paused: false, track_window: { current_track: { uri: 'old' } } })
    expect(notices).toHaveLength(count)
    expect(notices.at(-1)?.state).toBe('ready')
    second.disconnect()
  })
  it('does not hand an access token to a disposed SDK instance', async () => {
    let resolveToken: ((token: string) => void) | undefined
    const token = vi.fn(() => new Promise<string>((resolve) => { resolveToken = resolve }))
    const player = new BrowserPlayer(token, vi.fn())
    await player.connect()
    const callback = vi.fn()
    FakePlayer.instances[0].options.getOAuthToken(callback)
    player.disconnect()
    resolveToken!('fixture-token')
    await Promise.resolve()
    expect(callback).not.toHaveBeenCalled()
  })
  it('activates the browser element before dispatching a play command and waits for SDK evidence', async () => {
    const notices: PlayerNotice[] = []
    const player = new BrowserPlayer(async () => 'fixture-token', (notice) => notices.push(notice))
    await player.connect()
    const request = vi.fn().mockResolvedValue(null)
    const playing = player.play('spotify:track:requested', { request } as unknown as SpotifyApi)
    expect(FakePlayer.instances[0].activateElement).toHaveBeenCalledTimes(1)
    await playing
    expect(request).toHaveBeenCalledWith('me/player/play?device_id=fixture-device', 'PUT', { uris: ['spotify:track:requested'] })
    expect(notices).toEqual([{ state: 'ready' }])
    player.disconnect()
  })
})
