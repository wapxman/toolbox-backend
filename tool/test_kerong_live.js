/**
 * Живой тест Kerong LCS — прогон перед подключением замков к бэкенду.
 *
 * Использование:
 *   node tool/test_kerong_live.js                         # проверка API (без открытия замка)
 *   node tool/test_kerong_live.js --open 1 --zone 1       # + реально открыть замок №1 в зоне 1
 *   node tool/test_kerong_live.js --url http://192.168.1.50:9991   # другой адрес LCS
 *
 * По умолчанию LCS ищется на http://localhost:9991 (порт из KERONG_setup/docker-compose).
 */

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}

const URL = arg('url', 'http://localhost:9991');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'masterkey');
const OPEN = arg('open', null);   // номер замка для реального открытия
const ZONE = parseInt(arg('zone', '1'));

let token = null;

async function api(method, path, body) {
  const res = await fetch(`${URL}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  console.log(`\n=== Тест Kerong LCS: ${URL} ===\n`);

  // 1. Авторизация (7.2: POST /auth/v2/login)
  process.stdout.write('1. Авторизация admin... ');
  const auth = await api('POST', '/auth/v2/login', { username: USER, password: PASS });
  if (!auth.ok || !auth.data.accessToken) {
    console.log(`ПРОВАЛ (${auth.status}):`, auth.data);
    console.log('\nПодсказки: контейнер запущен? порт 9991? логин/пароль верны?');
    process.exit(1);
  }
  token = auth.data.accessToken;
  console.log('OK (accessToken получен)');

  // 2. Список зон (8.2: GET /zones)
  process.stdout.write('2. Список зон... ');
  const zones = await api('GET', '/zones');
  if (!zones.ok) {
    console.log(`ПРОВАЛ (${zones.status}):`, zones.data);
  } else {
    const list = Array.isArray(zones.data) ? zones.data : (zones.data.content || []);
    console.log(`OK (зон: ${list.length})`);
    list.forEach(z => console.log(`   зона id=${z.id} «${z.name}» активна=${z.active} замков=${z.locksCount ?? '?'}`));
    if (list.length === 0) {
      console.log('   ⚠ Зон нет — создать в веб-интерфейсе LCS (плата KR-BU → набор замков → зона)');
    }
  }

  // 3. Свободные замки зоны (8.6: GET /zones/{id}/free-locks-numbers)
  process.stdout.write(`3. Свободные замки зоны ${ZONE}... `);
  const free = await api('GET', `/zones/${ZONE}/free-locks-numbers`);
  if (!free.ok) {
    console.log(`ПРОВАЛ (${free.status}):`, free.data);
  } else {
    console.log('OK:', JSON.stringify(free.data));
  }

  // 4. Реальное открытие замка (8.14: POST /zones/open-lock) — только с флагом --open
  if (OPEN) {
    process.stdout.write(`4. ОТКРЫВАЮ замок №${OPEN} в зоне ${ZONE}... `);
    const open = await api('POST', '/zones/open-lock', { lockNumber: parseInt(OPEN), zoneId: ZONE });
    console.log(open.ok ? 'OK — замок должен щёлкнуть!' : `ПРОВАЛ (${open.status}): ${JSON.stringify(open.data)}`);
  } else {
    console.log('4. Открытие замка пропущено (запусти с --open <номер> --zone <id>, когда замок подключён)');
  }

  console.log('\n=== Тест завершён ===\n');
}

main().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
