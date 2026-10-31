import { expect, test } from '@playwright/test'

test('first run is honest about unverified integration and does not contact Spotify', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => { if (/spotify\.com|scdn\.co/.test(request.url())) requests.push(request.url()) })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Подключение Spotify' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Войти через Spotify' })).toBeVisible()
  await expect(page.getByLabel('Client ID приложения', { exact: true })).not.toBeVisible()
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '0')
  await expect(page.getByRole('button', { name: 'Проверка доступа', exact: true })).toBeDisabled()
  expect(requests).toEqual([])
})

test('invalid Client ID produces an inline error without leaving the app', async ({ page }) => {
  await page.goto('/')
  await page.getByText('Настройки разработчика', { exact: true }).click()
  await page.getByLabel('Client ID приложения', { exact: true }).fill('incorrect')
  await page.getByRole('button', { name: 'Войти через Spotify' }).click()
  await expect(page.getByRole('alert')).toContainText('32 символа')
  await expect(page).toHaveURL('http://127.0.0.1:5173/')
})

test('callback credentials are removed even when the OAuth transaction is missing', async ({ page }) => {
  await page.goto('/callback?code=fixture-code&state=fixture-state')
  await expect(page).toHaveURL('http://127.0.0.1:5173/')
  await expect(page.getByRole('alert')).toContainText('Вход устарел')
  await expect(page.locator('body')).not.toContainText('fixture-code')
})

for (const width of [390, 768, 1440]) {
  test(`setup fits ${width}px without horizontal scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await page.evaluate(() => document.fonts.ready)
    const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: window.innerWidth }))
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport)
    await expect(page.getByRole('button', { name: 'Войти через Spotify' })).toBeInViewport()
  })
}

test('blocked browser storage leaves a readable screen with connection disabled', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('storage blocked') } }) })
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('Браузер запретил хранилище')
  await expect(page.getByRole('button', { name: 'Войти через Spotify' })).toBeDisabled()
})

test('callback credentials are also removed when browser storage is blocked', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('storage blocked') } }) })
  await page.goto('/callback?code=fixture-code&state=fixture-state')
  await expect(page).toHaveURL('http://127.0.0.1:5173/')
  await expect(page.getByRole('alert')).toContainText('Браузер запретил хранилище')
})

test('keyboard can reach the connection action', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Войти через Spotify' }).focus()
  await page.keyboard.press('Tab')
  await expect(page.locator('summary')).toBeFocused()
})

test('a new account never inherits successful probe checks from a previous account', async ({ page }) => {
  await page.route('https://**/*', (route) => route.abort())
  await page.addInitScript(() => {
    sessionStorage.setItem('jamify.oauth.refresh.v1', JSON.stringify({ clientId: 'a'.repeat(32), refreshToken: 'fixture-refresh' }))
    sessionStorage.setItem('jamify.capability.probe.v1', JSON.stringify({
      operationId: 'fixture-operation', accountId: 'account-A', playlistId: 'old-test-playlist',
      status: 'verified', uris: ['A', 'B', 'C'].map((letter) => `spotify:track:${letter.repeat(22)}`), snapshotId: 'old-snapshot',
    }))
    window.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      let data: unknown
      if (url.origin === 'https://accounts.spotify.com') data = { access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600 }
      else if (url.pathname === '/v1/me') data = { id: 'account-B', display_name: 'Fixture account B' }
      else if (url.pathname === '/v1/me/playlists') data = { items: [], next: null, total: 0 }
      else throw new Error('Unexpected fixture request')
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Проверить мои плейлисты' })).toBeVisible()
  await page.getByRole('button', { name: 'Проверить мои плейлисты' }).click()
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '1')
  await expect(page.locator('body')).not.toContainText('old-test-playlist')
  await expect(page.getByRole('button', { name: 'Удалить A только из теста' })).toBeDisabled()
})
