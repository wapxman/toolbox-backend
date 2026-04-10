# ToolBox — Бриф для нового чата с Claude

Обновлено: 10 апреля 2026

---

## Что это за проект

ToolBox — приложение для посуточной аренды электроинструментов из умных боксов (шкафов с электронными замками) в Ташкенте.

Пользователь: открывает приложение → находит ближайший бокс → выбирает инструмент → оплачивает → замок открывается → забирает инструмент → возвращает когда готов.

Бизнес-модель: посуточная аренда, скидки 20% от 3 дней, 35% от 7+ дней. Оплата через Payme/Click. Пилот: 2 точки в Ташкенте (ТЦ + строительный рынок).

---

## Кто делает

Бахтиёр (wapxman) — основатель, не программист. Claude — пишет весь код и пушит в GitHub. Бахтиёр делает git pull и тестирует.

---

## Три репозитория

### 1. toolbox-backend (Node.js + Express)
- **GitHub:** github.com/wapxman/toolbox-backend
- **Vercel:** https://toolbox-backend-eight.vercel.app (работает, v1.1.0)
- **Статус:** ✅ Полностью рабочий, задеплоен

**Структура:**
```
src/
├── index.js              — Express app (v1.1.0)
├── lib/
│   ├── supabase.js       — клиент Supabase
│   ├── sms.js            — SMS (console mode)
│   └── kerong.js         — ✅ клиент Kerong LCS API (mock/live)
├── middleware/
│   └── auth.js           — JWT-верификация
└── routes/
    ├── auth.js           — send-code, verify, GET/PATCH /me
    ├── boxes.js          — список боксов, детали, инструменты
    ├── tools.js          — поиск, детали
    ├── rentals.js        — ✅ создать (+ открыть замок), продлить, вернуть (+ открыть замок)
    ├── notifications.js  — уведомления
    └── locks.js          — ✅ статус Kerong, открыть замок, свободные ячейки
```

**API эндпоинты:**
- POST /api/auth/send-code, POST /api/auth/verify
- GET/PATCH /api/auth/me
- GET /api/boxes, GET /api/boxes/:id, GET /api/boxes/:id/tools
- GET /api/tools/search?q=, GET /api/tools/:id
- POST /api/rentals (создаёт аренду + открывает замок через Kerong)
- POST /api/rentals/:id/extend, POST /api/rentals/:id/return (открывает замок)
- GET /api/rentals/active, GET /api/rentals/history, GET /api/rentals/:id
- GET /api/notifications
- GET /api/locks/status, POST /api/locks/open, GET /api/locks/free/:zoneId

**Env vars на Vercel:** SUPABASE_URL, SUPABASE_KEY, JWT_SECRET, SMS_PROVIDER=console, PORT=3000
**Kerong env (пока не установлены):** KERONG_LCS_URL, KERONG_LCS_USER, KERONG_LCS_PASSWORD

### 2. toolbox-app (Flutter)
- **GitHub:** github.com/wapxman/toolbox-app
- **Статус:** ✅ 22+ экранов, запускается, подключён к API

**Зависимости:** google_maps_flutter, mobile_scanner, http, shared_preferences, provider, cached_network_image, flutter_svg, geolocator, url_launcher, intl

**Структура экранов:**
```
lib/
├── main.dart
├── core/
│   ├── theme.dart         — дизайн-система (#1D9E75, 10px radius)
│   ├── constants.dart     — API URL, цены, скидки
│   └── api_service.dart   — ✅ HTTP клиент ко всем эндпоинтам backend
└── screens/
    ├── welcome_screen.dart          — экран 1
    ├── onboarding_screen.dart       — экраны 2-4
    ├── auth/
    │   ├── register_screen.dart     — экран 5
    │   └── login_screen.dart        — экран 6
    ├── home/
    │   ├── main_screen.dart         — таб-навигация
    │   ├── map_screen.dart          — ✅ карта боксов (из Supabase)
    │   ├── search_screen.dart       — ✅ поиск (реальный API)
    │   ├── box_detail_screen.dart   — ✅ инструменты бокса (из API)
    │   ├── box_offline_screen.dart  — бокс оффлайн
    │   └── tool_detail_screen.dart  — ✅ детали инструмента (из API)
    ├── rental/
    │   ├── booking_screen.dart      — бронирование
    │   ├── qr_scanner_screen.dart   — QR-сканер
    │   ├── payment_screen.dart      — оплата
    │   ├── payment_error_screen.dart
    │   ├── unlock_screen.dart       — анимация открытия замка
    │   ├── active_rental_screen.dart — активная аренда
    │   ├── extend_screen.dart       — продление
    │   ├── overdue_screen.dart      — просрочка
    │   └── return_confirm_screen.dart — возврат
    ├── rentals/
    │   └── rentals_screen.dart      — ✅ список аренд (из API)
    └── profile/
        ├── profile_screen.dart      — ✅ профиль (из API)
        ├── history_screen.dart      — история
        └── notifications_screen.dart — уведомления
```

### 3. toolbox-admin (Next.js + Tailwind)
- **GitHub:** github.com/wapxman/toolbox-admin
- **Vercel:** задеплоен (автодеплой)
- **Статус:** ✅ Подключена к Supabase, реальные данные

**Страницы:**
- Дашборд — статистика (боксы, инструменты, пользователи, аренды)
- Боксы — CRUD (добавить, вкл/откл, удалить) ✅ работает с реальной БД
- Инструменты — таблица из Supabase
- Аренды — таблица из Supabase
- Пользователи — таблица + блокировка
- Настройки — конфигурация

---

## Supabase

