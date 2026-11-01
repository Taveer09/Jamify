# S4 — durable apply review

Ночная реализация на общей gateway-границе и persistent demo. Live adapter не включён: S0 Spotify DELETE остаётся unknown. Реальных Spotify writes в S4 не выполнялось.

Независимый Astra xhigh reviewer нашёл и воспроизвёл:

| Приоритет | Находка | Исправление |
|---|---|---|
| P1 | Потеря confirmed identity/canRemove не меняла canonical fingerprint, старый URI всё равно удалялся | Fresh guard всей группы до begin и каждого batch: sourceUri, kind, identityConfidence, canRemove; 0 DELETE при потере identity |
| P2 | Snapshot-only edit между preflight и batch принимался молча | expectedSnapshotId в journal; версия проверяется перед batch и финализацией, обновляется только подтверждённым read-back |
| P2 | Account switch до dispatch оставлял навечно unknown pending при 0 запросов | dispatched flag; до отправки pending очищается, partial допускает только explicit resume после возврата аккаунта |
| P2 | Read-only recovery возвращал partial без сохранения, UI не предлагал продолжение | partial сохраняется в journal до результата |
| P2 | Immediate explicit resume игнорировал Retry-After | persisted retryAt, wait gate в apply/recover/resume, после429 нет даже read/API до deadline |

Первые четыре исправления перепроверены reviewer на пяти независимых fake-IDB сценариях, шести repository tests и четырёх browser сценариях Chromium/WebKit. Retry-After перепроверен reviewer с новой IndexedDB connection: apply/recover/resume до срока не вызывают gateway; после срока DELETE только по explicit resume. Regression с fake clock также pass.

Интеграционный browser suite нашёл отдельный UI crash: после adoptFinalized baseline уже не содержал удалённый URI, но preview ещё рендерился до следующего await. Данные preview теперь захвачены отдельно, journal читается до adoption, переход в result выполняется одним синхронным блоком. Полный demo/session subset28/28 pass после фикса.

Реализованы Web Lock на операцию, pending journal до DELETE, freeze draft/clearAccount, account/version/canonical preflight, safe reconciliation без blind retries, atomic finalize drafts+operations, восстановление после crash до/после server verify, idempotent completion, защита чужого аккаунта и opaque/local/episode entries. Миграция IndexedDB v1→v2 сохраняет данные.

Ограничения: UI-сессия содержит максимум25 выбранных групп. Adversarial plan>100 групп отклоняется как несоответствующий сохранённым решениям; positive UI-delete>100 не существует в v1. Код batch cap100 присутствует, но массовое удаление за пределами сессии не заявляется проверенной UI-возможностью. Copy ещё S6; текущий remove coordinator честно отклоняет copy. Полный final check/e2e и результаты live/mocks указываются отдельно.

Итоговая интеграция: npm run check110/110 pass, full Chromium/WebKit88/88 pass.
