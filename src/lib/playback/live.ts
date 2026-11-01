import type { Entry, PlaybackGateway, PlaybackState } from '../../contracts'
import { BrowserPlayer } from './sdk'
import type { PlayerNotice } from './sdk'
import type { SpotifyApi } from '../spotify/api'

export class SpotifyPlaybackGateway implements PlaybackGateway {
  private state:PlaybackState={requestedUri:null,actualUri:null,generation:0,status:'idle',positionMs:0,durationMs:0}
  private listeners=new Set<(state:PlaybackState)=>void>()
  private player:BrowserPlayer|null=null
  private ready=false
  private disposed=false
  private desired=false
  private intent=0
  private serial=Promise.resolve()
  constructor(private token:()=>Promise<string>,private api:SpotifyApi){}
  private publish(patch:Partial<PlaybackState>){this.state={...this.state,...patch};for(const fn of this.listeners)fn({...this.state})}
  private enqueue(job:()=>Promise<void>){const result=this.serial.then(job);this.serial=result.catch(()=>{});return result}
  private notice=(notice:PlayerNotice)=>{
    if(this.disposed)return
    if(notice.state==='error'){this.ready=false;this.publish({status:'error',actualUri:null,message:notice.message});return}
    if(notice.state==='playing'){
      if(this.desired&&notice.uri===this.state.requestedUri)this.publish({status:'playing',actualUri:notice.uri,positionMs:notice.positionMs??0,durationMs:notice.durationMs??this.state.durationMs,message:undefined})
      else this.publish({status:'idle',actualUri:null,message:'Spotify сообщает о другом треке. Нажми «Слушать», чтобы включить текущий.'})
      return
    }
    if(notice.state==='paused')this.publish({status:'paused',actualUri:null,...(notice.uri===this.state.requestedUri?{positionMs:notice.positionMs??this.state.positionMs}:{})})
    if(notice.state==='idle')this.publish({status:'idle',actualUri:null})
  }
  select(entry:Entry){
    if(this.disposed)return
    this.intent++;this.desired=false
    this.publish({requestedUri:entry.playbackUri,actualUri:null,generation:this.state.generation+1,status:'idle',positionMs:0,durationMs:entry.durationMs??0,message:undefined})
    void this.enqueue(async()=>{if(this.ready)await this.player?.pause()}).catch(()=>{})
  }
  async play(){
    if(this.disposed||!this.state.requestedUri)return
    this.desired=true
    const intent=++this.intent,uri=this.state.requestedUri
    // Preserve the immediate user activation before entering the serialized queue.
    const activation=(this.ready?this.player!.activate():Promise.resolve()).then(()=>({ok:true as const}),error=>({ok:false as const,error}))
    this.publish({status:'loading',actualUri:null,message:undefined})
    try{
      await this.enqueue(async()=>{
        if(this.disposed||intent!==this.intent)return
        if(!this.ready){
          this.player?.disconnect()
          this.player=new BrowserPlayer(this.token,this.notice)
          await this.player.connect();this.ready=true
        }
        const activated=await activation
        if(!activated.ok)throw activated.error
        if(this.disposed||intent!==this.intent||!this.desired)return
        await this.player!.play(uri,this.api)
      })
    }catch(error){if(!this.disposed&&intent===this.intent){this.ready=false;this.player?.disconnect();this.player=null;this.publish({status:'error',actualUri:null,message:error instanceof Error?error.message:'Не удалось включить Spotify. Нажми «Слушать» ещё раз.'})}}
  }
  pause(){this.intent++;this.desired=false;if(!this.disposed)this.publish({status:'paused',actualUri:null});return this.enqueue(async()=>{await this.player?.pause()}).catch(()=>{})}
  seek(positionMs:number){if(!this.ready||!Number.isFinite(positionMs))return;const position=Math.round(Math.max(0,Math.min(positionMs,this.state.durationMs)));void this.enqueue(async()=>{await this.api.request(`me/player/seek?position_ms=${position}`,'PUT')}).catch(()=>{this.publish({message:'Не удалось перемотать трек.'})})}
  subscribe(fn:(state:PlaybackState)=>void){this.listeners.add(fn);fn({...this.state});return()=>{this.listeners.delete(fn)}}
  dispose(){this.disposed=true;this.intent++;this.desired=false;this.player?.disconnect();this.player=null;this.listeners.clear()}
}
