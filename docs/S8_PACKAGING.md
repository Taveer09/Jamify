# S8 — упаковка и проверяемое состояние

Сводка подготовлена по текущему checkout. Она не означает, что GitHub Actions уже запускался на удалённом GitHub.

## Что подготовлено

- Код проекта лицензирован по MIT в корне репозитория. Демо-аудио проекта уже помечено как CC0-1.0.
- [PRIVACY.md](PRIVACY.md) описывает фактическое хранение OAuth данных, черновиков и журналов, запросы Spotify и локальное демо.
- `.github/workflows/ci.yml` задаёт CI без Spotify credentials и без учётной записи Spotify. Workflow использует только `contents: read`, `npm ci`, `npm run check`, установку Chromium/WebKit с системными зависимостями и `npm run test:e2e`. Playwright diagnostics загружаются только после сбоя.
- Версии официальных Actions сверены по [checkout releases](https://github.com/actions/checkout/releases/latest), [setup-node releases](https://github.com/actions/setup-node/releases/latest) и [upload-artifact releases](https://github.com/actions/upload-artifact/releases/latest) на 2026-11-01: `actions/checkout@v7`, `actions/setup-node@v7`, `actions/upload-artifact@v7`.

## Чистый локальный запуск

Требуется Node.js `22.13.x` или `24+` и npm, поставляемый с Node.js.

```sh
git clone https://github.com/Taveer09/Jamify.git
cd Jamify
npm ci
```

Скопируйте `.env.example` в `.env.local`, затем задайте публичный Spotify Client ID и redirect URI в настройках своего Spotify Developer App и в `.env.local`. Для локального Vite redirect URI должен точно совпадать с `http://127.0.0.1:5173/callback`. Client Secret не нужен и не должен добавляться.

```sh
npm run check
npx playwright install --with-deps chromium webkit
npm run test:e2e
npm run dev
```

Демо доступно без Spotify Client ID; live-вход требует настроенный Client ID. CI проверяет только локальные/fixture сценарии и не доказывает доступность Spotify API или реальное воспроизведение музыки.

## Состояние проверок и ограничения

| Проверка или возможность | Состояние | Что означает |
|---|---|---|
| Локальные typecheck, lint, unit/domain tests и production build | Проверено в checkout по `docs/STATUS.md`; перед финальным объединением packaging diff нужно повторить `npm run check` | Локальный результат не является GitHub CI результатом |
| Chromium/WebKit Playwright | Проверено в checkout по `docs/STATUS.md`; packaging workflow ещё не запускался удалённо | Fixture/browser checks не подтверждают live Spotify |
| OAuth PKCE, refresh и `/me` | Live pass зафиксирован в `docs/API_CAPABILITIES.md` | Наблюдение относится к проведённой ручной пробе |
| Создание disposable playlist, append и read-back | Live pass | Выполнено только на созданном probe playlist |
| Удаление тестовых URI | `unknown`; live gate не закрыт | Повтор DELETE не выполнялся; reconciliation прочитал исходные A,B,A,C |
| Реальное получение звука, paused event, relinking без `linked_from` | `not-run` или не подтверждено | Не выводить pass из тестов/фикстур |
| GitHub CI | Первый run567f432 — fail,85/88 browsers | Исправления и новый run — QA.md |
| Публичный production deployment | `not-run` | Не входит в S8 |

Пока live DELETE остаётся `unknown`, production v1 и удаление реальных пользовательских треков нельзя считать готовыми. Не повторяйте неоднозначные Spotify mutations автоматически; сначала используйте сохранённый журнал и read-only reconciliation.

## Контроль перед публикацией

Перед коммитом просмотрите итоговый diff и убедитесь, что `.env.local`, токены и персональные данные не попали в отслеживаемые файлы или CI artifacts. Запуск локального YAML, если он будет отдельно проверен, всё равно не считается удалённым GitHub CI pass.

После первого remote run обнаружены реальные CI failures, а не только YAML validation; актуальный протокол исправлений и перезапуска находится в QA.md.
