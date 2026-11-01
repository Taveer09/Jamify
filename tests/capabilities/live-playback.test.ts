import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpotifyPlaybackGateway } from '../../src/lib/playback/live'
import type { Entry, PlaybackState } from '../../src/contracts'
import type { SpotifyApi } from '../../src/lib/spotify/api'
class Player {
  static instances:Player[]=[]
  listeners=new Map<string,(value:unknown)=>void>()
  activateElement=vi.fn().mockResolvedValue(undefined)
  pause=vi.fn().mockResolvedValue(undefined)
  disconnect=vi.fn()
  constructor(){Player.instances.push(this)}
  addListener(name:string,fn:(value:unknown)=>void){this.listeners.set(name,fn);return true}
  emit(uri:string,paused=false){this.listeners.get('player_state_changed')?.({paused,position:1200,duration:180000,track_window:{current_track:{uri}}})}
  async connect(){queueMicrotask(()=>this.listeners.get('ready')?.({device_id:'fixture-device'}));return true}
}
const entry=(uri:string)=>({playbackUri:uri,durationMs:180000} as Entry)
beforeEach(()=>{Player.instances=[];vi.stubGlobal('window',{Spotify:{Player},setTimeout,clearTimeout})})
afterEach(()=>vi.unstubAllGlobals())
describe('live playback evidence and intent ordering',()=>{
  it('revokes prior confirmation when Spotify reports another playing or paused URI',async()=>{
    const request=vi.fn().mockResolvedValue(null),gateway=new SpotifyPlaybackGateway(async()=>'fixture',{request} as unknown as SpotifyApi)
    let state:PlaybackState|undefined;gateway.subscribe(value=>{state=value})
    gateway.select(entry('B'));await gateway.play()
    const sdk=Player.instances[0];sdk.emit('B');expect(state).toMatchObject({status:'playing',actualUri:'B'})
    sdk.emit('A');expect(state?.actualUri).toBeNull();expect(state?.status).not.toBe('playing')
    sdk.emit('B');sdk.emit('A',true);expect(state?.actualUri).toBeNull();expect(state?.status).not.toBe('playing')
    gateway.dispose();sdk.emit('B');expect(state?.actualUri).toBeNull()
  })
  it('consumes activation rejection when an immediate pause supersedes play',async()=>{
    const request=vi.fn().mockResolvedValue(null),gateway=new SpotifyPlaybackGateway(async()=>'fixture',{request} as unknown as SpotifyApi)
    gateway.select(entry('A'));await gateway.play()
    Player.instances[0].activateElement.mockRejectedValueOnce(new Error('fixture-activation-denied'))
    const pending=gateway.play();await gateway.pause();await pending
    expect(request).toHaveBeenCalledTimes(1)
    gateway.dispose()
  })
  it('serializes a stale request ahead of the latest selection and never confirms from HTTP alone',async()=>{
    let release!:()=>void
    const held=new Promise<void>(resolve=>{release=resolve})
    const request=vi.fn().mockImplementationOnce(()=>held).mockResolvedValue(null)
    const gateway=new SpotifyPlaybackGateway(async()=>'fixture',{request} as unknown as SpotifyApi)
    let state:PlaybackState|undefined;gateway.subscribe(value=>{state=value})
    gateway.select(entry('A'));const old=gateway.play()
    await vi.waitFor(()=>expect(request).toHaveBeenCalledTimes(1))
    gateway.select(entry('B'));const latest=gateway.play()
    Player.instances[0].emit('A');expect(state?.actualUri).toBeNull()
    release();await old;await latest
    expect(request.mock.calls.map(call=>call[2])).toEqual([{uris:['A']},{uris:['B']}])
    expect(state?.actualUri).toBeNull()
    Player.instances[0].emit('B');expect(state).toMatchObject({status:'playing',actualUri:'B'})
    gateway.dispose()
  })
})
