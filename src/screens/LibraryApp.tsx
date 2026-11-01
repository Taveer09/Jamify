import { useEffect, useMemo, useRef, useState } from 'react'
import type { Decision, PlaybackState } from '../contracts'
import type { ReviewCardHandle } from '../contracts/review-ui'
import { SpotifyAuth } from '../lib/spotify/auth'
import { SpotifyApi, SpotifyError } from '../lib/spotify/api'
import type { LibraryPlaylist } from '../lib/spotify/api'
import { SpotifyPlaybackGateway } from '../lib/playback/live'
import { chooseLive, clearLiveDraft, openLiveDraft, reviewEntries, saveLiveDraft, undoLive } from '../features/live-review'
import type { LiveDraft, LiveSource } from '../features/live-review'
import { ReviewUndoShortcut } from '../components/ReviewControls'
import { MusicReview } from '../components/MusicReview'
import '../styles/review.css'
import '../styles/music.css'

type User={id:string;display_name?:string|null}
const initialPlayer:PlaybackState={requestedUri:null,actualUri:null,generation:0,status:'idle',positionMs:0,durationMs:0}
function initialize(){
  try{const storage=window.sessionStorage;storage.setItem('jamify.storage-check','1');storage.removeItem('jamify.storage-check');return {auth:new SpotifyAuth({storage}),error:''}}
  catch{return {auth:null,error:'Браузер запретил хранилище вкладки. Разреши данные сайта, чтобы подключить Spotify.'}}
}
function localStore():Storage|null {try{return window.localStorage}catch{return null}}
function errorMessage(error:unknown){return error instanceof Error?error.message:'Не удалось загрузить Spotify. Попробуй ещё раз.'}
function Logo(){return <a className="wordmark" href="/"><svg viewBox="0 0 32 32" width="27" height="27" fill="none" aria-hidden="true"><path d="M9 5v13a5 5 0 1 1-5-5m17-8v18a5 5 0 1 1-5-5M9 9l12-4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg><span>Jamify</span></a>}
export function LibraryApp(){
  const [runtime]=useState(initialize),auth=runtime.auth
  const api=useMemo(()=>auth?new SpotifyApi(()=>auth.getAccessToken()):null,[auth])
  const [user,setUser]=useState<User|null>(null),[lists,setLists]=useState<LibraryPlaylist[]>([])
  const [screen,setScreen]=useState<'library'|'review'|'summary'>('library')
  const [source,setSource]=useState<LiveSource|null>(null),[draft,setDraft]=useState<LiveDraft|null>(null)
  const draftRef=useRef<LiveDraft|null>(null),generation=useRef(0),card=useRef<ReviewCardHandle>(null)
  const drafts=useRef(new Map<string,LiveDraft>())
  const [busy,setBusy]=useState(Boolean(auth)),[error,setError]=useState(runtime.error),[storageWarning,setStorageWarning]=useState('')
  const [clientId,setClientId]=useState(import.meta.env.VITE_SPOTIFY_CLIENT_ID??'')
  const [player,setPlayer]=useState(initialPlayer),[playback,setPlayback]=useState<SpotifyPlaybackGateway|null>(null)
  const [heard,setHeard]=useState<string|null>(null),[silent,setSilent]=useState(false),[pending,setPending]=useState(false)
  const autoplay=useRef(true),[restartId,setRestartId]=useState<string|null>(null)
  const entries=useMemo(()=>source?reviewEntries(source):new Map(),[source])
  const excluded=source?source.items.filter(item=>!item.uri||!entries.has(item.uri)).length:0
  const key=draft?.queue[draft.cursor],entry=key?entries.get(key):undefined
  const matching=Boolean(entry&&player.status==='playing'&&player.actualUri===entry.playbackUri)
  const canDecide=Boolean(entry&&(matching||heard===entry.playbackUri||silent))
  const redirectUri=import.meta.env.VITE_SPOTIFY_REDIRECT_URI||`${window.location.origin}/callback`

  useEffect(()=>{
    let active=true;const ticket=++generation.current
    const callback=window.location.pathname==='/callback',url=window.location.href
    if(callback)window.history.replaceState(null,'','/')
    if(!auth||!api)return
    void(async()=>{
      try{
        if(callback)await auth.complete(url)
        if(!auth.hasSession())return
        const profile=await api.currentUser()
        if(!active||ticket!==generation.current)return
        setUser(profile)
        const library=await api.libraryPlaylists(profile.id)
        if(active&&ticket===generation.current)setLists(library)
      }catch(caught){if(active&&ticket===generation.current)setError(errorMessage(caught))}
      finally{if(active&&ticket===generation.current)setBusy(false)}
    })()
    return()=>{active=false}
  },[auth,api])
  useEffect(()=>{
    if(!playback)return
    const off=playback.subscribe(state=>{setPlayer(state);if(state.status==='playing'&&state.actualUri)setHeard(state.actualUri)})
    return()=>{off();playback.dispose()}
  },[playback])
  useEffect(()=>{
    if(!playback)return
    if(screen!=='review'||!entry){void playback.pause();return}
    playback.select(entry)
    if(autoplay.current&&!silent)void playback.play()
  },[playback,entry,screen,silent])

  async function login(){
    if(!auth||busy)return
    setBusy(true);setError('')
    try{window.sessionStorage.setItem('jamify.auth.destination','library');window.location.assign(await auth.authorize({clientId:clientId.trim(),redirectUri},window.location.origin))}
    catch(caught){setError(errorMessage(caught));setBusy(false)}
  }
  function logout(){generation.current++;playback?.dispose();setPlayback(null);auth?.logout();setUser(null);setSource(null);setDraft(null);draftRef.current=null;setLists([]);setScreen('library');setBusy(false);setError('');setHeard(null);setPlayer(initialPlayer)}
  async function refreshLibrary(){
    if(!api||!user||busy)return
    const ticket=++generation.current;setBusy(true);setError('')
    try{const profile=await api.currentUser();if(profile.id!==user.id)throw new Error('Аккаунт изменился. Подключись ещё раз.');const list=await api.libraryPlaylists(user.id);if(ticket===generation.current)setLists(list)}
    catch(caught){if(ticket===generation.current)setError(errorMessage(caught))}
    finally{if(ticket===generation.current)setBusy(false)}
  }
  function persist(next:LiveDraft){
    drafts.current.set(JSON.stringify([next.accountId,next.sourceId]),next)
    draftRef.current=next;setDraft(next)
    try{const storage=localStore();if(!storage)throw new Error();saveLiveDraft(next,storage);setStorageWarning('')}
    catch{setStorageWarning('Решения пока только в этой вкладке: браузер не разрешил сохранение.')}
  }
  async function openSource(id:string,restart=false){
    if(!api||!auth||!user||busy)return
    const ticket=++generation.current,account=user.id;setBusy(true);setError('');setRestartId(null);void playback?.pause()
    try{
      const profile=await api.currentUser();if(profile.id!==account)throw new Error('Аккаунт изменился. Подключись ещё раз.')
      let loaded:LiveSource
      if(id==='liked')loaded={id,name:'Любимые треки',version:null,items:await api.savedTracks()}
      else{const result=await api.reviewSnapshot(id,account);loaded={id,name:result.playlist.name,version:result.playlist.snapshot_id,items:result.items}}
      const currentProfile=await api.currentUser();if(currentProfile.id!==account)throw new Error('Аккаунт изменился во время загрузки.')
      if(ticket!==generation.current)return
      const memoryKey=JSON.stringify([account,id])
      if(restart){clearLiveDraft(account,id,localStore());drafts.current.delete(memoryKey)}
      const memory=drafts.current.get(memoryKey)
      let readable=localStore()
      try{readable?.getItem('jamify.storage-check')}catch{readable=null}
      const restored=openLiveDraft(account,loaded,memory?{getItem:()=>JSON.stringify(memory)}:readable)
      setSource(loaded);persist(restored)
      if(!readable)setStorageWarning('Решения пока только в этой вкладке: браузер не разрешил сохранение.')
      setHeard(null);setSilent(false);setPlayer(initialPlayer);autoplay.current=true
      playback?.dispose();setPlayback(new SpotifyPlaybackGateway(()=>auth.getAccessToken(),api));setScreen('review')
    }catch(caught){
      if(ticket!==generation.current)return
      if(caught instanceof SpotifyError&&caught.status===403&&id==='liked')setError('Spotify не дал доступ к любимым трекам. Нажми «Переподключить Spotify» и разреши чтение медиатеки.')
      else{setError(errorMessage(caught));if(errorMessage(caught).includes('Начни новый разбор'))setRestartId(id)}
    }finally{if(ticket===generation.current)setBusy(false)}
  }
  function commit(expected:string,decision:Decision){
    const current=draftRef.current
    if(busy||!current||current.queue[current.cursor]!==expected||(decision!=='skip'&&!canDecide))return
    persist(chooseLive(current,expected,decision))
  }
  function requestDecision(expected:string,decision:Decision,animate=false){card.current?.decide(expected,decision,animate)}
  function undo(){if(!busy&&!card.current?.cancel()&&draftRef.current)persist(undoLive(draftRef.current))}
  function back(){card.current?.finish();generation.current++;void playback?.pause();setScreen('library')}
  function finish(){card.current?.finish();void playback?.pause();setScreen('summary')}
  function exportDecisions(){
    if(!source||!draft)return
    const rows=draft.queue.filter(key=>draft.decisions[key]).map(key=>({observedUri:key,title:entries.get(key)?.title,artist:entries.get(key)?.artist,decision:draft.decisions[key]}))
    const url=URL.createObjectURL(new Blob([JSON.stringify({playlist:source.name,spotifyChanged:false,decisions:rows},null,2)],{type:'application/json'}))
    const a=document.createElement('a');a.href=url;a.download='jamify-review.json';a.click();URL.revokeObjectURL(url)
  }
  const counts={keep:Object.values(draft?.decisions??{}).filter(x=>x==='keep').length,remove:Object.values(draft?.decisions??{}).filter(x=>x==='remove').length}
  return <div className="music-shell library-shell">
    <header className="demo-header"><Logo/><nav aria-label="Режим приложения"><a href="/demo">Попробовать демо</a>{user&&<details className="account-menu"><summary>{user.display_name||'Мой Spotify'}</summary><button className="text-button" onClick={logout}>Выйти</button></details>}</nav></header>
    <main className="demo-main">
      {error&&<div className="feedback error" role="alert"><p>{error}</p>{user&&<button className="text-button" disabled={busy} onClick={()=>void login()}>Переподключить Spotify</button>}{restartId&&<button className="text-button" onClick={()=>void openSource(restartId,true)}>Начать новый разбор</button>}</div>}
      {storageWarning&&<p className="feedback" role="alert">{storageWarning}</p>}
      {busy&&<p role="status" className="library-loading">Загружаем твою музыку…</p>}
      {screen==='library'&&!user?<section className="music-welcome"><div className="welcome-art" aria-hidden="true"><img src="/demo/citrus.svg" alt=""/><img src="/demo/rose.svg" alt=""/></div><h1>Оставь музыку,<br/>которая твоя.</h1><p>Подключи Spotify. Потяни трек вправо, чтобы оставить, влево — пометить на удаление.</p><button className="button primary" disabled={busy||!auth||!clientId.trim()} onClick={()=>void login()}>Войти через Spotify</button><a className="welcome-demo" href="/demo">Сначала попробовать</a><details className="developer-settings"><summary>Настройки разработчика</summary><label htmlFor="library-client">Client ID приложения</label><input id="library-client" value={clientId} onChange={e=>setClientId(e.target.value)} autoComplete="off"/><p>Redirect URI: {redirectUri}</p><a href="/diagnostics">Диагностика подключения</a></details></section>:null}
      {screen==='library'&&user?<section className="library-picker"><div className="library-title"><div><h1>Твоя медиатека</h1><p>Выбери, что переслушать.</p></div><button className="text-button" disabled={busy} onClick={()=>void refreshLibrary()}>Обновить</button></div><div className="library-list"><button className="library-item liked-item" disabled={busy} onClick={()=>void openSource('liked')}><span className="library-cover liked-cover" aria-hidden="true"><svg viewBox="0 0 24 24" width="27" height="27" fill="currentColor"><path d="M12 21s-9-5.7-9-12a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6.3-9 12-9 12Z"/></svg></span><span><strong>Любимые треки</strong><small>Твоя личная коллекция</small></span><span aria-hidden="true">↗</span></button>{lists.map(list=><button key={list.id} className="library-item" disabled={busy} onClick={()=>void openSource(list.id)}>{list.imageUrl?<img className="library-cover" src={list.imageUrl} alt=""/>:<span className="library-cover empty-cover" aria-hidden="true"><svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 18V5l11-2v13M9 9l11-2"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg></span>}<span><strong>{list.name}</strong><small>{!list.readable?'Сохранённый плейлист · Spotify ограничивает чтение':list.count===null?'Плейлист Spotify':`${list.count.toLocaleString('ru-RU')} треков`}</small></span><span aria-hidden="true">↗</span></button>)}</div>{!lists.length&&!busy&&<p className="field-hint">Spotify не вернул обычных плейлистов. Попробуй «Любимые треки» или проверь, тем ли аккаунтом ты вошёл.</p>}</section>:null}
      {screen==='review'&&source&&draft?<><p className="live-review-note">Свайпы сохраняют твои решения. Spotify пока не изменяется.</p><MusicReview reviewKey={key} entry={entry} nextEntry={entries.get(draft.queue[draft.cursor+1])} occurrences={source.items.filter(item=>item.uri===key).length} playlistName={source.name} cursor={draft.cursor} total={draft.queue.length} busy={busy} decisionPending={pending} canDecide={canDecide} canUndo={pending||Boolean(draft.history.length)} withoutSound={silent} playback={player} soundLabel={matching?'Играет текущий трек':player.message||(silent?'Без звука':player.status==='loading'?'Подключаем звук Spotify…':'Нажми «Слушать»')} canSeek={false} cardRef={card} onPendingChange={setPending} onDecisionCommit={commit} onDecision={requestDecision} onUndo={undo} onTogglePlayback={()=>{if(player.status==='playing'||player.status==='loading'){autoplay.current=false;void playback?.pause()}else{autoplay.current=true;void playback?.play()}}} onSeek={()=>{}} onSilent={()=>{autoplay.current=false;void playback?.pause();setSilent(true)}} onFinish={finish} onBack={back}/>{!entry&&<div className="music-empty-actions"><ReviewUndoShortcut disabled={busy} canUndo={Boolean(draft.history.length)} onUndo={undo}/><button className="text-button" disabled={busy||!draft.history.length} onClick={undo}>Отменить решение</button></div>}{excluded>0&&<p className="music-review-footnote">{excluded} записей недоступны для прослушивания. Они остаются в Spotify.</p>}<p className="save-status">{pending?'Завершаем решение…':storageWarning?'Решения в этой вкладке':'Решения сохранены на этом устройстве'}</p></>:null}
      {screen==='summary'&&draft&&source?<section className="result-panel live-summary"><h1>Твой выбор сохранён.</h1><p>{source.name}</p><dl><div><dt>Оставить</dt><dd>{counts.keep}</dd></div><div><dt>Помечено убрать</dt><dd>{counts.remove}</dd></div></dl><p>Треки в Spotify не удалялись. Применение изменений пока недоступно; список решений можно скачать.</p><div className="button-row">{draft.cursor<draft.queue.length&&<button className="button primary" onClick={()=>setScreen('review')}>Продолжить разбор</button>}<button className="button secondary" onClick={exportDecisions}>Скачать решения</button><button className="text-button" onClick={back}>Другой плейлист</button></div></section>:null}
    </main>
  </div>
}
