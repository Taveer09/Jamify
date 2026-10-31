import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApplyPlan, ApplyResult, Baseline, Decision, Entry, PlaybackState, PlaylistSummary } from '../contracts'
import { buildApplyPlan, shuffled, uniqueReviewEntries } from '../domain/playlist'
import { DemoApplyCoordinator, DemoPlaylistGateway } from '../demo/gateway'
import { LocalPlaybackGateway } from '../demo/playback'
import '../styles/review.css'

type Review = { queue: Entry[]; cursor: number; decisions: Record<string, Decision>; history: Array<{ uri: string; before?: Decision; after: Decision }> }
const emptyReview = (): Review => ({ queue: [], cursor: 0, decisions: {}, history: [] })
const initialPlayback: PlaybackState = { requestedUri: null, actualUri: null, generation: 0, status: 'idle', positionMs: 0, durationMs: 0 }
function time(ms: number) { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
function Mark() { return <svg width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M9 5v13a5 5 0 1 1-5-5m17-8v18a5 5 0 1 1-5-5M9 9l12-4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg> }

export function DemoApp() {
  const gateway = useMemo(() => new DemoPlaylistGateway(), [])
  const coordinator = useMemo(() => new DemoApplyCoordinator(gateway), [gateway])
  const playback = useMemo(() => new LocalPlaybackGateway(), [])
  const [player, setPlayer] = useState(initialPlayback)
  const [heardUri, setHeardUri] = useState<string | null>(null)
  const [withoutSound, setWithoutSound] = useState(false)
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([])
  const [selected, setSelected] = useState('night-drive')
  const [baseline, setBaseline] = useState<Baseline | null>(null)
  const [review, setReview] = useState<Review>(emptyReview)
  const [screen, setScreen] = useState<'choose' | 'review' | 'preview' | 'result'>('choose')
  const [plan, setPlan] = useState<ApplyPlan | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const applying = useRef(false)
  const autoplay = useRef(false)
  const current = review.queue[review.cursor]
  const confirmed = Boolean(current && player.status === 'playing' && player.actualUri === current.playbackUri)
  const mayDecide = Boolean(current && (confirmed || heardUri === current.playbackUri || withoutSound))

  useEffect(() => { let active = true; void gateway.listPlaylists().then((list) => { if (active) setPlaylists(list) }); return () => { active = false } }, [gateway])
  useEffect(() => {
    const unsubscribe = playback.subscribe((state) => { setPlayer(state); if (state.status === 'playing' && state.actualUri) setHeardUri(state.actualUri) })
    return () => { unsubscribe(); playback.dispose() }
  }, [playback])
  useEffect(() => {
    if (screen !== 'review' || !current) { playback.pause(); return }
    playback.select(current)
    if (autoplay.current && !withoutSound) void playback.play()
  }, [current, playback, screen, withoutSound])

  async function start() {
    setBusy(true); setError('')
    try {
      const loaded = await gateway.loadBaseline(selected)
      setBaseline(loaded)
      setHeardUri(null); setWithoutSound(false)
      setReview({ ...emptyReview(), queue: shuffled(uniqueReviewEntries(loaded.orderedEntries), Date.now()).slice(0, 25) })
      setScreen('review'); autoplay.current = true
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Не удалось открыть демо.') }
    finally { setBusy(false) }
  }
  function decide(decision: Decision) {
    setReview((previous) => {
      const entry = previous.queue[previous.cursor]
      const uri = entry?.sourceUri
      if (!uri) return previous
      if (decision !== 'skip' && !withoutSound && heardUri !== entry.playbackUri && !(player.status === 'playing' && player.actualUri === entry.playbackUri)) return previous
      return { ...previous, cursor: previous.cursor + 1,
        decisions: { ...previous.decisions, [uri]: decision },
        history: [...previous.history, { uri, before: previous.decisions[uri], after: decision }] }
    })
  }
  function undo() {
    setReview((previous) => {
      const last = previous.history.at(-1)
      if (!last) return previous
      const decisions = { ...previous.decisions }
      if (last.before === undefined) delete decisions[last.uri]
      else decisions[last.uri] = last.before
      return { ...previous, cursor: Math.max(0, previous.cursor - 1), decisions, history: previous.history.slice(0, -1) }
    })
  }
  function preview() {
    if (!baseline) return
    setPlan(buildApplyPlan(baseline, review.decisions, 'remove-uri-groups'))
    setScreen('preview')
  }
  async function apply() {
    if (!plan || applying.current) return
    applying.current = true; setBusy(true); setError('')
    try {
      const applied = await coordinator.apply(plan)
      setResult(applied); setScreen('result')
      if (applied.baseline) setBaseline(applied.baseline)
      setPlaylists(await gateway.listPlaylists())
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Изменения не завершены.') }
    finally { applying.current = false; setBusy(false) }
  }
  const selectedPlaylist = playlists.find((playlist) => playlist.id === selected)
  const removals = Object.values(review.decisions).filter((decision) => decision === 'remove').length
  const copies = current && baseline ? baseline.orderedEntries.filter((entry) => entry.sourceUri === current.sourceUri).length : 0
  const inaccessible = baseline ? baseline.orderedEntries.filter((entry) => !entry.canPlay).length : 0

  return <div className="demo-shell">
    <header className="demo-header"><a className="wordmark" href="/demo"><Mark /><span>Jamify</span></a><nav aria-label="Режим приложения"><span aria-current="page">Демо</span><a href="/">Подключить Spotify <span aria-hidden="true">↗</span></a></nav></header>
    <main className="demo-main">
      <div className="demo-title"><div><p className="small">{screen === 'choose' ? 'Твоя музыка — только любимое' : baseline?.playlistName}</p><h1>{screen === 'choose' ? 'Плейлисту пора выдохнуть.' : screen === 'preview' ? 'Последний взгляд.' : screen === 'result' ? result?.state === 'complete' ? 'Готово. Стало легче.' : 'Проверим результат.' : 'Оставь то, что откликается.'}</h1></div><p className="demo-label">Демо без аккаунта</p></div>
      {error && <p className="feedback error" role="alert">{error}</p>}
      {screen === 'choose' ? <div className="demo-chooser"><section aria-labelledby="choose-title"><h2 id="choose-title">С чего начнём?</h2><p className="description">Выбери вымышленный плейлист. Переслушай, оставь любимое и убери лишнее — реальные данные Spotify это не затронет.</p><div className="playlist-options">{playlists.map((playlist, index) => <button key={playlist.id} type="button" className={selected === playlist.id ? 'playlist-option selected' : 'playlist-option'} aria-pressed={selected === playlist.id} onClick={() => setSelected(playlist.id)}><span className="playlist-index">{String(index + 1).padStart(2, '0')}</span><span><strong>{playlist.name}</strong><span>{playlist.count.toLocaleString('ru-RU')} записей</span></span><span aria-hidden="true">{selected === playlist.id ? '●' : '○'}</span></button>)}</div><button className="button primary" disabled={busy || !selectedPlaylist} onClick={() => void start()}>Начать разбор <span aria-hidden="true">→</span></button></section><aside className="demo-explainer"><img src="/demo/slate.svg" alt="Собственная демо-обложка Jamify Lab" width="320" height="320" /><h2>Один трек. Одно решение.</h2><p>Оставить, убрать или пропустить. До применения любое решение можно отменить.</p><p className="field-hint">Имена вымышлены. Короткие аудиофрагменты созданы для демо.</p></aside></div> : null}
      {screen === 'review' ? <div className="review-layout"><section className="review-workspace" aria-label="Разбор плейлиста"><div className="session-progress"><span>{Math.min(review.cursor + 1, review.queue.length)} / {review.queue.length} уникальных треков</span><button className="text-button" onClick={preview}>Проверить решения →</button></div><progress aria-label="Прогресс разбора" max={Math.max(1, review.queue.length)} value={review.cursor} />
        {current ? <><article className="track-card" aria-label="Текущий трек"><img className="album-cover" src={current.imageUrl ?? '/demo/slate.svg'} alt={`Демо-обложка: ${current.title}`} width="320" height="320" draggable="false" /><div className="track-details"><p className="small">Демо-запись{copies > 1 ? ` · ${copies} вхождения` : ''}</p><h2>{current.title}</h2><p>{current.artist}</p></div></article><div className="demo-player"><button className="button secondary" onClick={() => { if (confirmed) { autoplay.current = false; playback.pause() } else { autoplay.current = true; void playback.play() } }} aria-label={confirmed ? 'Пауза' : 'Слушать'}>{confirmed ? 'Пауза' : 'Слушать'}</button><div><label className="sr-only" htmlFor="demo-seek">Позиция воспроизведения</label><input id="demo-seek" type="range" min="0" max={player.durationMs || 8000} step="100" value={Math.min(player.positionMs, player.durationMs || 8000)} onChange={(event) => playback.seek(Number(event.target.value))} /><div className="player-time"><span>{time(player.positionMs)}</span><span>{time(player.durationMs)}</span></div></div><p role="status">{confirmed ? 'Играет текущий трек' : player.message || (player.status === 'loading' ? 'Загружаем звук…' : 'Звук на паузе')}<span>Локальный демо-фрагмент</span></p></div><div className="sound-choice">{withoutSound ? <p className="field-hint">Режим без звука включён для этой сессии.</p> : !mayDecide ? <button className="text-button" onClick={() => { autoplay.current = false; playback.pause(); setWithoutSound(true) }}>Продолжить без звука</button> : null}</div><div className="decision-buttons"><button disabled={!mayDecide} className="button secondary decision-remove" onClick={() => decide('remove')}><span aria-hidden="true">←</span> Убрать</button><button className="button secondary" onClick={() => decide('skip')}>Пропустить</button><button disabled={!mayDecide} className="button primary" onClick={() => decide('keep')}>Оставить <span aria-hidden="true">→</span></button></div><p className="decision-hint">«Убрать» пометит все {copies} вхождения этого трека. Изменения применяются после проверки.</p></> : <div className="review-empty"><h2>{review.queue.length ? 'Карточки закончились.' : 'Здесь пока нечего слушать.'}</h2><p>{review.queue.length ? 'Проверь решения перед применением.' : 'Выбери другой плейлист или проверь состав текущего.'}</p><button className="button primary" onClick={preview}>Проверить решения</button></div>}
        <div className="review-bottom"><button className="text-button" disabled={!review.history.length} onClick={undo}>↶ Отменить решение</button><button className="text-button" onClick={() => setScreen('choose')}>Другой плейлист</button></div></section><aside className="review-summary"><h2>Пока ничего не удалено.</h2><dl><div><dt>Всего записей</dt><dd>{baseline?.orderedEntries.length.toLocaleString('ru-RU')}</dd></div><div><dt>Просмотрено треков</dt><dd>{review.cursor}</dd></div><div><dt>Групп на удаление</dt><dd>{removals}</dd></div></dl>{inaccessible > 0 && <p className="field-hint">{inaccessible} особенных записей сохранятся в плейлисте.</p>}<p>Слушай, решай, отменяй. Остальной плейлист сохранит свой порядок.</p></aside></div> : null}
      {screen === 'preview' && plan ? <section className="preview-panel"><div className="preview-heading"><h2>Удалить {plan.removedOccurrences} вхождения?</h2><p>{plan.removeUris.length} уникальных треков · останется {plan.expectedOrderedEntries.length} записей</p></div>{plan.blockedReasons.length > 0 ? <p role="alert">{plan.blockedReasons.join(' ')}</p> : null}{plan.removeUris.length ? <ul className="preview-list">{plan.removeUris.map((uri) => { const group = baseline!.orderedEntries.filter((entry) => entry.sourceUri === uri); return <li key={uri}><span><strong>{group[0].title}</strong><span>{group[0].artist}</span></span><span>{group.length} вхождения</span></li> })}</ul> : <p className="description">Ни один трек не помечен на удаление. Плейлист сохранится целиком.</p>}<p className="field-hint">Это демо: изменяется только вымышленный плейлист в этой вкладке.</p><div className="button-row"><button className="button secondary" disabled={busy} onClick={() => setScreen('review')}>Вернуться к решениям</button><button className="button primary" disabled={busy || Boolean(plan.blockedReasons.length)} onClick={() => void apply()}>{busy ? 'Проверяем результат…' : 'Применить в демо'}</button></div></section> : null}
      {screen === 'result' ? <section className="result-panel" aria-live="polite"><h2>{result?.state === 'complete' ? 'Результат совпал с планом.' : 'Изменения не подтверждены.'}</h2><p>{result?.message}</p>{result?.state === 'complete' && <p className="result-count">{baseline?.orderedEntries.length}<span>записей осталось в демо-плейлисте</span></p>}<div className="button-row"><button className="button primary" onClick={() => setScreen('choose')}>Вернуться к плейлистам</button><a className="button secondary" href="/">Подключить Spotify</a></div></section> : null}
      <footer><span>Jamify · оставь любимое</span><span>Демо не обращается к Spotify</span></footer>
    </main>
  </div>
}
