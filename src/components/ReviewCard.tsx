import { useImperativeHandle, useLayoutEffect, useRef } from 'react'
import type { PointerEvent } from 'react'
import type { Decision } from '../contracts'
import type { ReviewCardProps } from '../contracts/review-ui'
import '../styles/review-interactions.css'

type Gesture = { id: number; uri: string; x: number; y: number; offset: number; width: number; horizontal: boolean }
type Pending = { uri: string; decision: Decision }
const easing = 'cubic-bezier(0.23, 1, 0.32, 1)'
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

export function ReviewCard({ entry, nextEntry, occurrences, canDecide, disabled, onDecision, onPendingChange, ref }: ReviewCardProps) {
  const card = useRef<HTMLElement>(null)
  const motion = useRef<HTMLDivElement>(null)
  const feedback = useRef<HTMLParagraphElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const submitted = useRef<string | null>(null)
  const pending = useRef<Pending | null>(null)
  const animation = useRef<Animation | null>(null)
  const promote = useRef(false)

  function stopAnimation() {
    animation.current?.cancel()
    animation.current = null
  }
  function reset() {
    const active = gesture.current
    gesture.current = null
    if (card.current) {
      delete card.current.dataset.dragging
      delete card.current.dataset.direction
      delete card.current.dataset.ready
      if (active && card.current.hasPointerCapture(active.id)) card.current.releasePointerCapture(active.id)
    }
    if (motion.current) motion.current.style.transform = ''
    if (feedback.current) feedback.current.style.opacity = ''
  }
  function cancelPending() {
    const hadPending = Boolean(pending.current)
    pending.current = null
    if (hadPending) onPendingChange?.(false)
    stopAnimation()
    if (card.current) delete card.current.dataset.exiting
    reset()
    return hadPending
  }
  function finishPending() {
    const action = pending.current
    if (!action) return
    cancelPending()
    if (action.uri !== entry.sourceUri || disabled || (action.decision !== 'skip' && !canDecide)) return
    submitted.current = action.uri
    promote.current = !reduced()
    onDecision(action.uri, action.decision)
  }
  function decide(uri: string, decision: Decision, animate = true) {
    // A second action finishes the captured decision, never applies to an unseen card.
    if (pending.current) { finishPending(); return }
    if (disabled || uri !== entry.sourceUri || submitted.current === uri || (decision !== 'skip' && !canDecide)) return
    const from = motion.current ? getComputedStyle(motion.current).transform : 'none'
    reset()
    if (!animate || reduced() || decision === 'skip' || !motion.current) {
      stopAnimation()
      submitted.current = uri
      onDecision(uri, decision)
      return
    }
    stopAnimation()
    pending.current = { uri, decision }
    onPendingChange?.(true)
    if (card.current) card.current.dataset.exiting = decision
    animation.current = motion.current.animate([
      { transform: from === 'none' ? 'translateX(0)' : from, opacity: 1 },
      { transform: `translateX(${decision === 'keep' ? '' : '-'}140%)`, opacity: 0 },
    ], { duration: 160, easing, fill: 'forwards' })
    animation.current.onfinish = finishPending
  }
  useImperativeHandle(ref, () => ({ decide, cancel: cancelPending, finish: finishPending }))

  useLayoutEffect(() => {
    // Props invalidate both a captured pointer and a deferred decision.
    onPendingChange?.(false)
    pending.current = null
    animation.current?.cancel()
    animation.current = null
    gesture.current = null
    if (card.current) {
      delete card.current.dataset.dragging
      delete card.current.dataset.direction
      delete card.current.dataset.ready
      delete card.current.dataset.exiting
    }
    if (motion.current) motion.current.style.transform = ''
    if (feedback.current) feedback.current.style.opacity = ''
    submitted.current = null
    if (promote.current && motion.current && !reduced()) {
      animation.current = motion.current.animate([
        { transform: 'translateY(8px) scale(0.97)' }, { transform: 'translateY(0) scale(1)' },
      ], { duration: 160, easing })
    }
    promote.current = false
    return () => { animation.current?.cancel(); pending.current = null }
  }, [entry.sourceUri, disabled, canDecide, onPendingChange])

  function begin(event: PointerEvent<HTMLElement>) {
    if (disabled || !canDecide || !entry.sourceUri || submitted.current === entry.sourceUri || gesture.current || !event.isPrimary || event.button !== 0) return
    if ((event.target as HTMLElement).closest('a,button,input,select,textarea,[contenteditable]')) return
    // Grab an exiting/returning card at its visible position; no decision has committed yet.
    const offset = motion.current ? new DOMMatrixReadOnly(getComputedStyle(motion.current).transform).m41 : 0
    cancelPending()
    gesture.current = { id: event.pointerId, uri: entry.sourceUri, x: event.clientX, y: event.clientY, offset, width: event.currentTarget.clientWidth, horizontal: false }
    event.currentTarget.dataset.dragging = 'true'
    if (motion.current && !reduced()) motion.current.style.transform = `translateX(${offset}px)`
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
    event.currentTarget.dataset.direction = dx > 0 ? 'keep' : 'remove'
    event.currentTarget.dataset.ready = String(Math.abs(dx) >= threshold)
    if (feedback.current) feedback.current.style.opacity = String(Math.min(1, Math.abs(dx) / threshold))
    if (motion.current && !reduced()) motion.current.style.transform = `translateX(${Math.max(-active.width, Math.min(active.width, dx + active.offset))}px)`
  }
  function cancel(event: PointerEvent<HTMLElement>) {
    if (gesture.current?.id === event.pointerId) reset()
  }
  function finish(event: PointerEvent<HTMLElement>) {
    const active = gesture.current
    if (!active || active.id !== event.pointerId) return
    const dx = event.clientX - active.x
    const commit = active.horizontal && Math.abs(dx) >= Math.min(80, active.width * 0.2) && Math.abs(dx) > Math.abs(event.clientY - active.y)
    // Keep the visible transform as the exit's starting point.
    const transform = motion.current?.style.transform
    reset()
    if (commit && active.uri === entry.sourceUri) {
      if (motion.current && transform) motion.current.style.transform = transform
      decide(active.uri, dx > 0 ? 'keep' : 'remove')
    }
  }

  return <article ref={card} className="track-card swipe-card" aria-label="Текущий трек" onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}>
    <div className="card-stack">
      {nextEntry && <div className="next-card" aria-hidden="true">{nextEntry.imageUrl && <img src={nextEntry.imageUrl} alt="" draggable="false" />}</div>}
      <div ref={motion} className="track-card-motion">
        {entry.imageUrl ? <img className="album-cover" src={entry.imageUrl} alt={`Обложка: ${entry.title}`} width="320" height="320" draggable="false" /> : <div className="album-cover album-placeholder" aria-label="Обложка недоступна">Нет обложки</div>}
        <div className="track-details"><p className="small">{occurrences} {occurrences % 10 === 1 && occurrences % 100 !== 11 ? 'вхождение' : [2, 3, 4].includes(occurrences % 10) && ![12, 13, 14].includes(occurrences % 100) ? 'вхождения' : 'вхождений'} в плейлисте</p><h2>{entry.title}</h2><p>{entry.artist}</p>
          {entry.spotifyUrl && <a className="track-attribution" href={entry.spotifyUrl} target="_blank" rel="noopener noreferrer">Открыть в Spotify <span aria-hidden="true">↗</span></a>}
        </div>
      </div>
    </div>
    <p ref={feedback} className="swipe-feedback" aria-hidden="true"><span className="swipe-remove">← Убрать<span className="release-hint"> · отпусти</span></span><span className="swipe-keep">Оставить →<span className="release-hint"> · отпусти</span></span></p>
  </article>
}
