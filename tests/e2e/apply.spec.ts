import { expect, test } from '@playwright/test'

test('reload reconciles a verified server change after a crash before local finalization', async ({ page }) => {
  await page.goto('/demo')
  const expected = await page.evaluate(async () => {
    const storagePath = '/src/lib/persistence/database.ts', gatewayPath = '/src/demo/gateway.ts'
    const applyPath = '/src/features/apply/coordinator.ts', domainPath = '/src/domain/playlist.ts', sessionPath = '/src/domain/session/index.ts'
    const [{ JamifyStorage }, { DemoPlaylistGateway }, { DurableApplyCoordinator }, { buildApplyPlan }, { createSession, currentUri, decide }] = await Promise.all([import(storagePath), import(gatewayPath), import(applyPath), import(domainPath), import(sessionPath)])
    const storage = new JamifyStorage(), gateway = new DemoPlaylistGateway(storage)
    const baseline = await gateway.loadBaseline('night-drive'), initial = createSession(baseline, 1)
    const session = decide(initial, currentUri(initial), 'remove'), saved = await storage.saveDraft(baseline, session, null)
    const plan = { ...buildApplyPlan(baseline, session.decisions, 'remove-uri-groups'), draftRevision: saved.revision, runId: session.runId }
    storage.operations.finish = async () => { throw new Error('simulated browser crash after server verify') }
    const result = await new DurableApplyCoordinator(gateway, storage).apply(plan)
    if (result.state !== 'unknown') throw new Error('Crash simulation did not interrupt finalization')
    await storage.close()
    return plan.expectedOrderedEntries.length
  })
  await page.reload()
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await expect(page.getByRole('heading', { name: 'Изменения не подтверждены.' })).toBeVisible()
  await page.getByRole('button', { name: 'Проверить результат', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Результат совпал с планом.' })).toBeVisible()
  await expect(page.locator('.result-count')).toContainText(String(expected))
  await expect(page.locator('.save-status')).toHaveText('Решения сохранены на этом устройстве')
})

test('an unknown unchanged request stays blocked after reload and read-only verification', async ({ page }) => {
  await page.goto('/demo')
  await page.evaluate(async () => {
    const paths = ['/src/lib/persistence/database.ts', '/src/demo/gateway.ts', '/src/features/apply/coordinator.ts', '/src/domain/playlist.ts', '/src/domain/session/index.ts']
    const [{ JamifyStorage }, { DemoPlaylistGateway }, { DurableApplyCoordinator }, { buildApplyPlan }, { createSession, currentUri, decide }] = await Promise.all(paths.map((path) => import(path)))
    const storage = new JamifyStorage(), gateway = new DemoPlaylistGateway(storage)
    const baseline = await gateway.loadBaseline('night-drive'), initial = createSession(baseline, 1)
    const session = decide(initial, currentUri(initial), 'remove'), saved = await storage.saveDraft(baseline, session, null)
    const plan = { ...buildApplyPlan(baseline, session.decisions, 'remove-uri-groups'), draftRevision: saved.revision, runId: session.runId }
    gateway.removeUriGroups = async () => { throw new Error('lost response') }
    await new DurableApplyCoordinator(gateway, storage).apply(plan); await storage.close()
  })
  await page.reload()
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await page.getByRole('button', { name: 'Проверить результат', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Изменения не подтверждены.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Продолжить применение' })).not.toBeVisible()
  await page.getByRole('button', { name: 'Вернуться к плейлистам' }).click()
  await expect(page.getByRole('button', { name: /Ночная прогулка/ })).toContainText('8 записей')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Очистить локальные демо-данные' }).click()
  await expect(page.getByRole('alert')).toContainText('незавершённая операция')
})
