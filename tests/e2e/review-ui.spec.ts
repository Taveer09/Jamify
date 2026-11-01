import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

declare global {
  interface Window {
    reviewAudio: HTMLAudioElement[]
    reviewHarness: {
      events: Array<{ uri: string; decision: string }>
      undos: number
      update: (props: { index?: number; disabled?: boolean; canDecide?: boolean; canUndo?: boolean }) => void
    }
  }
}

async function mountComponents(page: Page) {
  await page.goto('/demo')
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js'
    const domPath = '/node_modules/.vite/deps/react-dom_client.js'
    const cardPath = '/src/components/ReviewCard.tsx'
    const controlsPath = '/src/components/ReviewControls.tsx'
    const [{ default: { createElement: h } }, { default: { createRoot } }, { ReviewCard }, { ReviewControls }] = await Promise.all([import(reactPath), import(domPath), import(cardPath), import(controlsPath)])
    document.getElementById('root')!.style.display = 'none'
    const container = document.createElement('main')
    container.className = 'review-workspace'
    container.style.maxWidth = '480px'
    document.body.append(container)
    const root = createRoot(container)
    let state = { index: 0, disabled: false, canDecide: true, canUndo: true }
    const events: Array<{ uri: string; decision: string }> = []
    const onDecision = (uri: string, decision: string) => { events.push({ uri, decision }); state.index += 1; render() }
    const onUndo = () => { window.reviewHarness.undos += 1; state.index = Math.max(0, state.index - 1); render() }
    function render() {
      const uri = `demo:track:${state.index}`
      const entry = { entryKey: uri, originalIndex: state.index, sourceUri: uri, observedUri: uri, playbackUri: uri, identityConfidence: 'confirmed', kind: 'track', title: `Трек ${state.index}`, artist: 'Jamify Lab', imageUrl: '/demo/slate.svg', spotifyUrl: null, durationMs: 8000, canPlay: true, canCopy: true, canRemove: true }
      root.render(h('div', null,
        h(ReviewCard, { entry, occurrences: 2, canDecide: state.canDecide, disabled: state.disabled, onDecision }),
        h(ReviewControls, { entryUri: uri, canDecide: state.canDecide, disabled: state.disabled, canUndo: state.canUndo, onDecision, onUndo }),
        h('input', { 'aria-label': 'Тестовый ползунок', type: 'range' }),
        h('textarea', { 'aria-label': 'Тестовый текст' }),
        h('a', { href: '#', id: 'focus-link' }, 'Ссылка'),
        h('div', { contentEditable: true, id: 'focus-editor', suppressContentEditableWarning: true }, 'Редактор'),
      ))
    }
    window.reviewHarness = { events, undos: 0, update: (props) => { state = { ...state, ...props }; render() } }
    render()
  })
  await expect(page.locator('.track-details h2')).toHaveText('Трек 0')
}

async function swipe(page: Page, direction: 'left' | 'right') {
  const box = await page.locator('.album-cover').boundingBox()
  if (!box) throw new Error('Missing album cover')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + (direction === 'right' ? 100 : -100), y + 2, { steps: 5 })
  await page.mouse.up()
}

async function bodyFocus(page: Page) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
}

