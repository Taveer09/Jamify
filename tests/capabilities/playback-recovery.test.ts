import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {BrowserPlayer} from '../../src/lib/playback/sdk'
import {SpotifyPlaybackGateway} from '../../src/lib/playback/live'
import {SpotifyError} from '../../src/lib/spotify/api'
import type {SpotifyApi} from '../../src/lib/spotify/api'
import type {Entry,PlaybackState} from '../../src/contracts'
class Player{
 static all:Player[]=[]
 listeners=new Map<string,(value:unknown)=>void>()
 state:{paused:boolean;position?:number;duration?:number;track_window:{current_track:{uri:string}}}|null=null
 activateElement=vi.fn().mockResolvedValue(undefined)
 pause=vi.fn().mockResolvedValue(undefined)
 seek=vi.fn(async(position:number)=>{if(this.state){this.state={...this.state,position};this.emit('player_state_changed',this.state)}})
 disconnect=vi.fn()
 getCurrentState=vi.fn(async()=>this.state)
 resume=vi.fn(async()=>{if(this.state){this.state={...this.state,paused:false};this.emit('player_state_changed',this.state)}})
 constructor(){Player.all.push(this)}
 addListener(event:string,callback:(value:unknown)=>void){this.listeners.set(event,callback);return true}
 emit(event:string,value:unknown={}){this.listeners.get(event)?.(value)}
 async connect(){queueMicrotask(()=>this.emit('ready',{device_id:'own'}));return true}
}
const request=()=>vi.fn().mockImplementation(async(path:string,method:string)=>path==='me/player'&&method==='GET'?{device:{id:'own',is_active:true}}:null)
const api=(fn:ReturnType<typeof request>)=>({request:fn} as unknown as SpotifyApi)
const local=(paused:boolean)=>({paused,track_window:{current_track:{uri:'requested'}}})
beforeEach(()=>{Player.all=[];vi.stubGlobal('window',{Spotify:{Player},setTimeout,clearTimeout})})
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
describe('playback recovery using real SDK adapter',()=>{
 it.each([true,false])('uses matching local SDK state paused=%s without REST start',async(paused)=>{
  const notices:unknown[]=[],sdk=new BrowserPlayer(async()=>'fixture',notice=>notices.push(notice));await sdk.connect()
  const player=Player.all[0];player.state=local(paused);const calls=request()
  await sdk.play('requested',api(calls))
  expect(calls).not.toHaveBeenCalled();expect(player.resume).toHaveBeenCalledTimes(paused?1:0)
  expect(notices.at(-1)).toMatchObject({state:'playing',uri:'requested'});sdk.disconnect()
 })
 it('does not fall through to a REST command after a rejected resume',async()=>{
  const sdk=new BrowserPlayer(async()=>'fixture',vi.fn());await sdk.connect();Player.all[0].state=local(true)
  Player.all[0].resume.mockRejectedValueOnce(new Error('fixture rejection'));const calls=request()
  await expect(sdk.play('requested',api(calls))).rejects.toMatchObject({diagnostic:{stage:'sdk',reason:'SDK_REJECTED'}});expect(calls).not.toHaveBeenCalled();sdk.disconnect()
 })
 it('preserves the original phase when a diagnostic devices read fails',async()=>{
  const sdk=new BrowserPlayer(async()=>'fixture',vi.fn());await sdk.connect()
  const calls=request().mockImplementation(async(path:string,method:string)=>{if(path==='me/player'&&method==='GET')throw new SpotifyError(404,null,false);if(path==='me/player/devices')throw new SpotifyError(403,null,false);return null})
  await expect(sdk.play('requested',api(calls))).rejects.toMatchObject({diagnostic:{stage:'state',status:404},reconnect:false});sdk.disconnect()
 })
 it('invalidates a captured device ID replaced during transfer',async()=>{
  const sdk=new BrowserPlayer(async()=>'fixture',vi.fn());await sdk.connect();let release!:()=>void
  const gate=new Promise<void>(done=>{release=done}),calls=request().mockImplementation(async()=>gate)
  const playing=sdk.play('requested',api(calls));await vi.waitFor(()=>expect(calls).toHaveBeenCalledTimes(1))
  Player.all[0].emit('ready',{device_id:'replacement'});release();await playing
  expect(calls).toHaveBeenCalledTimes(1);sdk.disconnect()
 })
 it('preserves the ready SDK after autoplay denial and activates synchronously on the next click',async()=>{
  const gateway=new SpotifyPlaybackGateway(async()=>'fixture',api(request()));let state:PlaybackState|undefined
  gateway.subscribe(next=>{state=next});gateway.select({playbackUri:'requested'} as Entry);await gateway.play()
  const player=Player.all[0];player.emit('autoplay_failed');expect(state?.diagnostic?.reason).toBe('autoplay_failed')
  player.state=local(true);const before=player.activateElement.mock.calls.length;const playing=gateway.play()
  expect(player.activateElement).toHaveBeenCalledTimes(before+1);await playing
  expect(Player.all).toHaveLength(1);expect(state).toMatchObject({status:'playing',actualUri:'requested'});gateway.dispose()
 })
 it('bounds missing SDK confirmation and ignores late playing after explicit pause',async()=>{
  vi.useFakeTimers();Object.assign(window,{setTimeout,clearTimeout})
  const gateway=new SpotifyPlaybackGateway(async()=>'fixture',api(request()));let state:PlaybackState|undefined
  gateway.subscribe(next=>{state=next});gateway.select({playbackUri:'requested'} as Entry);await gateway.play()
  await vi.advanceTimersByTimeAsync(10_000);expect(state).toMatchObject({status:'error',diagnostic:{stage:'confirm'}})
  await gateway.pause();Player.all[0].emit('player_state_changed',local(false));expect(state?.status).toBe('paused');gateway.dispose();expect(vi.getTimerCount()).toBe(0)
 })
 it('null SDK events cannot disable the missing-confirmation deadline',async()=>{
  vi.useFakeTimers();Object.assign(window,{setTimeout,clearTimeout})
  const gateway=new SpotifyPlaybackGateway(async()=>'fixture',api(request()));let state:PlaybackState|undefined
  gateway.subscribe(value=>{state=value});gateway.select({playbackUri:'requested'} as Entry);await gateway.play()
  Player.all[0].emit('player_state_changed',null)
  expect(state?.status).toBe('loading');await vi.advanceTimersByTimeAsync(10_000)
  expect(state?.diagnostic?.stage).toBe('confirm');gateway.dispose()
 })
 it('a never-settling SDK state read has a deadline and does not issue REST commands',async()=>{
  vi.useFakeTimers();Object.assign(window,{setTimeout,clearTimeout})
  const sdk=new BrowserPlayer(async()=>'fixture',vi.fn());await sdk.connect()
  Player.all[0].getCurrentState.mockImplementationOnce(()=>new Promise(()=>{}));const calls=request()
  const playing=expect(sdk.play('requested',api(calls))).rejects.toMatchObject({diagnostic:{reason:'SDK_TIMEOUT'}})
  await vi.advanceTimersByTimeAsync(10_000);await playing;expect(calls).not.toHaveBeenCalled();sdk.disconnect()
 })
 it('never-settling pause is bounded and cannot permanently occupy the queue',async()=>{
  vi.useFakeTimers();Object.assign(window,{setTimeout,clearTimeout})
  const sdk=new BrowserPlayer(async()=>'fixture',vi.fn());await sdk.connect()
  Player.all[0].pause.mockImplementationOnce(()=>new Promise(()=>{}))
  const paused=expect(sdk.pause()).rejects.toMatchObject({diagnostic:{reason:'SDK_TIMEOUT'}})
  await vi.advanceTimersByTimeAsync(10_000);await paused
  const calls=request();await sdk.play('requested',api(calls));expect(calls).toHaveBeenCalled();sdk.disconnect()
 })
 it('a replacement device ID invalidates earlier activation',async()=>{
  const sdk=new BrowserPlayer(async()=>'fixture',vi.fn());await sdk.connect();const calls=request()
  await sdk.play('first',api(calls));Player.all[0].emit('ready',{device_id:'replacement'})
  calls.mockImplementation(async(path:string,method:string)=>path==='me/player'&&method==='GET'?{device:{id:'replacement',is_active:true}}:null)
  await sdk.play('second',api(calls))
  expect(calls.mock.calls.filter(call=>call[0]==='me/player'&&call[1]==='PUT').map(call=>call[2])).toEqual([{device_ids:['own'],play:false},{device_ids:['replacement'],play:false}]);sdk.disconnect()
 })

 it('reset during pending SDK load cannot mark a disposed connection ready',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve})
  const connect=vi.spyOn(BrowserPlayer.prototype,'connect').mockImplementationOnce(()=>gate)
  const calls=request(),gateway=new SpotifyPlaybackGateway(async()=>'fixture',api(calls));let state:PlaybackState|undefined
  gateway.subscribe(value=>{state=value});gateway.select({playbackUri:'requested'} as Entry)
  const first=gateway.play();await vi.waitFor(()=>expect(connect).toHaveBeenCalledTimes(1))
  const reset=gateway.reconnect();release();await first;await reset
  expect(connect).toHaveBeenCalledTimes(2);expect(calls.mock.calls.some(call=>String(call[0]).includes('/play?'))).toBe(true)
  expect(state?.status).not.toBe('error');gateway.dispose();connect.mockRestore()
 })

 it('advances time between SDK snapshots and stops on pause',async()=>{
  vi.useFakeTimers();Object.assign(window,{setTimeout,clearTimeout})
  const gateway=new SpotifyPlaybackGateway(async()=>'fixture',api(request()));let state:PlaybackState|undefined
  gateway.subscribe(value=>{state=value});gateway.select({playbackUri:'requested',durationMs:180000} as Entry);await gateway.play()
  const sdk=Player.all[0];sdk.state={...local(false),position:1000,duration:180000};sdk.emit('player_state_changed',sdk.state)
  await vi.advanceTimersByTimeAsync(2500);expect(state?.positionMs).toBeGreaterThanOrEqual(3250)
  await gateway.pause();const stopped=state?.positionMs;await vi.advanceTimersByTimeAsync(2000);expect(state?.positionMs).toBe(stopped)
  gateway.dispose();expect(vi.getTimerCount()).toBe(0)
 })
 it('revokes playing evidence when a local SDK poll loses state',async()=>{
  vi.useFakeTimers();Object.assign(window,{setTimeout,clearTimeout})
  const gateway=new SpotifyPlaybackGateway(async()=>'fixture',api(request()));let state:PlaybackState|undefined
  gateway.subscribe(value=>{state=value});gateway.select({playbackUri:'requested',durationMs:180000} as Entry);await gateway.play()
  Player.all[0].emit('player_state_changed',{...local(false),position:1000,duration:180000})
  await vi.advanceTimersByTimeAsync(1000);expect(state?.actualUri).toBeNull();expect(state?.status).toBe('idle');gateway.dispose()
 })
 it('seeks only the same SDK track and ignores an older poll after seek',async()=>{
  vi.useFakeTimers();Object.assign(window,{setTimeout,clearTimeout})
  const calls=request(),gateway=new SpotifyPlaybackGateway(async()=>'fixture',api(calls));let state:PlaybackState|undefined
  gateway.subscribe(value=>{state=value});gateway.select({playbackUri:'requested',durationMs:180000} as Entry);await gateway.play()
  const sdk=Player.all[0];sdk.state={...local(false),position:1000,duration:180000};sdk.emit('player_state_changed',sdk.state)
  let release!:(value:Player['state'])=>void;const stale=new Promise<Player['state']>(resolve=>{release=resolve})
  sdk.getCurrentState.mockImplementationOnce(()=>stale);await vi.advanceTimersByTimeAsync(1000)
  await gateway.seek(45000)
  expect(sdk.seek).toHaveBeenCalledWith(45000);const position=state?.positionMs
  release({...local(false),position:1000,duration:180000});await vi.advanceTimersByTimeAsync(100)
  expect(state?.positionMs).toBe(position);expect(calls.mock.calls.some(call=>String(call[0]).includes('/seek'))).toBe(false);gateway.dispose()
 })
 it('cancelled seek after device replacement never publishes its target',async()=>{
  const gateway=new SpotifyPlaybackGateway(async()=>'fixture',api(request()));let state:PlaybackState|undefined
  gateway.subscribe(value=>{state=value});gateway.select({playbackUri:'requested',durationMs:180000} as Entry);await gateway.play()
  const sdk=Player.all[0];sdk.state={...local(false),position:1000,duration:180000};sdk.emit('player_state_changed',sdk.state)
  let release!:(value:Player['state'])=>void;const held=new Promise<Player['state']>(resolve=>{release=resolve})
  sdk.getCurrentState.mockImplementationOnce(()=>held);const seek=gateway.seek(45000)
  await Promise.resolve();await Promise.resolve();sdk.emit('ready',{device_id:'replacement'});release(sdk.state)
  await seek;expect(sdk.seek).not.toHaveBeenCalled();expect(state?.positionMs).not.toBe(45000);gateway.dispose()
 })
 it.each([180000,40000])('intro skipping respects track duration %s',async(durationMs)=>{
  const calls=request(),gateway=new SpotifyPlaybackGateway(async()=>'fixture',api(calls))
  gateway.setSkipIntro(true);gateway.select({playbackUri:'requested',durationMs} as Entry);await gateway.play()
  expect(calls.mock.calls.find(call=>String(call[0]).includes('/play?'))?.[2]).toEqual({uris:['requested'],...(durationMs>45000?{position_ms:30000}:{})});gateway.dispose()
 })

 it('does not poll fresh SDK state while a seek is pending',async()=>{
  vi.useFakeTimers();Object.assign(window,{setTimeout,clearTimeout})
  const gateway=new SpotifyPlaybackGateway(async()=>'fixture',api(request()));gateway.select({playbackUri:'requested',durationMs:180000} as Entry);await gateway.play()
  const sdk=Player.all[0];sdk.state={...local(false),position:1000,duration:180000};sdk.emit('player_state_changed',sdk.state)
  let release!:()=>void;const held=new Promise<void>(done=>{release=done});sdk.seek.mockImplementationOnce(async()=>held)
  const seek=gateway.seek(45000);await vi.advanceTimersByTimeAsync(0)
  const reads=sdk.getCurrentState.mock.calls.length;await vi.advanceTimersByTimeAsync(2500)
  expect(sdk.getCurrentState.mock.calls.length).toBe(reads)
  release();await seek;gateway.dispose()
 })

})
