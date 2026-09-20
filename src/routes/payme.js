// Payme Merchant API (JSON-RPC 2.0)
// Все вызовы приходят С СЕРВЕРА Payme на этот endpoint.
// Auth: Basic base64("Paycom:" + PAYME_KEY)
// Суммы — в тийинах (1 сум = 100 тийин), времена — unix ms.
// Документация: https://developer.help.paycom.uz/metody-merchant-api/

const express = require('express');
const supabase = require('../lib/supabase');
const orders = require('../lib/orders');

const router = express.Router();

// Состояния транзакции Payme
const STATE_CREATED = 1;
const STATE_COMPLETED = 2;
const STATE_CANCELLED = -1;          // отменена до проведения
const STATE_CANCELLED_AFTER = -2;    // отменена после проведения (возврат)

const TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 часов на оплату созданной транзакции

// Коды ошибок Payme
const ERR = {
  auth:            { code: -32504, message: 'Недостаточно привилегий' },
  method:          { code: -32601, message: 'Метод не найден' },
  wrongAmount:     { code: -31001, message: 'Неверная сумма' },
  txNotFound:      { code: -31003, message: 'Транзакция не найдена' },
  cannotPerform:   { code: -31008, message: 'Невозможно выполнить операцию' },
  rentalNotFound:  { code: -31050, message: { ru: 'Аренда не найдена', uz: 'Ijara topilmadi', en: 'Rental not found' }, data: 'rental_id' },
  rentalPaid:      { code: -31051, message: { ru: 'Аренда уже оплачена', uz: 'Ijara allaqachon to‘langan', en: 'Rental already paid' }, data: 'rental_id' },
  rentalCancelled: { code: -31052, message: { ru: 'Аренда отменена', uz: 'Ijara bekor qilingan', en: 'Rental cancelled' }, data: 'rental_id' },
};

function rpcError(res, id, err) {
  return res.json({ jsonrpc: '2.0', id, error: err });
}

function rpcResult(res, id, result) {
  return res.json({ jsonrpc: '2.0', id, result });
}

function checkAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const [login, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    const password = rest.join(':');
    return login === 'Paycom' && password === process.env.PAYME_KEY && !!process.env.PAYME_KEY;
  } catch {
    return false;
  }
}

async function getRental(rentalId) {
  if (!rentalId || !/^[0-9a-f-]{36}$/i.test(String(rentalId))) return null;
  const { data } = await supabase
    .from('rentals')
    .select('*, tools(name, cell_id, sale_stock, cells(cell_number, kerong_lock_number, boxes(*)))')
    .eq('id', rentalId)
    .single();
  return data || null;
}

async function getTxByPaycomId(paycomId) {
  const { data } = await supabase
    .from('payme_transactions')
    .select('*')
    .eq('paycom_id', paycomId)
    .single();
  return data || null;
}

// Просроченную created-транзакцию отменяем (reason 4 — таймаут)
async function expireIfNeeded(tx) {
  if (tx.state === STATE_CREATED && Date.now() - Number(tx.create_time) > TIMEOUT_MS) {
    const cancelTime = Date.now();
    await supabase.from('payme_transactions')
      .update({ state: STATE_CANCELLED, reason: 4, cancel_time: cancelTime })
      .eq('id', tx.id);
    await supabase.from('rentals')
      .update({ status: 'cancelled' })
      .eq('id', tx.rental_id)
      .eq('status', 'pending_payment');
    return { ...tx, state: STATE_CANCELLED, reason: 4, cancel_time: cancelTime };
  }
  return tx;
}

// === Методы ===

async function checkPerformTransaction(params) {
  const rental = await getRental(params?.account?.rental_id);
  if (!rental) return { error: ERR.rentalNotFound };
  if (rental.status === 'cancelled') return { error: ERR.rentalCancelled };
  if (rental.status !== 'pending_payment') return { error: ERR.rentalPaid };
  if (Number(params.amount) !== rental.total_price * 100) return { error: ERR.wrongAmount };
  // Покупка: нельзя принять оплату, если новых единиц на складе не осталось
  if (rental.kind === 'buy' && !(Number(rental.tools?.sale_stock || 0) > 0)) return { error: ERR.cannotPerform };

  return {
    result: {
      allow: true,
      detail: {
        receipt_type: 0,
        items: [{
          title: rental.kind === 'buy' ? `Покупка: ${rental.tools?.name || 'инструмент'}`
            : rental.kind === 'courier_return' ? `Вызов курьера: ${rental.tools?.name || 'инструмент'}`
            : `Аренда: ${rental.tools?.name || 'инструмент'} (${rental.days} дн.)`
            + (rental.fulfillment === 'delivery' ? ' + доставка' : ''),
          price: rental.total_price * 100,
          count: 1,
          code: '10306002002000000', // ИКПУ из договора
          vat_percent: 0,
          package_code: '1',
        }],
      },
    },
  };
}

async function createTransaction(params) {
  const existing = await getTxByPaycomId(params.id);
  if (existing) {
    const tx = await expireIfNeeded(existing);
    if (tx.state !== STATE_CREATED) return { error: ERR.cannotPerform };
    return { result: { create_time: Number(tx.create_time), transaction: tx.id, state: tx.state } };
  }

  const check = await checkPerformTransaction(params);
  if (check.error) return check;

  // Одна аренда — одна живая транзакция
  const { data: others } = await supabase
    .from('payme_transactions')
    .select('id, state, create_time')
    .eq('rental_id', params.account.rental_id)
    .eq('state', STATE_CREATED);
  const alive = [];
  for (const o of others || []) {
    const fresh = await expireIfNeeded({ ...o, rental_id: params.account.rental_id });
    if (fresh.state === STATE_CREATED) alive.push(fresh);
  }
  if (alive.length > 0) return { error: ERR.cannotPerform };

  const createTime = Date.now();
  const { data: tx, error } = await supabase
    .from('payme_transactions')
    .insert({
      paycom_id: params.id,
      paycom_time: Number(params.time),
      rental_id: params.account.rental_id,
      amount: Number(params.amount),
      state: STATE_CREATED,
      create_time: createTime,
    })
    .select()
    .single();
  if (error) throw error;

  return { result: { create_time: createTime, transaction: tx.id, state: STATE_CREATED } };
}

