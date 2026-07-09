/**
 * Kerong LCS API Client (docker-версия kerong-api v2.4.5)
 *
 * ВАЖНО: docker-образ kerong-api имеет СВОЙ API (/kerong-api/*), он НЕ совпадает
 * с большим LCS из PDF-документации (там был /api/v1/auth, /zones/* — их тут НЕТ).
 * Реальные эндпоинты выверены живьём 10.07.2026 (замок открыт по сети).
 *
 * Режим:
 * - KERONG_LCS_URL не задан → MOCK (замок не открывается, лог в консоль)
 * - KERONG_LCS_URL задан    → реальные запросы к LCS (через Cloudflare Tunnel)
 *
 * Плата KR-BU: сетевой модуль, заводской статический IP 192.168.0.7:23.
 * LCS держит с ней TCP-соединение и транслирует HTTP → бинарный протокол платы.
 */

const KERONG_URL = (process.env.KERONG_LCS_URL || '').replace(/\/+$/, '');
const BOARD_IP = process.env.KERONG_BOARD_IP || '192.168.0.7';
const BOARD_PORT = parseInt(process.env.KERONG_BOARD_PORT || '23', 10);
const BOARD_TYPE = process.env.KERONG_BOARD_TYPE || 'CU_16';
const MOCK_MODE = !KERONG_URL;

// uuid платы в LCS генерится при создании — кэшируем после первого резолва
let cachedBuUuid = null;

async function api(method, path, body = null) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${KERONG_URL}/kerong-api${path}`, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Kerong LCS ${res.status}: ${text || res.statusText}`);
  }
  return data;
}

/**
 * Найти (или создать) плату KR-BU в LCS и вернуть её uuid.
 * LCS хранит платы в своей БД; если её нет — регистрируем по заводскому IP.
 */
async function resolveBoardUuid() {
  if (cachedBuUuid) return cachedBuUuid;

  const list = await api('GET', '/kr-bu-boards-list');
  const existing = Array.isArray(list) ? list.find(b => b.address === BOARD_IP) : null;
  if (existing) {
    cachedBuUuid = existing.uuid;
    return cachedBuUuid;
  }

  const created = await api('POST', '/create-kr-bu', {
    name: 'ToolBox-BU',
    address: BOARD_IP,
    port: BOARD_PORT,
    stype: BOARD_TYPE,
    descr: 'ToolBox smart box',
    enabled: true,
  });
  cachedBuUuid = created.uuid;
  return cachedBuUuid;
}

// ==========================================
// Публичные методы для ToolBox backend
// ==========================================

/**
 * Открыть замок.
 * @param {number} zoneId    - зона бокса (kerong_zone_id); при одной плате не используется
 * @param {number} lockNumber - номер замка на плате (0-based позиция)
 */
async function openLock(zoneId, lockNumber) {
  console.log(`[KERONG] Открываем замок #${lockNumber} (зона ${zoneId})`);

  if (MOCK_MODE) {
    console.log(`[KERONG MOCK] Замок #${lockNumber} открыт (мок)`);
    return { success: true, mock: true };
  }

  const buBoardUuid = await resolveBoardUuid();
  // ГОТЧА: поле uuid называется именно buBoardUuid; поле замка — lockNumber
  const r = await api('POST', '/open-lock', {
    buBoardUuid,
    krCuId: 0,
    lockNumber,
  });
  if (r && r.ok === false) throw new Error(`Kerong open-lock отказ: ${JSON.stringify(r)}`);
  console.log(`[KERONG] Замок #${lockNumber} открыт!`, r);
  return { success: true };
}

/**
 * Получить состояние замков (свободные = замок закрыт/ячейка пуста).
 * Возвращает массив номеров, для совместимости со старой сигнатурой.
 */
async function getFreeLocks(zoneId) {
  if (MOCK_MODE) return [0, 1, 2, 3, 4, 5];

  const buBoardUuid = await resolveBoardUuid();
  const matrix = await api('GET', `/locks-list?kr-bu-uuid=${encodeURIComponent(buBoardUuid)}`);
  const cu = Array.isArray(matrix) ? matrix[0] : null;
  if (!cu || !Array.isArray(cu.locks)) return [];
  // detectionStatus === 'EMPTY' → ячейка свободна
  return cu.locks.filter(l => l.detectionStatus === 'EMPTY').map(l => l.lockNumber ?? l.lockId);
}

/**
 * Проверить связь с LCS и платой.
 */
async function checkConnection() {
  if (MOCK_MODE) {
    return { connected: false, mode: 'mock', message: 'KERONG_LCS_URL не задан, работаем в режиме мока' };
  }
  try {
    const buBoardUuid = await resolveBoardUuid();
    const matrix = await api('GET', `/locks-list?kr-bu-uuid=${encodeURIComponent(buBoardUuid)}`);
    const cu = Array.isArray(matrix) ? matrix[0] : null;
    return {
      connected: !!cu,
      mode: 'live',
      url: KERONG_URL,
      board: BOARD_IP,
      locks: cu ? cu.locks.length : 0,
    };
  } catch (err) {
    return { connected: false, mode: 'error', message: err.message };
  }
}

module.exports = {
  openLock,
  getFreeLocks,
  checkConnection,
  MOCK_MODE,
};
