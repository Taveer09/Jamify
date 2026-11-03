# Подключение Spotify к Jamify

Эта настройка выполняется владельцем Jamify один раз. Обычные пользователи нажимают «Войти через Spotify» и не создают Developer App. В закрытой бете владелец добавляет их аккаунты в allowlist; общий предел Development Mode — до 5 аккаунтов. Публичное демо и живой доступ к аккаунтам — разные возможности.

1. Войди в [Developer Dashboard](https://developer.spotify.com/dashboard) тем же аккаунтом, где есть Premium.
2. Создай приложение Jamify. Описание: `Personal playlist cleanup with swipe-based review`.
3. Website для локальной пробы: `http://127.0.0.1:5173`.
4. Redirect URI: `http://127.0.0.1:5173/callback`. Сохрани адрес и настройки Web API/Web Playback SDK.
5. Возьми **Client ID** из настроек. Client Secret не используется. Внеси Client ID в форму Jamify или в `.env.local`.
6. Если тестируешь другим аккаунтом, добавь его в Users and Access приложения. Для плеера этому аккаунту тоже нужен Premium.
7. Запусти `npm run dev`, открой локальный адрес и нажми «Войти через Spotify». Вход и выдача разрешений происходят на Spotify.
8. После возврата на `/` появятся «Любимые треки» и список плейлистов. Выбери список для музыкального разбора; все страницы загружаются до начала очереди.
9. Свайпы в настоящей медиатеке сохраняют локальные решения и позволяют скачать JSON; они пока не удаляют музыку из Spotify. Для новых scopes `user-library-read` и `playlist-read-collaborative` старому входу может понадобиться «Переподключить Spotify».
10. Технические проверки доступны отдельно на `/diagnostics`. Только там S0 может создать disposable тест A,B,A,C. При существующем unknown не повторяй запись и не сбрасывай журнал. Основные плейлисты сохраняются.

Если запись вернула неоднозначный ответ, не повторяй создание вручную из новой вкладки, пока не проверишь созданные плейлисты в Spotify. В S0 нет автоматического восстановления такого теста; журнал блокирует повтор в текущей вкладке. Тестовый плейлист можно удалить самостоятельно после проверки.

HTTP 403: проверь allowlist, Premium, доступность endpoint и разрешения; отсутствие поля product в `/me` не означает Free. HTTP 429: дождись окончания лимита. Ошибка Redirect URI: проверь точное совпадение, порт 5173 и `127.0.0.1` вместо `localhost`.

Локальные сценарии подключения проверяются в Chromium и WebKit. Нативный fetch отдельно проверен в Safari; браузерный звук, мобильный Spotify playback и relinking требуют отдельных живых проб. Никакие разрешения браузера/аккаунта не обходятся.

## Production на Vercel

Для production нужен публичный Client ID в VITE_SPOTIFY_CLIENT_ID; Client Secret не нужен. Redirect URI по умолчанию берётся из текущего origin + /callback. Не переносите локальный VITE_SPOTIFY_REDIRECT_URI=http://127.0.0.1:5173/callback вproduction: зарегистрируйте точный HTTPS адрес опубликованного сайта в Spotify Dashboard. Vercel rewrites сохраняют /demo, /callback и /diagnostics при прямом открытии. Локальные .env и OAuthданные вupload не входят.

Production URL: **https://jamify-lyart.vercel.app**. В приложении Jamify в [Spotify Dashboard](https://developer.spotify.com/dashboard) → Settings → Redirect URIs добавьте `https://jamify-lyart.vercel.app/callback` и сохраните. Для локальной разработки оставьте также `http://127.0.0.1:5173/callback`. Поле Website можно поставить на опубликованный адрес. Приложение формирует production redirect именно на HTTPS домен; Client ID настроен владельцем на Vercel. Allowlist и разрешения Spotify сохраняют силу.

Short public entry: https://usejamify.vercel.app is attached to project jamify and follows production. A host-only307 redirect sends it to https://jamify-lyart.vercel.app, retaining path/query. Keep the existing Spotify callback registration; do not use the short host as OAuth redirect. jamify.vercel.app alias assignment was rejected as already in use. No DNS/domain purchase needed.

Home-screen shortcuts: /apple-touch-icon.png is180px; manifest supplies192/512px regular and512px maskable PNG icons, all rendered from the existing vector Jamify mark. Manifest display=browser preserves the current browser-based Spotify PKCE flow; no offline/service-worker/standalone behavior is introduced. Existing saved shortcuts may retain their cached icon until removed and added again.
