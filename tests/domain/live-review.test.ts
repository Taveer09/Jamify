import { describe, expect, it } from 'vitest'
import { chooseLive, openLiveDraft, reviewEntries, saveLiveDraft, undoLive } from '../../src/features/live-review'
import type { LiveSource } from '../../src/features/live-review'
const source:LiveSource={id:'fixture-list',name:'Fixture music',version:'v1',items:Array.from({length:80},(_,i)=>({uri:`spotify:track:${String(i).padStart(22,'0')}`,kind:'track',isLocal:false,title:`Track ${i}`,linkedFromUri:null,canPlay:true}))}
const memory=()=>{const rows=new Map<string,string>();return {getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)}}}
describe('read-only real music drafts',()=>{
  it('reviews every unique track past 25, restores after reload and undoes the exact choice',()=>{
    const storage=memory();let draft=openLiveDraft('account',source,storage,42)
    const queue=[...draft.queue]
    for(let i=0;i<57;i++)draft=chooseLive(draft,queue[i],i%2?'remove':'keep')
    saveLiveDraft(draft,storage as Storage)
    const restored=openLiveDraft('account',source,storage,99)
    expect(restored).toEqual(draft);expect(restored.queue).toHaveLength(80)
    expect(restored.cursor).toBe(57);expect(Object.keys(restored.decisions)).toHaveLength(57)
    const undone=undoLive(restored);expect(undone.queue[undone.cursor]).toBe(queue[56]);expect(undone.decisions[queue[56]]).toBeUndefined()
  })
  it('never promotes an observed URI to confirmed mutation identity',()=>{
    const entries=reviewEntries({...source,items:[source.items[0],source.items[0],{...source.items[1],isLocal:true},{...source.items[2],canPlay:false}]})
    expect(entries.size).toBe(1)
    expect([...entries.values()][0]).toMatchObject({sourceUri:null,identityConfidence:'ambiguous',canRemove:false,canCopy:false,playbackUri:source.items[0].uri})
  })
  it('rejects corrupt, changed and cross-account drafts with a recoverable message',()=>{
    expect(()=>openLiveDraft('account',source,{getItem:()=>'{broken'})).toThrow('Начни новый разбор')
    const draft=openLiveDraft('account',source,null,42)
    const storage={getItem:()=>JSON.stringify(draft)}
    expect(()=>openLiveDraft('different',source,storage)).toThrow('Начни новый разбор')
    expect(()=>openLiveDraft('account',{...source,version:'v2'},storage)).toThrow('Начни новый разбор')
    expect(()=>openLiveDraft('account',source,{getItem:()=>JSON.stringify({...draft,cursor:1})})).toThrow('Начни новый разбор')
  })
  it('keeps skip local, ignores stale card actions and handles empty saved tracks without a fake snapshot',()=>{
    const draft=openLiveDraft('account',{...source,version:null},null,42)
    expect(chooseLive(draft,'stale','remove')).toBe(draft)
    const skipped=chooseLive(draft,draft.queue[0],'skip');expect(skipped.decisions[draft.queue[0]]).toBe('skip')
    expect(undoLive(skipped).cursor).toBe(0)
    expect(openLiveDraft('account',{...source,version:null,items:[]},null).queue).toEqual([])
  })
})
