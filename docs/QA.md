# Jamify — фактическое покрытие

2026-11-01, Asia/Oral. Ночная ветка `codex/night-2026-11-01`. Демо и live учитываются отдельно.

## Локальные проверки

- macOS: Node26.8.1; Chromium156 / WebKit27.2 через Playwright1.64.1. Дополнительно check запущен на минимальном поддерживаемом Node22.13.0 через временный npm runtime.
- S4/S5 checkpoint: npm run check110/110 unit, type/lint/build pass; полный browser suite88/88 pass.
- S6 core: npm run check156/156 unit, type/lint/build pass; test:apply66/66, включая46copy cases. Независимый Astra reviewer:19 дополнительных failure/integrity cases pass, затем66 repository apply tests pass.
- Copy+demo integration18/18 pass. После двух исправлений CI — setup/demo/copy subset46/46 pass локально. Полный S6 suite98/98 pass; после него добавлены и отдельно выполнены large-copy2/2 на том же source code:10000→3200 с сохранением source.
- npm audit0 на последнем npm ci. `.env.local` ignored, не копировался в clean checks и не коммитился.

| Область | Проверено | Граница доказательства |
|---|---|---|
| Demo isolation | Отдельные browser contexts без grant, ни одного запроса Spotify; собственные WAV/SVG | Это вымышленные данные |
| Карточки/звук | Native HTMLAudio playing, seek, pause, blocked/failed audio, старые события; explicit silent mode | Физическая слышимость не измерялась |
| Жесты/доступность | Pointer threshold/cancel/vertical scroll/stale URI, клавиши/IME/input/repeat, undo, reduced motion, 390/768/1440 | Реальный touch device — not-run |
| Сессия | Seed, полная очередь, окна25, skip/undo/reload, карта26, второй apply, 10000 entries | Большая очередь на fixtures/demo |
| Хранение | Account binding, schema/history, TTL30d, clock rollback, optimistic revision, blocked storage/volatile fallback, v1→v2 migration | Произвольная очистка браузером вне контроля приложения |
| Remove | Exact URI-groups, сохранение остальных entries/order, snapshot/identity conflicts, lost response, account switch, 429, rollback, locks/two coordinators | Live destructive apply закрыт S0 gate; UI максимум25 групп за сессию |
| Copy | Keep-first в исходном порядке, undecided сохраняются, remove choices исключаются, private new target, append100, известный ID/prefix recovery, unknown create без повторов | Проверено на demo gateway; Spotify private S6 copy — not-run |
| Journal integrity | Подмена согласованного плана/URI/null/pending batch блокируется против замороженных решений до writes | Не заявляется защита от произвольного XSS/полного контроля устройства |
| Atomic finalize | Server verify и локальная транзакция drafts+operations, crash до/после checkpoint, rollback receipt failure | Gateway write и local DB не являются общей distributed transaction; unknown обрабатывается чтением |

## Live Spotify — Safari

| Проверка | Статус |
|---|---|
| OAuth PKCE/profile/refresh | pass |
| Список своих обычных плейлистов | pass, до disposable пробы0; многостраничность только fixtures |
| Private disposable create + append A,B,A,C + full read | pass |
| DELETE A → B,C | unknown; read-only reconciliation всё ещё A,B,A,C, повтор не отправлялся |
| SDK ready/actual URI совпал | pass |
| Физический звук, paused callback, real mobile, relinking без linked_from | not-run / не подтверждено |
| S2 production end-to-end, S6 live copy | not-run, зависят от открытого S0 gate |

Основные плейлисты не изменялись. Исходную скрытую generic catch HTTP-ошибку нельзя восстановить задним числом. Подробности — [API_CAPABILITIES.md](API_CAPABILITIES.md).

## CI и чистый запуск

