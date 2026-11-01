import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const a = `spotify:track:${'A'.repeat(22)}`
const b = `spotify:track:${'B'.repeat(22)}`
const c = `spotify:track:${'C'.repeat(22)}`

async function setup(page: Page, waitForRead?: () => Promise<void>) {
  const writes: Array<{ path: string; method: string; body: Record<string, unknown> }> = []
  let testItems: string[] = []
  let version = 'empty'
  await page.addInitScript(() => {
    sessionStorage.setItem('jamify.oauth.refresh.v1', JSON.stringify({ clientId: 'a'.repeat(32), refreshToken: 'fixture-refresh' }))
    class FixturePlayer {
      listeners = new Map<string, (value: unknown) => void>()
      currentUri = ''
      constructor() {
        window.addEventListener('jamify-fixture-playback', (event) => {
          this.currentUri = (event as CustomEvent<string>).detail
          this.emit('player_state_changed', { paused: false, track_window: { current_track: { uri: this.currentUri } } })
        })
      }
      emit(name: string, value: unknown) { this.listeners.get(name)?.(value) }
      addListener(name: string, callback: (value: unknown) => void) { this.listeners.set(name, callback); return true }
      async connect() { queueMicrotask(() => this.emit('ready', { device_id: 'fixture-device' })); return true }
      disconnect() { this.listeners.clear() }
      async activateElement() {}
      async pause() { this.emit('player_state_changed', { paused: true, track_window: { current_track: { uri: this.currentUri } } }) }
    }
    window.Spotify = { Player: FixturePlayer }
  })
  await page.route('https://accounts.spotify.com/api/token', (route) => route.fulfill({ json: {
    access_token: 'fixture-access', expires_in: 3600, token_type: 'Bearer',
  } }))
  await page.route('https://api.spotify.com/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace('/v1/', '')
    const method = request.method()
    if (method !== 'GET') writes.push({ path, method, body: request.postDataJSON() as Record<string, unknown> })
    const metadata = (id: string) => ({ id, name: `Fixture ${id}`, owner: { id: 'fixture-account' }, collaborative: false, snapshot_id: id === 'test' ? version : 'original' })
    if (path === 'me') return route.fulfill({ json: { id: 'fixture-account' } })
    if (path === 'me/playlists' && method === 'GET') return route.fulfill({ json: { items: [metadata('original'), metadata('second')], next: null, total: 2 } })
    if (path === 'me/playlists' && method === 'POST') { version = 'empty'; return route.fulfill({ json: metadata('test') }) }
    if (path === 'me/player/play') return route.fulfill({ status: 204 })
    const match = /^playlists\/(original|second|test)(\/items)?$/.exec(path)
    if (!match) throw new Error(`Unexpected fixture request: ${path}`)
    const id = match[1]
    if (!match[2]) return route.fulfill({ json: metadata(id) })
    if (method === 'POST') { testItems = request.postDataJSON().uris; version = 'seeded'; return route.fulfill({ json: { snapshot_id: version } }) }
    if (method === 'DELETE') { testItems = testItems.filter((uri) => uri !== a); version = 'deleted'; return route.fulfill({ json: { snapshot_id: version } }) }
    if (id === 'original') await waitForRead?.()
    const items = id === 'test' ? testItems : [a, b, a, c]
    return route.fulfill({ json: { items: items.map((uri) => ({ item: { uri, type: 'track', name: 'Fixture track' } })), total: items.length, next: null } })
  })
  await page.goto('/diagnostics')
  await page.getByRole('button', { name: 'Проверить мои плейлисты' }).click()
  return { writes, externalEdit: () => { version = 'external-edit' } }
}

