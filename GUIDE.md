# ToolBox (TOOLS24) — Полный гид проекта

> Единый актуальный справочник. Обновлён: **3 июля 2026**.
> Заменяет устаревшие BRIEF.md и PLAN.md (они от апреля 2026).

---

## 1. Что это

**ToolBox** (возможный ребренд — **TOOLS24**) — приложение посуточной аренды
электроинструментов из умных боксов (шкафы с электрозамками) в Ташкенте.

**Сценарий:** открыл приложение → нашёл ближайший бокс на карте → выбрал инструмент →
оплатил → замок открылся → забрал → вернул когда готов.

**Бизнес-модель:** посуточная аренда. Скидки: −20% от 3 дней, −35% от 7+ дней.
Оплата Payme (Click — следующий). Пилот: 2 точки в Ташкенте.

**Юрлицо:** «AB PARTNERS» MChJ (директор NOSIROV BEHRUZ). Аккаунт GitHub/сервисов: **wapxman**.

---

## 2. Репозитории и инфраструктура

| Компонент | Репозиторий | Где работает |
|---|---|---|
| Backend (Node/Express) | `wapxman/toolbox-backend` | Vercel: `https://toolbox-backend-eight.vercel.app` |
| Приложение (Flutter) | `wapxman/toolbox-app` | Android APK |
| Админка (Next.js) | `wapxman/toolbox-admin` | Vercel (автодеплой) |

- **Все репозитории склонированы:** `C:\Users\User\Desktop\GitHub\`
- **Supabase (БД):** проект `ToolBox`, id `zwzmcihwtwgjajjjsbms`, регион ap-south-1
- **Vercel team:** `wapxmans-projects`
- Автодеплой: пуш в `main` → Vercel пересобирает backend и админку

---

## 3. База данных (Supabase, схема public)

| Таблица | Назначение | Ключевые поля |
|---|---|---|
| `users` | пользователи | phone, name, is_blocked, terms_accepted_at |
| `boxes` | боксы | name, address, lat, lng, cells_count, status, **kerong_zone_id** |
| `cells` | ячейки | box_id, cell_number, status(free/occupied), qr_code |
| `tools` | инструменты | cell_id, name, category, brand, day_price, specs(jsonb), photo_url |
| `rentals` | аренды | user_id, tool_id, days, status, total_price, overdue_fee |
| `transactions` | платежи | rental_id, amount, payment_method, payment_id, status |
| `notifications` | уведомления | user_id, type, title, message, read |
| `sms_codes` | коды из SMS | phone(pk), code, expires_at |
| `payme_transactions` | транзакции Payme | paycom_id, rental_id, amount(тийины), state |

**Статусы `rentals.status`:** `pending_payment` → `active` → `completed` / `overdue` / `cancelled`.

✅ **RLS включён на всех таблицах** (03.07.2026). Бэкенд ходит Supabase secret-ключом
(`sb_secret_...` в `SUPABASE_KEY`), который работает в обход RLS. Прямой доступ с
публичного/anon-ключа закрыт (чтение → пусто, запись → 401). Политики намеренно не
добавлены — вся работа с БД только через бэкенд с его JWT-авторизацией.

---

## 4. Переменные окружения (Vercel → toolbox-backend)

Значения — в Vercel Dashboard (Settings → Environment Variables). Здесь только назначение:

| Переменная | Назначение |
|---|---|
| `SUPABASE_URL`, `SUPABASE_KEY` | доступ к БД |
| `JWT_SECRET` | подпись токенов авторизации (30 дней) |
| `SMS_PROVIDER` | `eskiz` (боевой) или `console` (dev, мастер-код 0000) |
| `ESKIZ_EMAIL`, `ESKIZ_PASSWORD` | доступ к SMS-шлюзу Eskiz |
| `PAYME_MERCHANT_ID`, `PAYME_KEY` | касса Payme (ключ пока тестовый) |
| `PAYME_CHECKOUT_URL` | `https://checkout.test.paycom.uz` (тест). Убрать для боевого |
| `KERONG_LCS_URL`, `KERONG_LCS_USER`, `KERONG_LCS_PASSWORD` | замки (пока не заданы → mock) |

---

## 5. Интеграции — статус на 03.07.2026

### 5.1 Яндекс-карты ✅ работает
- Плагин `yandex_mapkit`, ключ MapKit зашит в `MainActivity.kt`.
- `minSdk 26` обязателен (требование MapKit).
- Экран `map_screen.dart`: карта Ташкента, зелёные пины боксов, тап → бокс.

### 5.2 SMS-вход (Eskiz.uz) ✅ код готов, ⏳ ждём модерацию
- Договор с Eskiz №1291-2026. Баланс 305 000 сум. Кабинет: my.eskiz.uz.
- `lib/sms.js`: логин в шлюз, кэш токена, релогин при 401.
- Коды хранятся в таблице `sms_codes` (не в памяти — Vercel serverless теряет память).
- Шаблон: `ToolBox: kod podtverzhdeniya {code}. Nikomu ne soobshchayte.` (id 78996).
- **Статус:** шаблон на модерации, аккаунт `inactive`. Проверка:
  `GET https://notify.eskiz.uz/api/user/templates` (Bearer-токен из логина).
