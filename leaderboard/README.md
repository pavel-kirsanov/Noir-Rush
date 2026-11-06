# Дошка розшуку (спільна таблиця лідерів)

Сервер таблиці лідерів для Noir Rush: **Cloudflare Worker** (невелика функція на JS, що працює на серверах Cloudflare) і база **D1** (SQLite від Cloudflare). На дошці зберігається найкращий забіг кожного гравця. Безкоштовного тарифу вистачає з великим запасом.

- `worker.js` — API: `POST /run/start`, `POST /score`, `GET /top`.
- `schema.sql` — таблиці `scores` (рекорди) і `runs` (квитки забігів).
- `wrangler.toml` — налаштування воркера.

## Де працює

- Сервер: https://noir-rush-leaderboard.pavel-kirsanov.workers.dev (`GET /top` — поточний топ).
- База D1: `noir-rush-leaderboard` (id у `wrangler.toml`).
- Приймає запити лише з `https://pavel-kirsanov.github.io` і `http://localhost:8000` (`ALLOWED_ORIGIN`).
- У панелі Cloudflare: Workers & Pages → `noir-rush-leaderboard`; Storage & Databases → D1 → `noir-rush-leaderboard`.

Після змін у `worker.js` достатньо виконати `npx wrangler deploy` у цій теці.

## Розгортання з нуля

Потрібні безкоштовний акаунт на cloudflare.com і Node.js 18+.

1. Увійти в Cloudflare:

   ```bash
   cd leaderboard
   npx wrangler login
   ```

2. Створити базу й скопіювати `database_id` з виводу в `wrangler.toml`:

   ```bash
   npx wrangler d1 create noir-rush-leaderboard
   ```

3. Створити таблиці:

   ```bash
   npx wrangler d1 execute noir-rush-leaderboard --remote --file=schema.sql
   ```

4. Опублікувати воркер. Наприкінці команда надрукує адресу вигляду `https://noir-rush-leaderboard.<акаунт>.workers.dev`:

   ```bash
   npx wrangler deploy
   ```

5. Вписати цю адресу в `index.html`, у рядок `const LEADERBOARD_URL=...`, закомітити й запушити.

Щоб приймати запити лише від вашої гри, вкажіть її адресу в `ALLOWED_ORIGIN` у `wrangler.toml` (кілька адрес — через кому) і повторіть `npx wrangler deploy`.

Без термінала все те саме можна зробити на сайті Cloudflare: Storage & Databases → D1 → створити базу й виконати `schema.sql` у консолі; Workers & Pages → створити воркер, вставити `worker.js`, у Settings → Bindings додати D1 з іменем `DB`.

## Захист від підробки

Гра працює в браузері, тож повністю захиститися від підроблених результатів неможливо. Сервер робить підробку клопіткою:

- на початку забігу гра отримує квиток, і тривалість забігу міряється за годинником сервера;
- за кожним квитком результат можна надіслати один раз, відхилений результат теж витрачає квиток;
- рівень має відповідати пройденим метрам, метри — тривалості (не швидше за 120 м/с), очки — метрам, капелюхам і рівню за правилами гри.

Якщо зміните в грі довжину рівнів або нарахування очок, оновіть константи на початку `worker.js`.

Видалити запис із дошки:

```bash
npx wrangler d1 execute noir-rush-leaderboard --remote --command="DELETE FROM scores WHERE name='...'"
```