test.describe('review components', () => {
  test.beforeEach(async ({ page }) => { await mountComponents(page) })

  test('keyboard decisions, undo and all disabled gates', async ({ page }) => {
    await page.keyboard.press('ArrowLeft')
    await expect(page.locator('.track-details h2')).toHaveText('Трек 1')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.track-details h2')).toHaveText('Трек 2')
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('.track-details h2')).toHaveText('Трек 3')
    await page.keyboard.press('Control+z')
    await expect(page.locator('.track-details h2')).toHaveText('Трек 2')
    await page.keyboard.press('Meta+z')
    await expect(page.locator('.track-details h2')).toHaveText('Трек 1')
    expect(await page.evaluate(() => window.reviewHarness.events.map((event) => event.decision))).toEqual(['remove', 'keep', 'skip'])
    expect(await page.evaluate(() => window.reviewHarness.undos)).toBe(2)
    await page.evaluate(() => window.reviewHarness.update({ canDecide: false, canUndo: false }))
    await expect(page.getByRole('button', { name: 'Убрать' })).toBeDisabled()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Control+z')
    await expect(page.locator('.track-details h2')).toHaveText('Трек 1')
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('.track-details h2')).toHaveText('Трек 2')
    await page.evaluate(() => window.reviewHarness.update({ disabled: true }))
    await expect(page.getByRole('button', { name: 'Пропустить', exact: true })).toBeDisabled()
    await bodyFocus(page)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Control+z')
    await swipe(page, 'right')
    expect(await page.evaluate(() => window.reviewHarness.events.length)).toBe(4)
    expect(await page.evaluate(() => window.reviewHarness.undos)).toBe(2)
  })

  test('shortcuts ignore focused interactive elements, repeat and modifiers', async ({ page }) => {
    for (const selector of ['input', 'textarea', '#focus-link', '#focus-editor', '.decision-keep']) {
      await page.locator('main.review-workspace').locator(selector).focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Control+z')
    }
    await bodyFocus(page)
    // Dispatch conflicts without triggering the browser's own Back navigation.
    await page.evaluate(() => {
      for (const init of [{ key: 'ArrowRight', altKey: true }, { key: 'ArrowRight', ctrlKey: true }, { key: 'ArrowLeft', metaKey: true }, { key: 'z', ctrlKey: true, shiftKey: true }]) document.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }))
    })
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true })))
    expect(await page.evaluate(() => window.reviewHarness.events)).toEqual([])
    expect(await page.evaluate(() => window.reviewHarness.undos)).toBe(0)
  })

  test('horizontal swipe commits the captured URI and preserves full artwork', async ({ page }) => {
    await expect(page.locator('.track-details')).toContainText('2 вхождения')
    expect(await page.locator('.album-cover').evaluate((image) => getComputedStyle(image).objectFit)).toBe('contain')
    expect(await page.locator('.swipe-card').evaluate((card) => getComputedStyle(card).touchAction)).toBe('pan-y')
    await swipe(page, 'right')
    await expect(page.locator('.track-details h2')).toHaveText('Трек 1')
    await swipe(page, 'left')
    await expect(page.locator('.track-details h2')).toHaveText('Трек 2')
    expect(await page.evaluate(() => window.reviewHarness.events)).toEqual([{ uri: 'demo:track:0', decision: 'keep' }, { uri: 'demo:track:1', decision: 'remove' }])
  })

  test('pointercancel, lost capture, vertical movement and subthreshold drag make no decision', async ({ page }) => {
    const card = page.locator('.swipe-card')
    for (const end of ['pointercancel', 'lostpointercapture', 'vertical', 'short']) {
      const box = (await page.locator('.album-cover').boundingBox())!
      await page.mouse.move(box.x + 40, box.y + 40)
      await page.mouse.down()
      await page.mouse.move(box.x + (end === 'short' ? 60 : end === 'vertical' ? 42 : 150), box.y + (end === 'vertical' ? 150 : 42))
      if (end === 'pointercancel' || end === 'lostpointercapture') await card.dispatchEvent(end, { pointerId: 1 })
      await page.mouse.up()
      await expect(card).not.toHaveAttribute('data-dragging')
    }
    expect(await page.evaluate(() => window.reviewHarness.events)).toEqual([])
  })

  test('new props during a drag cannot decide the replacement card', async ({ page }) => {
    const box = (await page.locator('.album-cover').boundingBox())!
    await page.mouse.move(box.x + 40, box.y + 40)
    await page.mouse.down()
    await page.mouse.move(box.x + 150, box.y + 40)
    await page.evaluate(() => window.reviewHarness.update({ index: 5 }))
    await expect(page.locator('.track-details h2')).toHaveText('Трек 5')
    await page.mouse.up()
    expect(await page.evaluate(() => window.reviewHarness.events)).toEqual([])
    await swipe(page, 'left')
    await expect(page.locator('.track-details h2')).toHaveText('Трек 6')
    expect(await page.evaluate(() => window.reviewHarness.events)).toEqual([{ uri: 'demo:track:5', decision: 'remove' }])
  })

  test('reduced motion preserves swipe decisions without moving artwork', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const box = (await page.locator('.album-cover').boundingBox())!
    await page.mouse.move(box.x + 40, box.y + 40)
    await page.mouse.down()
    await page.mouse.move(box.x + 150, box.y + 40)
    expect(await page.locator('.track-card-motion').evaluate((node) => getComputedStyle(node).transform)).toBe('none')
    expect(await page.locator('.track-card-motion').evaluate((node) => getComputedStyle(node).transitionDuration)).toBe('0s')
    await page.mouse.up()
    await expect(page.locator('.track-details h2')).toHaveText('Трек 1')
  })

  test('ten rapid swipe decisions remain unique and in order', async ({ page }) => {
    for (let index = 0; index < 10; index++) {
      await swipe(page, index % 2 ? 'left' : 'right')
      await expect(page.locator('.track-details h2')).toHaveText(`Трек ${index + 1}`)
    }
    const events = await page.evaluate(() => window.reviewHarness.events)
    expect(events.map((event) => event.uri)).toEqual(Array.from({ length: 10 }, (_, index) => `demo:track:${index}`))
    expect(events.map((event) => event.decision)).toEqual(Array.from({ length: 10 }, (_, index) => index % 2 ? 'remove' : 'keep'))
  })
})

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 900 }, { width: 1440, height: 900 }]) {
  test(`review demo fits first fold ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/demo')
    await page.getByRole('button', { name: /Начать разбор/ }).click()
    await expect(page.locator('.swipe-card')).toBeVisible()
    for (const name of ['Убрать', 'Оставить', 'Пропустить']) {
      const box = await page.getByRole('button', { name, exact: name === 'Пропустить' }).boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/jamify-review-${viewport.width}.png`, fullPage: true })
  })
}