- Как одобрят: SMS пойдут сами, мастер-код 0000 отключится автоматически.

### 5.3 Оплата (Payme) ✅ код готов и протестирован, ⏳ ждём активацию кассы
- Касса «ToolBox» (Web-касса, с биллингом), ID `6a46b561b42f7c214f5dbee4`, на модерации.
- Endpoint в кабинете Payme: `.../api/payments/payme`. Реквизит: `rental_id`.
- `routes/payme.js`: Merchant API JSON-RPC (CheckPerform/Create/Perform/Cancel/Check/GetStatement).
  Basic-auth `Paycom:PAYME_KEY`, суммы в тийинах, таймаут 12ч, идемпотентность.
- **Флоу:** аренда создаётся в `pending_payment` (замок НЕ открывается) → оплата →
  `PerformTransaction` открывает замок и активирует аренду.
- Приложение: `payment_screen.dart` открывает checkout-ссылку, поллит `/rentals/:id/payment-status`.
- Прогнано на проде: 12 сценариев (auth, суммы, идемпотентность, отмена-возврат).
- Как активируют кассу: заменить `PAYME_KEY` на продакшн-ключ, убрать `PAYME_CHECKOUT_URL`.

### 5.4 QR-сканер ✅ готов (тест на телефоне)
- `qr_scanner_screen.dart` на `mobile_scanner`: камера, распознавание, фонарик.
- Из QR извлекается UUID бокса → `getBox` → экран бокса.
- Разрешение `CAMERA` в манифесте. В эмуляторе не тестируется (виртуальная камера).

### 5.5 Замки (Kerong LCS) 📦 пакет готов, ждём железо
- Оборудование: KR-BU (контроллер) + KR-CU 16 (плата на 16 замков) + 6 электрозамков.
- `lib/kerong.js`: клиент LCS. Открытие замка `POST /api/v1/zones/open-lock {lockNumber, zoneId}` + Bearer.
  ⚠️ Авторизацию поправить на `POST /api/v1/auth/v2/login` (в коде было `/auth/login`).
- Пакет для мини-ПК: `C:\Users\User\Desktop\KERONG_setup\` (docker-образ + compose + init.sql + README).
- Порты LCS: API **9991**, PostgreSQL **10000**. Логин admin/masterkey. Встроенные доки: `/ui/docs`.
- Осталось: запустить контейнер на мини-ПК → сверить API по /ui/docs → **Cloudflare Tunnel**
  (Vercel → локальный LCS без белого IP) → задать `KERONG_LCS_*` → mock выключится.
- Документация Kerong (PDF): на рабочем столе — API LCS, установка, монтаж, моб. приложение.

---

## 6. Сборка Android-приложения

**Тулчейн (стоит на этом ПК):** Flutter `C:\src\flutter`, JDK 17 `C:\Java\jdk-17`,
Android SDK `%LOCALAPPDATA%\Android\Sdk`.

```bash
cd C:\Users\User\Desktop\GitHub\toolbox-app
flutter build apk --release
# готовый файл: build/app/outputs/flutter-apk/app-release.apk (~161 МБ)
```
Готовый APK кладём на рабочий стол как `ToolBox.apk`.
Лёгкие версии по архитектурам: `flutter build apk --release --split-per-abi` (~55 МБ каждая).

**Эмулятор для тестов:** AVD `toolbox_test` (Pixel 7, Android 35 x86_64).
```bash
adb install -r ToolBox.apk
```
- Вход в приложении требует SMS → пока на модерации, в эмуляторе не залогиниться штатно.
- Приложение всегда стартует с экрана приветствия (токен при старте не проверяется).

---

## 7. Что осталось сделать

**Ждём внешнее:**
- [ ] Модерация SMS-шаблона Eskiz (мониторится автоматически)
- [ ] Активация кассы Payme → продакшн-ключ
- [ ] Железо Kerong (приезд) → запуск LCS + Cloudflare Tunnel

**Можем делать сейчас:**
- [ ] **Включить RLS в Supabase** (безопасность) — перевести бэкенд на service-role ключ
- [ ] Click как второй способ оплаты
- [ ] Финальный ребрендинг ToolBox → TOOLS24 (имя приложения, иконка, тексты, SMS-шаблон)
- [ ] Восстановить из старой APK v6.9: Firebase-пуши, геолокацию «боксы рядом»
- [ ] Уведомления: окончание аренды, просрочка

**После пилота:**
- [ ] Публикация в Google Play (.aab), вторая точка

---

## 8. Дизайн-система
- Primary: `#1D9E75` (зелёный), border-radius 10px, шрифт SF Pro / Roboto.
- QR-сканер — центральная кнопка в таб-баре.

---

## 9. Артефакты на рабочем столе
- `ToolBox.apk` — актуальная сборка (карты + авторизация + оплата + QR)
- `ToolBox-v6.9.apk` — старая версия с ноутбука (архив, источник ключей/функций)
- `TOOLS24_logo.png` — логотип кассы Payme (512×512)
- `KERONG_setup\` — пакет для запуска LCS на мини-ПК
- Kerong PDF: `ДОКУМЕНТАЦИЯ KERONG API LCS.pdf`, `Руководство_по_установке_системы.pdf` и др.
