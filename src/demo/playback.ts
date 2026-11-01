import type { Entry, PlaybackGateway, PlaybackState } from '../contracts'
import { demoSample } from './fixtures'

export class LocalPlaybackGateway implements PlaybackGateway {
  private audio: HTMLAudioElement | null = null
  private listeners = new Set<(state: PlaybackState) => void>()
  private state: PlaybackState = { requestedUri: null, actualUri: null, generation: 0, status: 'idle', positionMs: 0, durationMs: 0 }
  private disposed = false
  private playAttempt = 0
  constructor(private factory: () => HTMLAudioElement = () => new Audio()) {}
  private publish(patch: Partial<PlaybackState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener({ ...this.state })
  }
  select(entry: Entry): void {
    if (this.disposed) return
    this.playAttempt++
    const generation = this.state.generation + 1
    // Invalidate old event callbacks before pause() dispatches anything.
    this.state = { ...this.state, generation }
    this.audio?.pause()
    this.audio = null
    this.publish({ requestedUri: entry.playbackUri, actualUri: null, status: 'idle', positionMs: 0, durationMs: entry.durationMs ?? 0, message: undefined })
    if (!entry.canPlay || !entry.playbackUri) return
    const audio = this.factory()
    this.audio = audio
    audio.preload = 'metadata'
    audio.volume = 0.25
    const current = () => !this.disposed && this.audio === audio && generation === this.state.generation
    audio.addEventListener('playing', () => { if (current()) this.publish({ status: 'playing', actualUri: entry.playbackUri, message: undefined }) })
    audio.addEventListener('pause', () => { if (current()) this.publish({ status: 'paused', actualUri: null }) })
    audio.addEventListener('ended', () => { if (current()) this.publish({ status: 'paused', actualUri: null }) })
    audio.addEventListener('waiting', () => { if (current()) this.publish({ status: 'loading', actualUri: null }) })
    audio.addEventListener('timeupdate', () => { if (current()) this.publish({ positionMs: Math.round(audio.currentTime * 1000) }) })
    audio.addEventListener('loadedmetadata', () => { if (current() && Number.isFinite(audio.duration)) this.publish({ durationMs: Math.round(audio.duration * 1000) }) })
    audio.addEventListener('error', () => { if (current()) this.publish({ status: 'error', actualUri: null, message: 'Демо-аудио не загрузилось. Попробуй ещё раз.' }) })
    audio.src = demoSample(entry)
  }
  async play(): Promise<void> {
    const audio = this.audio
    const generation = this.state.generation
    if (!audio || this.disposed) return
    const attempt = ++this.playAttempt
    this.publish({ status: 'loading', actualUri: null, message: undefined })
    try { await audio.play() }
    catch (error) {
      const name = error instanceof Error ? error.name : ''
      const message = name === 'NotAllowedError' ? 'Нажми «Слушать», чтобы разрешить звук в браузере.'
        : name === 'NotSupportedError' || audio.error ? 'Демо-аудио не загрузилось или формат не поддерживается.'
          : 'Не удалось воспроизвести демо-аудио. Попробуй ещё раз.'
      if (!this.disposed && generation === this.state.generation && attempt === this.playAttempt) this.publish({ status: 'error', actualUri: null, message })
    }
  }
  pause(): void { this.playAttempt++; this.audio?.pause(); if (!this.disposed) this.publish({ status: 'paused', actualUri: null, message: undefined }) }
  seek(positionMs: number): void {
    if (!this.audio || !Number.isFinite(positionMs)) return
    const bounded = Math.min(Math.max(positionMs, 0), this.state.durationMs)
    this.audio.currentTime = bounded / 1000
    this.publish({ positionMs: bounded })
  }
  subscribe(listener: (state: PlaybackState) => void): () => void {
    this.listeners.add(listener)
    listener({ ...this.state })
    return () => { this.listeners.delete(listener) }
  }
  dispose(): void {
    this.disposed = true
    this.playAttempt++
    this.state.generation++
    this.audio?.pause(); this.audio = null; this.listeners.clear()
  }
}
