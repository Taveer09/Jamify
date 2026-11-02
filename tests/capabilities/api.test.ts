import { describe, expect, it, vi } from 'vitest'
import { apiUrl, canonical, parseObservedItem, SpotifyApi } from '../../src/lib/spotify/api'
import { json } from './helpers'

const meta = { id: 'playlist', name: 'Fixture playlist', snapshot_id: 'version1', owner: { id: 'account' }, collaborative: false }
const track = (uri: string) => ({ item: { type: 'track', uri, name: 'Fixture song' } })

describe('Spotify API capability contracts', () => {
  it.each(['https://evil.example/v1/me', '//evil.example/v1/me', 'https://api.spotify.com.evil.example/v1/me', 'https://api.spotify.com/outside'])('rejects credential forwarding to %s', (url) => {
    expect(() => apiUrl(url)).toThrow()
  })
  it('accepts both current item and legacy track envelopes without inventing linked_from', () => {
    expect(parseObservedItem(track('spotify:track:A')).linkedFromUri).toBeNull()
    expect(parseObservedItem({ track: { uri: 'spotify:track:B', type: 'track' } }).uri).toBe('spotify:track:B')
    expect(parseObservedItem({ item: null }).uri).toBeNull()
    expect(parseObservedItem({ item: null, track: { uri: 'should-not-win' } }).uri).toBeNull()
  })
  it('does not require product, country or email from the current user', async () => {
    const api = new SpotifyApi(async () => 'fixture', vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'account' })))
    expect(await api.currentUser()).toEqual({ id: 'account' })
  })
  it('loads every page and preserves duplicate and null entries', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(meta))
      .mockResolvedValueOnce(json({ items: [track('A'), { item: null }], next: 'https://api.spotify.com/v1/playlists/playlist/items?offset=2', total: 3 }))
      .mockResolvedValueOnce(json({ items: [track('A')], next: null, total: 3 }))
      .mockResolvedValueOnce(json(meta))
    const result = await new SpotifyApi(async () => 'fixture', fetcher).stableSnapshot('playlist', 'account')
    expect(result.items.map((item) => item.uri)).toEqual(['A', null, 'A'])
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it('rejects an off-origin pagination next before forwarding a token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ items: [], next: 'https://evil.example', total: 0 }))
    await expect(new SpotifyApi(async () => 'fixture', fetcher).ownPlaylists('account')).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('refuses a truncated result even when Spotify returned 200', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ items: [], next: null, total: 3 }))
    await expect(new SpotifyApi(async () => 'fixture', fetcher).ownPlaylists('account')).rejects.toThrow(/не все/)
  })
  it('refuses lists beyond the declared limit instead of silently truncating', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ items: [], next: null, total: 10_001 }))
    await expect(new SpotifyApi(async () => 'fixture', fetcher).ownPlaylists('account')).rejects.toThrow(/10 000/)
  })
  it('does not treat a changing snapshot as a stable baseline', async () => {
    const fetcher = vi.fn<typeof fetch>()
    for (let i = 0; i < 2; i++) {
      fetcher.mockResolvedValueOnce(json(meta)).mockResolvedValueOnce(json({ items: [], next: null, total: 0 }))
        .mockResolvedValueOnce(json({ ...meta, snapshot_id: 'changed' }))
    }
    await expect(new SpotifyApi(async () => 'fixture', fetcher).stableSnapshot('playlist', 'account')).rejects.toThrow(/меняется/)
    expect(fetcher).toHaveBeenCalledTimes(6)
  })
  it('does not read items of another owner or a collaborative playlist', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ ...meta, collaborative: true }))
    await expect(new SpotifyApi(async () => 'fixture', fetcher).stableSnapshot('playlist', 'account')).rejects.toThrow(/свои/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('preserves multiplicity and local entries in canonical comparison without mutable titles', () => {
    const a = parseObservedItem(track('A'))
    expect(canonical([a])).toBe(canonical([{ ...a, title: 'Renamed song' }]))
    expect(canonical([a, a])).not.toBe(canonical([a]))
    expect(canonical([{ ...a, isLocal: true }])).not.toBe(canonical([a]))
  })
  it('marks a network timeout after DELETE as ambiguous and never retries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('network diagnostic'))
    await expect(new SpotifyApi(async () => 'fixture', fetcher).request('playlists/fixture/items', 'DELETE', { items: [] }))
      .rejects.toMatchObject({ ambiguous: true, status: null })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('retains Retry-After without retrying a rate-limited mutation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}, 429, { 'Retry-After': '12' }))
    await expect(new SpotifyApi(async () => 'fixture', fetcher).request('playlists/fixture/items', 'POST', {}))
      .rejects.toMatchObject({ status: 429, retryAfter: 12 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('shows followed and collaborative lists without weakening the mutation probe owner gate', async () => {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(json({items:[meta,{...meta,id:'followed',owner:{id:'other'}},{...meta,id:'collab',owner:{id:'other'},collaborative:true}],next:null,total:3}))
    const lists=await new SpotifyApi(async ()=>'fixture',fetcher).libraryPlaylists('account')
    expect(lists.map(p=>[p.id,p.readable])).toEqual([['playlist',true],['followed',false],['collab',true]])
  })
  it('paginates all saved tracks and preserves artist, artwork and unavailable entries',async()=>{
    const fetcher=vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({items:[{track:{type:'track',uri:'A',name:'First',artists:[{name:'Artist'}],album:{images:[{url:'https://fixture.example/art.jpg'}]},duration_ms:123000}}],next:'https://api.spotify.com/v1/me/tracks?offset=1',total:2}))
      .mockResolvedValueOnce(json({items:[{track:null}],next:null,total:2}))
    const items=await new SpotifyApi(async ()=>'fixture',fetcher).savedTracks()
    expect(items[0]).toMatchObject({uri:'A',artist:'Artist',imageUrl:'https://fixture.example/art.jpg',durationMs:123000,canPlay:true})
    expect(items[1]).toMatchObject({uri:null,canPlay:false});expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('tries followed playlist reads and leaves the authorization verdict to Spotify',async()=>{
    const collaborative={...meta,collaborative:true,owner:{id:'other'}}
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json(collaborative)).mockResolvedValueOnce(json({items:[],next:null,total:0})).mockResolvedValueOnce(json(collaborative))
    expect((await new SpotifyApi(async ()=>'fixture',fetcher).reviewSnapshot('playlist')).items).toEqual([])
    const followedMeta={...meta,owner:{id:'other'}}
    const followed=vi.fn<typeof fetch>().mockResolvedValueOnce(json(followedMeta)).mockResolvedValueOnce(json({items:[track('A')],next:null,total:1})).mockResolvedValueOnce(json(followedMeta))
    expect((await new SpotifyApi(async ()=>'fixture',followed).reviewSnapshot('playlist')).items[0].uri).toBe('A')
    expect(followed).toHaveBeenCalledTimes(3)
  })

  it('rechecks playback intent after token refresh before dispatching a command',async()=>{
    let resolve!:(value:string)=>void;let current=true
    const fetcher=vi.fn<typeof fetch>(),token=new Promise<string>(done=>{resolve=done})
    const request=new SpotifyApi(()=>token,fetcher).request('me/player','PUT',{device_ids:['fixture']},()=>current)
    const rejected=expect(request).rejects.toMatchObject({name:'AbortError'})
    current=false;resolve('fixture');await rejected
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('preserves only safe reason codes while retaining a definite404 status',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(json({error:{status:404,reason:'NO_ACTIVE_DEVICE',message:'untrusted diagnostic'}},404))
    await expect(new SpotifyApi(async()=>'fixture',fetcher).request('me/player','PUT',{})).rejects.toMatchObject({status:404,reason:'NO_ACTIVE_DEVICE',ambiguous:false})
  })

})
