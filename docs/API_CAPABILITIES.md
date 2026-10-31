# Spotify API: состояние проверки S0

Дата: 2026-11-01, Asia/Oral. Client ID предоставлен пользователем и записан только в игнорируемую `.env.local`. Значение и данные аккаунта в отчёте не приводятся.

| Возможность | Код/контрактные проверки | Живая проба |
|---|---|---|
| OAuth PKCE S256, state, expiry, replay protection | Реализованы; Vitest, browser regression без AbortSignal.timeout, native-fetch callback/refresh в Chromium и WebKit | pass в Safari после исправления: успешное восстановление аккаунта и /me; ранние попытки до фикса были fail |
| Refresh single-flight, logout invalidation | Реализованы; Vitest | refresh pass в Safari после reload; single-flight/logout races — fixture tests |
| `/me` без product/email/country | Реализовано; Vitest | pass в Safari |
| Свои обычные плейлисты, все страницы, snapshot consistency | Реализовано; Vitest | list pass (до disposable теста 0 своих обычных плейлистов); stable read A,B,A,C pass; многостраничность только fixtures |
| Web Playback SDK и подтверждение actual URI | Реализовано; lifecycle tests | Safari: ready и actual URI matched — pass; физическая слышимость и paused event — not-run |
| Создание private test playlist и append A,B,A,C | Реализовано; isolated probe tests | pass, создан один новый приватный disposable playlist, содержимое прочитано |
| DELETE URI A и повторное чтение B,C | Реализовано; isolated probe tests | unknown/fail gate: операция не подтверждена, read-only reconciliation показывает A,B,A,C, повтор не выполняется |
| Relinking без linked_from | Не подтверждено; отсутствующее поле не доказывает исходную идентичность | not-run |
| Connect fallback на открытый Spotify | Дальнейшая работа S2; не заявляется готовым | not-run |

Живой протокол должен фиксировать браузер/устройство, дату, успешность SDK и фактически наблюдаемую семантику ответов, без access/refresh tokens. Наличие Client ID и зелёные моки не закрывают live gate. Неподтверждённый relinking остаётся отдельным ограничением.

Проба S0 допускает запись только в свой заново созданный disposable playlist. Его ID не принимается из произвольного поля или URL; journal связывает его с аккаунтом. После сетевой неопределённости запись не повторяется. Семантика URI-групп ещё не переносится на основные плейлисты до реальной проверки.

Если Spotify возвращает 403, отсутствующие поля или иной состав после append/delete, сохранить статус fail/unknown и адаптировать контракт. Не обходить ограничения и не объявлять неподтверждённую возможность доступной.


## Живая проба 2026-11-01 около 01:55–02:00 Asia/Oral

Проведена в установленном Safari через временный локальный тестовый модуль по прямому поручению пользователя самостоятельно проверить реализованные функции. Токены не выводились и не сохранялись в отчёт/файлы. Все playlist writes направлялись в единственный заново созданный disposable target; исходные плейлисты не менялись. Тестовые URI взяты из публичных примеров Spotify, а не из личных записей пользователя.

Удаление остановило probe со статусом unknown. Первичная ошибка HTTP была скрыта старым generic catch; catch исправлен для следующих операций, но исходный статус задним числом не выдумывается. Повторное чтение с cache:no-store также возвращает A,B,A,C. Наблюдаемые GET headers max-age=0, CORS preflight допускает DELETE; это не объясняет первичный отказ. Не отправлять повтор DELETE, не сбрасывать journal и не создавать второй тест ради зелёного результата.

SDK подключился и сообщил actual URI, совпадающий с запрошенным тестовым треком. После паузы/отключения paused callback не был зафиксирован, поэтому пауза не объявлена live pass. Временные файлы диагностики удалены; безопасные sessionStorage evidence доступны только в локальной вкладке и не публикуются.
