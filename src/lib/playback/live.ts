import type { Entry, PlaybackGateway, PlaybackState } from '../../contracts'
import { BrowserPlayer } from './sdk'
import type { PlayerNotice } from './sdk'
import { PlaybackFailure } from './failure'
import { SpotifyError } from '../spotify/api'
import type { SpotifyApi } from '../spotify/api'

function playbackMessage(error: unknown): string {
  if (error instanceof PlaybackFailure && error.diagnostic.stage==='confirm')return error.message
  if (error instanceof PlaybackFailure && error.diagnostic.status!==null)return playbackMessage(new SpotifyError(error.diagnostic.status,null,false,error.diagnostic.reason))
  if (error instanceof SpotifyError) {
    if (error.status === 404) return 'Spotify не нашёл плеер. Подключи звук ещё раз.'
    if (error.status === 401) return 'Сессия Spotify истекла. Переподключи аккаунт.'
    if (error.reason === 'PREMIUM_REQUIRED') return 'Для прослушивания нужен Spotify Premium.'
    if (error.status === 403) return 'Spotify не разрешил включить музыку. Переподключи аккаунт и проверь доступ приложения.'
    if (error.status === 429) return 'Слишком много запросов к Spotify. Попробуй чуть позже.'
    return 'Не удалось связаться с плеером Spotify. Проверь подключение и попробуй ещё раз.'
  }
  return error instanceof Error ? error.message : 'Не удалось включить звук. Попробуй ещё раз.'
}

