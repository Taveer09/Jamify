import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApplyPlan, ApplyResult, Baseline, Decision, MutationJournal, PlaybackState, PlaylistSummary } from '../contracts'
import { buildApplyPlan } from '../domain/playlist'
import { currentUri, SESSION_SIZE } from '../domain/session'
import { SessionController } from '../features/session/controller'
import { JamifyStorage } from '../lib/persistence/database'
import { DurableApplyCoordinator } from '../features/apply/coordinator'
import { DemoApplyCoordinator, DemoPlaylistGateway } from '../demo/gateway'
import { LocalPlaybackGateway } from '../demo/playback'
import { ReviewCard } from '../components/ReviewCard'
import { ReviewControls, ReviewUndoShortcut } from '../components/ReviewControls'
import '../styles/review.css'

const initialPlayback: PlaybackState = { requestedUri: null, actualUri: null, generation: 0, status: 'idle', positionMs: 0, durationMs: 0 }
function time(ms: number) { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
function Mark() { return <svg width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M9 5v13a5 5 0 1 1-5-5m17-8v18a5 5 0 1 1-5-5M9 9l12-4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg> }

export function DemoApp() {
  const storage = useMemo(() => new JamifyStorage(), [])
  const gateway = useMemo(() => new DemoPlaylistGateway(storage), [storage])
  const controller = useMemo(() => new SessionController(storage), [storage])
  const [sessionState, setSessionState] = useState(() => controller.snapshot())
  const coordinator = useMemo(() => new DemoApplyCoordinator(gateway), [gateway])
  const durable = useMemo(() => new DurableApplyCoordinator(gateway, storage), [gateway, storage])
  const playback = useMemo(() => new LocalPlaybackGateway(), [])
  const [player, setPlayer] = useState(initialPlayback)
  const [heardUri, setHeardUri] = useState<string | null>(null)
  const [withoutSound, setWithoutSound] = useState(false)
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([])
  const [selected, setSelected] = useState('night-drive')
  const baseline = sessionState.baseline
  const session = sessionState.session
  const review = session ?? { queue: [], cursor: 0, decisions: {}, history: [], reviewedUris: [] }
  const windowSize = Math.min(SESSION_SIZE, review.queue.length)
  const entriesByUri = useMemo(() => new Map(baseline?.orderedEntries.map((entry) => [entry.sourceUri, entry])), [baseline])
  const [screen, setScreen] = useState<'choose' | 'review' | 'preview' | 'result'>('choose')
  const [plan, setPlan] = useState<ApplyPlan | null>(null)
  const [previewSource, setPreviewSource] = useState<Baseline | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [operation, setOperation] = useState<MutationJournal | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const applying = useRef(false)
  const autoplay = useRef(false)
  const uri = session ? currentUri(session) : null
  const current = uri ? entriesByUri.get(uri) : undefined
  const confirmed = Boolean(current && player.status === 'playing' && player.actualUri === current.playbackUri)
  const mayDecide = Boolean(current && (confirmed || heardUri === current.playbackUri || withoutSound))

  useEffect(() => controller.subscribe(setSessionState), [controller])
  useEffect(() => () => { void controller.flush().finally(() => storage.close()) }, [controller, storage])
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
      if (!gateway.storageWarning) {
        const pending = await storage.operations.read(loaded.accountId, loaded.playlistId)
        if (pending && !pending.sessionFinalized) {
          const previous = await storage.loadDraft(loaded.accountId, loaded.playlistId)
          if (!previous) throw new Error('Не найден черновик незавершённой операции. Проверь результат вручную.')
          await controller.open(previous.baseline, Date.now())
          setOperation(pending); setPlan(pending.plan); setResult({ state: pending.state, message: pending.message }); setScreen('result')
          return
        }
      }
      setOperation(null)
      await controller.open(loaded, Date.now(), false, Boolean(gateway.storageWarning))
      setHeardUri(null); setWithoutSound(false)
      setScreen('review'); autoplay.current = true
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Не удалось открыть демо.') }
    finally { setBusy(false) }
  }
  function decide(expectedUri: string, decision: Decision) {
    if (busy || current?.sourceUri !== expectedUri || (decision !== 'skip' && !mayDecide)) return
    controller.choose(expectedUri, decision)
  }
  function undo() { if (!busy) controller.undo() }
  async function clearLocalData() {
    if (busy || !window.confirm('Удалить демо-плейлисты и решения Jamify на этом устройстве? Spotify это не затронет.')) return
    setBusy(true); playback.pause()
    try { await controller.flush(); await storage.clearAccount('demo-account'); window.location.assign('/demo') }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Не удалось очистить локальные данные. Попробуй ещё раз.'); setBusy(false) }
  }
  async function restart() {
    if (!baseline || busy) return
    setBusy(true)
    try { await controller.open(baseline, Date.now(), true, Boolean(gateway.storageWarning)); setScreen('review') }
    catch { setError('Не удалось начать новый проход.') }
    finally { setBusy(false) }
  }
  async function preview() {
    if (!baseline || busy) return
    setBusy(true); setError('')
    try {
      await controller.flush()
      const state = controller.snapshot()
      if (!state.baseline || !state.session) return
      const binding = gateway.storageWarning ? { draftRevision: null, runId: null } : await controller.binding()
      setPreviewSource(state.baseline)
      setPlan({ ...buildApplyPlan(state.baseline, state.session.decisions, 'remove-uri-groups'), ...binding })
      setScreen('preview')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Не удалось подготовить изменения.') }
    finally { setBusy(false) }
  }
  async function recoverOperation(resume = false) {
    if (!operation || busy) return
    setBusy(true); setError('')
    try {
      const recovered = await (resume ? durable.resume(operation.accountId, operation.sourcePlaylistId) : durable.recover(operation.accountId, operation.sourcePlaylistId))
      if (recovered.state === 'complete') controller.adoptFinalized(recovered)
      setResult(recovered); setOperation(await storage.operations.read(operation.accountId, operation.sourcePlaylistId))
      setPlaylists(await gateway.listPlaylists())
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Не удалось проверить результат операции.') }
    finally { setBusy(false) }
  }
  async function apply() {
    if (!plan || applying.current) return
    applying.current = true; setBusy(true); setError('')
    try {
      await controller.flush()
      if (!controller.snapshot().persistent && !gateway.storageWarning) {
        throw new Error('Решения не сохранены или изменены в другой вкладке. Применение заблокировано: обнови страницу и проверь черновик.')
      }
      if (!gateway.storageWarning) await controller.ensureCurrentDraft()
      const applied = await (gateway.storageWarning ? coordinator.apply(plan) : durable.apply(plan))
      const nextOperation = gateway.storageWarning ? null : await storage.operations.read(plan.accountId, plan.playlistId)
      if (applied.state === 'complete' && applied.baseline) {
        if (gateway.storageWarning) await controller.finalize(applied.baseline)
        else controller.adoptFinalized(applied)
      }
      setOperation(nextOperation)
      setResult(applied); setScreen('result')
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
      {(sessionState.error || gateway.storageWarning) && <p className="feedback error" role="alert">{sessionState.error || gateway.storageWarning}</p>}
      {session && <p className="save-status" aria-live="polite">{sessionState.saving ? 'Сохраняем решения…' : sessionState.persistent ? 'Решения сохранены на этом устройстве' : 'Решения пока только в этой вкладке'}</p>}
      {screen === 'choose' ? <div className="demo-chooser"><section aria-labelledby="choose-title"><h2 id="choose-title">С чего начнём?</h2><p className="description">Выбери вымышленный плейлист. Переслушай, оставь любимое и убери лишнее — реальные данные Spotify это не затронет.</p><div className="playlist-options">{playlists.map((playlist, index) => <button key={playlist.id} type="button" className={selected === playlist.id ? 'playlist-option selected' : 'playlist-option'} aria-pressed={selected === playlist.id} disabled={busy} onClick={() => setSelected(playlist.id)}><span className="playlist-index">{String(index + 1).padStart(2, '0')}</span><span><strong>{playlist.name}</strong><span>{playlist.count.toLocaleString('ru-RU')} записей</span></span><span aria-hidden="true">{selected === playlist.id ? '●' : '○'}</span></button>)}</div><button className="button primary" disabled={busy || !selectedPlaylist} onClick={() => void start()}>Начать разбор <span aria-hidden="true">→</span></button></section><aside className="demo-explainer"><img src="/demo/slate.svg" alt="Собственная демо-обложка Jamify Lab" width="320" height="320" /><h2>Один трек. Одно решение.</h2><p>Оставить, убрать или пропустить. До применения любое решение можно отменить.</p><p className="field-hint">Имена вымышлены. Короткие аудиофрагменты созданы для демо.</p></aside></div> : null}
      {screen === 'review' ? <div className="review-layout"><section className="review-workspace" aria-label="Разбор плейлиста"><div className="session-progress"><span>{Math.min(review.cursor + 1, windowSize)} / {windowSize} уникальных треков</span><button className="text-button" onClick={preview}>Проверить решения →</button></div><progress aria-label="Прогресс разбора" max={Math.max(1, windowSize)} value={review.cursor} />
        {current ? <><ReviewCard entry={current} occurrences={copies} canDecide={mayDecide} disabled={busy} onDecision={decide} /><div className="demo-player"><button className="button secondary" onClick={() => { if (confirmed) { autoplay.current = false; playback.pause() } else { autoplay.current = true; void playback.play() } }} aria-label={confirmed ? 'Пауза' : 'Слушать'}>{confirmed ? 'Пауза' : 'Слушать'}</button><div><label className="sr-only" htmlFor="demo-seek">Позиция воспроизведения</label><input id="demo-seek" type="range" min="0" max={player.durationMs || 8000} step="100" value={Math.min(player.positionMs, player.durationMs || 8000)} onChange={(event) => playback.seek(Number(event.target.value))} /><div className="player-time"><span>{time(player.positionMs)}</span><span>{time(player.durationMs)}</span></div></div><p role="status">{confirmed ? 'Играет текущий трек' : player.message || (player.status === 'loading' ? 'Загружаем звук…' : 'Звук на паузе')}<span>Локальный демо-фрагмент</span></p></div><div className="sound-choice">{withoutSound ? <p className="field-hint">Режим без звука включён для этой сессии.</p> : !mayDecide ? <button className="text-button" onClick={() => { autoplay.current = false; playback.pause(); setWithoutSound(true) }}>Продолжить без звука</button> : null}</div><ReviewControls entryUri={current.sourceUri!} canDecide={mayDecide} disabled={busy} canUndo={Boolean(review.history.length)} onDecision={decide} onUndo={undo} /></> : <div className="review-empty"><h2>{review.queue.length ? 'Сессия завершена.' : 'Здесь пока нечего слушать.'}</h2><p>{review.queue.length ? 'Проверь решения перед применением.' : 'Выбери другой плейлист или проверь состав текущего.'}</p><button className="button primary" onClick={preview}>Проверить решения</button>{!current && baseline && !review.queue.length && baseline.orderedEntries.length > 0 && <button className="button secondary" disabled={busy} onClick={() => void restart()}>Начать новый проход</button>}</div>}
        <div className="review-bottom">{!current && <ReviewUndoShortcut disabled={busy} canUndo={Boolean(review.history.length)} onUndo={undo} />}{!current && <button className="text-button" disabled={busy || !review.history.length} onClick={undo}>Отменить решение</button>}<button className="text-button" onClick={() => setScreen('choose')}>Другой плейлист</button></div></section><aside className="review-summary"><h2>Пока ничего не удалено.</h2><dl><div><dt>Всего записей</dt><dd>{baseline?.orderedEntries.length.toLocaleString('ru-RU')}</dd></div><div><dt>Просмотрено треков</dt><dd>{review.reviewedUris.length + review.cursor}</dd></div><div><dt>Групп на удаление</dt><dd>{removals}</dd></div></dl>{inaccessible > 0 && <p className="field-hint">{inaccessible} особенных записей сохранятся в плейлисте.</p>}<p>Слушай, решай, отменяй. Остальной плейлист сохранит свой порядок.</p></aside></div> : null}
      {screen === 'preview' && plan ? <section className="preview-panel"><div className="preview-heading"><h2>Удалить {plan.removedOccurrences} вхождения?</h2><p>{plan.removeUris.length} уникальных треков · останется {plan.expectedOrderedEntries.length} записей</p></div>{plan.blockedReasons.length > 0 ? <p role="alert">{plan.blockedReasons.join(' ')}</p> : null}{plan.removeUris.length ? <ul className="preview-list">{plan.removeUris.map((uri) => { const group = previewSource?.orderedEntries.filter((entry) => entry.sourceUri === uri) ?? []; return <li key={uri}><span><strong>{group[0]?.title ?? 'Трек'}</strong><span>{group[0]?.artist}</span></span><span>{group.length} вхождения</span></li> })}</ul> : <p className="description">Ни один трек не помечен на удаление. Плейлист сохранится целиком.</p>}<p className="field-hint">Это демо: изменяется только вымышленный плейлист в этой вкладке.</p><div className="button-row"><button className="button secondary" disabled={busy} onClick={() => setScreen('review')}>Вернуться к решениям</button><button className="button primary" disabled={busy || Boolean(plan.blockedReasons.length)} onClick={() => void apply()}>{busy ? 'Проверяем результат…' : 'Применить в демо'}</button></div></section> : null}
      {screen === 'result' ? <section className="result-panel" aria-live="polite"><h2>{result?.state === 'complete' ? 'Результат совпал с планом.' : 'Изменения не подтверждены.'}</h2><p>{result?.message}</p>{result?.state === 'complete' && <p className="result-count">{baseline?.orderedEntries.length}<span>записей осталось в демо-плейлисте</span></p>}<div className="button-row">{operation && !operation.sessionFinalized && <button className="button primary" disabled={busy} onClick={() => void recoverOperation()}>Проверить результат</button>}{operation?.state === 'partial' && !operation.pendingBatch && <button className="button secondary" disabled={busy} onClick={() => void recoverOperation(true)}>Продолжить применение</button>}{result?.state === 'complete' && session && currentUri(session) && <button className="button primary" onClick={() => setScreen('review')}>Продолжить разбор</button>}<button className="button secondary" onClick={() => setScreen('choose')}>Вернуться к плейлистам</button><a className="button secondary" href="/">Подключить Spotify</a></div></section> : null}
      <footer><span>Jamify · оставь любимое</span><button className="text-button" disabled={busy} onClick={() => void clearLocalData()}>Очистить локальные демо-данные</button><span>Демо не обращается к Spotify</span></footer>
    </main>
  </div>
}
