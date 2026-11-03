import { useEffect, useRef } from 'react'
import type { MusicReviewProps } from '../contracts/music-review'
import { ReviewCard } from './ReviewCard'
import { ReviewControls } from './ReviewControls'
import { Button } from './ui/Button'
import { PlaybackTransport } from './PlaybackTransport'
import { AlbumBackdrop } from './AlbumBackdrop'
import '../styles/music.css'

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
  const autoplayBlocked=playback.diagnostic?.reason==='autoplay_failed'
  const needsAttention=!withoutSound&&(playback.status==='loading'||!canDecide||Boolean(playback.message))
  return <section className="music-review" aria-label="Разбор плейлиста">
    <AlbumBackdrop imageUrl={entry?.imageUrl} enabled={!entry || (playback.status === 'playing' && playback.actualUri === entry.playbackUri)} />
    <header className="music-review-header">
      <div className="music-heading-group"><Button className="review-back" type="button" aria-label="Выйти из разбора" disabled={busy} onClick={onBack}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h12"/></svg><span>Назад</span></Button><div className="music-playlist"><h1>{playlistName}</h1><p className="session-progress"><span>{Math.min(cursor + (entry ? 1 : 0), total)} / {total}</span></p></div></div>
      <div className="music-header-actions">
        <details ref={menu} className="music-options" onKeyDown={event => { if(event.key === 'Escape'){event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus()} }}>
          <summary aria-label="Ещё действия"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="5" cy="12" r="1.7" fill="currentColor" /><circle cx="12" cy="12" r="1.7" fill="currentColor" /><circle cx="19" cy="12" r="1.7" fill="currentColor" /></svg></summary>
          <div className="music-options-menu" onClick={event => { if(event.target instanceof Element && event.target.closest('button,a') && menu.current) menu.current.open = false }}>
            {entry && <Button type="button" disabled={busy} onClick={onFinish}>Проверить решения</Button>}
            {entry && reviewKey && <Button type="button" disabled={blocked} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); onDecision(reviewKey, 'skip', false) }}>Пропустить</Button>}
            {!withoutSound && entry && <Button type="button" disabled={blocked} onClick={onSilent}>Продолжить без звука</Button>}
            <Button type="button" disabled={busy} onClick={onBack}>Другой плейлист</Button>
            {props.menuExtras}
            <p>← убрать · → оставить<br />↓ пропустить · ⌘ / Ctrl Z отменить</p>
          </div>
        </details>
      </div>
    </header>
    {entry ? <div className="music-stage">
      <ReviewCard reviewKey={reviewKey} ref={cardRef} entry={entry} nextEntry={nextEntry} occurrences={occurrences} disabled={busy} canDecide={canDecide} onDecision={onDecisionCommit} onPendingChange={onPendingChange} />
      <PlaybackTransport playback={playback} duration={duration} canSeek={canSeek} blocked={blocked} canPlay={entry.canPlay} onTogglePlayback={onTogglePlayback} onSeek={onSeek}/>
      <div className={playback.status==='error'&&!withoutSound&&!autoplayBlocked?'music-sound-error':needsAttention?'music-audio-hint':'sr-only'}>
        <p className="music-sound-status" role="status">{soundLabel}</p>
        {playback.status==='error'&&!withoutSound&&!autoplayBlocked&&<Button key="retry" className="music-reconnect" disabled={blocked||!entry.canPlay} onClick={onTogglePlayback}>Подключить звук</Button>}
        {!canDecide&&!withoutSound&&playback.status!=='loading'&&<Button key="silent" className="music-silent" disabled={blocked} onClick={onSilent} aria-label="Продолжить без звука">Без звука</Button>}
      </div>
      <ReviewControls entryUri={reviewKey} canDecide={canDecide} disabled={busy} decisionPending={decisionPending} canUndo={canUndo} onDecision={onDecision} onUndo={onUndo} />

    </div> : <div className="music-empty"><svg viewBox="0 0 48 48" width="48" height="48" fill="none" aria-hidden="true"><path d="m11 25 9 9 18-20" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg><h2>Можно проверить решения</h2><p>В очереди больше нет треков.</p><Button className="button primary" type="button" disabled={busy} onClick={onFinish}>Проверить решения</Button><Button className="text-button" type="button" disabled={busy} onClick={onBack}>Другой плейлист</Button></div>}
  </section>
}
