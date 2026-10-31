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
  it('revokes playing evidence when the SDK loses the playback state', async () => {
    const notices: PlayerNotice[] = []
    const player = new BrowserPlayer(async () => 'fixture-token', (notice) => notices.push(notice))
    await player.connect()
    const sdk = FakePlayer.instances[0]
    sdk.emit('player_state_changed', { paused: false, track_window: { current_track: { uri: 'fixture' } } })
    sdk.emit('player_state_changed', null)
    expect(notices.at(-1)).toEqual({ state: 'idle' })
    player.disconnect()
  })
  it('ignores late ready after a failed connection and releases its timer', async () => {
    vi.useFakeTimers()
    Object.assign(window, { setTimeout, clearTimeout })
    const connect = vi.spyOn(FakePlayer.prototype, 'connect').mockResolvedValue(true)
    try {
      const notices: PlayerNotice[] = []
      const player = new BrowserPlayer(async () => 'fixture-token', (notice) => notices.push(notice))
      const assertion = expect(player.connect()).rejects.toThrow('не подключил плеер')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(20_000)
      await assertion
      FakePlayer.instances[0].emit('ready', { device_id: 'too-late' })
      expect(notices).toEqual([])
      expect(FakePlayer.instances[0].disconnect).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { connect.mockRestore(); vi.useRealTimers() }
  })
  it('cancels a pending connection immediately on disposal', async () => {
    const connect = vi.spyOn(FakePlayer.prototype, 'connect').mockResolvedValue(true)
    try {
      const player = new BrowserPlayer(async () => 'fixture-token', vi.fn())
      const assertion = expect(player.connect()).rejects.toThrow('отменено')
      await Promise.resolve()
      player.disconnect()
      await assertion
    } finally { connect.mockRestore() }
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
