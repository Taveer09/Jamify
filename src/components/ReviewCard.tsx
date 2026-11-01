import { useImperativeHandle, useLayoutEffect, useRef } from 'react'
import type { PointerEvent } from 'react'
import type { Decision } from '../contracts'
import type { ReviewCardProps } from '../contracts/review-ui'
import '../styles/review-interactions.css'

type Pose = { x: number; y: number; rotation: number }
type Gesture = { id: number; uri: string; x: number; y: number; pose: Pose; width: number; horizontal: boolean; lastX: number; lastTime: number; velocity: number; torque: number }
type Pending = { uri: string; decision: Decision }
const easing = 'cubic-bezier(0.23, 1, 0.32, 1)'
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

export function ReviewCard({ reviewKey, entry, nextEntry, occurrences, canDecide, disabled, onDecision, onPendingChange, ref }: ReviewCardProps) {
  const currentKey = reviewKey ?? entry.sourceUri
  const card = useRef<HTMLElement>(null)
  const motion = useRef<HTMLDivElement>(null)
  const feedback = useRef<HTMLParagraphElement>(null)
  const next = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const submitted = useRef<string | null>(null)
  const pending = useRef<Pending | null>(null)
  const animation = useRef<Animation | null>(null)
  const promote = useRef(false)

  function visiblePose(): Pose {
    if (!motion.current) return { x: 0, y: 0, rotation: 0 }
    const matrix = new DOMMatrixReadOnly(getComputedStyle(motion.current).transform)
    return { x: matrix.m41, y: matrix.m42, rotation: Math.atan2(matrix.m12, matrix.m11) * 180 / Math.PI }
  }
  function transform(pose: Pose) { return `translate3d(${pose.x}px, ${pose.y}px, 0) rotate(${pose.rotation}deg)` }
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
    if (next.current) next.current.style.transform = ''
  }
  function settle() {
    const pose = visiblePose()
    reset()
    stopAnimation()
    if (!motion.current || reduced() || Math.abs(pose.x) < 1) return
    animation.current = motion.current.animate([
      { transform: transform(pose) },
      { transform: transform({ x: -pose.x * .035, y: 0, rotation: -pose.rotation * .035 }), offset: .75 },
      { transform: transform({ x: 0, y: 0, rotation: 0 }) },
    ], { duration: 240, easing })
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
    if (action.uri !== currentKey || disabled || (action.decision !== 'skip' && !canDecide)) return
    submitted.current = action.uri
    promote.current = !reduced()
    onDecision(action.uri, action.decision)
  }
  function decide(uri: string, decision: Decision, animate = true) {
    // A second action finishes the captured decision, never applies to an unseen card.
    if (pending.current) { finishPending(); return }
    if (disabled || uri !== currentKey || submitted.current === uri || (decision !== 'skip' && !canDecide)) return
    const from = motion.current ? getComputedStyle(motion.current).transform : 'none'
    const pose = visiblePose()
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
    const direction = decision === 'keep' ? 1 : -1
    const width = motion.current.clientWidth
    const tilt = Math.abs(pose.rotation) > 1 ? Math.sign(pose.rotation) : direction
    animation.current = motion.current.animate([
      { transform: from === 'none' ? 'translateX(0)' : from, opacity: 1 },
      { transform: transform({ x: pose.x + direction * width * .55, y: pose.y - 24, rotation: tilt * 14 }), opacity: .9, offset: .6 },
      { transform: transform({ x: pose.x + direction * width * 1.45, y: pose.y + 42, rotation: tilt * 25 }), opacity: 0 },
    ], { duration: 200, easing, fill: 'forwards' })
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
    if (next.current) next.current.style.transform = ''
    submitted.current = null
    if (promote.current && motion.current && !reduced()) {
      animation.current = motion.current.animate([
        { transform: 'translateY(8px) scale(0.97)' }, { transform: 'translateY(0) scale(1)' },
      ], { duration: 160, easing })
    }
    promote.current = false
    return () => { animation.current?.cancel(); pending.current = null }
  }, [currentKey, disabled, canDecide, onPendingChange])

  function begin(event: PointerEvent<HTMLElement>) {
    if (disabled || !canDecide || !currentKey || submitted.current === currentKey || gesture.current || !event.isPrimary || event.button !== 0) return
    if ((event.target as HTMLElement).closest('a,button,input,select,textarea,[contenteditable]')) return
    // Preserve the visible pose when a user catches an exiting or returning card.
    const pose = visiblePose()
    const bounds = event.currentTarget.getBoundingClientRect()
    const pickup = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
    cancelPending()
    gesture.current = { id: event.pointerId, uri: currentKey, x: event.clientX, y: event.clientY, pose, width: event.currentTarget.clientWidth, horizontal: false, lastX: event.clientX, lastTime: event.timeStamp, velocity: 0, torque: pickup > .65 ? -.7 : .65 + (.65 - pickup) }
    event.currentTarget.dataset.dragging = 'true'
    if (motion.current && !reduced()) motion.current.style.transform = transform(pose)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent<HTMLElement>) {
    const active = gesture.current
    if (!active || active.id !== event.pointerId) return
    const dx = event.clientX - active.x
    const dy = event.clientY - active.y
    if (!active.horizontal && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { reset(); return }
    if (!active.horizontal && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.15) active.horizontal = true
    if (!active.horizontal) return
    const elapsed = event.timeStamp - active.lastTime
    if (elapsed > 0) active.velocity = (event.clientX - active.lastX) / elapsed
    active.lastX = event.clientX
    active.lastTime = event.timeStamp
    const threshold = Math.min(80, active.width * 0.2)
    event.currentTarget.dataset.direction = dx > 0 ? 'keep' : 'remove'
    event.currentTarget.dataset.ready = String(Math.abs(dx) >= threshold)
    if (feedback.current) feedback.current.style.opacity = String(Math.min(1, Math.abs(dx) / threshold))
    if (!reduced()) {
      const travel = Math.max(-active.width * 1.15, Math.min(active.width * 1.15, dx + active.pose.x))
      if (motion.current) motion.current.style.transform = transform({ x: travel, y: active.pose.y + dy * .12 - Math.min(14, Math.abs(dx) * .04), rotation: active.pose.rotation + Math.max(-15, Math.min(15, dx / active.width * 22 * active.torque)) })
      const progress = Math.min(1, Math.abs(dx) / threshold)
      if (next.current) next.current.style.transform = `translateY(${5 * (1 - progress)}px) scale(${.96 + .04 * progress})`
    }
  }
  function cancel(event: PointerEvent<HTMLElement>) {
    if (gesture.current?.id === event.pointerId) settle()
  }
  function finish(event: PointerEvent<HTMLElement>) {
    const active = gesture.current
    if (!active || active.id !== event.pointerId) return
    const dx = event.clientX - active.x
    const dy = event.clientY - active.y
    const recentVelocity = event.timeStamp - active.lastTime < 90 ? active.velocity : 0
    const flick = Math.abs(dx) >= 32 && Math.abs(recentVelocity) >= .55 && Math.sign(recentVelocity) === Math.sign(dx)
    const commit = active.horizontal && (Math.abs(dx) >= Math.min(80, active.width * .2) || flick) && Math.abs(dx) > Math.abs(dy) * 1.15
    // Keep the visible transform as the exit's starting point.
    const transform = motion.current?.style.transform
    if (!commit || active.uri !== currentKey) { settle(); return }
    reset()
    if (commit && active.uri === currentKey) {
      if (motion.current && transform) motion.current.style.transform = transform
      decide(active.uri, dx > 0 ? 'keep' : 'remove')
    }
  }

  return <article ref={card} className="track-card swipe-card" aria-label="Текущий трек" onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}>
    <div className="card-stack">
      {nextEntry && <div ref={next} className="next-card" aria-hidden="true">{nextEntry.imageUrl && <img src={nextEntry.imageUrl} alt="" draggable="false" />}</div>}
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
