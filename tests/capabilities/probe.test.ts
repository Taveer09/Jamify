import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityProbe, trackUri } from '../../src/features/capabilities/probe'
import type { PlaylistSnapshot, SpotifyApi } from '../../src/lib/spotify/api'
import { MemoryStorage } from './helpers'

const a = `spotify:track:${'A'.repeat(22)}`
const b = `spotify:track:${'B'.repeat(22)}`
const c = `spotify:track:${'C'.repeat(22)}`
function snapshot(uris: string[], version = 'seeded'): PlaylistSnapshot {
  return {
    playlist: { id: 'disposable', name: 'Jamify test', snapshot_id: version, owner: { id: 'account' }, collaborative: false },
    items: uris.map((uri) => ({ uri, kind: 'track', isLocal: false, title: 'Fixture', linkedFromUri: null })),
  }
}
function setup() {
  const api = {
    currentUser: vi.fn().mockResolvedValue({ id: 'account' }),
    request: vi.fn().mockResolvedValue({ id: 'disposable', snapshot_id: 'empty' }),
    stableSnapshot: vi.fn().mockResolvedValue(snapshot([a, b, a, c])),
  }
  const storage = new MemoryStorage()
  const probe = new CapabilityProbe(api as unknown as SpotifyApi, storage)
  return { api, storage, probe }
}
beforeEach(() => vi.stubGlobal('navigator', {
  locks: { request: (_name: string, _options: unknown, job: (lock: object) => unknown) => job({}) },
}))
afterEach(() => vi.unstubAllGlobals())

describe('isolated disposable playlist probe', () => {
  it('accepts only Spotify track URIs', () => {
    expect(trackUri(a)).toBe(a)
    expect(() => trackUri('https://open.spotify.com/track/A')).toThrow()
    expect(() => trackUri('spotify:episode:AAAAAAAAAAAAAAAAAAAAAA')).toThrow()
  })
  it('refuses writes if Web Locks is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    const { probe, api } = setup()
    await expect(probe.create('account', [a, b, c])).rejects.toThrow(/Web Locks/)
    expect(api.request).not.toHaveBeenCalled()
  })
  it('refuses a second active tab before any network writes', async () => {
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, job: (lock: null) => unknown) => job(null) } })
    const { probe, api } = setup()
    await expect(probe.create('account', [a, b, c])).rejects.toThrow(/другой вкладке/)
    expect(api.request).not.toHaveBeenCalled()
  })
  it('creates a private disposable playlist and verifies A,B,A,C before enabling deletion', async () => {
    const { probe, api } = setup()
    expect((await probe.create('account', [a, b, c])).status).toBe('seeded')
    expect(api.request).toHaveBeenNthCalledWith(1, 'me/playlists', 'POST', expect.objectContaining({ public: false }))
    expect(api.request).toHaveBeenNthCalledWith(2, 'playlists/disposable/items', 'POST', { uris: [a, b, a, c] })
    await expect(probe.create('account', [a, b, c])).rejects.toThrow(/уже создавался/)
    expect(api.request).toHaveBeenCalledTimes(2)
  })
  it('refuses an arbitrary target when no disposable probe was created', async () => {
    const { probe, api } = setup()
    await expect(probe.removeDuplicateGroup('account')).rejects.toThrow(/только/)
    expect(api.request).not.toHaveBeenCalled()
  })
  it('does not write under another account', async () => {
    const { probe, api } = setup()
    api.currentUser.mockResolvedValue({ id: 'someone-else' })
    await expect(probe.create('account', [a, b, c])).rejects.toThrow(/изменился/)
    expect(api.request).not.toHaveBeenCalled()
  })
  it('preserves unknown and does not repeat create after a lost response, including after reload', async () => {
    const { probe, api, storage } = setup()
    api.request.mockRejectedValueOnce(new Error('connection interrupted'))
    await expect(probe.create('account', [a, b, c])).rejects.toThrow()
    expect(probe.state()?.status).toBe('unknown')
    const restored = new CapabilityProbe(api as unknown as SpotifyApi, storage)
    await expect(restored.create('account', [a, b, c])).rejects.toThrow(/уже создавался/)
    expect(api.request).toHaveBeenCalledTimes(1)
  })
  it('blocks deletion when seed URIs were substituted by Spotify', async () => {
    const { probe, api } = setup()
    api.stableSnapshot.mockResolvedValue(snapshot([c, b, c, a]))
    await expect(probe.create('account', [a, b, c])).rejects.toThrow()
    expect(probe.state()?.status).toBe('unknown')
    await expect(probe.removeDuplicateGroup('account')).rejects.toThrow(/только/)
    expect(api.request).toHaveBeenCalledTimes(2)
  })
  it('checks snapshot and contents immediately before test deletion', async () => {
    const { probe, api } = setup()
    await probe.create('account', [a, b, c])
    api.stableSnapshot.mockResolvedValue(snapshot([a, b, a, c], 'external-edit'))
    await expect(probe.removeDuplicateGroup('account')).rejects.toThrow(/изменился/)
    expect(api.request).toHaveBeenCalledTimes(2)
  })
  it('verifies B,C by reading back instead of trusting DELETE response', async () => {
    const { probe, api } = setup()
    await probe.create('account', [a, b, c])
    api.stableSnapshot.mockResolvedValueOnce(snapshot([a, b, a, c])).mockResolvedValueOnce(snapshot([b, c], 'after'))
    expect((await probe.removeDuplicateGroup('account')).status).toBe('verified')
    expect(api.request).toHaveBeenLastCalledWith('playlists/disposable/items', 'DELETE', { items: [{ uri: a }], snapshot_id: 'seeded' })
  })
  it('does not claim success when Spotify removes just one occurrence', async () => {
    const { probe, api } = setup()
    await probe.create('account', [a, b, c])
    api.stableSnapshot.mockResolvedValueOnce(snapshot([a, b, a, c])).mockResolvedValueOnce(snapshot([b, a, c], 'after'))
    await expect(probe.removeDuplicateGroup('account')).rejects.toThrow(/требует проверки/)
    expect(probe.state()?.status).toBe('unknown')
    await expect(probe.removeDuplicateGroup('account')).rejects.toThrow(/только/)
    expect(api.request).toHaveBeenCalledTimes(3)
  })
  it('aborts before create if the local journal cannot be saved', async () => {
    const { probe, api, storage } = setup()
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
    await expect(probe.create('account', [a, b, c])).rejects.toThrow(/quota/)
    expect(api.request).not.toHaveBeenCalled()
  })
})
