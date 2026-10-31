# Jamify — план разработки для Codex

Статус: реализация согласована пользователем 2026-11-01, Asia/Oral. Начат S0; независимая критика учтена.
Вход: [SPEC.md](SPEC.md), обсуждение с пользователем; Premium подтверждён пользователем. В репозитории пока нет кода, AGENTS.md, CASE.md и расписания хакатона. Дедлайн не задан, поэтому часы до заморозки не вычисляются. Время подготовки проверено через `date`: 2026-11-01 00:25 +05.

Документы лежат в `cases/playlist-swipe/`, потому что приложение ещё не создано. После согласования на S0 перенести SPEC/PLAN/TASKS/PLAN_REVIEW в `docs/` и исправить внутренние ссылки. Не запускать разработку автоматически из этого документа.

## 1. Объём и важные решения

Уточнение по пользовательскому сценарию (2026-11-01): Client ID задаёт владелец экземпляра Jamify, пользователи входят через общую OAuth-кнопку. Ввод своего Client ID не является обычным onboarding. Для GitHub сохраняется опция самостоятельного запуска; публикация демо на Vercel не означает массового доступа к Spotify. Лимит до 5 аккаунтов и требования Extended Quota проверены в официальной документации повторно; серверная прослойка и desktop wrapper их не снимают.

1. Веб-приложение, сначала десктопный Chromium и адаптивный интерфейс. На мобильном устройстве отдельно проверить реальный звук и жесты; адаптивность сама по себе этого не доказывает.
2. Свайпы только записывают решения. Запросы изменения выполняются после финального просмотра и нажатия «Применить».
3. Два разных результата: удалить целые URI-группы из исходника; либо создать приватную очищенную копию, оставив одно вхождение каждого выбранного URI. Дедупликация исходника через полную перезапись не входит в v1.
4. Random — один раз перемешанный список уникальных URI с сохранённым seed и курсором. Нет повторов в проходе; skip остаётся без решения и не зацикливается в текущей сессии.
5. Только свои обычные плейлисты без совместного редактирования. Недоступные и локальные записи имеют отдельные счётчики; нельзя молча выбрасывать их из результата.
6. В v1 нет AI и вызовов OpenAI API. Модели из плана используются для разработки в Codex.

## 2. Проверенные возможности и неизвестные

Актуальность источников: проверены 2026-11-01; поведение собственного Developer App ещё не проверялось.