test('all S0 controls complete their fixture flow and writes stay in the disposable playlist', async ({ page }) => {
  const { writes } = await setup(page)
  await page.getByRole('button', { name: 'Проверить загрузку' }).click()
  await expect(page.locator('.counts dd')).toHaveText(['4', '3', '1'])
  await page.getByRole('button', { name: 'Использовать три разных трека для теста' }).click()
  await expect(page.getByLabel('Трек A', { exact: true })).toHaveValue(a)
  await page.getByRole('button', { name: 'Подключить плеер', exact: true }).click()
  await page.getByRole('button', { name: 'Слушать', exact: true }).click()
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '2')
  await page.evaluate((uri) => window.dispatchEvent(new CustomEvent('jamify-fixture-playback', { detail: uri })), a)
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '3')
  await page.getByRole('button', { name: 'Пауза', exact: true }).click()
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '2')
  await page.getByLabel('Создать отдельный тестовый плейлист в моём Spotify').check()
  await page.getByRole('button', { name: 'Создать тестовый плейлист', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Удалить A только из теста' })).toBeEnabled()
  await page.getByRole('button', { name: 'Удалить A только из теста' }).click()
  await expect(page.getByText('Удаление URI-группы подтверждено.', { exact: false })).toBeVisible()
  const mutations = writes.filter((request) => request.path !== 'me/player/play')
  expect(mutations.map(({ method, path }) => `${method} ${path}`)).toEqual(['POST me/playlists', 'POST playlists/test/items', 'DELETE playlists/test/items'])
  expect(mutations[0].body.public).toBe(false)
  expect(mutations[1].body.uris).toEqual([a, b, a, c])
  expect(mutations[2].body).toEqual({ items: [{ uri: a }], snapshot_id: 'seeded' })
  await page.reload()
  await page.getByRole('button', { name: 'Проверить мои плейлисты' }).click()
  await expect(page.getByRole('button', { name: 'Создать тестовый плейлист', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Удалить A только из теста' })).toBeDisabled()
  await expect(page.getByText('Удаление URI-группы подтверждено.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Отключить аккаунт' }).click()
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '0')
  expect(await page.evaluate(() => sessionStorage.getItem('jamify.oauth.refresh.v1'))).toBeNull()
})

test('playlist selector is locked during reads and refresh clears a previous snapshot', async ({ page }) => {
  let release: (() => void) | undefined
  let requested: (() => void) | undefined
  const started = new Promise<void>((resolve) => { requested = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  await setup(page, async () => { requested!(); await gate })
  await page.getByRole('button', { name: 'Проверить загрузку' }).click()
  await started
  await expect(page.getByLabel('Выбери плейлист для чтения')).toBeDisabled()
  release!()
  await expect(page.locator('.snapshot-result')).toContainText('Fixture original')
  await page.getByLabel('Выбери плейлист для чтения').selectOption('second')
  await page.getByRole('button', { name: 'Проверить загрузку' }).click()
  await expect(page.locator('.snapshot-result')).toContainText('Fixture second')
  await page.getByRole('button', { name: 'Обновить', exact: true }).click()
  await expect(page.getByLabel('Выбери плейлист для чтения')).toHaveValue('original')
  await expect(page.locator('.snapshot-result')).not.toBeVisible()
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '1')
})

test('external changes stop the test deletion before a DELETE request', async ({ page }) => {
  const { writes, externalEdit } = await setup(page)
  await page.getByRole('button', { name: 'Проверить загрузку' }).click()
  await expect(page.locator('.snapshot-result')).toBeVisible()
  await page.getByRole('button', { name: 'Использовать три разных трека для теста' }).click()
  await page.getByLabel('Создать отдельный тестовый плейлист в моём Spotify').check()
  await page.getByRole('button', { name: 'Создать тестовый плейлист', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Удалить A только из теста' })).toBeEnabled()
  externalEdit()
  await page.getByRole('button', { name: 'Удалить A только из теста' }).click()
  await expect(page.getByRole('alert')).toContainText('изменился')
  expect(writes.some(({ method }) => method === 'DELETE')).toBe(false)
})
