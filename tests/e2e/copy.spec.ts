import { expect, test } from '@playwright/test'

test('large copy verifies all 3200 unique entries without changing its 10000-entry source', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/demo')
  await page.getByRole('button', { name: /Большая коллекция/ }).click()
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await page.getByRole('button', { name: /Проверить решения/ }).click()
  await page.getByRole('radio', { name: 'Создать копию без дублей' }).check()
  await expect(page.getByRole('heading', { name: 'Создать копию из 3200 записей?' })).toBeVisible()
  // A collapsed contents disclosure must not mount thousands of offscreen rows.
  await expect(page.locator('.copy-contents li')).toHaveCount(0)
  await page.getByRole('button', { name: 'Создать копию в демо' }).click()
  await expect(page.getByRole('heading', { name: 'Результат совпал с планом.' })).toBeVisible({ timeout: 90_000 })
  await expect(page.locator('.result-count')).toContainText('3200')
  await expect(page.getByText('Исходный плейлист сохранён: 10000 записей.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Вернуться к плейлистам' }).click()
  await expect(page.getByRole('button', { name: /Большая коллекция.*10.000 записей/ })).toBeVisible()
  await expect(page.locator('.playlist-option')).toHaveCount(5)
})

test('clean copy preserves source and keeps the first exact URI in source order, including after reload', async ({ page }) => {
  const errors: string[] = [], spotify: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => { if (/spotify\.com|scdn\.co/.test(request.url())) spotify.push(request.url()) })
  await page.goto('/demo')
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await page.getByRole('button', { name: /Проверить решения/ }).click()
  await page.getByRole('radio', { name: 'Создать копию без дублей' }).check()
  await expect(page.getByRole('heading', { name: 'Создать копию из 6 записей?' })).toBeVisible()
  await expect(page.locator('.preview-heading > p')).toContainText('2 точных дублей исключено')
  await page.locator('.copy-contents summary').click()
  await expect(page.locator('.copy-contents li strong')).toHaveText(['After Hours', 'Open Window', 'Slow Motion', 'City / 04:17', 'Almost Home', 'Low Tide'])
  await page.getByRole('button', { name: 'Создать копию в демо', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Результат совпал с планом.' })).toBeVisible()
  await expect(page.locator('.result-count')).toContainText('6')
  await expect(page.getByText('Исходный плейлист сохранён: 8 записей.', { exact: false })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: /Ночная прогулка.*8 записей/ })).toBeVisible()
  await expect(page.locator('.playlist-option')).toHaveCount(5)
  const contents = await page.evaluate(async () => {
    const path = '/src/demo/gateway.ts', storagePath = '/src/lib/persistence/database.ts'
    const [{ DemoPlaylistGateway }, { JamifyStorage }] = await Promise.all([import(path), import(storagePath)])
    const storage = new JamifyStorage(), gateway = new DemoPlaylistGateway(storage)
    const lists = await gateway.listPlaylists()
    const copy = lists.find((list: { id: string }) => !['night-drive', 'mixed', 'empty', 'large'].includes(list.id))
    const source = await gateway.loadBaseline('night-drive'), target = await gateway.loadBaseline(copy.id)
    await storage.close()
    return { source: source.orderedEntries.map((entry: { sourceUri: string }) => entry.sourceUri), target: target.orderedEntries.map((entry: { sourceUri: string }) => entry.sourceUri) }
  })
  expect(contents.source).toEqual(['demo:track:0', 'demo:track:1', 'demo:track:0', 'demo:track:2', 'demo:track:3', 'demo:track:1', 'demo:track:4', 'demo:track:5'])
  expect(contents.target).toEqual(['demo:track:0', 'demo:track:1', 'demo:track:2', 'demo:track:3', 'demo:track:4', 'demo:track:5'])
  expect(errors).toEqual([])
  expect(spotify).toEqual([])
})

