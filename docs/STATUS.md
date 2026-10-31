# Jamify: статус разработки

2026-11-01, Asia/Oral. Пользователь согласовал начало реализации. Репозиторий: [Taveer09/Jamify](https://github.com/Taveer09/Jamify), основная ветка `main`. Исходная рабочая ветка: `codex/jamify-foundation`.

## S0 — живое удаление ещё не подтверждено

Реализованы Vite/React/TypeScript-каркас, локальный экран подключения, PKCE/refresh, HTTP-адаптер, consistent pagination, SDK-адаптер и изолированная проба на новом приватном плейлисте. Документы перенесены из cases/playlist-swipe в docs; Client ID задан локально. Код и команды проверки существуют, дальнейшие scripts добавляются вместе с соответствующими этапами, без пустых зелёных заглушек.

Проверено: typecheck, lint, production build, 90 unit/domain/capability tests и 60 Playwright-сценариев (Chromium и WebKit) прошли. npm audit: 0 уязвимостей; minimatch закреплён на исправленной 11.0.3 через override, lint и tests с ним проходят. Браузеры автопроверки: Chromium 156 и WebKit 27.2; viewport 390/768/1440, blocked storage, OAuth callback cleanup, account binding, клавиатура. Taste lint: 0 FAIL/0 WARN; browser inspector: 0 FAIL/1 WARN (независимые панели разной высоты, обоснование в DESIGN.md). Все итоговые снимки просмотрены.

Независимое ревью выявило ошибки lifecycle/account binding; подтверждённые находки исправлены и закреплены regression tests (см. S0_REVIEW.md). Живой OAuth/profile/refresh, создание/append/read теста и SDK actual URI подтвердились; DELETE остался unknown — полный S0 не закрыт. Публичный доступ ограничен Development Mode; скрытие Client ID это ограничение не меняет.

После двух неудачных попыток входа причина воспроизведена в самом Safari: сохранённый как метод объекта нативный fetch выбрасывал `TypeError: Can only call Window.fetch on instances of Window` до отправки HTTP. Обычный глобальный fetch в той же вкладке получил HTTP 400 от token endpoint и HTTP 401 от `/me` на заведомо невалидных данных. Конструкторы OAuth и API теперь привязывают fetch к globalThis. Исправленные адаптеры дополнительно запущены в самом Safari на невалидных тестовых данных: OAuth получает ожидаемый HTTP 400, API — HTTP 401; ошибка receiver больше не возникает. Это проверка транспорта, не успешного входа. Два regression-сценария используют настоящий browser fetch с перехваченными HTTP-ответами: callback/refresh и загрузка профиля проходят в Chromium и WebKit. Предыдущая правка AbortSignal.timeout закрыла отдельный воспроизводимый дефект, но не была причиной второй пользовательской ошибки.

Успешный grant и восстановление аккаунта теперь подтверждены в Safari, SDK подключился и сообщил правильный actual URI. Для теста создан один новый приватный плейлист; create/append/read прошли, DELETE остался unknown, read-only reconciliation показывает прежний A,B,A,C. Первичная причина отказа пока не установлена. Повторная запись не выполняется. Свои обычные плейлисты до disposable пробы API не вернул (0), выборка со многими страницами проверена на fixtures. Временная диагностика удалена.

Вмешательство пользователя для независимых demo/session работ не требуется. Закрытие DELETE live gate и подтверждение неоднозначной идентичности остаются условиями включения production mutations.

S1 реализован локально: /demo с вымышленными плейлистами, собственным аудио, случайными карточками, keep/remove/skip/undo, preview и проверенным in-memory apply. S2 и S4–S9 не завершены; S3 session/persistence реализован на demo gateway; live apply остаётся закрыт. Жесты и полноценный live apply пока отсутствуют. Production mutations и дальнейшая live-интеграция не объявляются готовыми до S0 live gate.

Исходная оценка S0 в PLAN.md включала успешную живую пробу, поэтому она пока не закрыта. После входа и теста API пересчитать оставшийся бюджет, особенно при новых ограничениях Spotify; ожидание аккаунта не считать временем генерации кода. По отдельному поручению пользователя создан публичный [GitHub-репозиторий Jamify](https://github.com/Taveer09/Jamify), исходная история и исправления отправлены в `main`. Авторство коммитов проверяется через GitHub; фиктивные коммиты и изменение дат не применяются. `.env.local` и временная диагностика не опубликованы; деплой не выполнялся.


## Ночная работа

Пользователь поручил работать до утра (ориентир 09:00 2026-11-01 Asia/Oral), выбирать модели/effort и периодически проводить ревью. Ветка `codex/night-2026-11-01`; подробные задачи и условия в OVERNIGHT.md, факты — NIGHT-LOG.md. Heartbeat jamify действительно сохранён ACTIVE с cadence 30 минут в локальном automation.toml. Main автоматически не сливается, ночная ветка может публиковаться по прежнему поручению пользователя. S1 demo/contracts завершён локально и прошёл независимое Astra xhigh review с исправлениями; S3 session/persistence завершён локально, следующий шаг — S4 operation journal и S5 UI при открытом DELETE live gate.


## S1 — демо и контракты

Реализованы contracts, каноническое сравнение без UI-индексов/названий, воспроизводимый shuffle и группировка URI, preview с сохранением неподдерживаемых записей, fake gateway и read-back apply. /demo работает без Client ID и без запросов Spotify. Есть обычный, mixed, empty и 10 000-entry dataset; три собственных CC0 аудиофрагмента и обложки. Native HTML audio подтверждён browser playing event в Chromium/WebKit, seek/pause проверены.

Два замечания независимого review исправлены: решения требуют прослушивания либо явного silent mode; источник аудио не путается с autoplay denial. Гонка WebKit-теста воспроизведена и устранена ожиданием завершения first-play attempt (5/5 повторов pass после фикса). S3 persistence и S4 production journal не объявляются реализованными. Demo gateway теперь сохраняет изменения на устройстве через IndexedDB (S3); при недоступном хранилище явно переходит в volatile режим.

Живой протокол обновлён в API_CAPABILITIES.md; актуальная live матрица — в API_CAPABILITIES.md, история предыдущих попыток — в NIGHT-LOG.md. Основной продукт продолжает выполняться на ночной ветке, без merge/deploy.


## S3 — сессии и хранение

Реализованы полная seeded очередь URI (без обрезания до25), окна по25, keep/remove/skip/undo, черновики и persistent demo library через idb8.0.4. Проверены 10000 entries, account/playlist binding, 30-day TTL без удаления при clock rollback, schema/history/queue coverage, optimistic revisions, текущая revision перед apply, восстановление карточки26 и второй apply без повторной отправки старых решений. Есть очистка локальных demo данных и явный volatile status при отказе IndexedDB. Volatile drafts переживают переключение плейлистов в той же вкладке.

Независимое Sol high review и точечная перепроверка исправлений — S3_REVIEW.md. Итог: check (90 tests/typecheck/lint/build) и 60 Chromium/WebKit browser checks pass. Один промежуточный suite дал ошибки ENOENT trace artifacts из-за параллельных reviewer/prod test runs с общим output; финальный последовательный suite60/60 прошёл. Для отдельных reviewer запусков назначены раздельные output directories.

До S4 нет общей atomic связи mutation journal/finalize и Web Lock на весь apply. Поэтому S3 не включил production writes и не закрывает DELETE live gate. S5 компоненты могут разрабатываться параллельно S4 в отдельных файловых зонах.