test('review demo keyboard, undo, swipe and ten rapid decisions keep audio bound to the card', async ({ page }) => {
  await page.route('**/demo/*.wav', (route) => route.fulfill({ status: 404, body: 'not found' }))
  await page.goto('/demo')
  await page.getByRole('button', { name: /Большая коллекция/ }).click()
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await page.getByRole('button', { name: 'Продолжить без звука' }).click()
  await bodyFocus(page)
  const original = await page.locator('.track-details h2').innerText()
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.track-details h2')).not.toHaveText(original)
  await page.keyboard.press('Control+z')
  await expect(page.locator('.track-details h2')).toHaveText(original)
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.track-details h2')).not.toHaveText(original)
  for (let index = 0; index < 10; index++) {
    const previous = await page.locator('.track-details h2').innerText()
    await swipe(page, index % 2 ? 'left' : 'right')
    await expect(page.locator('.track-details h2')).not.toHaveText(previous)
    await expect(page.locator('.session-progress > span')).toContainText(`${index + 3} / 25`)
    await expect(page.getByRole('button', { name: 'Слушать', exact: true })).toBeVisible()
    await expect(page.locator('#demo-seek')).toHaveValue('0')
    await expect(page.getByRole('status')).not.toContainText('Играет текущий трек')
  }
})

test('review demo restores the last card with keyboard undo after the session ends', async ({ page }) => {
  await page.goto('/demo')
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await bodyFocus(page)
  for (let index = 0; index < 5; index++) {
    const previous = await page.locator('.track-details h2').innerText()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('.track-details h2')).not.toHaveText(previous)
  }
  const last = await page.locator('.track-details h2').innerText()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('heading', { name: 'Сессия завершена.' })).toBeVisible()
  await expect(page.getByRole('article', { name: 'Текущий трек' })).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(page.locator('.track-details h2')).toHaveText(last)
  await expect(page.locator('.session-progress > span')).toContainText('6 / 6')
})

// Hold only exits so assertions exercise the interval before a decision commits,
// without relying on machine speed or extending production animation durations.
async function holdExits(page: Page) {
  await page.evaluate(() => {
    const animate = Element.prototype.animate
    Element.prototype.animate = function (frames, options) {
      const animation = animate.call(this, frames, options)
      if (Array.isArray(frames) && frames.at(-1)?.opacity === 0) {
        animation.pause()
        animation.currentTime = 40
      }
      return animation
    }
  })
}

async function startSilentReview(page: Page) {
  await page.route('**/demo/*.wav', (route) => route.fulfill({ status: 404, body: 'missing' }))
  await page.goto('/demo')
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await page.getByRole('button', { name: 'Продолжить без звука' }).click()
  await holdExits(page)
}

test('exit stays on its track, undo cancels the first pending choice and buttons can retry', async ({ page }) => {
  await startSilentReview(page)
  const title = await page.locator('.track-details h2').innerText()
  await page.getByRole('button', { name: 'Оставить', exact: true }).click()
  await expect(page.locator('.swipe-card')).toHaveAttribute('data-exiting', 'keep')
  await expect(page.locator('.track-details h2')).toHaveText(title)
  await expect(page.locator('.session-progress > span')).toContainText('1 / 6')
  await page.getByRole('button', { name: 'Отменить решение', exact: true }).click()
  await expect(page.locator('.swipe-card')).not.toHaveAttribute('data-exiting')
  await expect(page.locator('.track-details h2')).toHaveText(title)
  await page.getByRole('button', { name: 'Убрать', exact: true }).click()
  await expect(page.locator('.swipe-card')).toHaveAttribute('data-exiting', 'remove')
  await page.locator('.track-card-motion').evaluate((node) => node.getAnimations().forEach((animation) => animation.finish()))
  await expect(page.locator('.session-progress > span')).toContainText('2 / 6')
  await expect(page.locator('.track-details h2')).not.toHaveText(title)
  await expect(page.locator('.review-summary')).toContainText('Групп на удаление1')
})

