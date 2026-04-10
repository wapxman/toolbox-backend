# ToolBox Backend API

Backend для приложения аренды электроинструментов через умные боксы с замками Kerong.

## Стек
- **Backend:** Node.js + Express (деплой на Vercel)
- **БД:** Supabase (PostgreSQL + PostGIS)
- **Авторизация:** JWT + SMS-верификация
- **IoT/Замки:** Kerong LCS API (Docker) → KR-BU → KR-CU → электрозамки
- **Оплата:** Payme / Click
- **Приложение:** Flutter (отдельный репозиторий toolbox-app)

## Архитектура
```
Flutter App → ToolBox Backend (Vercel) → Kerong LCS (Docker, локально) → KR-BU → KR-CU → Замки
                  ↕                              ↕
              Supabase (БД)              Cloudflare Tunnel
              Payme/Click
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
│   ├── supabase.js       — клиент Supabase
│   ├── sms.js            — SMS-модуль (console/eskiz)
│   └── kerong.js         — [TODO] клиент Kerong LCS API
├── middleware/
│   └── auth.js           — JWT-верификация
└── routes/
    ├── auth.js           — авторизация (send-code, verify)
    ├── boxes.js          — боксы (список, детали)
    ├── tools.js          — инструменты (поиск, детали)
    ├── rentals.js        — аренды (создать, продлить, вернуть)
    └── notifications.js  — уведомления
```

## API Endpoints

### Авторизация
- `POST /api/auth/send-code` — отправить SMS-код
- `POST /api/auth/verify` — проверить код, получить JWT

### Боксы и инструменты
- `GET /api/boxes` — список боксов
- `GET /api/boxes/:id` — детали бокса
- `GET /api/boxes/:id/tools` — инструменты в боксе
- `GET /api/tools/search?q=` — поиск инструмента
- `GET /api/tools/:id` — детали инструмента

### Аренда
- `POST /api/rentals` — создать аренду (+ открыть замок через Kerong)
- `POST /api/rentals/:id/extend` — продлить аренду
- `POST /api/rentals/:id/return` — вернуть инструмент (+ открыть замок)
- `GET /api/rentals/active` — активные аренды
- `GET /api/rentals/history` — история аренд

### Kerong IoT (TODO)
- `POST /api/locks/open` — открыть замок (проксирует на Kerong LCS)
- `GET /api/locks/status` — статус замков

## Переменные окружения
```
SUPABASE_URL=https://zwzmcihwtwgjajjjsbms.supabase.co
SUPABASE_KEY=***
JWT_SECRET=***
SMS_PROVIDER=console
KERONG_LCS_URL=http://localhost:9777  # адрес Kerong LCS сервера
KERONG_LCS_USER=admin                # логин LCS
KERONG_LCS_PASSWORD=***              # пароль LCS
PORT=3000
```

## Статус
См. [PLAN.md](./PLAN.md) для текущего плана и прогресса.
