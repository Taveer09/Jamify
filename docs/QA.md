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
