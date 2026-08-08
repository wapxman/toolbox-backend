# Шлюз платёжных колбэков (pay.taketool.uz)

Зачем: файрвол Click выпускает запросы только на статические IP из белого
списка, у Vercel входящие IP плавающие → колбэки Prepare/Complete не доходили
(ошибка -1905 «Нет ответа от поставщика»). Payme это не касается — он ходит
на Vercel напрямую.

Где живёт: shared-хостинг webname.uz (Arsenal D), тариф Silver 50M,
договор №55275-АН, домен-владелец taketool.uz. Поддомен `pay.taketool.uz`
(A-запись в Vercel DNS → IP хостинга; NS домена остаются на Vercel!).

Файлы `gateway/click/*.php` заливаются на хостинг по FTP в корень сайта
(структура URL: `https://pay.taketool.uz/click/prepare.php`).

В кабинете Click (mc.click.uz → Сервисы → карандаш, сервис 105872):
- Prepare URL:  `https://pay.taketool.uz/click/prepare.php`
- Complete URL: `https://pay.taketool.uz/click/complete.php`

После смены URL сообщить в поддержку Click IP хостинга для белого списка.

Проверка шлюза без Click: POST form-urlencoded с валидной подписью
(md5(click_trans_id + service_id + SECRET + merchant_trans_id + amount +
action + sign_time)) на prepare.php → должен вернуться JSON бэкенда.
