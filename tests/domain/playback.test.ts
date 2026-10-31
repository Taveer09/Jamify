import { describe, expect, it, vi } from 'vitest'
import type { PlaybackState } from '../../src/contracts'
import { LocalPlaybackGateway } from '../../src/demo/playback'
import { demoEntry } from '../../src/demo/fixtures'

class FakeAudio extends EventTarget {
  preload = ''; volume = 0; src = ''; currentTime = 0; duration = 8
  play = vi.fn(async () => { this.dispatchEvent(new Event('playing')) })
  pause = vi.fn(() => this.dispatchEvent(new Event('pause')))
}
function setup() {
  const audios: FakeAudio[] = []
  const states: PlaybackState[] = []
  const playback = new LocalPlaybackGateway(() => { const audio = new FakeAudio(); audios.push(audio); return audio as unknown as HTMLAudioElement })
  playback.subscribe((state) => states.push(state))
  return { playback, audios, states }
}
describe('local demo playback', () => {
  it.each([
    ['NotAllowedError', 'разрешить звук'],
    ['NotSupportedError', 'формат не поддерживается'],
  ])('diagnoses %s without confusing a missing source with autoplay permission', async (name, message) => {
    const { playback, audios, states } = setup()
    playback.select(demoEntry(0))
    audios[0].play.mockRejectedValueOnce(new DOMException('fixture', name))
    await playback.play()
    expect(states.at(-1)?.status).toBe('error')
    expect(states.at(-1)?.message).toContain(message)
    playback.dispose()
  })
  it('ignores old media events after a card switch and confirms only the new actual URI', async () => {
    const { playback, audios, states } = setup()
    playback.select(demoEntry(0)); await playback.play()
    expect(states.at(-1)?.actualUri).toBe('demo:track:0')
    playback.select(demoEntry(1))
    audios[0].dispatchEvent(new Event('playing'))
    audios[0].dispatchEvent(new Event('error'))
    expect(states.at(-1)).toMatchObject({ actualUri: null, requestedUri: 'demo:track:1', status: 'idle' })
    await playback.play()
    expect(states.at(-1)).toMatchObject({ actualUri: 'demo:track:1', status: 'playing' })
    expect(audios[0].pause).toHaveBeenCalled()
    playback.dispose()
  })
  it('keeps a user-requested pause when an interrupted play rejects late', async () => {
    const { playback, audios, states } = setup()
    playback.select(demoEntry(0))
    let rejectPlay: ((error: Error) => void) | undefined
    audios[0].play.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject }))
    const request = playback.play()
    playback.pause()
    rejectPlay!(new Error('interrupted by pause'))
    await request
    expect(states.at(-1)).toMatchObject({ status: 'paused', actualUri: null, message: undefined })
    playback.dispose()
  })
  it('bounds seek and revokes playing evidence when audio ends or buffers', async () => {
    const { playback, audios, states } = setup()
    playback.select(demoEntry(0)); await playback.play()
    playback.seek(20_000)
    expect(audios[0].currentTime).toBe(8)
    audios[0].dispatchEvent(new Event('waiting'))
    expect(states.at(-1)).toMatchObject({ status: 'loading', actualUri: null })
    audios[0].dispatchEvent(new Event('ended'))
    expect(states.at(-1)).toMatchObject({ status: 'paused', actualUri: null })
    playback.dispose()
    const count = states.length
    audios[0].dispatchEvent(new Event('playing'))
    expect(states).toHaveLength(count)
  })
})