async function performTransaction(params) {
  let tx = await getTxByPaycomId(params.id);
  if (!tx) return { error: ERR.txNotFound };
  tx = await expireIfNeeded(tx);

  if (tx.state === STATE_COMPLETED) {
    return { result: { transaction: tx.id, perform_time: Number(tx.perform_time), state: STATE_COMPLETED } };
  }
  if (tx.state !== STATE_CREATED) return { error: ERR.cannotPerform };

  const performTime = Date.now();
  await supabase.from('payme_transactions')
    .update({ state: STATE_COMPLETED, perform_time: performTime })
    .eq('id', tx.id);

  // Подтверждаем заказ: аренда/покупка, из бокса/с доставкой — вся логика в lib/orders
  await orders.confirmPayment(tx.rental_id, {
    method: 'payme',
    paymentId: tx.paycom_id,
    amountSum: Math.round(Number(tx.amount) / 100),
  });

  return { result: { transaction: tx.id, perform_time: performTime, state: STATE_COMPLETED } };
}

async function cancelTransaction(params) {
  let tx = await getTxByPaycomId(params.id);
  if (!tx) return { error: ERR.txNotFound };

  if (tx.state === STATE_CANCELLED || tx.state === STATE_CANCELLED_AFTER) {
    return { result: { transaction: tx.id, cancel_time: Number(tx.cancel_time), state: tx.state } };
  }

  const cancelTime = Date.now();
  const newState = tx.state === STATE_COMPLETED ? STATE_CANCELLED_AFTER : STATE_CANCELLED;

  await supabase.from('payme_transactions')
    .update({ state: newState, reason: Number(params.reason) || null, cancel_time: cancelTime })
    .eq('id', tx.id);

  // Отмена ДО оплаты — просто закрываем заказ. Отмена ПОСЛЕ оплаты (возврат средств
  // со стороны Payme) — заказ отменён, деньги уже вернулись (refund done), склад/ячейка обратно.
  // Завершённую аренду (инструмент уже возвращён) не трогаем.
  const rental = await getRental(tx.rental_id);
  if (rental && rental.status !== 'completed') {
    const afterPay = newState === STATE_CANCELLED_AFTER;
    await supabase.from('rentals').update({
      status: 'cancelled', cancelled_at: new Date().toISOString(),
      ...(afterPay ? { refund_status: 'done' } : {}),
    }).eq('id', tx.rental_id);
    if (afterPay && rental.kind === 'buy') await orders.returnStock(rental.tool_id);
    // Ячейку освобождаем только по самому заказу; вызов курьера (courier_return) ячейкой не владеет
    if (rental?.tools?.cells && rental.kind === 'rent') {
      await supabase.from('cells').update({ status: 'free' }).eq('id', rental.tools.cell_id);
    }
  }
  if (newState === STATE_CANCELLED_AFTER) {
    await supabase.from('transactions')
      .update({ status: 'failed' })
      .eq('payment_id', tx.paycom_id);
  }

  return { result: { transaction: tx.id, cancel_time: cancelTime, state: newState } };
}

async function checkTransaction(params) {
  let tx = await getTxByPaycomId(params.id);
  if (!tx) return { error: ERR.txNotFound };
  tx = await expireIfNeeded(tx);
  return {
    result: {
      create_time: Number(tx.create_time),
      perform_time: Number(tx.perform_time) || 0,
      cancel_time: Number(tx.cancel_time) || 0,
      transaction: tx.id,
      state: tx.state,
      reason: tx.reason ?? null,
    },
  };
}

async function getStatement(params) {
  const { data } = await supabase
    .from('payme_transactions')
    .select('*')
    .gte('paycom_time', Number(params.from))
    .lte('paycom_time', Number(params.to));

  return {
    result: {
      transactions: (data || []).map(tx => ({
        id: tx.paycom_id,
        time: Number(tx.paycom_time),
        amount: Number(tx.amount),
        account: { rental_id: tx.rental_id },
        create_time: Number(tx.create_time),
        perform_time: Number(tx.perform_time) || 0,
        cancel_time: Number(tx.cancel_time) || 0,
        transaction: tx.id,
        state: tx.state,
        reason: tx.reason ?? null,
      })),
    },
  };
}

// === JSON-RPC endpoint ===
router.post('/', async (req, res) => {
  const { id, method, params } = req.body || {};

  if (!checkAuth(req)) {
    return rpcError(res, id ?? null, ERR.auth);
  }

  try {
    let out;
    switch (method) {
      case 'CheckPerformTransaction': out = await checkPerformTransaction(params); break;
      case 'CreateTransaction':       out = await createTransaction(params); break;
      case 'PerformTransaction':      out = await performTransaction(params); break;
      case 'CancelTransaction':       out = await cancelTransaction(params); break;
      case 'CheckTransaction':        out = await checkTransaction(params); break;
      case 'GetStatement':            out = await getStatement(params); break;
      default: return rpcError(res, id, ERR.method);
    }
    if (out.error) return rpcError(res, id, out.error);
    return rpcResult(res, id, out.result);
  } catch (err) {
    console.error('payme webhook error:', err);
    return rpcError(res, id, { code: -32400, message: 'Внутренняя ошибка' });
  }
});

module.exports = router;
