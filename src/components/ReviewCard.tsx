import { useLayoutEffect, useRef } from 'react'
import type { PointerEvent } from 'react'
import type { ReviewCardProps } from '../contracts/review-ui'
import '../styles/review-interactions.css'

type Gesture = { id: number; uri: string; x: number; y: number; offset: number; width: number; horizontal: boolean }

export function ReviewCard({ entry, occurrences, canDecide, disabled, onDecision }: ReviewCardProps) {
  const card = useRef<HTMLElement>(null)
  const motion = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const submitted = useRef<string | null>(null)

  function reset() {
    gesture.current = null
    if (card.current) { delete card.current.dataset.dragging; delete card.current.dataset.direction }
    if (motion.current) motion.current.style.transform = ''
  }

  useLayoutEffect(() => {
    gesture.current = null
    if (card.current) { delete card.current.dataset.dragging; delete card.current.dataset.direction }
    if (motion.current) motion.current.style.transform = ''
  }, [entry.sourceUri, disabled, canDecide])
  useLayoutEffect(() => { submitted.current = null }, [entry.sourceUri])

  function begin(event: PointerEvent<HTMLElement>) {
    if (disabled || !canDecide || !entry.sourceUri || submitted.current === entry.sourceUri || gesture.current || !event.isPrimary || event.button !== 0) return
    if ((event.target as HTMLElement).closest('a,button,input,select,textarea,[contenteditable]')) return
    // Interrupt a returning card at its current position instead of jumping it.
    const offset = motion.current ? new DOMMatrixReadOnly(getComputedStyle(motion.current).transform).m41 : 0
    gesture.current = { id: event.pointerId, uri: entry.sourceUri, x: event.clientX, y: event.clientY, offset, width: event.currentTarget.clientWidth, horizontal: false }
    event.currentTarget.dataset.dragging = 'true'
    if (motion.current) motion.current.style.transform = `translateX(${offset}px)`
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function move(event: PointerEvent<HTMLElement>) {
    const active = gesture.current
    if (!active || active.id !== event.pointerId) return
    const dx = event.clientX - active.x
    const dy = event.clientY - active.y
    if (!active.horizontal && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { reset(); return }
    if (!active.horizontal && Math.abs(dx) > 10) active.horizontal = true
    if (!active.horizontal) return
    const threshold = Math.min(80, active.width * 0.2)
    event.currentTarget.dataset.direction = Math.abs(dx) >= threshold ? dx > 0 ? 'keep' : 'remove' : ''
    if (motion.current && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      motion.current.style.transform = `translateX(${Math.max(-active.width, Math.min(active.width, dx + active.offset))}px)`
    }
  }

  function cancel(event: PointerEvent<HTMLElement>) {
    if (gesture.current?.id === event.pointerId) reset()
  }

  function finish(event: PointerEvent<HTMLElement>) {
    const active = gesture.current
    if (!active || active.id !== event.pointerId) return
    const dx = event.clientX - active.x
    const commit = active.horizontal && Math.abs(dx) >= Math.min(80, active.width * 0.2) && Math.abs(dx) > Math.abs(event.clientY - active.y)
    reset()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    // Capture identity at pointerdown. A changed card must never inherit this gesture.
    if (commit && !disabled && canDecide && active.uri === entry.sourceUri && submitted.current !== active.uri) {
      submitted.current = active.uri
      onDecision(active.uri, dx > 0 ? 'keep' : 'remove')
    }
  }

  return <article ref={card} className="track-card swipe-card" aria-label="Текущий трек" onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}>
    <div ref={motion} className="track-card-motion">
      {entry.imageUrl ? <img className="album-cover" src={entry.imageUrl} alt={`Обложка: ${entry.title}`} width="320" height="320" draggable="false" /> : <div className="album-cover album-placeholder" aria-label="Обложка недоступна">Нет обложки</div>}
      <div className="track-details"><p className="small">{occurrences} {occurrences % 10 === 1 && occurrences % 100 !== 11 ? 'вхождение' : [2, 3, 4].includes(occurrences % 10) && ![12, 13, 14].includes(occurrences % 100) ? 'вхождения' : 'вхождений'} в плейлисте</p><h2>{entry.title}</h2><p>{entry.artist}</p>
        {entry.spotifyUrl && <a className="track-attribution" href={entry.spotifyUrl} target="_blank" rel="noopener noreferrer">Открыть в Spotify <span aria-hidden="true">↗</span></a>}
      </div>
    </div>
    <p className="swipe-feedback" aria-hidden="true"><span className="swipe-remove">Отпусти, чтобы убрать</span><span className="swipe-keep">Отпусти, чтобы оставить</span></p>
  </article>
}
