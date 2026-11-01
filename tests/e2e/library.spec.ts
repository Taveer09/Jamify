import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { reviewOption } from './helpers/music'

async function fixture(page:Page, options:{deniedLiked?:boolean;holdItems?:Promise<void>}={}){
  const writes:Array<{path:string;method:string}>=[]
  const track=(index:number)=>({track:{type:'track',uri:`spotify:track:${String(index).padStart(22,'0')}`,name:`Track ${index}`,artists:[{name:'Fixture artist'}],duration_ms:180000,album:{images:[]}}})
  await page.addInitScript(()=>{
    sessionStorage.setItem('jamify.oauth.refresh.v1',JSON.stringify({clientId:'a'.repeat(32),refreshToken:'fixture-refresh'}))
    class FixturePlayer{
      listeners=new Map<string,(value:unknown)=>void>()
      currentUri=''
      constructor(){window.addEventListener('fixture-playback',event=>this.emit((event as CustomEvent<string>).detail))}
      emit(uri:string,paused=false){this.currentUri=uri;this.listeners.get('player_state_changed')?.({paused,position:1200,duration:180000,track_window:{current_track:{uri}}})}
      addListener(name:string,fn:(value:unknown)=>void){this.listeners.set(name,fn);return true}
      async connect(){queueMicrotask(()=>this.listeners.get('ready')?.({device_id:'fixture-device'}));return true}
      disconnect(){this.listeners.clear()}
      async activateElement(){}
      async pause(){this.emit(this.currentUri,true)}
    }
    window.Spotify={Player:FixturePlayer}
  })
  await page.route('https://accounts.spotify.com/api/token',route=>route.fulfill({json:{access_token:'fixture-access',expires_in:3600,token_type:'Bearer'}}))
  await page.route('https://api.spotify.com/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/v1/',''),method=request.method()
    if(method!=='GET')writes.push({path,method})
    if(path==='me')return route.fulfill({json:{id:'fixture-account',display_name:'Fixture listener'}})
    const metadata=(id:string)=>({id,name:id==='owned'?'Моя музыка':'Чужой сохранённый',snapshot_id:'v1',owner:{id:id==='owned'?'fixture-account':'other'},collaborative:false,items:{total:70}})
    if(path==='me/playlists')return route.fulfill({json:{items:[metadata('owned'),metadata('followed')],next:null,total:2}})
    if(path==='playlists/owned')return route.fulfill({json:metadata('owned')})
    if(path==='playlists/followed')return route.fulfill({json:metadata('followed')})
    if(path==='me/tracks'&&options.deniedLiked)return route.fulfill({status:403,json:{error:{status:403}}})
    if(path==='playlists/owned/items'||path==='me/tracks'){
      await options.holdItems
      const offset=Number(url.searchParams.get('offset')||0),total=70,end=Math.min(total,offset+50)
      return route.fulfill({json:{items:Array.from({length:end-offset},(_,i)=>track(offset+i)),next:end<total?`https://api.spotify.com/v1/${path}?offset=${end}`:null,total}})
    }
    if(path==='me/player/play'){
      const uri=request.postDataJSON().uris[0]
      await page.evaluate(uri=>window.dispatchEvent(new CustomEvent('fixture-playback',{detail:uri})),uri)
      return route.fulfill({status:204})
    }
    throw new Error(`Unexpected fixture path ${method} ${path}`)
  })
  return {writes}
}

