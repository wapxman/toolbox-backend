/**
 * Kerong LCS API Client
 * Модуль для управления электрозамками через Kerong LCS сервер.
 * 
 * Документация: ДОКУМЕНТАЦИЯ_KERONG_API_LCS.pdf (300 стр.)
 * Используем 6 эндпоинтов из ~100+
 * 
 * Режим работы:
 * - MOCK=true  → замки не открываются, логи в консоль (разработка)
 * - MOCK=false → реальные запросы к Kerong LCS (продакшн)
 */

const KERONG_URL = process.env.KERONG_LCS_URL || 'http://localhost:9777';
const KERONG_USER = process.env.KERONG_LCS_USER || 'admin';
const KERONG_PASS = process.env.KERONG_LCS_PASSWORD || 'masterkey';
const MOCK_MODE = !process.env.KERONG_LCS_URL; // мок если URL не задан

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Получить JWT-токен от Kerong LCS
 * POST /api/v1/auth/login
 */
async function getToken() {
  if (MOCK_MODE) return 'mock-token';
  
  // Кэшируем токен на 50 минут (LCS выдаёт на 60)
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch(`${KERONG_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: KERONG_USER, password: KERONG_PASS })
  });

  if (!res.ok) throw new Error(`Kerong auth failed: ${res.status}`);
  
  const data = await res.json();
  cachedToken = data.accessToken;
  tokenExpiry = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

/**
 * Выполнить запрос к Kerong LCS API
 */
async function kerongRequest(method, path, body = null) {
  if (MOCK_MODE) {
    console.log(`[KERONG MOCK] ${method} ${path}`, body || '');
    return { mock: true };
  }

  const token = await getToken();
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${KERONG_URL}/api/v1${path}`, options);
  
  if (res.status === 401) {
    // Токен протух — сбрасываем и пробуем ещё раз
    cachedToken = null;
    tokenExpiry = 0;
    return kerongRequest(method, path, body);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Kerong API error ${res.status}: ${err}`);
  }

  // Некоторые эндпоинты возвращают пустой body (open-lock → 200 без тела)
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ==========================================
// Публичные методы для ToolBox backend
// ==========================================

/**
 * Открыть замок
 * POST /api/v1/zones/open-lock
 * @param {number} zoneId - ID зоны в Kerong
 * @param {number} lockNumber - Номер замка (1-16)
 */
async function openLock(zoneId, lockNumber) {
  console.log(`[KERONG] Открываем замок #${lockNumber} в зоне ${zoneId}`);
  
  if (MOCK_MODE) {
    console.log(`[KERONG MOCK] Замок #${lockNumber} открыт (мок)`);
    return { success: true, mock: true };
  }

  await kerongRequest('POST', '/zones/open-lock', { lockNumber, zoneId });
  console.log(`[KERONG] Замок #${lockNumber} открыт!`);
  return { success: true };
}

/**
 * Получить свободные ячейки в зоне
 * GET /api/v1/zones/{id}/free-locks-numbers
 * @param {number} zoneId
 * @returns {number[]} массив свободных номеров замков
 */
async function getFreeLocks(zoneId) {
  if (MOCK_MODE) {
    return [1, 2, 3, 4, 5, 6]; // мок: все 6 свободны
  }
  
  const data = await kerongRequest('GET', `/zones/${zoneId}/free-locks-numbers`);
  return data.freeLocksNumbers || [];
}

/**
 * Создать аренду в Kerong LCS
 * PATCH /api/v1/booking
 */
async function createBooking({ lockNumber, zoneId, startDate, endDate }) {
  if (MOCK_MODE) {
    return { uuid: `mock-${Date.now()}`, lockNumber, zoneId, active: true, mock: true };
  }

  return kerongRequest('PATCH', '/booking', {
    lockNumber,
    zoneId,
    startDate,
    endDate,
    identifiersIdList: [],
    accessMode: 'PUBLIC',
    isPasswordAccess: false
  });
}

/**
 * Завершить аренду в Kerong LCS (замок откроется автоматически)
 * POST /api/v1/booking/{uuid}/complete
 */
async function completeBooking(bookingUuid) {
  if (MOCK_MODE) {
    console.log(`[KERONG MOCK] Аренда ${bookingUuid} завершена (мок)`);
    return { success: true, mock: true };
  }

  return kerongRequest('POST', `/booking/${bookingUuid}/complete`);
}

/**
 * Проверить статус соединения с Kerong LCS
 */
async function checkConnection() {
  if (MOCK_MODE) {
    return { connected: false, mode: 'mock', message: 'KERONG_LCS_URL не задан, работаем в режиме мока' };
  }

  try {
    await getToken();
    return { connected: true, mode: 'live', url: KERONG_URL };
  } catch (err) {
    return { connected: false, mode: 'error', message: err.message };
  }
}

module.exports = {
  openLock,
  getFreeLocks,
  createBooking,
  completeBooking,
  checkConnection,
  MOCK_MODE
};
