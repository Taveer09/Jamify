import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Decision } from '../contracts'
import type { ReviewControlsProps } from '../contracts/review-ui'
import '../styles/review-interactions.css'

function ignoreShortcut(event: KeyboardEvent, disabled: boolean) {
  if (disabled || event.defaultPrevented || event.repeat || event.isComposing || event.altKey) return true
  const target = event.target
  return target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest('input,textarea,select,button,a,[contenteditable],audio,video,[role="slider"],[role="textbox"]')))
}

export function ReviewUndoShortcut({ disabled, canUndo, onUndo }: Pick<ReviewControlsProps, 'disabled' | 'canUndo' | 'onUndo'>) {
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (ignoreShortcut(event, disabled) || !canUndo || event.shiftKey) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        onUndo()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [disabled, canUndo, onUndo])
  return null
}

export function ReviewControls({ entryUri, canDecide, disabled, canUndo, onDecision, onUndo }: ReviewControlsProps) {
  const submitted = useRef<string | null>(null)
  useLayoutEffect(() => { submitted.current = null }, [entryUri])

  function decide(decision: Decision) {
    if (disabled || !entryUri || (decision !== 'skip' && !canDecide) || submitted.current === entryUri) return
    submitted.current = entryUri
    onDecision(entryUri, decision)
  }

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (ignoreShortcut(event, disabled)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        if (canUndo) { event.preventDefault(); onUndo() }
        return
      }
      if (event.ctrlKey || event.metaKey || event.shiftKey) return
      const decision = event.key === 'ArrowLeft' ? 'remove' : event.key === 'ArrowRight' ? 'keep' : event.key === 'ArrowDown' ? 'skip' : null
      if (decision && (decision === 'skip' || canDecide)) {
        event.preventDefault()
        if (entryUri && submitted.current !== entryUri) {
          submitted.current = entryUri
          onDecision(entryUri, decision)
        }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [entryUri, disabled, canDecide, canUndo, onDecision, onUndo])

  return <div className="review-controls">
    <div className="decision-buttons" aria-label="Решение о треке">
      <button type="button" disabled={disabled || !canDecide} className="button secondary decision-remove" onClick={() => decide('remove')} aria-keyshortcuts="ArrowLeft"><span aria-hidden="true">←</span>Убрать</button>
      <button type="button" disabled={disabled} className="button secondary decision-skip" onClick={() => decide('skip')} aria-keyshortcuts="ArrowDown">Пропустить</button>
      <button type="button" disabled={disabled || !canDecide} className="button primary decision-keep" onClick={() => decide('keep')} aria-keyshortcuts="ArrowRight">Оставить<span aria-hidden="true">→</span></button>
    </div>
    <div className="review-bottom"><button type="button" className="text-button" disabled={disabled || !canUndo} onClick={onUndo} aria-keyshortcuts="Control+z Meta+z">Отменить решение</button><p className="decision-hint">← убрать · → оставить · ↓ пропустить<br />Ctrl / ⌘ Z — отменить</p></div>
  </div>
}
