import { useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { SpotifyAuth } from '../lib/spotify/auth'
import { SpotifyApi } from '../lib/spotify/api'
import type { PlaylistSnapshot } from '../lib/spotify/api'
import { BrowserPlayer } from '../lib/playback/sdk'
import type { PlayerNotice } from '../lib/playback/sdk'
import { CapabilityProbe, trackUri } from '../features/capabilities/probe'
import type { ProbeState } from '../features/capabilities/probe'

type User = { id: string; display_name?: string | null }
type Screen = 'connect' | 'probe'

function initialize() {
  try {
    const storage = window.sessionStorage
    storage.setItem('jamify.storage-check', 'ok')
    storage.removeItem('jamify.storage-check')
    return { storage, auth: new SpotifyAuth({ storage }), error: '' }
  } catch {
    return { storage: null, auth: null, error: 'Браузер запретил хранилище вкладки. Разреши данные сайта, чтобы подключить Spotify.' }
  }
}

function messageFor(error: unknown): string {
  if (error instanceof z.ZodError) return 'Проверь введённые данные. Ответ Spotify пока не соответствует ожидаемому формату.'
  if (error instanceof Error) return error.message
  return 'Проверка не завершилась. Попробуй ещё раз.'
}

function JamMark() {
  return <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" fill="none">
    <path d="M9 5v13a5 5 0 1 1-5-5m17-8v18a5 5 0 1 1-5-5M9 9l12-4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
}

export function App() {
  const [runtime] = useState(initialize)
  const { auth, storage } = runtime
  const api = useMemo(() => auth ? new SpotifyApi(() => auth.getAccessToken()) : null, [auth])
  const probe = useMemo(() => api && storage ? new CapabilityProbe(api, storage) : null, [api, storage])
  const [screen, setScreen] = useState<Screen>('connect')
  const [clientId, setClientId] = useState(import.meta.env.VITE_SPOTIFY_CLIENT_ID ?? '')
  const redirectUri = import.meta.env.VITE_SPOTIFY_REDIRECT_URI || `${window.location.origin}/callback`
  const [user, setUser] = useState<User | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState(runtime.error)
  const [notice, setNotice] = useState('')
  const [playlists, setPlaylists] = useState<Array<{ id: string; name: string }>>([])
  const [selectedId, setSelectedId] = useState('')
  const [snapshot, setSnapshot] = useState<PlaylistSnapshot | null>(null)
  const [probeState, setProbeState] = useState<ProbeState | null>(null)
  const [uris, setUris] = useState(['', '', ''])
  const [playerNotice, setPlayerNotice] = useState<PlayerNotice | null>(null)
  const [requestedUri, setRequestedUri] = useState<string | null>(null)
  const [playUri, setPlayUri] = useState('')
  const [consent, setConsent] = useState(false)
  const player = useRef<BrowserPlayer | null>(null)

  useEffect(() => {
    const callback = window.location.pathname === '/callback'
    const callbackUrl = window.location.href
    // Remove authorization code/state before the request or any rendering of errors.
    if (callback) window.history.replaceState(null, '', '/diagnostics')
    if (!auth || !api) return
    let active = true
    async function restore() {
      try {
        if (callback) await auth!.complete(callbackUrl)
        if (!auth!.hasSession()) return
        const profile = await api!.currentUser()
        if (active) {
          setUser(profile)
          const saved = probe?.state()
          setProbeState(saved?.accountId === profile.id ? saved : null)
          setNotice('Spotify подключён. Можно проверить доступ к плейлистам.')
        }
      } catch (caught) { if (active) setError(messageFor(caught)) }
    }
    void restore()
    return () => { active = false; player.current?.disconnect() }
  }, [auth, api, probe])

  async function run(label: string, action: () => Promise<void>) {
    if (busy) return
    setBusy(label); setError(''); setNotice('')
    try { await action() } catch (caught) { setError(messageFor(caught)) }
    finally {
      setBusy(null)
      try {
        const saved = probe?.state()
        setProbeState(saved?.accountId === user?.id ? saved ?? null : null)
      } catch { setError('Не удалось прочитать журнал теста. Не повторяй запись; сначала проверь тестовый плейлист в Spotify.') }
    }
  }

  function disconnect() {
    player.current?.disconnect(); player.current = null
    auth?.logout(); setUser(null); setPlaylists([]); setSnapshot(null)
    setPlayerNotice(null); setProbeState(null); setRequestedUri(null); setScreen('connect')
    setNotice('Аккаунт отключён от этой вкладки. Тестовый плейлист в Spotify сохранён.')
  }

  async function loadPlaylists() {
    if (!api || !user) return
    const list = await api.ownPlaylists(user.id)
    setSnapshot(null)
    setPlaylists(list); setSelectedId(list[0]?.id ?? ''); setScreen('probe')
    setNotice(list.length ? `Найдено своих плейлистов: ${list.length}.` : 'Своих обычных плейлистов пока нет.')
  }

  const observed = snapshot?.items.filter((item) => item.kind === 'track' && !item.isLocal && item.uri) ?? []
  const uniqueCount = new Set(observed.map((item) => item.uri)).size
  const checks = [
    { label: 'Вход в Spotify', done: Boolean(user) },
    { label: 'Чтение плейлиста целиком', done: Boolean(snapshot) },
    { label: 'Воспроизведение в браузере', done: playerNotice?.state === 'playing' && playerNotice.uri === requestedUri },
    { label: 'Создание тестовой копии', done: probeState?.status === 'seeded' || probeState?.status === 'verified' },
    { label: 'Удаление точных повторов', done: probeState?.status === 'verified' },
  ]
  const completed = checks.filter((check) => check.done).length

  return <div className="app-shell">
    <aside className="sidebar" aria-label="Jamify">
      <a className="wordmark" href="/" aria-label="Jamify: главная"><JamMark /><span>Jamify</span></a>
      <div className="sidebar-body">
        <p className="nav-caption">Твоя музыка</p>
        <nav aria-label="Разделы">
          <button className={screen === 'connect' ? 'nav-button active' : 'nav-button'} aria-current={screen === 'connect' ? 'page' : undefined} onClick={() => setScreen('connect')}>Подключение</button>
          <button className={screen === 'probe' ? 'nav-button active' : 'nav-button'} aria-current={screen === 'probe' ? 'page' : undefined} disabled={!user} onClick={() => setScreen('probe')}>Проверка доступа</button>
        </nav>
        <div className="sidebar-note"><p>Музыка, которую<br />хочется оставить.</p><span>Первое подключение</span></div>
      </div>
      <div className="account"><span className={user ? 'signal connected' : 'signal'} aria-hidden="true" /><div><strong>{user?.display_name || (user ? 'Spotify подключён' : 'Spotify не подключён')}</strong><span>{user ? 'Личный аккаунт' : 'Начни с подключения'}</span></div></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><span>Твоя коллекция <span className="slash">/</span> {screen === 'connect' ? 'Первое подключение' : 'Проверка доступа'}</span><a href="https://open.spotify.com" target="_blank" rel="noreferrer">Открыть Spotify <span aria-hidden="true">↗</span></a></header>
      <main id="main">
        <div className="title-row"><div><h1>{screen === 'connect' ? 'Подключение Spotify' : 'Проверка доступа'}</h1><p>Подготовим Jamify к твоим плейлистам.</p></div>{user && <button className="button secondary" disabled={Boolean(busy)} onClick={disconnect}>Отключить аккаунт</button>}</div>
        {error && <div className="feedback error" role="alert"><strong>Проверка остановлена</strong><p>{error}</p></div>}
        {notice && <p className="feedback" role="status">{notice}</p>}
        {busy && <p className="feedback" role="status" aria-live="polite">{busy}…</p>}
        <div className="workspace-grid">
          <div className="primary-column">
            {screen === 'connect' ? <>
              <section className="panel connection-panel" aria-labelledby="connect-title">
                <div className="panel-heading"><h2 id="connect-title">Твой аккаунт. Твои плейлисты.</h2><span className="small">Spotify Premium</span></div>
                <p className="description">Подключи Spotify, чтобы Jamify мог читать твои плейлисты и воспроизводить музыку. Пароль вводится только на сайте Spotify.</p>
                <form onSubmit={(event) => { event.preventDefault(); void run('Переходим в Spotify', async () => {
                  if (!auth) throw new Error(runtime.error)
                  window.sessionStorage.setItem('jamify.auth.destination', 'diagnostics')
                  window.location.assign(await auth.authorize({ clientId: clientId.trim(), redirectUri }, window.location.origin))
                }) }}>
                  {user ? <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => void run('Загружаем плейлисты', loadPlaylists)}>Проверить мои плейлисты <span aria-hidden="true">→</span></button>
                    : <button type="submit" className="button primary" disabled={Boolean(busy) || !auth || !clientId.trim()}>Войти через Spotify <span aria-hidden="true">→</span></button>}
                  {!clientId.trim() && <p className="field-hint">Владелец этого экземпляра Jamify ещё не настроил подключение Spotify.</p>}
                  <details className="developer-settings">
                    <summary>Настройки разработчика</summary>
                    <p className="field-hint">Для самостоятельного запуска Jamify. Обычному пользователю достаточно кнопки входа выше.</p>
                    <label htmlFor="client-id">Client ID приложения</label>
                    <input id="client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Из настроек Spotify Developer Dashboard" aria-describedby="client-hint" disabled={Boolean(busy) || Boolean(user)} />
                    <p className="field-hint" id="client-hint">Публичный идентификатор приложения. Client Secret здесь не используется.</p>
                    <p className="field-hint"><a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">Настроить приложение в Spotify Developer Dashboard ↗</a></p>
                    <p className="field-hint">Redirect URI в настройках Spotify:</p>
                    <code className="redirect">{redirectUri}</code>
                  </details>
                </form>
              </section>
              <section className="panel"><h2>Сначала попробовать?</h2><p className="description">Разбери вымышленный плейлист с локальным звуком — без входа в аккаунт.</p><a className="button secondary" href="/demo">Открыть демо →</a></section>
              <section className="panel setup-panel" aria-labelledby="setup-title"><h2 id="setup-title">Один вход через Spotify</h2><p>Войди в свой аккаунт и разреши Jamify доступ. Создавать приложение Spotify и искать идентификаторы тебе не нужно.</p><p className="field-hint">Сейчас Jamify тестируется в закрытом режиме. Доступ получают аккаунты, добавленные владельцем приложения.</p></section>
            </> : <>
              <section className="panel" aria-labelledby="read-title"><div className="panel-heading"><h2 id="read-title">Твои плейлисты</h2><button className="text-button" disabled={Boolean(busy)} onClick={() => void run('Обновляем список', loadPlaylists)}>Обновить</button></div>
                {playlists.length ? <><label htmlFor="playlist">Выбери плейлист для чтения</label><select id="playlist" value={selectedId} disabled={Boolean(busy)} onChange={(event) => { setSelectedId(event.target.value); setSnapshot(null) }}>{playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button className="button secondary" disabled={Boolean(busy)} onClick={() => void run('Читаем все страницы', async () => { if (!api || !user) return; setSnapshot(await api.stableSnapshot(selectedId, user.id)) })}>Проверить загрузку</button></> : <p className="description">Нажми «Обновить», чтобы загрузить свои плейлисты. Проверка ничего в них не меняет.</p>}
                {snapshot && <div className="snapshot-result"><p><strong>{snapshot.playlist.name}</strong></p><dl className="counts"><div><dt>Всего записей</dt><dd>{snapshot.items.length}</dd></div><div><dt>Уникальных треков</dt><dd>{uniqueCount}</dd></div><div><dt>Повторных вхождений</dt><dd>{observed.length - uniqueCount}</dd></div></dl><p className="field-hint">Локальные файлы и недоступные записи учтены в общем количестве. Идентичность при замене треков Spotify ещё требует отдельной проверки.</p>
                  <ul className="track-list">{observed.slice(0, 3).map((item, index) => <li key={`${index}-${item.uri}`}><span>{item.title}</span><code>{item.uri}</code></li>)}</ul>
                  <button className="text-button" disabled={observed.length < 3} onClick={() => { const unique = Array.from(new Set(observed.map((item) => item.uri))).filter((uri): uri is string => Boolean(uri)).slice(0, 3); if (unique.length === 3) { setUris(unique); setPlayUri(unique[0]) } else setError('Нужно три разных доступных трека.') }}>Использовать три разных трека для теста</button>
                </div>}
              </section>
              <section className="panel" aria-labelledby="player-title"><div className="panel-heading"><h2 id="player-title">Проверка звука</h2><span className="small">Браузерный плеер</span></div><p className="description">Подключи плеер и запусти один трек. Успех подтвердится, когда Spotify сообщит, что играет именно выбранная композиция.</p>
                <label htmlFor="play-uri">Spotify URI трека</label><input id="play-uri" value={playUri} onChange={(event) => setPlayUri(event.target.value)} placeholder="spotify:track:…" />
                <div className="button-row"><button className="button secondary" disabled={Boolean(busy)} onClick={() => void run('Подключаем плеер', async () => {
                  if (!auth) return; player.current?.disconnect(); setPlayerNotice(null)
                  const next = new BrowserPlayer(() => auth.getAccessToken(), setPlayerNotice); player.current = next; await next.connect()
                })}>Подключить плеер</button><button className="button primary" disabled={Boolean(busy) || !playerNotice || playerNotice.state === 'error'} onClick={() => void run('Запускаем трек', async () => { if (!api || !player.current) return; const uri = trackUri(playUri); setRequestedUri(uri); await player.current.play(uri, api) })}>Слушать</button><button className="text-button" disabled={!playerNotice} onClick={() => void run('Ставим на паузу', async () => { await player.current?.pause() })}>Пауза</button></div>
                {playerNotice && <p role="status" className="field-hint">{playerNotice.state === 'error' ? playerNotice.message : playerNotice.state === 'ready' ? 'Плеер подключён. Теперь нажми «Слушать».' : playerNotice.uri === requestedUri && playerNotice.state === 'playing' ? 'Выбранный трек играет. Воспроизведение подтверждено.' : 'Воспроизведение ещё не подтверждено для выбранного трека.'}</p>}
              </section>
              <section className="panel" aria-labelledby="probe-title"><h2 id="probe-title">Одноразовый тест изменений</h2><p className="description">Jamify создаст отдельный приватный плейлист с последовательностью A, B, A, C. Затем можно проверить удаление обеих копий A. Твои исходные плейлисты остаются без изменений.</p>
                {uris.map((uri, index) => <div className="field" key={index}><label htmlFor={`uri-${index}`}>Трек {['A', 'B', 'C'][index]}</label><input id={`uri-${index}`} value={uri} onChange={(event) => setUris(uris.map((old, i) => i === index ? event.target.value : old))} placeholder="spotify:track:…" disabled={Boolean(busy) || Boolean(probeState)} /></div>)}
                <label className="checkbox"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>Создать отдельный тестовый плейлист в моём Spotify</span></label>
                <div className="button-row"><button className="button secondary" disabled={!consent || Boolean(busy) || Boolean(probeState)} onClick={() => void run('Создаём тестовый плейлист', async () => { if (probe && user) { await probe.create(user.id, uris); setNotice('Тестовый плейлист создан: A, B, A, C. Можно проверить удаление повторов.') } })}>Создать тестовый плейлист</button><button className="button secondary destructive" disabled={Boolean(busy) || probeState?.status !== 'seeded'} onClick={() => void run('Проверяем удаление тестового трека A', async () => { if (probe && user) { await probe.removeDuplicateGroup(user.id); setNotice('Проверено повторным чтением: остались только B и C.') } })}>Удалить A только из теста</button></div>
                {probeState && <p className="field-hint" role="status">{probeState.status === 'verified' ? 'Удаление URI-группы подтверждено.' : probeState.status === 'seeded' ? 'Тест подготовлен: 4 записи, включая две копии A.' : 'Есть незавершённая тестовая операция. Повторная запись отключена; проверь результат в Spotify.'}{probeState.playlistId && <> <a href={`https://open.spotify.com/playlist/${probeState.playlistId}`} target="_blank" rel="noreferrer">Открыть тестовый плейлист ↗</a></>}</p>}
              </section>
            </>}
          </div>
          <aside className="progress-column" aria-labelledby="progress-title"><section className="panel progress-panel"><div className="panel-heading"><h2 id="progress-title">Готовность подключения</h2><span className="progress-number">{completed}<span> / {checks.length}</span></span></div><progress value={completed} max={checks.length} aria-label="Готовность подключения" /><ul className="check-list">{checks.map((check) => <li key={check.label}><span className={check.done ? 'check done' : 'check'} aria-hidden="true">{check.done ? <svg viewBox="0 0 16 16" width="12" height="12" fill="none"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="1.5" /></svg> : '–'}</span><span>{check.label}</span><span className="sr-only">{check.done ? 'проверено' : 'ещё не проверено'}</span></li>)}</ul><p className="field-hint">Результаты появятся после реальных проверок. Наличие Client ID само по себе не подтверждает доступ.</p></section>
            <section className="next-panel"><h2>Дальше — твоя музыка</h2><p>После подключения начнём с коротких сессий: случайный трек, прослушивание, оставить или убрать.</p><p className="small">Свайпы появятся на следующем этапе. Сейчас проверяем интеграцию.</p></section>
          </aside>
        </div>
        <footer><span>Jamify · оставь любимое</span><a href="https://open.spotify.com" target="_blank" rel="noreferrer">Открыть Spotify ↗</a></footer>
      </main>
    </div>
  </div>
}