test('mixed entries block a clean copy without losing them or writing source', async ({ page }) => {
  await page.goto('/demo')
  await page.getByRole('button', { name: /Особенные записи/ }).click()
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await page.getByRole('button', { name: /Проверить решения/ }).click()
  await page.getByRole('radio', { name: 'Создать копию без дублей' }).check()
  await expect(page.getByRole('alert')).toContainText('Копию нельзя создать без потерь')
  await expect(page.getByRole('button', { name: 'Создать копию в демо' })).toBeDisabled()
  await page.getByRole('radio', { name: 'Убрать из исходника' }).check()
  await expect(page.getByRole('button', { name: 'Применить в демо' })).toBeEnabled()
  await expect(page.locator('.preview-heading > p')).toContainText('останется 4')
})

test('reload verifies an existing copy after a crash before receipt finalization', async ({ page }) => {
  await page.goto('/demo')
  await page.evaluate(async () => {
    const paths = ['/src/lib/persistence/database.ts', '/src/demo/gateway.ts', '/src/features/apply/coordinator.ts', '/src/domain/playlist.ts', '/src/domain/session/index.ts']
    const [{ JamifyStorage }, { DemoPlaylistGateway }, { DurableApplyCoordinator }, { buildApplyPlan }, { createSession }] = await Promise.all(paths.map((path) => import(path)))
    const storage = new JamifyStorage(), gateway = new DemoPlaylistGateway(storage)
    const baseline = await gateway.loadBaseline('night-drive'), session = createSession(baseline, 1), saved = await storage.saveDraft(baseline, session, null)
    const plan = { ...buildApplyPlan(baseline, session.decisions, 'create-clean-copy'), draftRevision: saved.revision, runId: session.runId }
    storage.operations.finish = async () => { throw new Error('simulated crash before local receipt') }
    const result = await new DurableApplyCoordinator(gateway, storage).apply(plan)
    if (result.state !== 'unknown') throw new Error('Crash did not interrupt copy finalization')
    await storage.close()
  })
  await page.reload()
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await page.getByRole('button', { name: 'Проверить результат', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Результат совпал с планом.' })).toBeVisible()
  await expect(page.locator('.result-count')).toContainText('6')
  await expect(page.getByText('Исходный плейлист сохранён: 8 записей.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Вернуться к плейлистам' }).click()
  await expect(page.locator('.playlist-option')).toHaveCount(5)
})

test('lost create response never creates another copy after reload or read-only recovery', async ({ page }) => {
  await page.goto('/demo')
  await page.evaluate(async () => {
    const paths = ['/src/lib/persistence/database.ts', '/src/demo/gateway.ts', '/src/features/apply/coordinator.ts', '/src/domain/playlist.ts', '/src/domain/session/index.ts']
    const [{ JamifyStorage }, { DemoPlaylistGateway }, { DurableApplyCoordinator }, { buildApplyPlan }, { createSession }] = await Promise.all(paths.map((path) => import(path)))
    const storage = new JamifyStorage(), gateway = new DemoPlaylistGateway(storage)
    const baseline = await gateway.loadBaseline('night-drive'), session = createSession(baseline, 1), saved = await storage.saveDraft(baseline, session, null)
    const plan = { ...buildApplyPlan(baseline, session.decisions, 'create-clean-copy'), draftRevision: saved.revision, runId: session.runId }
    const create = gateway.createPrivatePlaylist.bind(gateway)
    gateway.createPrivatePlaylist = async (name: string) => { await create(name); throw new Error('lost create response') }
    const result = await new DurableApplyCoordinator(gateway, storage).apply(plan)
    if (result.state !== 'unknown') throw new Error('Lost create response was incorrectly confirmed')
    await storage.close()
  })
  await page.reload()
  await expect(page.locator('.playlist-option')).toHaveCount(5)
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await page.getByRole('button', { name: 'Проверить результат', exact: true }).click()
  await expect(page.getByText('Ответ создания потерян:', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Продолжить применение' })).not.toBeVisible()
  await page.getByRole('button', { name: 'Вернуться к плейлистам' }).click()
  await expect(page.locator('.playlist-option')).toHaveCount(5)
  await expect(page.getByRole('button', { name: /Ночная прогулка.*8 записей/ })).toBeVisible()
})
