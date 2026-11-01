import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { expect, it } from 'vitest'
import { JamifyStorage } from '../../src/lib/persistence/database'
import { demoFixtures } from '../../src/demo/fixtures'
import { createSession, currentUri, decide } from '../../src/domain/session'

it('upgrades a v1 database without losing its saved draft or demo playlist', async () => {
  const name = crypto.randomUUID(), baseline = demoFixtures()[0]
  const initial = createSession(baseline, 1), session = decide(initial, currentUri(initial)!, 'remove')
  const old = await openDB(name, 1, { upgrade(db) { db.createObjectStore('drafts'); db.createObjectStore('demo-playlists') } })
  await old.put('drafts', { baseline, session, revision: 1, updatedAt: Date.now() }, [baseline.accountId, baseline.playlistId])
  await old.put('demo-playlists', baseline, [baseline.accountId, baseline.playlistId]); old.close()
  const next = new JamifyStorage(name)
  try {
    expect((await next.loadDraft(baseline.accountId, baseline.playlistId))?.session.cursor).toBe(1)
    expect((await next.loadDemoPlaylist(baseline.playlistId)).orderedEntries).toHaveLength(8)
    expect(await next.operations.read(baseline.accountId, baseline.playlistId)).toBeNull()
  } finally { await next.close() }
})
