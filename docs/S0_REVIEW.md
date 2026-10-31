# S0: проверенные замечания и исправления

2026-11-01, Asia/Oral. Область: auth.ts, sdk.ts, api.ts, probe.ts и интеграция App.tsx. Это локальное ревью S0, а не итоговое ревью всех этапов или доказательство работы живого Spotify.

Два независимых Astra xhigh subagent проверяли auth/session/playback и API/probe. Они успели передать воспроизведённые находки, но их сессии остановились по лимиту до окончательных отчётов. Полученные находки перепроверены основным агентом; итоговые regression tests выполнены локально.

| Приоритет | Ошибка | Исправление и доказательство |
|---|---|---|
| P2 | При blocked sessionStorage код/state callback оставались в URL | Очистка URL выполняется до проверки доступности auth; отдельный Playwright regression |
| P2 | Late not_ready старого плеера сбрасывал готовность нового | disposed guards на событие и выдачу OAuth token; playback lifecycle regression |
| P2 | Успех probe аккаунта A отображался для аккаунта B | UI читает journal только при совпадении accountId; Playwright regression показывает progress=1 и заблокированное удаление для B |
| P3 | Invalid state при старой сессии сохранял refresh token | Fail-closed logout; auth regression проверяет очистку и отсутствие token exchange |
| P1 | Safari отклонял нативный fetch, вызванный как метод SpotifyAuth/SpotifyApi | Привязка к globalThis; ошибка receiver воспроизведена в самом Safari, callback/refresh/profile проверены с нативным fetch в WebKit и Chromium |
| P2 | Отсутствующий AbortSignal.timeout ошибочно отображался как сетевая ошибка OAuth | Переносимый AbortController + deadline для запроса и чтения тела; браузерный regression без native helper, unit tests таймаута и диагностики. Это отдельный дефект; последующая диагностика Safari установила ошибку receiver нативного fetch |
| P2/покрытие | Чтение смешанного плейлиста не запрашивало эпизоды явно | additional_types=track,episode; null/локальные entries остаются в наблюдаемом списке |

Полный итог: 55 Vitest tests, 26 Playwright tests (Chromium и WebKit), typecheck, lint, build прошли. Первая живая попытка OAuth завершилась ошибкой связи по сообщению пользователя; после исправления повтор ещё не выполнен. Успешный OAuth grant не подтверждён. DRM-плеер, private playlist create/append/delete и relinking остаются not-run. Connect fallback относится к следующему live-этапу. Автоматическое восстановление неоднозначной тестовой записи S0 не заявляется; повтор заблокирован.
