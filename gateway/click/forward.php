<?php
// Общий форвардер: принимает form-urlencoded POST от Click,
// пересылает его в Vercel как есть и возвращает ответ без изменений.
// Подпись Click не проверяем — это делает бэкенд; шлюз намеренно тупой.
function click_forward(string $target): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        http_response_code(405);
        header('Content-Type: application/json; charset=utf-8');
        echo '{"error":-3,"error_note":"POST only"}';
        return;
    }

    $body = file_get_contents('php://input'); // сырое тело — байт в байт
    $ch = curl_init($target);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $body,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/x-www-form-urlencoded'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT        => 25,   // Click ждёт ответ; Vercel отвечает за секунды
    ]);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);

    header('Content-Type: application/json; charset=utf-8');
    if ($resp === false) {
        // Апстрим недоступен — отвечаем кодом Click «системная ошибка»,
        // чтобы Click повторил попытку, а не завис без ответа.
        http_response_code(200);
        error_log('click gateway upstream error: ' . $err);
        echo '{"error":-9,"error_note":"Upstream unavailable"}';
        return;
    }
    http_response_code($code ?: 200);
    echo $resp;
}
