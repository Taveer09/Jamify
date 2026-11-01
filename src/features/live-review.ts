import { z } from 'zod'
import type { Decision, Entry } from '../contracts'
import type { ObservedItem } from '../lib/spotify/api'
import { shuffled } from '../domain/playlist'

export type LiveSource = { id: string; name: string; version: string | null; items: ObservedItem[] }
export type LiveDraft = { accountId: string; sourceId: string; fingerprint: string; queue: string[]; cursor: number; decisions: Record<string, Decision>; history: Array<{ key: string; decision: Decision }>; updatedAt: number }
const draftSchema = z.object({ accountId: z.string(), sourceId: z.string(), fingerprint: z.string(), queue: z.array(z.string()).max(10_000), cursor: z.number().int().nonnegative(), decisions: z.record(z.string(), z.enum(['keep','remove','skip'])), history: z.array(z.object({key:z.string(),decision:z.enum(['keep','remove','skip'])})).max(10_000), updatedAt:z.number() })
export function reviewEntries(source: LiveSource): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  source.items.forEach((item, index) => {
    if (!item.uri || item.kind !== 'track' || item.isLocal || item.canPlay === false || entries.has(item.uri)) return
    // Observed URI identifies a local listening choice only. It never attests a mutation source URI.
    entries.set(item.uri, { entryKey: `${source.id}:${index}`, originalIndex:index, observedUri:item.uri, sourceUri:null, playbackUri:item.uri,
      identityConfidence:'ambiguous',kind:'track',title:item.title,artist:item.artist || 'Spotify',imageUrl:item.imageUrl ?? null,
      spotifyUrl:item.spotifyUrl ?? (/^spotify:track:[A-Za-z0-9]{22}$/.test(item.uri) ? `https://open.spotify.com/track/${item.uri.split(':')[2]}` : null),
      durationMs:item.durationMs ?? null, canPlay:true, canRemove:false,canCopy:false })
  })
  return entries
}
const keyFor = (accountId:string, sourceId:string) => `jamify.listen.v1:${JSON.stringify([accountId,sourceId])}`
const content = (source:LiveSource) => JSON.stringify([source.version,source.items.map(item=>[item.kind,item.uri,item.isLocal])])
export function openLiveDraft(accountId:string,source:LiveSource,storage:Pick<Storage,'getItem'>|null,seed=Date.now()):LiveDraft {
  const fingerprint=content(source),keys=[...reviewEntries(source).keys()],keySet=new Set(keys)
  const raw=storage?.getItem(keyFor(accountId,source.id))
  if(raw){
    let parsed:unknown
    try { parsed=JSON.parse(raw) } catch { throw new Error('Сохранённые решения повреждены. Начни новый разбор.') }
    const value=draftSchema.safeParse(parsed)
    if(value.success){const draft=value.data
      const replay=Object.fromEntries(draft.history.map(item=>[item.key,item.decision]))
      if(draft.accountId===accountId&&draft.sourceId===source.id&&draft.fingerprint===fingerprint&&Date.now()-draft.updatedAt<30*86400_000&&Date.now()>=draft.updatedAt&&draft.cursor===draft.history.length&&draft.cursor<=draft.queue.length&&new Set(draft.queue).size===keys.length&&draft.queue.length===keys.length&&draft.queue.every(key=>keySet.has(key))&&draft.history.every((item,i)=>item.key===draft.queue[i])&&JSON.stringify(replay)===JSON.stringify(draft.decisions))return draft
    }
    throw new Error('Плейлист или сохранённые решения изменились. Начни новый разбор, чтобы не смешать разные версии.')
  }
  return {accountId,sourceId:source.id,fingerprint,queue:shuffled(keys,seed),cursor:0,decisions:{},history:[],updatedAt:Date.now()}
}
export function chooseLive(draft:LiveDraft,key:string,decision:Decision):LiveDraft {
  if(draft.queue[draft.cursor]!==key)return draft
  return {...draft,cursor:draft.cursor+1,decisions:{...draft.decisions,[key]:decision},history:[...draft.history,{key,decision}],updatedAt:Date.now()}
}
export function undoLive(draft:LiveDraft):LiveDraft {
  const last=draft.history.at(-1);if(!last)return draft
  const decisions={...draft.decisions};delete decisions[last.key]
  return {...draft,cursor:draft.cursor-1,decisions,history:draft.history.slice(0,-1),updatedAt:Date.now()}
}
export function saveLiveDraft(draft:LiveDraft,storage:Storage|null):void {storage?.setItem(keyFor(draft.accountId,draft.sourceId),JSON.stringify(draft))}
export function clearLiveDraft(accountId:string,sourceId:string,storage:Storage|null):void {storage?.removeItem(keyFor(accountId,sourceId))}