- Development Mode требует Premium у владельца и ограничен пятью allowlisted пользователями. GitHub и самостоятельный запуск допустимы как формат проекта; это не обещание расширенного доступа. [Spotify quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).
- Использовать текущие `/playlists/{id}/items`, а не копировать старые примеры `/tracks`. У новых приложений ограничения чтения плейлистов и изменённая схема ответов. [Migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).
- В Development Mode могут отсутствовать `linked_from` у треков и `product/country/email` у `/me`. Не определять Premium по отсутствующему product и не выдумывать исходный URI. Способ подтверждения идентичности — часть S0; неоднозначные случаи имеют отдельный закрытый гейт. [Migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).
- DELETE принимает до 100 URI-объектов и snapshot_id. В актуальной схеме не указан параметр positions. Семантику удаления повторных URI подтвердить на тестовом плейлисте; не реализовывать недокументированные поля по памяти. [Remove items](https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist).
- Воспроизведение в SDK требует Premium и может нуждаться в первом пользовательском нажатии. [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk/reference).
- Playback API управляет активным/выбранным устройством и требует Premium. Это запасной путь при недоступном браузерном SDK. [Start playback](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback).
- `preview_url` устарел и может отсутствовать; не использовать как основу звука. [Get track](https://developer.spotify.com/documentation/web-api/reference/get-track).
- PKCE подходит браузерному приложению без Client Secret. Redirect: `http://127.0.0.1:5173/callback` для локального запуска; для хостинга HTTPS и точное совпадение адреса. `localhost` не использовать. [PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow), [Redirect URIs](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).
- Локальные записи нельзя добавить в новую копию через API. snapshot_id обозначает версию и помогает работе с изменениями, но не является обещанием атомарной транзакции для серии запросов. [Playlists](https://developer.spotify.com/documentation/web-api/concepts/playlists).

## 3. Архитектура

Стек: React + TypeScript + Vite, CSS variables и обычный CSS, React Router, Zustand для состояния, Zod на границе API, Vitest + Testing Library, MSW, Playwright. Версии выбрать и закрепить lock-файлом на S0, без номеров из памяти. Анимацию сначала делать CSS/Pointer Events; отдельную библиотеку добавлять только при доказанной необходимости.

Слои:

```text
screens/components → session store → pure domain logic
                  → playback coordinator → SDK / Connect adapter
                  → playlist service → Spotify HTTP + OAuth
                  → apply coordinator → mutation journal + verification
demo screen       → те же интерфейсы с fake adapter и локальным аудио
```

Файловые границы:

```text
src/contracts/              модели и интерфейсы; меняет только интегратор
src/domain/                 shuffle, decisions, duplicates, diff, apply plan
src/lib/spotify/             HTTP, DTO schemas, OAuth, pagination, mapping
src/lib/playback/            SDK, Connect, единый координатор команд
src/lib/persistence/         версия схемы, сессии и журнал операций
src/features/session/        store и прикладная координация
src/features/apply/          исполнение плана и сверка результата
src/features/duplicates/     режим создания очищенной копии
src/screens/                login, playlists, review, apply, result
src/components/             карточки, кнопки, player, feedback
src/styles/                 токены и адаптивность
src/demo/ public/demo/       фикстуры и собственное/разрешённое тестовое аудио
tests/domain/ tests/api/ tests/playback/ tests/apply/ tests/e2e/
docs/ scripts/              руководства и опциональная live-проверка
```

### Контракты до параллельной работы

Ниже схемы для реализации, а не уже существующий код.

```ts
type Entry = {
  entryKey: string; // playlistId + baselineSnapshot + originalIndex
  originalIndex: number;
  observedUri: string | null; // буквально полученный URI
  sourceUri: string | null; // только подтверждённая идентичность исходника
  playbackUri: string | null; // может отличаться из-за track relinking
  identityConfidence: 'confirmed' | 'ambiguous' | 'opaque';
  kind: 'track' | 'episode' | 'local' | 'unavailable';
  title: string;
  artist: string;
  imageUrl: string | null;
  spotifyUrl: string | null;
  durationMs: number | null;
  canPlay: boolean;
  canCopy: boolean;
  canRemove: boolean;
};
type CanonicalItem = {
  kind: Entry['kind'];
  identity: string | null; // подтверждённый URI или стабильный observed URI
  visibility: 'identified' | 'opaque';
};
type Baseline = {
  accountId: string; playlistId: string; snapshotId: string;
  orderedEntries: Entry[]; fingerprint: string;
};
type Decision = 'keep' | 'remove' | 'skip';
type ReviewSession = {
  schemaVersion: 1; accountId: string; playlistId: string;
  runId: string; reviewedUris: string[];
  baselineSnapshotId: string; baselineFingerprint: string;
  seed: number; queue: string[]; cursor: number;
  decisions: Record<string, Decision>; // ключ: sourceUri
  history: Array<{ uri: string; before?: Decision; after: Decision }>;
};
type ApplyPlan = {
  operationId: string; playlistId: string; baselineFingerprint: string;
  mode: 'remove-uri-groups' | 'create-clean-copy';
  removeUris: string[];
  expectedOrderedEntries: Entry[];
};
type ApplyState =
  | 'idle' | 'preflight' | 'applying' | 'reconciling'
  | 'complete' | 'conflict' | 'partial' | 'unknown';
type MutationJournal = {
  operationId: string; accountId: string; sourcePlaylistId: string;
  targetPlaylistId: string | null;
  expectedCanonical: CanonicalItem[];
  confirmedPrefix: number;
  pendingBatch: { kind: 'delete' | 'create' | 'append'; uris: string[] } | null;
  state: ApplyState; sessionFinalized: boolean;
};
type PlaybackState = {
  requestedUri: string | null; actualUri: string | null;
  generation: number;
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
};
```

`entryKey` нужен только UI/истории текущего baseline. В fingerprint/проверке результата сравнивать упорядоченный `CanonicalItem[]` с сохранением повторов, без entryKey, snapshot, индексов, названий и обложек. Для opaque null API позволяет подтвердить только наблюдаемый тип/позицию/количество; скрытую идентичность гарантировать нельзя. Это явно отражается в результате и QA.

`PlaylistGateway`: getCurrentUser, listOwnedPlaylists, loadStableBaseline, removeUriGroups, createPrivatePlaylist, appendItems, readOrderedItems. Все мутации проходят через ApplyCoordinator; компонент не вызывает fetch.

`PlaybackGateway`: connect, play(uri, generation), pause, seek, subscribe, disconnect. Координатор хранит последнее желаемое URI; команды сериализуются, устаревшие ответы не меняют карточку. При расхождении actual/requested интерфейс показывает загрузку и не разрешает решение «на слух», пока не придёт подтверждение либо пользователь явно выберет продолжение без звука.

### Состояние и хранение

- Baseline и runtime-состояние — память; компактные решения, seed, очередь, baseline и журнал применения — IndexedDB через небольшой wrapper (`idb`). Метаданные сохранять только необходимые; предоставить «Очистить локальные данные», TTL черновиков 30 дней.
- Access token — память; refresh token, PKCE verifier и state — sessionStorage, очистка при logout/ошибке state. Это данные, доступные JS страницы; не обещать изоляцию от XSS. Никаких секретов в URL после callback, логах, IndexedDB, git и демо.
- Закрытие вкладки может потребовать повторного входа, но решения сохранятся. Сессию привязывать к accountId и playlistId; чужой аккаунт не получает черновик.
- OAuth state одноразовый, проверка перед обменом кода, очистка callback через replaceState, refresh single-flight. Scopes: playlist-read-private, playlist-modify-private, playlist-modify-public, streaming, user-read-playback-state, user-modify-playback-state, user-read-private, user-read-email. Три требуемых SDK-разрешения streaming/user-read-private/user-read-email проверить фактическим подключением плеера; сам email не запрашивать для хранения. [SDK authorization](https://developer.spotify.com/documentation/web-playback-sdk/howtos/web-app-player). Каждый scope сверить с выбранными endpoint на S0.
- При logout/смене аккаунта остановить плеер, снять подписки и отменить запросы чтения. Начатая мутация сохраняет привязку к исходному аккаунту и переходит к reconciliation; завершать её токеном другого аккаунта нельзя. Новые записи блокируются до явного разрешения неизвестного результата.
- SDK не кэшировать в service worker, аудио Spotify не скачивать. Демо использует собственные короткие звуки и вымышленные названия/обложки; никаких Spotify-токенов в CI.

## 4. Алгоритмы и гарантии

### Чтение и очередь

Прочитать snapshot → последовательно загрузить все страницы → перечитать snapshot. При смене версии повторить ограниченное число раз; затем показать «Плейлист меняется, попробуйте позже». Верхняя граница v1: 10 000 записей; при превышении — явное сообщение, не частичная тихая загрузка. Сохранять каждое исходное вхождение, включая null/эпизоды/локальные записи. relinking не должен подменять URI удаления URI воспроизведения. Правило sourceUri подтверждается S0 на фактических DTO; отсутствие linked_from не означает отсутствия relinking. При identityConfidence!=confirmed запретить destructive remove и автоматическую дедупликацию; не гарантируемый состав копии блокирует copy-mode. Нет подходящего live-примера relinking — ограничение остаётся явно непроверенным и соответствующая поддержка не объявляется.

Группировка точных дублей — только по sourceUri; ремастеры и другие ID автоматически не склеивать. Перемешать уникальные доступные музыкальные группы алгоритмом Fisher–Yates с seed. Сессия берёт 25 ещё не просмотренных групп; исходный порядок не меняется.

### Удаление URI-групп из исходника

1. Экран предпросмотра показывает треки, количество удаляемых вхождений, сохраняемые неподдерживаемые элементы; undecided/skip сохраняются.
2. Создать устойчивый журнал operationId с baseline и ожидаемой последовательностью. До начала получить exclusive Web Lock для accountId/playlistId; если API блокировки недоступен — отключить мутации в этом браузере с объяснением.
3. Перечитать исходник целиком. Если fingerprint/версия не соответствуют baseline — остановиться, предложить пересборку черновика с повторным просмотром. Молчаливого rebase нет.
4. DELETE последовательными пакетами до 100 уникальных URI, snapshot обновлять после подтверждённого ответа. Нельзя использовать Promise.all для изменений одного плейлиста.
5. После каждого пакета записать результат, перед следующим проверить ожидаемую версию. При 401 обновить авторизацию, затем сначала сверить состояние. При 429 учитывать Retry-After; перед повтором сверить состояние. При timeout/сетевой ошибке/5xx у мутации не делать слепой retry: сначала повторное чтение.
6. Если удалено ожидаемое подмножество и остальное точно совпадает — показать partial и оставшиеся действия; продолжение только после явного действия пользователя и нового preflight. Непонятный результат — unknown, конфликт — conflict. Не обещать exactly-once от Spotify.
7. В конце сравнить всю каноническую упорядоченную последовательность, количество повторов и наблюдаемую сохранность неподдерживаемых элементов. Только совпадение даёт complete; предел opaque-проверки показывается отдельно.

### После применения и при перезагрузке

«Применить и продолжить» завершает текущую порцию, а не весь проход. После verified complete одной транзакцией IndexedDB: сохранить новый baseline, архивировать применённые remove, завершить их undo-историю, оставить reviewedUris/seed/остаток очереди и выставить sessionFinalized в журнале. Нельзя возвращать применённые решения в активную историю. После copy-mode завершить текущую операцию; повторное нажатие показывает созданную копию, а не создаёт следующую.

При старте приложения сначала обнаружить незавершённый журнал и сверить Spotify под исходным аккаунтом, затем разрешать новую запись. Если приложение закрылось после проверки сервера, но до локальной транзакции, повторная сверка и идемпотентная локальная финализация завершают sessionFinalized без нового DELETE. При ошибке записи журнала до HTTP не начинать мутацию; при ошибке после HTTP показать unknown и сохранить доступную диагностику для восстановления.

Предварительная проверка snapshot не исключает изменение извне между чтением и DELETE. Совместные плейлисты исключены, локальные вкладки сериализованы; внешнюю гонку можно обнаружить, но нельзя обещать транзакционную изоляцию. Приложение предупреждает об обнаруженном конфликте и не переписывает весь исходник для исправления.

Undo после применения не обещается. Undo в v1 действует до записи. Перед изменением сохраняется локальный JSON-манифест исходного порядка; это справочная копия метаданных, а не гарантия полного восстановления локальных/недоступных записей.

### Очищенная копия с дедупликацией

Пройти исходный порядок, исключить remove, оставить первое вхождение каждого оставленного sourceUri. Отдельно показать переход «было N → останется M». Если любое сохраняемое вхождение не canCopy — заблокировать режим и показать список причин; исходный режим удаления остаётся доступен.

Перед созданием перечитать baseline и сверить с preview; внешняя правка требует нового preview. Создать новый приватный плейлист через `POST /me/playlists`, записать его ID до добавления треков. Журнал содержит targetPlaylistId, полный expectedCanonical, confirmedPrefix и pendingBatch. Добавлять URI последовательно пакетами до лимита endpoint, подтверждённого на S0. После reload/сбоя при известном ID загрузить весь целевой список; продолжить по явному действию пользователя только от подтверждённого ожидаемого префикса. Постороннее содержимое — conflict. Не повторять create/append после неоднозначного ответа. Unknown на create без ID требует поиска результата пользователем; автоматическая повторная попытка не создаёт копии одну за другой. Полностью сверить итоговый порядок и multiplicity, затем показать ссылку. Исходник не мутирует.

## 5. Модели и effort

Распределение ниже — инженерная рекомендация, не обещание производительности. Названия и роли сверены с [OpenAI Docs](https://learn.chatgpt.com/docs/models) и доступным каталогом инструментов этой сессии. Доступность в пользовательском переключателе зависит от тарифа и клиента.

- **GPT-6 Astra (`gpt-6-astra`) / xhigh (Extra High):** независимая критика архитектуры, ревью опасных мутаций, итоговое ревью. Высокий effort оправдан комбинацией API, гонок и возможной потери данных.
- **GPT-6.1 Sol (`gpt-6.1-sol`) / high:** основной исполнитель: API, OAuth, воспроизведение, reducer и применение. На типовом UI — medium.
- **GPT-6 Luna (`gpt-6-luna`) / high:** фикстуры, README и настройка CI по готовым контрактам. Не поручать самостоятельно менять OAuth/мутации.
- Max/Ultra не нужны по умолчанию. Два безуспешных исправления критической ошибки → передать минимальный repro в Astra xhigh, не перегенерировать всё приложение.
- Если Astra недоступна: Sol xhigh в независимой сессии. Если Luna недоступна: Sol medium. Не подменять выбранную модель молча.

## 6. Этапы и критерии готовности

Все команды ниже — обязательства будущей реализации. Сейчас package.json и тестов нет, команды не выполнялись. S0 должен создать описанные npm scripts, последующие шаги добавляют содержательные проверки. Пустые scripts и отсутствие тестов не дают зелёный статус: незавершённые проверки должны явно завершаться ошибкой/пометкой not-run. Live-сценарии выполняются интерактивно, секреты в отчёт не попадают.

| Шаг | Работа и владелец | Модель / effort | Часы | Зависимость |
|---|---|---|---:|---|
| S0 | Проверка доступа + минимальный каркас | Sol / high | 2 | согласованный план |
| S1 | Контракты, доменная модель, mock-проход | Sol / high | 3 | S0 |
| S2 | Реальный сквозной сценарий на тестовом плейлисте | Sol / high | 4 | S1 |
| S3 | Очередь, undo, сохранение сессий | Sol / high | 3 | S2 |
| S4 | Надёжное применение и сверка | Sol / high; Astra / xhigh review | 5 | S3 |
| S5 | Готовый интерфейс и жесты | Sol / medium | 3 | S3; интеграция после S4 |
| S6 | Точные дубли → очищенная копия | Sol / high | 3 | S4 |
| S7 | Ошибки и сквозные проверки | Sol / high | 3 | S5 + S6 |
| S8 | GitHub-упаковка, CI, демо | Luna / high; Sol / medium интеграция | 2 | S7 |
| S9 | Независимое ревью и исправления | Astra / xhigh; Sol / high fixes | 2 | S8 |
| | **База / с запасом 30%** | | **30 / 39** | |

### S0 — доступ и техническая проба

Зоны: package.json, lockfile, tsconfig/vite/vitest/playwright config, .gitignore, .env.example, src/main.tsx, src/app/**, scripts/capability-check/**, docs/API_CAPABILITIES.md. В начале перенести документы в docs и создать минимальный AGENTS.md с границами проекта.

Действия: Vite/TS-каркас и scripts; интерактивная PKCE-проба через минимальные OAuth/HTTP-адаптеры, которые затем развиваются в S2; Developer Dashboard настраивает пользователь (Client ID и allowlist; пароль приложению не нужен). На отдельном тестовом плейлисте проверить чтение страниц, SDK с полным grant, DELETE дублей на последовательности A,B,A,C, создание приватной копии и append. Зафиксировать реальную схему ответов, source/playback URI, наличие relinking-полей и все ограничения. Relinking — отдельный capability gate; обычная A,B,A,C-проба его не закрывает. Не использовать основной плейлист для пробы.

Готово: `npm run typecheck`, `npm run build`, `npm run test:capabilities` (контрактные проверки), плюс `npm run dev -- --host 127.0.0.1` и ручной live-протокол в API_CAPABILITIES.md со статусами pass/fail/not-run. Если нет Client ID — закончить mock-контракты, пометить live-гейт незакрытым; S2 и реальные мутации блокированы. При отказе API не обходить ограничения; пересогласовать затронутый сценарий.

### S1 — контракты и проход от начала до конца на mock

Зоны: src/contracts/**, src/domain/**, src/demo/**, public/demo/**, tests/domain/**, tests/e2e/demo.spec.ts, временная минимальная проводка экранов интегратором.

Действия: утвердить типы, определить минимальный интерфейс ApplyCoordinator для S2; fixtures обычного/пустого/большого/смешанного плейлиста; fake PlaylistGateway и PlaybackGateway; минимальный путь выбор → карточка со звуком → 3 решения → preview → fake apply → result. При рефакторинге DTO и Entry не смешивать. Сложную mutation logic не реализовывать до S4.

Готово: `npm run test:domain`, `npm run test:e2e -- demo.spec.ts`, `npm run typecheck`. Демо не обращается к accounts.spotify.com/api.spotify.com и не требует Client ID. Звук — разрешённый локальный файл, в CI проверяется плеер, а слышимость проверяется вручную.

### S2 — первый реальный сквозной сценарий

Зоны: src/lib/spotify/**, src/lib/playback/**, tests/api/**, tests/playback/**, интеграция src/app/** и src/screens/**.

Действия: PKCE/refresh/state, все страницы с consistency-check, SDK/выбор устройства/пауза/seek, минимальный реальный preview/apply для одного URI через общий ApplyCoordinator. На этом шаге мутации ограничить 1 URI и тестовым playlist ID; не создавать отдельный временный опасный fetch в UI. Финальный координатор укрепляется на S4.

Готово: `npm run test:api`, `npm run test:playback`, `npm run typecheck`, `npm run build`; вручную пройти login → test playlist → услышать A → убрать B → повторно прочитать ожидаемый список. В отчёте указать устройство, браузер, дату и actual URI без токенов.

### S3 — полноценная сессия разбора

Зоны: src/domain/session/**, src/features/session/**, src/lib/persistence/**, tests/domain/session/**.

Действия: стабильный shuffle, 25 карточек на сессию, очередь на весь проход, skip, undo, история, восстановление после reload, account binding, очистка/TTL данных и обработка отказа IndexedDB. Прогресс считает группы и исходные вхождения раздельно.

Готово: `npm run test:session`, `npm run typecheck`; тесты seed/reload/undo/skip, другой аккаунт, обновившийся baseline, storage failure. 10 000 записей не обрезаются и не создают повторные карточки. UI на ошибке сохранения не обещает продолжение после закрытия. Жизненный цикл «25 → apply → reload → карточка 26 → второй apply» проверить как контракт с fake gateway; с реальным координатором повторить на S4.

### S4 — применение без ложного успеха

Зоны: src/domain/apply/**, src/features/apply/**, tests/apply/**, tests/e2e/apply.spec.ts; изменения persistence только согласованным расширением контракта.

Действия: предпросмотр ожидаемых изменений, журнал, lock, preflight, batch DELETE, reconciliation, проверка ordered URI и неподдерживаемых записей, состояния partial/conflict/unknown. Затем независимое Astra-review этого diff и исправления Sol.

Готово: `npm run test:apply`, `npm run test:e2e -- apply.spec.ts`, `npm run typecheck`; тесты >100 удаляемых URI, дублей, гонки snapshot, двойного нажатия, 2 вкладок, timeout после успешной записи, 401/429/5xx, сбоя journal до/после DELETE, reload в partial, смены аккаунта. Обязательны удаление первого элемента без ложного конфликта из-за сдвига индексов, ambiguous relinking и opaque entries, «25 → apply → reload → карточка 26 → второй apply», crash между server verify и локальной финализацией. Live: только тестовый плейлист, повторное чтение результата. Ни один error-case не показывает complete без сверки.

### S5 — интерфейс, жесты, доступность

Зоны: src/components/**, src/styles/**, tests/e2e/review-ui.spec.ts; интегратор меняет src/screens/** и composition root.

Действия: использовать design-taste-frontend для направления и ui-ux-pro-max для UX при фактической работе над UI. Большая обложка, название/исполнитель, player, keep/remove/skip, undo, прогресс, явные статусы синхронизации звука. Spotify-атрибуция и ссылки на трек/плейлист; обложку не обрезать и не перекрывать метками свайпа, метки размещать рядом. Pointer Events, осмысленный порог свайпа, вертикальная прокрутка, reduced-motion, фокус, клавиатура и контраст. Клавиши не срабатывают в input и не конфликтуют с управлением плеером.

Готово: `npm run test:e2e -- review-ui.spec.ts`, `npm run build`; browser review 390×844 и 1440×900, кнопки работают без свайпов, нет горизонтальной прокрутки, серия из 10 быстрых свайпов не рассинхронизирует карточку/звук/решение. Реальный mobile playback отметить отдельно pass/fail/not-run.

### S6 — дедупликация в очищенную копию

Зоны: src/domain/duplicates/**, src/features/duplicates/**, tests/domain/duplicates/**, tests/apply/copy.spec.ts. Тексты/экран подключает интегратор.

Действия: точные URI-группы, keep-first в исходном порядке, preview, private copy, последовательный append/checkpoint/verify. Удаление URI-групп и дедупликация не выглядят одной и той же кнопкой. При canCopy=false режим недоступен с перечнем причин; похожие ID только для будущего ручного сравнения.

Готово: `npm run test:duplicates`, `npm run test:copy`, `npm run typecheck`. A,B,A,C,B → A,B,C; remove B → A,C; undeсided сохраняются; тесты null/local/episode, больших пакетов, timeout create/append и восстановления; live-копия сверяется полностью, исходник не изменён.

### S7 — интеграция и проверка неприятных сценариев

Зоны: tests/e2e/**, tests/fixtures/**, docs/QA.md; точечные исправления делает владелец соответствующего слоя.

Действия: отозванный доступ, offline, пустой плейлист, недоступный трек, устройство исчезло, истёкший токен, переходы вкладок/аккаунтов, внешний edit, медленные и переставленные ответы playback. Никаких live credentials в автотестах.

Готово: `npm run check` = typecheck + lint + unit/integration + build; `npm run test:e2e`; ручной live-сценарий из SPEC и запись фактического браузерного покрытия в QA.md. Все исходные unknown/fail либо устранены, либо явно ограничивают поддержку; mock не считается доказательством реального Spotify playback.

### S8 — репозиторий, демо и самостоятельный запуск

Зоны: README.md, LICENSE, docs/SETUP.md, docs/PRIVACY.md, docs/media/**, .github/workflows/ci.yml, .env.example. package scripts меняет интегратор.

Действия: точный запуск через npm ci + .env.local + npm run dev; инструкция Developer App и точного redirect; различие demo/live, лимит пользователей, scopes, очистка локальных данных, известные ограничения. Выбрать обычную permissive-лицензию для собственного кода; сторонние assets — с атрибуцией. Скриншоты без личных данных, короткое демо, CI без секретов. Репозиторий и live-hosting не публикуются в этом этапе автоматически.

Готово: из чистой временной копии `npm ci`, `npm run check`, `npm run test:e2e`; пройти README буквально. Проверить, что .env.local игнорируется, tracked diff и docs/media не содержат токены и личные данные; показать список будущих публичных файлов. Запуск опубликованного URL проверяется только при отдельном деплое.

### S9 — независимое ревью и готовность к публикации

Зоны: docs/REVIEW.md; исправления в исходных слоях только интегратором.

Действия: Astra получает SPEC, код и фактические результаты, ищет баги удаления, потерю копируемых элементов, рассинхрон звука, утечки и ложный complete. Каждая находка проверяется; Sol исправляет подтверждённые. Перезапускать затронутые проверки, затем итоговые check/e2e.

Готово: `npm run check`, `npm run test:e2e`, live-протокол пройден; нет открытых P0/P1, для остальных указаны ограничения. Итоговый отчёт: preview URL, ветка/коммит если создавались, что проверено локально/live, список оставшихся ограничений. Пользователь может после этого отдельно поручить push/publication/deploy.

## 7. Параллельность и бюджет

По умолчанию одна основная сессия Sol и отдельные независимые ревью. Не создавать десять чатов и не терять контекст. План допускает только одну полезную параллель: после S3 UI в src/components и src/styles может идти одновременно с S4 apply logic. Интегратор единолично меняет contracts, package.json, lockfile, src/app и src/screens; изменения контрактов сначала обсуждаются и фиксируются. S6 идёт после S4, потому что делит журнал мутаций.

30 часов — предварительная оценка активной инженерной работы с ручными проверками, не обещание времени генерации Codex. С запасом 30%: 39 часов. Ожидание настройки аккаунта и внешних ограничений сюда не входит. После S0 обязательно пересчитать оценки: 2 часа S0 предполагают быстрый доступ к Developer App и успешные пробы, а 2 часа S9 — небольшой объём исправлений; ограничения API или серьёзные находки увеличат бюджет. Комфортный ориентир: 5–7 рабочих сессий, длительность зависит от живых проверок. При новом дедлайне сумма оставшихся шагов ×1.3 должна укладываться до заморозки.

Если нужен более ранний результат: первая пригодная контрольная точка S0–S4 (17 ч базы / 22.1 ч с запасом) — рабочая чистка с простым интерфейсом. Это ещё не полная v1: polish, отдельная дедупликация и GitHub-упаковка остаются. Резать сначала COULD/SHOULD, затем согласовывать перенос MUST; не вырезать сверку удаления, undo до записи и обработку ошибок.

## 8. История независимой критики

Результаты и принятые изменения фиксируются в [PLAN_REVIEW.md](PLAN_REVIEW.md). Статус согласования пользователем отражается отдельно от прохождения ревью.
