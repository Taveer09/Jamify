# Jamify: статус разработки

2026-11-01, Asia/Oral. Пользователь согласовал начало реализации. Репозиторий: [Taveer09/Jamify](https://github.com/Taveer09/Jamify), основная ветка `main`. Исходная рабочая ветка: `codex/jamify-foundation`.

## S0 — живое удаление ещё не подтверждено

Реализованы Vite/React/TypeScript-каркас, локальный экран подключения, PKCE/refresh, HTTP-адаптер, consistent pagination, SDK-адаптер и изолированная проба на новом приватном плейлисте. Документы перенесены из cases/playlist-swipe в docs; Client ID задан локально. Код и команды проверки существуют, дальнейшие scripts добавляются вместе с соответствующими этапами, без пустых зелёных заглушек.

Проверено: typecheck, lint, production build, 156 unit/domain/capability tests; полный Playwright suite98/98 и дополнительно2/2 large-copy сценария (Chromium и WebKit) прошли. npm audit: 0 уязвимостей; minimatch закреплён на исправленной 11.0.3 через override, lint и tests с ним проходят. Браузеры автопроверки: Chromium 156 и WebKit 27.2; viewport 390/768/1440, blocked storage, OAuth callback cleanup, account binding, клавиатура. Taste lint: 0 FAIL/0 WARN; browser inspector: 0 FAIL/1 WARN (независимые панели разной высоты, обоснование в DESIGN.md). Все итоговые снимки просмотрены.

Независимое ревью выявило ошибки lifecycle/account binding; подтверждённые находки исправлены и закреплены regression tests (см. S0_REVIEW.md). Живой OAuth/profile/refresh, создание/append/read теста и SDK actual URI подтвердились; DELETE остался unknown — полный S0 не закрыт. Публичный доступ ограничен Development Mode; скрытие Client ID это ограничение не меняет.

После двух неудачных попыток входа причина воспроизведена в самом Safari: сохранённый как метод объекта нативный fetch выбрасывал `TypeError: Can only call Window.fetch on instances of Window` до отправки HTTP. Обычный глобальный fetch в той же вкладке получил HTTP 400 от token endpoint и HTTP 401 от `/me` на заведомо невалидных данных. Конструкторы OAuth и API теперь привязывают fetch к globalThis. Исправленные адаптеры дополнительно запущены в самом Safari на невалидных тестовых данных: OAuth получает ожидаемый HTTP 400, API — HTTP 401; ошибка receiver больше не возникает. Это проверка транспорта, не успешного входа. Два regression-сценария используют настоящий browser fetch с перехваченными HTTP-ответами: callback/refresh и загрузка профиля проходят в Chromium и WebKit. Предыдущая правка AbortSignal.timeout закрыла отдельный воспроизводимый дефект, но не была причиной второй пользовательской ошибки.

Успешный grant и восстановление аккаунта теперь подтверждены в Safari, SDK подключился и сообщил правильный actual URI. Для теста создан один новый приватный плейлист; create/append/read прошли, DELETE остался unknown, read-only reconciliation показывает прежний A,B,A,C. Первичная причина отказа пока не установлена. Повторная запись не выполняется. Свои обычные плейлисты до disposable пробы API не вернул (0), выборка со многими страницами проверена на fixtures. Временная диагностика удалена.

Вмешательство пользователя для независимых demo/session работ не требуется. Закрытие DELETE live gate и подтверждение неоднозначной идентичности остаются условиями включения production mutations.

S1 реализован локально: /demo с вымышленными плейлистами, собственным аудио, случайными карточками, keep/remove/skip/undo, preview и проверенным in-memory apply. S3 session/persistence, S4 durable remove и S5 gestures реализованы на demo gateway. S6 durable demo copy реализован и проверен; S2 live и полная приёмка S7–S9 ещё не завершены; полноценный live apply остаётся закрыт. Production mutations и дальнейшая live-интеграция не объявляются готовыми до S0 live gate.

Исходная оценка S0 в PLAN.md включала успешную живую пробу, поэтому она пока не закрыта. После входа и теста API пересчитать оставшийся бюджет, особенно при новых ограничениях Spotify; ожидание аккаунта не считать временем генерации кода. По отдельному поручению пользователя создан публичный [GitHub-репозиторий Jamify](https://github.com/Taveer09/Jamify), исходная история и исправления отправлены в `main`. Авторство коммитов проверяется через GitHub; фиктивные коммиты и изменение дат не применяются. `.env.local` и временная диагностика не опубликованы; деплой не выполнялся.


## Ночная работа

Пользователь поручил работать до утра (ориентир 09:00 2026-11-01 Asia/Oral), выбирать модели/effort и периодически проводить ревью. Ветка `codex/night-2026-11-01`; подробные задачи и условия в OVERNIGHT.md, факты — NIGHT-LOG.md. После возобновления в07:00 heartbeat работал с cadence15 минут. Удалён в12:07 при первом успешном завершении после дедлайна; история — NIGHT-LOG.md. Main автоматически не сливается, ночная ветка может публиковаться по прежнему поручению пользователя. S1 demo/contracts завершён локально и прошёл независимое Astra xhigh review с исправлениями; S3 session/persistence завершён локально, S4 operation journal и S5 UI проверены; S6 demo copy проверен; полный live сценарий и финальная приёмка остаются открыты.


## S1 — демо и контракты

Реализованы contracts, каноническое сравнение без UI-индексов/названий, воспроизводимый shuffle и группировка URI, preview с сохранением неподдерживаемых записей, fake gateway и read-back apply. /demo работает без Client ID и без запросов Spotify. Есть обычный, mixed, empty и 10 000-entry dataset; три собственных CC0 аудиофрагмента и обложки. Native HTML audio подтверждён browser playing event в Chromium/WebKit, seek/pause проверены.

Два замечания независимого review исправлены: решения требуют прослушивания либо явного silent mode; источник аудио не путается с autoplay denial. Гонка WebKit-теста воспроизведена и устранена ожиданием завершения first-play attempt (5/5 повторов pass после фикса). Live production apply не объявляется реализованным. Demo gateway теперь сохраняет изменения на устройстве через IndexedDB (S3); при недоступном хранилище явно переходит в volatile режим.

Живой протокол обновлён в API_CAPABILITIES.md; актуальная live матрица — в API_CAPABILITIES.md, история предыдущих попыток — в NIGHT-LOG.md. Основной продукт продолжает выполняться на ночной ветке, без merge/deploy.


## S3 — сессии и хранение

Реализованы полная seeded очередь URI (без обрезания до25), окна по25, keep/remove/skip/undo, черновики и persistent demo library через idb8.0.4. Проверены 10000 entries, account/playlist binding, 30-day TTL без удаления при clock rollback, schema/history/queue coverage, optimistic revisions, текущая revision перед apply, восстановление карточки26 и второй apply без повторной отправки старых решений. Есть очистка локальных demo данных и явный volatile status при отказе IndexedDB. Volatile drafts переживают переключение плейлистов в той же вкладке.

Независимое Sol high review и точечная перепроверка исправлений — S3_REVIEW.md. Итог: check (90 tests/typecheck/lint/build) и 60 Chromium/WebKit browser checks pass. Один промежуточный suite дал ошибки ENOENT trace artifacts из-за параллельных reviewer/prod test runs с общим output; финальный последовательный suite60/60 прошёл. Для отдельных reviewer запусков назначены раздельные output directories.

S3 сам по себе не включил production writes и не закрыл DELETE live gate. Связь journal/finalize и Web Lock добавлены в S4 ниже.


## S4–S5 — проверено на demo gateway

S4: persistent operation journal до dispatch, Web Locks, account/snapshot/canonical preflight, fresh identity guard, read-only reconciliation без повторов ambiguous write, explicit partial resume, Retry-After deadline и atomic session+receipt finalize. После reload незавершённая операция замораживает черновик и локальную очистку. Миграция IndexedDB сохраняет S3 данные. Независимое Astra xhigh review с подтверждёнными исправлениями — S4_REVIEW.md.

S5: Pointer Events свайпы, кнопки, клавиши, Ctrl/Cmd+Z, guards для IME/input/repeat/stale URI, reduced-motion, отзывчивые карточки. Финальные screenshot проверки 390/768/1440 и отдельные UI24/24 pass — S5_REVIEW.md. Физический телефон и live mobile audio не проверены.

Итоговый npm run check:110/110 unit, typecheck/lint/build pass. Полный Chromium/WebKit suite88/88 pass (/tmp/jamify-s4-s5-final). Preview crash после server verify исправлен и покрыт pageerror regression. Retry-After независимо перепроверен после открытия новой IndexedDB connection: до срока apply/recover/resume дают0 gateway calls; после срока только explicit resume отправляет DELETE. Моки не закрывают S0 live gate.


## Сохранённый итог ночного этапа

Проверка времени:12:07 Asia/Oral,1 ноября. Новая разработка остановлена; automation jamify удалена, наличие папки automation после удаления не обнаружено. После07:22 в истории до этого запуска нет подтверждённых изменений; поступавшие heartbeat не считаются выполненной работой.

S6: очищенная private copy на demo gateway, keep-first в source order, source не меняется. Pending create/ID/append-prefix сохраняются; потеря create ID не приводит к новой копии; неоднозначный append проверяется чтением без повтора. Atomic финализация сохраняет source baseline отдельно от targetBaseline. Общий journal сверяется с замороженными решениями: подмена согласованного плана или URI не разрешает чужую запись. Реализовал Sol high; Astra xhigh независимо проверил19 failure cases и66 repository apply tests; замечания исправлены. Подробнее S6_IMPLEMENTATION.md.

Итог до остановки: npm run check156/156, полный Chromium/WebKit98/98, дополнительно large-copy2/2:10000 source entries →3200 unique target entries, source сохранён. Последнее изменение после full suite добавляло только эти2 теста. Copy preview просмотрен на390/768/1440, нет overflow; taste0 FAIL, один WARN о51px промежутке в desktop confirmation. Автоматический GIF и полный финальный S9 аудит не завершены. S8 добавил README/снимки/MIT/privacy/CI и OFL Inter.

Первый remote CI на567f432 упал:85/88 browsers pass. Исправлены зависимость keyboard test от локального Client ID и невозможность pause при loading/buffering; minimum Node22.13 согласован с ESLint. Новый CI и чистый запуск указываются в QA.md только по факту. Ночной код сохраняется в codex/night-2026-11-01, без merge main и деплоя.

Полный пользовательский v1 пока НЕ готов: S0 DELETE unknown, поэтому S2 production gateway/apply не включены, S6 live copy и mobile/audio/relinking не подтверждены. Основные плейлисты не менялись, неоднозначный DELETE не повторялся.


## Продолжение в desktop: swipe stack

По новому поручению пользователя терминальный агент остановлен, его Terminal окна закрыты; работа продолжена в desktop. Добавлены next-card sleeve,160ms WAAPI exit/promotion по transform/opacity, drag feedback под обложкой, отмена pending swipe и захват прерванного exit. Клавиатура и reduced-motion переключают карточку без задержки. Решение относится только к захваченному URI; пока exit не завершён, кнопки решений временно недоступны, Undo остаётся доступен. Preview и переход к другому плейлисту завершают pending выбор перед сохранением. Save status честно показывает незавершённое решение.

Исправлены регрессии первоначальной реализации: быстрые кнопки теряли выбор; уход в другой плейлист терял pending выбор. Тесты восстановления теперь ожидают видимую смену карточки, а audio regression отслеживает настоящий Audio constructor без предположения о DOM audio. Pointer re-grab проверяется в видимой части статьи после scroll.

Полный check156/156, type/lint/build pass; full Chromium/WebKit108/108 pass до финальной CSS правки ширины мобильной стопки и контраста disabled кнопки. Независимое Astra high review не нашло дополнительных подтверждённых дефектов; отдельно проверило pending→navigation/preview, Undo/reload в Chromium/WebKit и старт exit с текущего drag offset. Финальные snapshots390/768/1440 просмотрены, taste0 FAIL/0 WARN, Inter загружен. Дополнительный UI suite после CSS фиксируется в QA.md. Данные/audio вымышлены; live Spotify gate не изменился, физический touch not-run.
