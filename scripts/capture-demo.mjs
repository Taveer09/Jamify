import { chromium } from '@playwright/test'
import process from 'node:process'
import { log } from 'node:console'
import { mkdir } from 'node:fs/promises'

// A fresh browser context deliberately has no Spotify grant or personal data.
const origin = process.env.JAMIFY_CAPTURE_URL || 'http://127.0.0.1:5173'
await mkdir('docs/media/raw', { recursive: true })
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: 'docs/media/raw' } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
await page.route(/spotify\.com|scdn\.co/, (route) => route.abort())
try {
  await page.goto(`${origin}/demo`)
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await page.getByRole('status').filter({ hasText: /Играет текущий трек|Нажми.*Слушать/ }).waitFor()
  if ((await page.getByRole('status').innerText()).includes('Нажми')) await page.getByRole('button', { name: 'Слушать', exact: true }).click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: 'docs/media/review.png', fullPage: true })
  await page.getByRole('button', { name: 'Убрать', exact: false }).click()
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: /Отменить решение/ }).click()
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: 'Оставить', exact: false }).click()
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: /Проверить решения/ }).click()
  await page.getByRole('radio', { name: 'Создать копию без дублей' }).check()
  await page.locator('.copy-contents summary').click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: 'docs/media/copy-preview.png', fullPage: true })
  await page.getByRole('button', { name: 'Создать копию в демо' }).click()
  await page.getByRole('heading', { name: 'Результат совпал с планом.' }).waitFor()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: 'docs/media/copy-result.png', fullPage: true })
  if (errors.length) throw new Error(`Demo raised ${errors.length} browser errors: ${errors.join('; ')}`)
} finally {
  const video = page.video()
  await context.close()
  log(`Video: ${await video.path()}`)
  await browser.close()
}
