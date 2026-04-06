# ToolBox Backend API

Backend для приложения аренды электроинструментов через умные боксы.

## Стек
- Node.js + Express
- Supabase (PostgreSQL)
- JWT авторизация
- Payme / Click интеграция

## Запуск
```bash
npm install
npm run dev
```

## API Endpoints
- `POST /api/auth/send-code` — отправить SMS-код
- `POST /api/auth/verify` — проверить код
- `GET /api/boxes` — список боксов
- `GET /api/boxes/:id/tools` — инструменты в боксе
- `GET /api/tools/search?q=` — поиск инструмента
- `GET /api/tools/:id` — детали инструмента
- `POST /api/rentals` — создать аренду
- `POST /api/rentals/:id/extend` — продлить
- `POST /api/rentals/:id/return` — вернуть
- `GET /api/rentals/active` — активные аренды
- `GET /api/rentals/history` — история
