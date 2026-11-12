// =====================================================================
//  ОЧЕРЕДЬ И ОТПРАВКА
//
//  Как это работает:
//    1. Бармен жмёт «Сохранить» → запись СРАЗУ кладётся в очередь на телефоне.
//       Даже если интернета нет — запись уже не потеряется.
//    2. Функция syncNow() пытается отправить очередь на сервер.
//       Её вызывают: при открытии приложения, при появлении сети,
//       при возврате в приложение, раз в 30 секунд и после каждого сохранения.
//    3. Сервер отвечает по каждой записи:
//         saved / duplicate → убираем из очереди (запись в таблице)
//         error с retry     → оставляем, попробуем позже
//         error без retry   → помечаем «отклонено», показываем бармену причину
//    4. Если запрос оборвался — ничего страшного: при повторе сервер
//       узнает ID и ответит duplicate, дубль не появится.
// =====================================================================

import { db } from './db.js';
import { apiPost, NetworkError, ApiError } from './api.js';

const BATCH_SIZE = 20;      // сколько обычных записей отправлять за один запрос
const SENT_KEEP = 200;      // сколько отправленных записей хранить для истории

let syncing = false;
let syncAgain = false;      // пока шла отправка, появились новые записи — пройдём ещё раз
let lastSync = null;        // время последней успешной связи
let lastError = '';
const listeners = new Set();

/** Подписка на изменения статуса (для полоски внизу экрана). */
export function onSyncChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
async function notify() {
  const s = await getStatus();
  listeners.forEach(fn => { try { fn(s); } catch (e) { console.error(e); } });
}

export async function getStatus() {
  const all = await db.getAll('queue');
  return {
    online: navigator.onLine,
    pending: all.filter(r => r.status !== 'rejected').length,
    rejected: all.filter(r => r.status === 'rejected').length,
    syncing,
    lastSync,
    lastError,
  };
}

/** Уникальный ID записи. Придумывается на телефоне в момент сохранения. */
export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Положить запись в очередь. Возвращается сразу, отправка — в фоне. */
export async function enqueue(record) {
  const rec = {
    id: newId(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
    error: '',
    ...record,
  };
  await db.put('queue', rec);
  notify();
  syncNow(); // не ждём — пусть отправляется в фоне
  return rec;
}

export async function removeFromQueue(id) { await db.del('queue', id); notify(); }

/** Вернуть отклонённую запись в очередь (например, после смены PIN). */
export async function retryRejected(id, patch = {}) {
  const rec = await db.get('queue', id);
  if (!rec) return;
  await db.put('queue', { ...rec, ...patch, status: 'pending', error: '' });
  notify();
  syncNow();
}

export async function listQueue() {
  return (await db.getAll('queue')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function listSent() {
  return (await db.getAll('sent')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Главная функция: отправить всё, что есть в очереди. */
export async function syncNow() {
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  syncAgain = false;
  notify();
  let networkFailed = false;
  try {
    const queue = (await listQueue()).filter(r => r.status !== 'rejected');
    const plain = queue.filter(r => r.type !== 'photo');
    const photos = queue.filter(r => r.type === 'photo');

    // Обычные записи — пачками по 20
    for (let i = 0; i < plain.length; i += BATCH_SIZE) {
      await sendBatch(plain.slice(i, i + BATCH_SIZE), 30000);
    }
    // Фото — по одному (они тяжёлые), с большим таймаутом
    for (const p of photos) {
      await sendBatch([p], 90000);
    }
    lastError = '';
  } catch (e) {
    // Сетевая ошибка: прерываем цикл, остальное попробуем в следующий раз
    lastError = e.message || String(e);
    networkFailed = true;
  } finally {
    syncing = false;
    notify();
  }
  if (syncAgain && !networkFailed) syncNow();
}

async function sendBatch(records, timeoutMs) {
  // На сервер уходят только нужные поля (без служебных status/attempts)
  const payload = records.map(({ status, attempts, error, ...rest }) => rest);
  let res;
  try {
    res = await apiPost({ action: 'submit', records: payload }, timeoutMs);
  } catch (e) {
    if (e instanceof ApiError) {
      // Сервер отказал всему запросу целиком (например, «таблица занята») — повторим позже
      for (const r of records) await db.put('queue', { ...r, attempts: r.attempts + 1, error: e.message });
    }
    throw e;
  }
  lastSync = new Date();

  const byId = new Map(res.results.map(x => [x.id, x]));
  for (const r of records) {
    const result = byId.get(r.id);
    if (!result) continue;
    if (result.status === 'saved' || result.status === 'duplicate') {
      const { pin, image, ...forHistory } = r; // PIN и само фото в историю не сохраняем
      await db.put('sent', { ...forHistory, sentAt: new Date().toISOString() });
      await db.del('queue', r.id);
    } else if (result.retry || result.code === 'locked') {
      await db.put('queue', { ...r, attempts: r.attempts + 1, error: result.error });
    } else {
      await db.put('queue', { ...r, status: 'rejected', error: result.error, code: result.code || '' });
    }
  }
  await trimSent();
}

async function trimSent() {
  const sent = await listSent();
  for (const old of sent.slice(SENT_KEEP)) await db.del('sent', old.id);
}

/** Автоматические триггеры отправки. Вызывается один раз при старте. */
export function startAutoSync(intervalMs) {
  window.addEventListener('online', () => { notify(); syncNow(); });
  window.addEventListener('offline', notify);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
  setInterval(syncNow, intervalMs);
  syncNow();
}

export { NetworkError };