- **Проект:** ToolBox, ID: zwzmcihwtwgjajjjsbms
- **Регион:** ap-south-1
- **Anon key:** eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp3em1jaWh3dHdnamFqampzYm1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0OTQ0MzksImV4cCI6MjA5MTA3MDQzOX0.X4UnLTta5Pm70sOwZkwJgvA8EkQtJPDmsn-2dMlkqjA

**7 таблиц:**
- users (0 записей) — phone, name, is_blocked
- boxes (1 запись) — name, address, lat, lng, cells_count, status
- cells (6 записей) — box_id, cell_number, status, qr_code
- tools (6 записей) — cell_id, name, category, brand, day_price, specs, photo_url
- rentals (0) — user_id, tool_id, days, status, total_price, overdue_fee
- transactions (0) — rental_id, amount, payment_method, status
- notifications (0) — user_id, type, title, message, read

---

## Оборудование Kerong (ждём ~5 дней)

**Заказано у Юниверс-Софт (российский дистрибьютор Kerong):**
- 1× KR-BU (BOX) — сетевой контроллер (TCP/IP → RS485)
- 1× KR-CU 16 (BOX) — плата управления до 16 замков
- 6× электрозамков (KR-S99N или KR-S5966)
- 6× хуков + проставок
- 1× блок питания S-120-24 (24V 5A)
- Кабели и разъёмы

**Документация Kerong (изучена, 4 PDF):**
- Руководство по установке LCS (Docker на Windows)
- Руководство мобильного приложения Kerong
- API документация LCS (300 стр.) — нужны только 6 эндпоинтов
- Руководство по монтажу оборудования

**Архитектура IoT:**
```
Flutter App → ToolBox Backend (Vercel)
                  ↓ HTTPS (Cloudflare Tunnel)
         Мини-ПК + Docker (Kerong LCS, порт 9777)
                  ↓ LAN (Ethernet)
         KR-BU (контроллер)
                  ↓ RS485 (патч-корд)
         KR-CU 16 (плата замков)
                  ↓ провода (4 жилы)
         6× электрозамков
```

**Нужные эндпоинты Kerong LCS (6 из 100+):**
- POST /api/v1/auth/login — JWT-токен
- POST /api/v1/zones/open-lock — открыть замок {lockNumber, zoneId}
- PATCH /api/v1/booking — создать аренду в LCS
- POST /api/v1/booking/{uuid}/complete — завершить аренду
- GET /api/v1/zones/{id}/free-locks-numbers — свободные ячейки
- GET /api/v1/booking?clientId=X&active=true — активные аренды

**Модуль kerong.js уже написан** (src/lib/kerong.js) — работает в mock-режиме пока нет KERONG_LCS_URL. Когда железо приедет — переключается на live.

---

## Что сделано (полный список)

### Фаза 0 — Discovery ✅
- PRD с бизнес-моделью и рисками
- Схема БД (7 таблиц)
- Интерактивный прототип v3 (28 экранов) — ToolBox_Prototype_v3.html
- Полная документация — ToolBox_Full_Documentation.md

### Фаза 1 — Backend ✅
- Node.js + Express, все API эндпоинты
- Supabase: таблицы, индексы, тестовые данные
- JWT авторизация + SMS (console mode)
- Деплой на Vercel — работает
- Kerong модуль (mock) + роут /api/locks

### Фаза 2 — Flutter ✅ (частично)
- 22+ экранов из 28 написаны
- Дизайн-система (тема, цвета, компоненты)
- API-сервис подключён к реальному backend
- Экраны карты, бокса, инструмента, поиска, профиля, аренд — тянут реальные данные

### Фаза 3 — Админка ✅
- Next.js + Tailwind, задеплоена на Vercel
- Подключена к Supabase — реальные данные
- CRUD для боксов работает (добавить из админки → появится в приложении)

---

## Что НЕ сделано (предстоит)

### Приоритет 1 — Когда приедет железо Kerong:
- [ ] Установить Docker Desktop + Kerong LCS на Windows-ПК Бахтиёра
- [ ] Собрать оборудование: БП → BU → CU → замки (по инструкции)
- [ ] Переключить kerong.js с mock на live (добавить KERONG_LCS_URL в env)
- [ ] Тест: кнопка в приложении → замок открылся
- [ ] Добавить kerong_zone_id в таблицу boxes в Supabase

### Приоритет 2 — Оплата и SMS:
- [ ] Интеграция Payme/Click (без оплаты нет бизнеса)
- [ ] SMS-провайдер Eskiz.uz или PlayMobile (без SMS юзеры не войдут)

### Приоритет 3 — Доработки:
- [ ] PostGIS геолокация (поиск ближайших боксов)
- [ ] Push/SMS уведомления (окончание аренды, просрочка)
- [ ] RLS безопасность в Supabase
- [ ] Cloudflare Tunnel для доступа Vercel → локальный LCS на точке

### Приоритет 4 — Пилот:
- [ ] Мини-ПК на точке (вместо Windows-компа)
- [ ] Установка бокса в ТЦ
- [ ] Бета-тест с реальными пользователями
- [ ] Вторая точка (строительный рынок)

---

## Файлы для нового чата

В новом чате приложи:
1. **Этот файл** (BRIEF.md из репозитория toolbox-backend)
2. **ToolBox_Full_Documentation.md** — полная документация проекта
3. **ToolBox_Prototype_v3.html** — если нужно работать с UI/экранами

Claude подтянет остальное из GitHub через MCP-инструменты.

---

## Ключевые принципы работы

- Claude пишет код → пушит в GitHub → Бахтиёр делает git pull → тестирует
- Vercel автодеплоит backend и админку при пуше в GitHub
- Flutter тестируется локально через `flutter run` (Chrome или Android)
- Минимум ручных шагов для Бахтиёра
- Дизайн: primary #1D9E75, border-radius 10px, SF Pro/Roboto
- QR-сканер — центральная кнопка в таб-баре