test('grabbing an exiting card and pointercancel aborts the pending choice; feedback never covers art', async ({ page }) => {
  await startSilentReview(page)
  const title = await page.locator('.track-details h2').innerText()
  await swipe(page, 'right')
  await expect(page.locator('.swipe-card')).toHaveAttribute('data-exiting', 'keep')
  // The silent-mode control may have scrolled the article partly above the viewport.
  await page.locator('.swipe-card').evaluate((node) => node.scrollIntoView({ block: 'center' }))
  // Grab a visible edge of the article while its child is exiting.
  const box = (await page.locator('.swipe-card').boundingBox())!
  await page.mouse.move(box.x + box.width - 20, box.y + 80)
  await page.mouse.down()
  await expect(page.locator('.swipe-card')).not.toHaveAttribute('data-exiting')
  await page.mouse.move(box.x + box.width - 55, box.y + 80)
  const art = (await page.locator('.album-cover').boundingBox())!
  const feedback = (await page.locator('.swipe-feedback').boundingBox())!
  expect(feedback.y).toBeGreaterThanOrEqual(art.y + art.height)
  await page.locator('.swipe-card').dispatchEvent('pointercancel', { pointerId: 1 })
  await page.mouse.up()
  await expect(page.locator('.track-details h2')).toHaveText(title)
  await expect(page.locator('.session-progress > span')).toContainText('1 / 6')
  await expect(page.locator('.swipe-card')).not.toHaveAttribute('data-dragging')
  await bodyFocus(page)
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.session-progress > span')).toContainText('2 / 6')
  await expect(page.locator('.swipe-card')).not.toHaveAttribute('data-exiting')
})

test('a replacement or disabled card invalidates a deferred exit', async ({ page }) => {
  await mountComponents(page)
  await holdExits(page)
  await swipe(page, 'left')
  await expect(page.locator('.swipe-card')).toHaveAttribute('data-exiting', 'remove')
  await page.evaluate(() => window.reviewHarness.update({ index: 5 }))
  await expect(page.locator('.track-details h2')).toHaveText('Трек 5')
  expect(await page.evaluate(() => window.reviewHarness.events)).toEqual([])
  await swipe(page, 'right')
  await page.evaluate(() => window.reviewHarness.update({ disabled: true }))
  await expect(page.locator('.swipe-card')).not.toHaveAttribute('data-exiting')
  expect(await page.evaluate(() => window.reviewHarness.events)).toEqual([])
})

test('real local audio remains bound through exit, next-card loading and undo', async ({ page }) => {
  const spotifyRequests: string[] = []
  await page.route(/https:\/\/.*spotify\.com\//, (route) => { spotifyRequests.push(route.request().url()); return route.abort() })
  await page.addInitScript(() => {
    window.reviewAudio = []
    const NativeAudio = window.Audio
    window.Audio = class extends NativeAudio {
      constructor(src?: string) { super(src); window.reviewAudio.push(this) }
    }
  })
  await page.goto('/demo')
  await page.getByRole('button', { name: /Начать разбор/ }).click()
  await expect(page.getByRole('status')).toContainText(/Играет текущий трек|Нажми.*Слушать/)
  if ((await page.getByRole('status').innerText()).includes('Нажми')) await page.getByRole('button', { name: 'Слушать', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Играет текущий трек')
  const original = await page.locator('.track-details h2').innerText()
  const source = await page.evaluate(() => window.reviewAudio.at(-1)!.src)
  await holdExits(page)
  await page.getByRole('button', { name: 'Убрать', exact: true }).click()
  await expect(page.locator('.track-details h2')).toHaveText(original)
  await expect.poll(() => page.evaluate(() => window.reviewAudio.at(-1)!.src)).toBe(source)
  await page.locator('.track-card-motion').evaluate((node) => node.getAnimations().forEach((animation) => animation.finish()))
  await expect(page.locator('.track-details h2')).not.toHaveText(original)
  await expect(page.getByRole('status')).toContainText('Играет текущий трек')
  expect(await page.evaluate(() => { const audio = window.reviewAudio.at(-1)!; return !audio.paused && audio.currentTime >= 0 })).toBe(true)
  await page.getByRole('button', { name: 'Отменить решение', exact: true }).click()
  await expect(page.locator('.track-details h2')).toHaveText(original)
  await expect.poll(() => page.evaluate(() => window.reviewAudio.at(-1)!.src)).toBe(source)
  await expect(page.getByRole('status')).toContainText('Играет текущий трек')
  expect(spotifyRequests).toEqual([])
})
