import { reviewOption } from './helpers/music'
import { expect, test } from '@playwright/test'

test('demo reviews random URI groups, undoes decisions and applies only after preview without Spotify', async ({ page }) => {
  const spotify: string[] = []
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => { if (/spotify\.com|scdn\.co/.test(request.url())) spotify.push(request.url()) })
  await page.goto('/demo')
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await expect(page.getByRole('article', { name: 'Текущий трек' })).toBeVisible()
  const original = await page.locator('.track-details h2').innerText()
  await page.getByRole('button', { name: 'Убрать', exact: false }).click()
  await page.getByRole('button', { name: /Отменить решение/ }).click()
  await expect(page.locator('.track-details h2')).toHaveText(original)
  await page.getByRole('button', { name: 'Убрать', exact: false }).click()
  await page.getByRole('button', { name: 'Оставить', exact: false }).click()
  await reviewOption(page, 'Пропустить')
  await page.getByRole('button', { name: /Проверить решения/ }).click()
  await expect(page.locator('.preview-list li')).toHaveCount(1)
  const remaining = Number((await page.locator('.preview-heading > p').innerText()).match(/останется (\d+)/)?.[1])
  expect(remaining).toBeGreaterThanOrEqual(6)
  expect(remaining).toBeLessThan(8)
  await page.getByRole('button', { name: 'Применить в демо' }).click()
  await expect(page.getByRole('heading', { name: 'Результат совпал с планом.' })).toBeVisible()
  await expect(page.locator('.result-count')).toContainText(String(remaining))
  await page.getByRole('button', { name: 'Вернуться к плейлистам' }).click()
  await expect(page.getByRole('button', { name: /Ночная прогулка/ })).toContainText(`${remaining} записей`)
  expect(spotify).toEqual([])
  expect(pageErrors).toEqual([])
})

test('demo plays the local audio, supports seeking and pauses before leaving the card', async ({ page }) => {
  await page.goto('/demo')
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  // Wait for the initial autoplay attempt to settle; clicking a loading-time
  // toggle can race its transition from Play to Pause, especially in WebKit.
  await expect(page.getByRole('status')).toContainText(/Играет текущий трек|Нажми.*Слушать/)
  if ((await page.getByRole('status').innerText()).includes('Нажми')) {
    await page.getByRole('button', { name: 'Слушать', exact: true }).click()
  }
  await expect(page.getByRole('status')).toContainText('Играет текущий трек')
  await page.getByLabel('Позиция воспроизведения').fill('3000')
  await expect(page.locator('.music-time')).toContainText('0:03')
  await page.getByRole('button', { name: 'Пауза', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Звук на паузе')
  await reviewOption(page, 'Пропустить')
  await expect(page.getByLabel('Позиция воспроизведения')).toHaveValue('0')
  await expect(page.getByRole('button', { name: 'Слушать', exact: true })).toBeVisible()
})

test('empty and mixed playlists preserve non-reviewable entries', async ({ page }) => {
  await page.goto('/demo')
  await page.getByRole('button', { name: /Чистый лист/ }).click()
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await expect(page.getByRole('heading', { name: 'Можно проверить решения' })).toBeVisible()
  await reviewOption(page, 'Другой плейлист')
  await page.getByRole('button', { name: /Особенные записи/ }).click()
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await expect(page.getByText('3 особенных записей сохранятся в плейлисте.')).toBeVisible()
  await page.getByRole('button', { name: 'Убрать', exact: false }).click()
  await page.getByRole('button', { name: /Проверить решения/ }).first().click()
  await expect(page.locator('.preview-heading > p')).toContainText('останется 3')
  await page.getByRole('button', { name: 'Применить в демо' }).click()
  await expect(page.locator('.result-count')).toContainText('3')
})

for (const width of [390, 768, 1440]) {
  test(`demo card and decisions fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/demo')
    await page.getByRole('button', { name: /Начать разбор/ }).click()
    await expect(page.getByRole('article', { name: 'Текущий трек' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole('button', { name: 'Оставить', exact: false })).toBeVisible()
  })
}

test('audio failure requires an explicit choice before keep/remove becomes available', async ({ page }) => {
  await page.route('**/demo/*.wav', (route) => route.fulfill({ status: 404, body: 'not found' }))
  await page.goto('/demo')
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await expect(page.getByRole('status')).toContainText(/не загрузилось|не поддерживается/)
  await expect(page.getByRole('button', { name: 'Убрать', exact: false })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Оставить', exact: false })).toBeDisabled()
  await page.getByRole('button', { name: 'Продолжить без звука' }).click()
  await expect(page.getByRole('button', { name: 'Убрать', exact: false })).toBeEnabled()
  await page.getByRole('button', { name: 'Убрать', exact: false }).click()
  await expect(page.getByRole('status')).toContainText('Без звука')
})

test('a loading audio request can be paused before playback is confirmed', async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/demo/*.wav', async (route) => { await held; await route.continue() })
  await page.goto('/demo')
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await expect(page.getByRole('status')).toContainText('Загружаем звук')
  await expect(page.getByRole('button', { name: 'Убрать', exact: false })).toBeDisabled()
  await page.getByRole('button', { name: 'Пауза', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Звук на паузе')
  release()
  await expect(page.getByRole('button', { name: 'Слушать', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Убрать', exact: false })).toBeDisabled()
})