test('real-library route paginates all tracks, reviews past25, restores and exports without playlist writes',async({page})=>{
  const {writes}=await fixture(page)
  await page.goto('/')
  await expect(page.getByRole('heading',{name:'Твоя медиатека'})).toBeVisible()
  await expect(page.getByRole('button',{name:/Чужой сохранённый/})).toBeVisible()
  await page.getByRole('button',{name:/Моя музыка/}).click()
  await expect(page.getByRole('status')).toContainText('Играет текущий трек')
  await page.getByLabel('Ещё действия',{exact:true}).click()
  await page.getByRole('button',{name:'Продолжить без звука'}).click()
  await page.getByLabel('Ещё действия',{exact:true}).click()
  await page.locator('.track-details h2').click()
  for(let i=0;i<27;i++)await page.keyboard.press(i%2?'ArrowRight':'ArrowLeft')
  await expect(page.locator('.session-progress > span')).toHaveText('28 / 70')
  const next=await page.locator('.track-details h2').innerText()
  await page.getByRole('button',{name:'Проверить решения'}).click()
  await expect(page.getByText('Треки в Spotify не удалялись.',{exact:false})).toBeVisible()
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Скачать решения'}).click()
  expect((await download).suggestedFilename()).toBe('jamify-review.json')
  await page.reload()
  await page.getByRole('button',{name:/Моя музыка/}).click()
  await expect(page.locator('.track-details h2')).toHaveText(next)
  await expect(page.locator('.session-progress > span')).toHaveText('28 / 70')
  expect(writes.every(write=>write.method==='PUT'&&write.path==='me/player/play')).toBe(true)
})

test('liked tracks ask for reconsent when old grant lacks scope',async({page})=>{
  const {writes}=await fixture(page,{deniedLiked:true})
  await page.goto('/');await page.getByRole('button',{name:/Любимые треки/}).click()
  await expect(page.getByRole('alert')).toContainText('разреши чтение медиатеки')
  await expect(page.getByRole('button',{name:'Переподключить Spotify'})).toBeVisible()
  expect(writes).toEqual([])
})

test('saved followed playlists are visible and explain Spotify item-access restriction',async({page})=>{
  const {writes}=await fixture(page)
  await page.goto('/');await page.getByRole('button',{name:/Чужой сохранённый/}).click()
  await expect(page.getByRole('alert')).toContainText('его треки недоступны')
  expect(writes).toEqual([])
})

test('late source response after logout cannot restore the account or card',async({page})=>{
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve})
  const {writes}=await fixture(page,{holdItems:held})
  await page.goto('/');await page.getByRole('button',{name:/Моя музыка/}).click()
  await expect(page.getByRole('status')).toContainText('Загружаем')
  await page.getByText('Fixture listener',{exact:true}).click();await page.getByRole('button',{name:'Выйти',exact:true}).click()
  release()
  await expect(page.getByRole('button',{name:'Войти через Spotify'})).toBeVisible()
  await expect(page.getByRole('article',{name:'Текущий трек'})).toHaveCount(0)
  expect(writes).toEqual([])
})

test('denied localStorage falls back to memory and retains choices across source navigation',async({page})=>{
  await fixture(page)
  await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new Error('fixture-blocked')}}))
  await page.goto('/');await page.getByRole('button',{name:/Моя музыка/}).click()
  await expect(page.getByRole('alert')).toContainText('только в этой вкладке')
  await expect(page.getByRole('status')).toContainText('Играет текущий трек')
  await page.locator('.track-details h2').click();await page.keyboard.press('ArrowRight')
  await expect(page.locator('.session-progress > span')).toHaveText('2 / 70')
  const next=await page.locator('.track-details h2').innerText()
  await reviewOption(page,'Другой плейлист');await page.getByRole('button',{name:/Моя музыка/}).click()
  await expect(page.locator('.track-details h2')).toHaveText(next)
  await expect(page.locator('.session-progress > span')).toHaveText('2 / 70')
})

test('a foreign SDK URI revokes playing status instead of displaying old confirmation',async({page})=>{
  await fixture(page)
  await page.goto('/');await page.getByRole('button',{name:/Моя музыка/}).click()
  await expect(page.getByRole('status')).toContainText('Играет текущий трек')
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('fixture-playback',{detail:'spotify:track:foreign'})))
  await expect(page.getByRole('status')).toContainText('другом треке')
  await expect(page.getByRole('status')).not.toContainText('Играет текущий трек')
})

for(const width of [390,768,1440])test(`Spotify product entry fits ${width}px`,async({page})=>{
  const requests:string[]=[];page.on('request',request=>{if(/spotify\.com|scdn\.co/.test(request.url()))requests.push(request.url())})
  await page.setViewportSize({width,height:900});await page.goto('/')
  await expect(page.getByRole('button',{name:'Войти через Spotify'})).toBeInViewport()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  expect(requests).toEqual([])
})