Первый реальный GitHub run на567f432: [CI#1](https://github.com/Taveer09/Jamify/actions/runs/41264158056) — fail,85/88 browser pass. Type/lint/unit/build прошли. Подтверждены две проблемы: keyboard test полагался на локальный Client ID; после seek/buffering кнопка не позволяла остановить ещё активное аудио, пока не пришёл новый playing event. Тест теперь сам настраивает fixture Client ID с клавиатуры, плеер допускает pause при loading без выдачи playing подтверждения. Отдельный stalled-audio regression и setup/demo/copy46/46 локально pass. Минимальный Node поднят с22.12 до22.13 из-за фактического engines ESLint; это не выдаётся за причину всех browser failures.

Новый удалённый CI и clean install должны быть подтверждены на сохранённом итоговом commit; полный локальный suite98/98 плюс large-copy2/2 pass. Production deploy не выполнялся.


## Desktop swipe continuation

- Full check156/156 unit + type/lint/build pass; full Playwright108/108 pass.
- Added real Audio instance instrumentation verifies old track through exit, next audio selection and Undo, with0 Spotify calls. Held animations exercise interrupt/Undo/disabled/stale props without speed-dependent sleeps.
- Fixed pending button/navigation/save status regressions. Session persistence waits for visible card promotion before capturing the next title.
- Independent Astra reviewer: pending navigation commits once, preview includes pending removal, Undo/reload restore correct decisions, drag exit starts at captured offset; no additional confirmed issue.
- Final390/768/1440 screenshots reviewed; taste measurements0FAIL/0WARN after CSS alignment/contrast polish. Headless browser checks do not prove physical touch/live Spotify/audio audibility.

Final CSS check: npm run check156/156 pass; targeted review-ui Chromium/WebKit32/32 pass after mobile stack and disabled contrast polish.

## Full queue and Spotify palette revision

- `npm run check`:167/167 tests + types/lint/build pass (последовательный запуск после завершения browser suite).
- Full Playwright126/126 Chromium/WebKit pass; targeted library/review50/50 также pass. Старые6 first-fold тестов сначала искали скрытый Skip; обновлены под пользовательское требование2главных кнопок, само Skip продолжает проверяться через меню и ArrowDown.
- Новая live-route fixture матрица: pagination70tracks,27choices/reload/export; no playlist/library writes; Liked403/reconsent; followed403; logout while GET pending; blocked localStorage with memory restore; SDK foreign URI invalidates prior playing evidence. OAuth/SDK fixtures не доказывают живую медиатеку и звук.
- Domain queue3200unique/10000source entries проходит25→26 без окна.205 согласованных draft-removals проверены последовательными fake batches100/100/5, full ordered read-back и finalization. Existing forged150request по-прежнему не отправляет mutation.
- Review обнаружил stale playing confirmation, unhandled activation rejection, blocked localStorage read и исчезающие unsupported entries; подтверждённые случаи исправлены, regression tests добавлены. Независимый UI finish review: ship по шести снимкам.
- Новый live продукт в реальном аккаунте: not-run в этой ревизии. Исторические Safari OAuth/SDK actual URI pass и DELETE unknown остаются прежними. Mobile physical audio, relinking/source proof, production apply — открыты.

## Playback recovery and minimal release, 2026-11-02

Check175unit/capability/domain/apply +types/lint/build pass. Full Chromium/WebKit138/138 pass. New tests coverSDK error duringtransfer/readiness, immediatepause duringpendingread, post-refresh cancellation beforedispatch, boundedreadiness polling, sameSDK404manualretry and zero playlist/librarywrites. Read-only followedplaylist is nowtested bothAPIallowed andserver403 instead ofa guessedowner verdict.

Minimal screenshots390/768/1440 andmenus inspected; actionsfitfirstfold. No footer/always-visible secondarybuttons. Healthy save state is screenreader-only; errors/storagewarnings/safety note remainvisible. Menu/Escape/focus and explicit silent→audio transition verified. Real userSpotifynewplayback remainsnot-run, historicalunknownDELETEunchanged. Production smoke is appended afterdeployment.

Production smoke (2026-11-02): https://jamify-lyart.vercel.app доступен без Vercel login. HTTP200 root/demo/callback/diagnostics, SVG favicon MIME корректен. Chromium390 проверил localdemo audio playing, arrow+Undo, zero pageerrors/overflow. Production authorize URL формирует верный /callback; запрос остановлен доOAuth, пользовательскийgrant иlive Spotify звук not-run.

## Playback investigation (2026-11-03)

187 unit tests/type/lint/build pass. New regression coverage: matching paused/unpaused SDK track avoids REST, rejected resume never REST-falls-through, original404 phase survives failed device diagnostics, replacementdevice duringtransfer and after activation, autoplay denial followed by sameSDK click, confirmation timeout despite null events, late playing after Pause, hung SDK read/pause deadline, reset during pendingSDK load. Full138 Chromium/WebKit pass; after adding browser SDKresume/autoplay fixtures and final reset guard, library26/26 pass (overlapping coverage; do not sum as unique tests). Fixture SDK evidence is not live Spotify audio.

No authenticated live Jamify browser tab was available. Required live acceptance: select actual track→matching SDK URI+advancing position; hear sound; pause/resume same track→no extra RESTstart; change track→newmatchingURI;20swipes remain bound. If failure persists, capture only menu's stage/status/reason/visibility line. Never paste auth URL, token, device IDs or raw response. Original disposable DELETEunknown remains untouched.

Production d054284 smoke: new bundle served onstablealias, HTTP200, actualdemo Audio playing andzero pageerror. This is a hosting/demo check, not liveSpotify playback proof. No real playlist writes performed.

## Clock, seek and animated keyboard choices — 2026-11-03

- Final check:194/194 unit, types/lint/build pass. Tests include clock progress with frozen SDK snapshots, pause/dispose, null state, stale poll after backward/forward seek, device replacement cancelling a seek, no polling during pending seek, long/short intro offsets. Cancelled/stale assertions occur before pause.
- Full browser run146/146 Chromium/WebKit pass (/tmp/jamify-clock-seek-animation-e2e); final targeted library/review64/64 pass (/tmp/jamify-clock-seek-final-e2e). Overlapping suites; latest intro case included in final targeted run. Mouse-click seek, advancing time without Pause, paused position, keyboard exit/Undo, reduced motion and past25 choices covered with fake Spotify SDK/API.390px review render inspected.
- Independent playback review findings addressed. Only local SDK calls reconcile/seek; no playlist/library mutations and no private preview endpoints. Intro30s is optional, session-only, off by default, tracks≤45s start at0. It does not detect a song's best part.
- Real user Spotify audio/seek is not-run in this automated verification. Historical DELETEunknown and all mutation gates unchanged. Public deployment smoke follows after release.
