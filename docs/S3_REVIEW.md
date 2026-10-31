# S3 — сессии и локальное хранение

2026-11-01, Asia/Oral. Независимое read-only review выполнено GPT-6.1 Sol high. Область: domain/session, persistence schema/database, SessionController, persistent demo gateway, DemoApp integration и regression tests.

Подтверждённые P2 и исправления:

- При недоступном IndexedDB переключение плейлистов уничтожало volatile решения раньше reload. Добавлен in-memory cache с ключом account/playlist; возврат восстанавливает точную очередь/решения, UI продолжает честно показывать отсутствие durable save.
- Откат часов на 1 ms физически удалял действительный draft. Future updatedAt считается нулевым возрастом; 30-дневный TTL не удаляет данные из-за rollback системных часов.
- Schema принимала пустую/обрезанную очередь при наличии непросмотренных треков. Теперь union(queue, reviewedUris) покрывает все reviewable URI; unknown/duplicated queue, несогласованная история и чужая привязка отклоняются.
- После сохранения другой вкладкой cached persistent=true позволяло применить старый draft. Перед coordinator повторно проверяются revision/runId; оба варианта stale tab закреплены browser tests. После конфликта новые durable apply блокируются.

Проверено: 17 session unit/integration tests, IndexedDB с fake-indexeddb, optimistic concurrency двух соединений, TTL/clock rollback, account binding, corruption gate, 25 → apply → reload → card 26 → second apply, blocked storage, очистка demo данных. Повторный reviewer проверил fixes, 4/4 targeted stale-tab/volatile browser checks; последний exact stale-saved scenario 2/2 Chromium/WebKit pass.

Ограничение до S4: между preflight revision check и серверной мутацией ещё нет общего Web Lock и durable operation journal. Это не гарантия production apply. S2 live integration не включена из-за S0 DELETE unknown. Ночная реализация S3 использует демо-адаптер и не меняет Spotify. Итоговый check90/90 и полный Chromium/WebKit suite60/60 pass.
