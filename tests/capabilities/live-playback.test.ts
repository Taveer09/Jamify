import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpotifyPlaybackGateway } from '../../src/lib/playback/live'
import type { Entry, PlaybackState } from '../../src/contracts'
import { SpotifyError } from '../../src/lib/spotify/api'
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
const active={device:{id:'fixture-device',is_active:true}}
const available=()=>vi.fn().mockImplementation(async(path:string,method='GET')=>path==='me/player'&&method==='GET'?active:null)
const entry=(uri:string)=>({playbackUri:uri,durationMs:180000} as Entry)
beforeEach(()=>{Player.instances=[];vi.stubGlobal('window',{Spotify:{Player},setTimeout,clearTimeout})})
afterEach(()=>vi.unstubAllGlobals())
describe('live playback evidence and intent ordering',()=>{
  it('revokes prior confirmation when Spotify reports another playing or paused URI',async()=>{
    const request=available(),gateway=new SpotifyPlaybackGateway(async()=>'fixture',{request} as unknown as SpotifyApi)
    let state:PlaybackState|undefined;gateway.subscribe(value=>{state=value})
    gateway.select(entry('B'));await gateway.play()
    const sdk=Player.instances[0];sdk.emit('B');expect(state).toMatchObject({status:'playing',actualUri:'B'})
    sdk.emit('A');expect(state?.actualUri).toBeNull();expect(state?.status).not.toBe('playing')
    sdk.emit('B');sdk.emit('A',true);expect(state?.actualUri).toBeNull();expect(state?.status).not.toBe('playing')
    gateway.dispose();sdk.emit('B');expect(state?.actualUri).toBeNull()
  })
  it('consumes activation rejection when an immediate pause supersedes play',async()=>{
    const request=available(),gateway=new SpotifyPlaybackGateway(async()=>'fixture',{request} as unknown as SpotifyApi)
    gateway.select(entry('A'));await gateway.play()
    Player.instances[0].activateElement.mockRejectedValueOnce(new Error('fixture-activation-denied'))
    const pending=gateway.play();await gateway.pause();await pending
    expect(request).toHaveBeenCalledTimes(3)
    gateway.dispose()
  })
  it('serializes a stale request ahead of the latest selection and never confirms from HTTP alone',async()=>{
    let release!:()=>void
    const held=new Promise<void>(resolve=>{release=resolve})
    let firstPlay=true
    const request=available().mockImplementation(async(path:string,method='GET')=>{
      if(path==='me/player'&&method==='GET')return active
      if(path.includes('/play?')&&firstPlay){firstPlay=false;await held}
      return null
    })
    const gateway=new SpotifyPlaybackGateway(async()=>'fixture',{request} as unknown as SpotifyApi)
    let state:PlaybackState|undefined;gateway.subscribe(value=>{state=value})
    gateway.select(entry('A'));const old=gateway.play()
    await vi.waitFor(()=>expect(request.mock.calls.some(call=>String(call[0]).includes('/play?'))).toBe(true))
    gateway.select(entry('B'));const latest=gateway.play()
    Player.instances[0].emit('A');expect(state?.actualUri).toBeNull()
    release();await old;await latest
    expect(request.mock.calls.filter(call=>String(call[0]).includes('/play?')).map(call=>call[2])).toEqual([{uris:['A']},{uris:['B']}])
    expect(state?.actualUri).toBeNull()
    Player.instances[0].emit('B');expect(state).toMatchObject({status:'playing',actualUri:'B'})
    gateway.dispose()
  })
  it('retains the SDK device after404 and only transfers again on a new explicit play',async()=>{
    let fail=true
    const request=available().mockImplementation(async(path:string,method='GET')=>{
      if(path==='me/player'&&method==='GET')return active
      if(path.includes('/play?')&&fail)throw new SpotifyError(404,null,false,'NO_ACTIVE_DEVICE')
      return null
    })
    const gateway=new SpotifyPlaybackGateway(async()=>'fixture',{request} as unknown as SpotifyApi)
    let state:PlaybackState|undefined;gateway.subscribe(value=>{state=value})
    gateway.select(entry('A'));await gateway.play()
    expect(state).toMatchObject({status:'error',actualUri:null,message:'Spotify не нашёл плеер. Подключи звук ещё раз.'})
    expect(Player.instances).toHaveLength(1);expect(Player.instances[0].disconnect).not.toHaveBeenCalled()
    expect(request.mock.calls.filter(call=>String(call[0]).includes('/play?'))).toHaveLength(1)
    fail=false;await gateway.play()
    expect(Player.instances).toHaveLength(1)
    expect(request.mock.calls.filter(call=>call[0]==='me/player'&&call[1]==='PUT')).toHaveLength(2)
    Player.instances[0].emit('A');expect(state).toMatchObject({status:'playing',actualUri:'A'})
    gateway.dispose()
  })
  it('does not start a track after the user cancels while transfer is pending',async()=>{
    let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve})
    const request=available().mockImplementation(async(path:string,method='GET')=>{
      if(path==='me/player'&&method==='PUT')await held
      return path==='me/player'&&method==='GET'?active:null
    })
    const gateway=new SpotifyPlaybackGateway(async()=>'fixture',{request} as unknown as SpotifyApi)
    gateway.select(entry('A'));const playing=gateway.play()
    await vi.waitFor(()=>expect(request).toHaveBeenCalledTimes(1))
    const paused=gateway.pause();release();await playing;await paused
    expect(request.mock.calls.map(call=>call.slice(0,2))).toEqual([['me/player','PUT']])
    gateway.dispose()
  })
  it('polls readiness without repeating transfer or claiming playback before the device is active',async()=>{
    const request=available().mockImplementation(async()=>null)
    const gateway=new SpotifyPlaybackGateway(async()=>'fixture',{request} as unknown as SpotifyApi)
    let state:PlaybackState|undefined;gateway.subscribe(value=>{state=value})
    gateway.select(entry('A'));await gateway.play()
    expect(request.mock.calls.filter(call=>call[1]==='PUT')).toHaveLength(1)
    expect(request.mock.calls.filter(call=>call[1]==='GET')).toHaveLength(6)
    expect(state?.status).toBe('error');expect(state?.actualUri).toBeNull()
    gateway.dispose()
  })

  it.each(['transfer','readiness'])('SDK error during %s cancels the pending start',async(phase)=>{
    let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve})
    let entered=false
    const request=available().mockImplementation(async(path:string,method='GET')=>{
      if(path==='me/player'&&((phase==='transfer'&&method==='PUT')||(phase==='readiness'&&method==='GET'))){entered=true;await held}
      return path==='me/player'&&method==='GET'?active:null
    })
    const gateway=new SpotifyPlaybackGateway(async()=>'fixture',{request} as unknown as SpotifyApi)
    let state:PlaybackState|undefined;gateway.subscribe(value=>{state=value})
    gateway.select(entry('A'));const playing=gateway.play()
    await vi.waitFor(()=>expect(entered).toBe(true))
    Player.instances[0].listeners.get('authentication_error')?.({})
    release();await playing
    expect(request.mock.calls.some(call=>String(call[0]).includes('/play?'))).toBe(false)
    expect(state?.status).toBe('error')
    gateway.dispose()
  })
  it('pauses the SDK immediately while a readiness read is still pending',async()=>{
    let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve})
    let reading=false
    const request=available().mockImplementation(async(path:string,method='GET')=>{
      if(path==='me/player'&&method==='GET'){reading=true;await held;return active}
      return null
    })
    const gateway=new SpotifyPlaybackGateway(async()=>'fixture',{request} as unknown as SpotifyApi)
    gateway.select(entry('A'));const playing=gateway.play()
    await vi.waitFor(()=>expect(reading).toBe(true))
    const paused=gateway.pause()
    expect(Player.instances[0].pause).toHaveBeenCalled()
    release();await playing;await paused
    expect(request.mock.calls.some(call=>String(call[0]).includes('/play?'))).toBe(false)
    gateway.dispose()
  })

})
