# Taketool Backend API

Backend для приложения аренды электроинструментов **Taketool** (ex-ToolBox)
через умные боксы с замками Kerong.

**Полный актуальный справочник проекта — [GUIDE.md](./GUIDE.md).**

## Стек
- **Backend:** Node.js + Express (деплой на Vercel: `toolbox-backend-eight.vercel.app`)
- **БД:** Supabase (PostgreSQL), RLS включён, бэкенд ходит secret-ключом
- **Авторизация:** JWT (30 дней) + SMS-верификация (Eskiz.uz, боевой режим)
- **IoT/Замки:** Kerong LCS (docker kerong-api на мини-ПК точки) → KR-BU → KR-CU16 → замки KR-S99N
- **Оплата:** Payme ✅ (боевой) и Click ✅ (код готов)
- **Приложение:** Flutter (репозиторий toolbox-app), админка — toolbox-admin

## Архитектура
```
Flutter App → Taketool Backend (Vercel) → cloudflared-туннель → lcs-guard (мини-ПК)
                  ↕                                                  ↓
              Supabase (БД)                              Kerong LCS → KR-BU → замки
              Payme / Click (колбэки с их серверов)
```

## Запуск
```bash
git clone https://github.com/wapxman/toolbox-backend.git
cd toolbox-backend
npm install
cp .env.example .env  # заполнить переменные
npm run dev
```

## Структура проекта
```
src/
├── index.js              — Express app, точка входа
├── lib/
│   ├── supabase.js       — клиент Supabase (secret-ключ, в обход RLS)
│   ├── sms.js            — SMS-модуль (console/eskiz), текст = одобренный шаблон Eskiz
│   ├── kerong.js         — клиент docker-API Kerong LCS (ретраи, X-ToolBox-Secret)
│   └── click_mapi.js     — Click Merchant API (Create Invoice)
├── middleware/
│   └── auth.js           — JWT-верификация
└── routes/
    ├── auth.js           — авторизация (send-code, verify, me)
    ├── boxes.js          — боксы (список с расстоянием, детали, инструменты)
    ├── tools.js          — инструменты (поиск, детали)
    ├── rentals.js        — аренды (создать+оплата, продлить, вернуть, поллинг оплаты)
    ├── notifications.js  — уведомления
    ├── locks.js          — сервисные роуты замков (только с X-Admin-Secret)
    ├── payme.js          — Payme Merchant API (JSON-RPC, колбэки Payme)
    └── click.js          — Click SHOP API (Prepare/Complete, страница /return)
```

## API Endpoints

### Авторизация
- `POST /api/auth/send-code` — отправить SMS-код
- `POST /api/auth/verify` — проверить код, получить JWT
- `GET/PATCH /api/auth/me` — профиль

### Боксы и инструменты
- `GET /api/boxes?lat&lng` — список боксов (сортировка по расстоянию)
- `GET /api/boxes/:id`, `GET /api/boxes/:id/tools` — детали, инструменты
- `GET /api/tools/search?q=`, `GET /api/tools/:id` — поиск, детали

### Аренда (JWT)
- `POST /api/rentals` — создать аренду в `pending_payment` (+`provider`: payme/click → ссылка/инвойс)
- `GET /api/rentals/:id/payment-status` — поллинг оплаты (ссылка своего провайдера)
- `POST /api/rentals/:id/extend` — продлить (только active/overdue)
- `POST /api/rentals/:id/return` — вернуть, открыть замок (только active/overdue)
- `GET /api/rentals/active` / `/history` / `/:id`

### Платёжные колбэки (вызывают Payme/Click со своих серверов)
- `POST /api/payments/payme` (алиас `/api/payme`) — Merchant API JSON-RPC
- `POST /api/payments/click/prepare` / `/complete` — SHOP API (md5-подпись)
- `GET /api/payments/click/return` — страница возврата после оплаты

### Сервисные (заголовок `X-Admin-Secret: $ADMIN_API_SECRET`, иначе 404)
- `POST /api/locks/open` — открыть замок `{zoneId, lockNumber}` (0-based)
- `GET /api/locks/status` — статус подключения к LCS
- `GET /api/locks/free/:zoneId` — свободные ячейки по датчикам

## Переменные окружения
Полная таблица с назначением — в [GUIDE.md](./GUIDE.md#4-переменные-окружения-vercel--toolbox-backend).
Кратко: `SUPABASE_URL/KEY`, `JWT_SECRET`, `SMS_PROVIDER`+`ESKIZ_*`, `PAYME_*`,
`CLICK_*` (5 шт.), `KERONG_LCS_URL/SECRET` + `KERONG_BOARD_*`, `ADMIN_API_SECRET`.

⚠️ Значения в Vercel заливать через bash: `printf '%s' 'VALUE' | npx vercel env add NAME production`
(PowerShell-pipe дописывает `\r`).