export class SpotifyPlaybackGateway implements PlaybackGateway {
  private state:PlaybackState={requestedUri:null,actualUri:null,generation:0,status:'idle',positionMs:0,durationMs:0}
  private listeners=new Set<(state:PlaybackState)=>void>()
  private player:BrowserPlayer|null=null
  private ready=false
  private disposed=false
  private desired=false
  private intent=0
  private clock:ReturnType<typeof setInterval>|undefined
  private anchor={at:0,position:0}
  private polling=false
  private ticks=0
  private seekRevision=0
  private pendingSeek:number|null=null
  private skipIntro=false
  setSkipIntro(value:boolean){this.skipIntro=value}
  private stopClock(){clearInterval(this.clock);this.clock=undefined}
  private startClock(){
    this.anchor={at:Date.now(),position:this.state.positionMs}
    if(this.clock)return
    this.clock=setInterval(()=>{
      if(this.disposed||!this.desired||this.state.status!=='playing'){this.stopClock();return}
      this.publish({positionMs:Math.min(this.state.durationMs,Math.max(0,this.anchor.position+Date.now()-this.anchor.at))})
      if(++this.ticks%4===0&&!this.polling&&this.pendingSeek===null){
        const intent=this.intent,revision=this.seekRevision;this.polling=true
        void this.player?.refresh(()=>!this.disposed&&this.desired&&intent===this.intent&&revision===this.seekRevision).catch(()=>{}).finally(()=>{this.polling=false})
      }
    },250)
  }
  private confirmation:ReturnType<typeof setTimeout>|undefined
  private clearConfirmation(){clearTimeout(this.confirmation);this.confirmation=undefined}
  private serial=Promise.resolve()
  constructor(private token:()=>Promise<string>,private api:SpotifyApi){}
  private publish(patch:Partial<PlaybackState>){this.state={...this.state,...patch};for(const fn of this.listeners)fn({...this.state})}
  private enqueue(job:()=>Promise<void>){const result=this.serial.then(job);this.serial=result.catch(()=>{});return result}
  private notice=(notice:PlayerNotice)=>{
    if(this.disposed)return
    if(notice.state==='error'){this.stopClock();this.clearConfirmation();this.intent++;this.desired=false;if(notice.code!=='autoplay_failed')this.ready=false;this.publish({status:'error',actualUri:null,message:notice.message,canSeek:false,diagnostic:{stage:'sdk',status:null,reason:notice.code??'SDK_ERROR'}});return}
    if(notice.state==='playing'){
      if(!this.desired)return
      if(this.state.status==='loading'&&notice.uri!==this.state.requestedUri)return
      if(this.desired&&notice.uri===this.state.requestedUri){this.clearConfirmation();this.publish({status:'playing',actualUri:notice.uri,positionMs:notice.sampled?Math.max(this.state.positionMs,notice.positionMs??this.state.positionMs):notice.positionMs??this.state.positionMs,durationMs:notice.durationMs??this.state.durationMs,message:undefined,diagnostic:undefined,canSeek:notice.canSeek??this.state.canSeek});this.startClock()}
      else {this.stopClock();this.publish({status:'idle',actualUri:null,canSeek:false,message:'Spotify сообщает о другом треке. Нажми «Слушать», чтобы включить текущий.'})}
      return
    }
    if(notice.state==='paused'&&!(this.desired&&this.state.status==='loading')){this.stopClock();this.publish({status:'paused',actualUri:null,...(notice.uri===this.state.requestedUri?{positionMs:notice.positionMs??this.state.positionMs}:{}),canSeek:notice.uri===this.state.requestedUri?(notice.canSeek??this.state.canSeek):false})}
    if(notice.state==='idle'&&!(this.desired&&this.state.status==='loading')){this.stopClock();this.publish({status:'idle',actualUri:null,canSeek:false})}
  }
  select(entry:Entry){
    if(this.disposed)return
    this.stopClock();this.pendingSeek=null;this.seekRevision++;this.clearConfirmation();this.intent++;this.desired=false
    this.publish({requestedUri:entry.playbackUri,actualUri:null,generation:this.state.generation+1,status:'idle',positionMs:0,durationMs:entry.durationMs??0,message:undefined,diagnostic:undefined,canSeek:false})
    void this.player?.pause().catch(()=>{})
    void this.enqueue(async()=>{if(this.ready)await this.player?.pause()}).catch(()=>{})
  }
  async play(){
    if(this.disposed||!this.state.requestedUri)return
    this.clearConfirmation();this.desired=true
    const intent=++this.intent,uri=this.state.requestedUri
    // Preserve the immediate user activation before entering the serialized queue.
    const activation=(this.ready?this.player!.activate():Promise.resolve()).then(()=>({ok:true as const}),error=>({ok:false as const,error}))
    this.publish({status:'loading',actualUri:null,message:undefined,diagnostic:undefined})
    try{
      await this.enqueue(async()=>{
        if(this.disposed||intent!==this.intent)return
        if(!this.ready){
          this.player?.disconnect()
          const connecting=new BrowserPlayer(this.token,this.notice)
          this.player=connecting
          await connecting.connect()
          if(this.disposed||intent!==this.intent||this.player!==connecting)return
          this.ready=true
        }
        const activated=await activation
        if(!activated.ok)throw activated.error
        if(this.disposed||intent!==this.intent||!this.desired)return
        await this.player!.play(uri,this.api,()=>!this.disposed&&intent===this.intent&&this.desired,this.skipIntro&&this.state.durationMs>45_000?30_000:0)
        if(!this.disposed&&intent===this.intent&&this.desired&&this.state.status==='loading')this.confirmation=setTimeout(()=>{
          if(!this.disposed&&intent===this.intent&&this.desired&&this.state.status==='loading'){
            const failure=new PlaybackFailure({stage:'confirm',status:null,reason:null})
            this.publish({status:'error',actualUri:null,message:failure.message,canSeek:false,diagnostic:failure.diagnostic})
          }
        },10_000)
      })
    }catch(error){if(!this.disposed&&intent===this.intent){this.desired=false;if(error instanceof PlaybackFailure&&error.reconnect)this.ready=false;this.publish({status:'error',actualUri:null,message:playbackMessage(error),canSeek:false,diagnostic:error instanceof PlaybackFailure?error.diagnostic:undefined})}}
  }
  pause(){this.stopClock();this.pendingSeek=null;this.seekRevision++;this.clearConfirmation();this.intent++;this.desired=false;if(!this.disposed)this.publish({status:'paused',actualUri:null,message:undefined});void this.player?.pause().catch(()=>{});return this.enqueue(async()=>{await this.player?.pause()}).catch(()=>{})}
  reconnect(){this.stopClock();this.pendingSeek=null;this.seekRevision++;this.clearConfirmation();this.intent++;this.desired=false;this.player?.disconnect();this.player=null;this.ready=false;return this.play()}
  seek(positionMs:number){
    if(!this.ready||!this.state.canSeek||!this.state.requestedUri||!Number.isFinite(positionMs))return
    const position=Math.round(Math.max(0,Math.min(positionMs,this.state.durationMs))),uri=this.state.requestedUri,revision=++this.seekRevision,intent=this.intent
    this.pendingSeek=revision
    const current=()=>!this.disposed&&intent===this.intent&&revision===this.seekRevision&&uri===this.state.requestedUri
    return this.enqueue(async()=>{
      if(!current())return
      const succeeded=await this.player?.seek(position,uri,current)
      if(!succeeded||!current())return
      this.anchor={at:Date.now(),position};this.publish({positionMs:position,message:undefined})
    }).catch(()=>{if(current())this.publish({message:'Не удалось перемотать трек. Попробуй ещё раз.'})}).finally(()=>{if(this.pendingSeek===revision){this.pendingSeek=null;this.seekRevision++}})
  }
  subscribe(fn:(state:PlaybackState)=>void){this.listeners.add(fn);fn({...this.state});return()=>{this.listeners.delete(fn)}}
  dispose(){this.stopClock();this.pendingSeek=null;this.seekRevision++;this.clearConfirmation();this.disposed=true;this.intent++;this.desired=false;this.player?.disconnect();this.player=null;this.listeners.clear()}
}
