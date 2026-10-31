# Spotify API: состояние проверки S0

Дата: 2026-11-01, Asia/Oral. Client ID предоставлен пользователем и записан только в игнорируемую `.env.local`. Значение и данные аккаунта в отчёте не приводятся.

| Возможность | Код/контрактные проверки | Живая проба |
|---|---|---|
| OAuth PKCE S256, state, expiry, replay protection | Реализованы; Vitest и browser regression без AbortSignal.timeout | fail: пользователь сообщил об ошибке связи при возврате; повтор после исправления ожидается |
| Refresh single-flight, logout invalidation | Реализованы; Vitest | not-run |
| `/me` без product/email/country | Реализовано; Vitest | not-run |
| Свои обычные плейлисты, все страницы, snapshot consistency | Реализовано; Vitest | not-run |
| Web Playback SDK и подтверждение actual URI | Реализовано; mock lifecycle tests, живой звук не утверждается | not-run |
| Создание private test playlist и append A,B,A,C | Реализовано; isolated probe tests | not-run |
| DELETE URI A и повторное чтение B,C | Реализовано; isolated probe tests | not-run |
| Relinking без linked_from | Не подтверждено; отсутствующее поле не доказывает исходную идентичность | not-run |
| Connect fallback на открытый Spotify | Дальнейшая работа S2; не заявляется готовым | not-run |

Живой протокол должен фиксировать браузер/устройство, дату, успешность SDK и фактически наблюдаемую семантику ответов, без access/refresh tokens. Наличие Client ID и зелёные моки не закрывают live gate. Неподтверждённый relinking остаётся отдельным ограничением.

Проба S0 допускает запись только в свой заново созданный disposable playlist. Его ID не принимается из произвольного поля или URL; journal связывает его с аккаунтом. После сетевой неопределённости запись не повторяется. Семантика URI-групп ещё не переносится на основные плейлисты до реальной проверки.

Если Spotify возвращает 403, отсутствующие поля или иной состав после append/delete, сохранить статус fail/unknown и адаптировать контракт. Не обходить ограничения и не объявлять неподтверждённую возможность доступной.
