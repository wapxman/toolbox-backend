<?php
// Шлюз Click → Vercel (Prepare).
// Живёт на UZ-хостинге со статическим IP (pay.taketool.uz) только потому,
// что файрвол Click выпускает запросы лишь на статические IP из белого списка,
// а у Vercel адреса плавающие. Никакой логики тут нет — чистый форвард POST.
require __DIR__ . '/forward.php';
click_forward('https://toolbox-backend-eight.vercel.app/api/payments/click/prepare');
