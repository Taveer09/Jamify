import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import type { MusicReviewProps } from '../contracts/music-review'
import { ReviewCard } from './ReviewCard'
import { ReviewControls } from './ReviewControls'
import '../styles/music.css'

function time(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function MusicReview(props: MusicReviewProps) {
  const { entry, nextEntry, occurrences, playlistName, cursor, total, busy, decisionPending, canDecide, canUndo, withoutSound, playback, soundLabel, canSeek = true, cardRef, onPendingChange, onDecisionCommit, onDecision, onUndo, onTogglePlayback, onSeek, onSilent, onFinish, onBack } = props
  const menu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (event: PointerEvent) => { if (menu.current?.open && event.target instanceof Node && !menu.current.contains(event.target)) menu.current.open = false }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  const reviewKey = props.reviewKey ?? entry?.sourceUri ?? entry?.observedUri ?? ''
  const blocked = busy || decisionPending
  const duration = playback.durationMs || entry?.durationMs || 0
  const playing = playback.status === 'playing' || playback.status === 'loading'
  const position = Math.min(Math.max(0, playback.positionMs), duration)
  const timelineStyle = { '--played': `${duration ? position / duration * 100 : 0}%` } as CSSProperties
  return <section className="music-review" aria-label="Разбор плейлиста">
    <header className="music-review-header">
      <div className="music-playlist"><h1>{playlistName}</h1><p className="session-progress"><span>{Math.min(cursor + (entry ? 1 : 0), total)} / {total}</span></p></div>
      <div className="music-header-actions">
        <details ref={menu} className="music-options" onKeyDown={event => { if(event.key === 'Escape'){event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus()} }}>
          <summary aria-label="Ещё действия"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="5" cy="12" r="1.7" fill="currentColor" /><circle cx="12" cy="12" r="1.7" fill="currentColor" /><circle cx="19" cy="12" r="1.7" fill="currentColor" /></svg></summary>
          <div className="music-options-menu" onClick={event => { if(event.target instanceof Element && event.target.closest('button,a') && menu.current) menu.current.open = false }}>
            {entry && <button type="button" disabled={busy} onClick={onFinish}>Проверить решения</button>}
            {entry && reviewKey && <button type="button" disabled={blocked} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); onDecision(reviewKey, 'skip', false) }}>Пропустить</button>}
            {!withoutSound && entry && <button type="button" disabled={blocked} onClick={onSilent}>Продолжить без звука</button>}
            <button type="button" disabled={busy} onClick={onBack}>Другой плейлист</button>
            {props.menuExtras}
            <p>← убрать · → оставить<br />↓ пропустить · ⌘ / Ctrl Z отменить</p>
          </div>
        </details>
      </div>
    </header>
    {entry ? <div className="music-stage">
      <ReviewCard reviewKey={reviewKey} ref={cardRef} entry={entry} nextEntry={nextEntry} occurrences={occurrences} disabled={busy} canDecide={canDecide} onDecision={onDecisionCommit} onPendingChange={onPendingChange} />
      <div className="music-player">
        <button type="button" className="music-play" aria-label={playing ? 'Пауза' : 'Слушать'} disabled={blocked || !entry.canPlay} onClick={onTogglePlayback}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{playing ? <><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></> : <path d="M8 4.8c0-.8.9-1.3 1.6-.9l11 7.2c.6.4.6 1.4 0 1.8l-11 7.2c-.7.4-1.6-.1-1.6-.9z" />}</svg>
        </button>
        <div className="music-timeline" style={timelineStyle}>
          {canSeek ? <div className="music-seek"><span className="music-seek-track" aria-hidden="true"><span /></span><input type="range" aria-label="Позиция воспроизведения" aria-valuetext={`${time(position)} из ${time(duration)}`} step="1000" min="0" max={Math.max(1, duration)} value={position} disabled={blocked || !entry.canPlay || !duration || playback.status === 'loading'} onChange={(event) => onSeek(Number(event.target.value))} /></div> : <div className="music-progress"><progress aria-label="Позиция воспроизведения" aria-valuetext={`${time(position)} из ${time(duration)}`} max={Math.max(1, duration)} value={position} /></div>}
          <div className="music-time"><span>{time(position)}</span><span>{time(duration)}</span></div>
        </div>
      </div>
      {playback.status === 'error' && !withoutSound ? <div className="music-sound-error"><p className="music-sound-status" role="status">{soundLabel}</p><button className="music-reconnect" type="button" disabled={blocked || !entry.canPlay} onClick={onTogglePlayback}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3a7 7 0 0 0 11.6-1" /></svg>Подключить звук</button></div> : <p className="music-sound-status" role="status">{soundLabel}</p>}
      {!canDecide && !withoutSound && <button className="music-silent" type="button" disabled={blocked} onClick={onSilent}>Продолжить без звука</button>}
      <ReviewControls entryUri={reviewKey} canDecide={canDecide} disabled={busy} decisionPending={decisionPending} canUndo={canUndo} onDecision={onDecision} onUndo={onUndo} />
      {cursor === 0 && <p className="music-drag-hint">Потяни карточку или выбери ниже</p>}
    </div> : <div className="music-empty"><svg viewBox="0 0 48 48" width="48" height="48" fill="none" aria-hidden="true"><path d="m11 25 9 9 18-20" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg><h2>Можно проверить решения</h2><p>В очереди больше нет треков.</p><button className="button primary" type="button" disabled={busy} onClick={onFinish}>Проверить решения</button><button className="text-button" type="button" disabled={busy} onClick={onBack}>Другой плейлист</button></div>}
  </section>
}
