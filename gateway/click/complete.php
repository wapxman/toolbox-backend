<?php
// Шлюз Click → Vercel (Complete). См. комментарий в prepare.php.
require __DIR__ . '/forward.php';
click_forward('https://toolbox-backend-eight.vercel.app/api/payments/click/complete');
