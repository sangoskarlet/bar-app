// =====================================================================
//  ХРАНИЛИЩЕ НА ТЕЛЕФОНЕ (IndexedDB)
//
//  IndexedDB — встроенная в браузер база данных. Она переживает
//  закрытие приложения, перезагрузку телефона и отсутствие интернета.
//
//  Хранилища («таблицы» внутри телефона):
//    queue     — записи, которые ещё НЕ дошли до Google Таблицы
//    sent      — последние отправленные записи (для истории на экране)
//    kv        — разное: справочник, вход сотрудника и т.п.
//    ttkPhotos — фото ТТК, скачанные заранее, чтобы смотреть без сети
// =====================================================================

const DB_NAME = 'bar-app';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sent')) db.createObjectStore('sent', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('ttkPhotos')) db.createObjectStore('ttkPhotos');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Универсальная обёртка: открыть транзакцию, выполнить действие, дождаться конца.
async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  get: (store, key) => run(store, 'readonly', s => s.get(key)),
  getAll: (store) => run(store, 'readonly', s => s.getAll()),
  count: (store) => run(store, 'readonly', s => s.count()),
  put: (store, value, key) => run(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key))),
  del: (store, key) => run(store, 'readwrite', s => s.delete(key)),
  keys: (store) => run(store, 'readonly', s => s.getAllKeys()),
};
