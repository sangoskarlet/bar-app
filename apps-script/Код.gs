/**
 * =====================================================================
 *  БАР — ЖУРНАЛ. Серверная часть (Google Apps Script)
 * =====================================================================
 *
 *  Что делает этот скрипт:
 *    Он — «дверь» в Google Таблицу. Приложение на телефоне не пишет
 *    в таблицу напрямую, а отправляет сюда запрос. Скрипт проверяет
 *    PIN, проверяет данные, защищает от дублей и записывает строку.
 *
 *  Два типа запросов:
 *    GET  (doGet)  — приложение что-то ЧИТАЕТ: справочник, ТТК, фото ТТК, вопросы викторины,
 *                    состояние дуэли, рейтинг, профиль персонажа (заготовка).
 *    POST (doPost) — приложение что-то ПИШЕТ: вход, переносы, списания, фото,
 *                    обжалование вопроса викторины, ответы дуэли, результат викторины.
 *
 *  Главные правила надёжности:
 *    1. У каждой записи есть уникальный ID, который придумывает телефон.
 *       Если запись с таким ID уже есть — второй раз не пишем (нет дублей).
 *    2. Запись идёт под блокировкой (LockService): два запроса
 *       одновременно не перемешают строки.
 *    3. На каждую запись отвечаем статусом: saved / duplicate / error.
 *       Телефон удаляет запись из очереди только после saved или duplicate.
 * =====================================================================
 */

// ID новой таблицы (из её адреса: docs.google.com/spreadsheets/d/<ВОТ_ЭТО>/edit)
const SPREADSHEET_ID = '1Vde5OWYoyY_3uGRmwzeoYdJZNzmMXKI-YDCm8XZ7JD8';

// Названия листов. Если переименуете лист в таблице — поменяйте и здесь.
const SHEETS = {
  transfers: 'Переносы',
  writeoffs: 'Списания',
  photos:    'Фото уборки',
  ttk:       'ТТК',
  items:     'Справочник',
  lists:     'Списки',
  staff:     'Сотрудники',
  log:       'Лог',
  invList:   'Опись',     // что считаем на инвентаризации
  invCounts: 'Подсчёт',   // каждая цифра от бармена — отдельная строка
  actTpl:    'Шаблоны переработки', // какие акты бывают и их рецепты
  acts:      'Акты переработки',    // журнал актов: строка на каждое сырьё и результат
  refs:      'Эталоны уборки',      // зона → что проверять + эталонное фото (для ИИ-проверки)
  questions: 'Вопросы',             // банк вопросов викторины (создаётся setupQuiz)
  disputes:  'Обжалования',         // жалобы на вопросы викторины (создаётся setupQuiz)
  duels:     'Дуэли',               // история матчей (создаётся автоматически)
  ratings:   'Рейтинг',             // Elo дуэли + агрегаты викторины (создаётся автоматически)
  quizTries: 'Викторина',           // сырые попытки викторины (создаётся автоматически)
  characters: 'Персонажи',          // персонаж сотрудника (создаётся автоматически)
  itemCatalog: 'Предметы',          // каталог предметов и эффектов (создаётся автоматически)
  inventory: 'Инвентарь',           // полученные предметы и экипировка (создаётся автоматически)
};

// В каком столбце листа лежит ID записи (считаем с 1: A=1, B=2 ...).
// Совпадает с последним столбцом «ID записи» в каждом журнале.
const ID_COLUMN = {
  transfer: 9, // Переносы: I
  writeoff: 9, // Списания: I
  photo:    7, // Фото уборки: G
  inventory: 16, // Подсчёт: P
  processing: 11, // Акты переработки: K
  processingClose: 16, // Акты переработки: P «ID закрытия» (закрытие акта, где выход записали позже)
};

const DIRECTIONS = ['Кухня → Бар', 'Бар → Кухня'];
const UNITS = ['г', 'мл', 'шт', 'кг', 'л'];
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;   // предел на одно фото уборки
const MAX_TTK_PHOTO_BYTES = 4 * 1024 * 1024; // предел на фото ТТК, которое отдаём на телефон
const MAX_RECORDS_PER_REQUEST = 50;
const PIN_FAIL_LIMIT = 8;          // сколько неверных PIN подряд разрешено...
const PIN_FAIL_WINDOW_SEC = 15 * 60; // ...за 15 минут, потом имя блокируется на это время


/* =====================================================================
 *  ТОЧКИ ВХОДА
 * ===================================================================== */

/** GET-запросы: чтение. Пример: <URL>?action=config */
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || '';
    if (action === 'config') return json_(getConfig_());
    if (action === 'ttkPhoto') return json_(getTtkPhoto_(e.parameter.id));
    if (action === 'openActs') return json_({ ok: true, acts: openActs_(ss_()) });
    if (action === 'questions') return json_(getQuestions_());
    if (action === 'duelState') return json_(duelState_(e.parameter.duelId, e.parameter.employee));
    if (action === 'duelCancel') return json_(duelCancel_(e.parameter.duelId, e.parameter.employee));
    if (action === 'duelRating') return json_(duelRating_(e.parameter.employee));
    if (action === 'profile') return json_(getProfile_(e.parameter.employee));
    if (action === 'ping') return json_({ ok: true, time: new Date().toISOString() });
    return json_({ ok: false, error: 'Неизвестное действие: ' + action });
  } catch (err) {
    log_('ОШИБКА GET', String(err && err.stack || err));
    return json_({ ok: false, error: 'Ошибка сервера: ' + err });
  }
}

/** POST-запросы: запись. Тело запроса — JSON строкой. */
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'login') return json_(login_(body.name, body.pin));
    if (body.action === 'submit') return json_(submit_(body.records));
    if (body.action === 'dispute') return json_(dispute_(body));
    if (body.action === 'duelCreate') return json_(duelCreate_(body));
    if (body.action === 'duelJoin') return json_(duelJoin_(body));
    if (body.action === 'duelAnswer') return json_(duelAnswer_(body));
    if (body.action === 'quizResult') return json_(quizResult_(body));
    return json_({ ok: false, error: 'Неизвестное действие: ' + body.action });
  } catch (err) {
    log_('ОШИБКА POST', String(err && err.stack || err));
    return json_({ ok: false, error: 'Ошибка сервера: ' + err });
  }
}


/* =====================================================================
 *  ЧТЕНИЕ: справочник, списки, сотрудники (без PIN!), ТТК
 * ===================================================================== */

function getConfig_() {
  const ss = ss_();

  // Сотрудники: отдаём только имена активных. PIN никогда не уходит на телефон.
  const employees = rows_(ss, SHEETS.staff)
    .filter(r => str_(r[0]) && r[3] === true)
    .map(r => str_(r[0]));

  // Справочник позиций: только отмеченные «Показывать».
  const items = rows_(ss, SHEETS.items)
    .filter(r => str_(r[0]) && r[3] === true)
    .map(r => ({ name: str_(r[0]), unit: str_(r[1]) || 'шт', category: str_(r[2]) || 'Прочее' }));

  // Списки: A — причины списания, B — зоны уборки,
  //         C2 — название активной инвентаризации, D — места инвентаризации,
  //         E — места Gift-shop (Кабинет, Витрина), F2 — оформление (обычное / зимнее / авто).
  const lists = rows_(ss, SHEETS.lists);
  const reasons = lists.map(r => str_(r[0])).filter(Boolean);
  const zones = lists.map(r => str_(r[1])).filter(Boolean);
  const inventory = {
    active: lists.length ? str_(lists[0][2]) : '',
    locations: lists.map(r => str_(r[3])).filter(Boolean),
    giftLocations: giftLocations_(lists),
    items: inventoryItems_(ss),
  };

  // ТТК: только отмеченные «Показывать».
  const ttk = rows_(ss, SHEETS.ttk)
    .filter(r => str_(r[0]) && r[8] === true)
    .map(r => ({
      name: str_(r[0]),
      category: str_(r[1]) || 'Без категории',
      glass: str_(r[2]),
      method: str_(r[3]),
      ingredients: str_(r[4]).split('\n').map(s => s.trim()).filter(Boolean),
      garnish: str_(r[5]),
      notes: str_(r[6]),
      photoId: driveId_(r[7]),
    }));

  const acts = actTemplates_(ss);

  // Оформление приложения: «Списки»!F2 — обычное / зимнее / авто (пусто = авто)
  const theme = lists.length ? str_(lists[0][5]) : '';
  return {
    theme, ok: true, employees, items, reasons, zones, ttk, inventory, acts, directions: DIRECTIONS, units: UNITS };
}

/** Места Gift-shop из «Списки»!E (по умолчанию Кабинет и Витрина). */
function giftLocations_(lists) {
  const locs = lists.map(r => str_(r[4])).filter(Boolean);
  return locs.length ? locs : ['Кабинет', 'Витрина'];
}

/**
 * Шаблоны актов переработки.
 * Лист: Акт | Тип | Роль (Сырьё/Результат) | Позиция | Ед. | Кол-во по рецепту | Ключевое | Показывать |
 *       Постоянное (не пересчитывать) | Чистить (вес до и после)
 * Несколько строк с одним названием акта = один акт.
 *   простой:     одно сырьё + один результат, бармен вводит «было» и «стало»
 *   по рецепту:  несколько видов сырья; бармен вводит только ключевое,
 *                остальное приложение пересчитывает по пропорции рецепта
 */
function actTemplates_(ss) {
  const map = {};
  const order = [];
  rows_(ss, SHEETS.actTpl).forEach(r => {
    const name = str_(r[0]);
    if (!name || !str_(r[3])) return;
    if (!map[name]) { map[name] = { name, type: str_(r[1]) || 'простой', inputs: [], output: null, show: false }; order.push(name); }
    const a = map[name];
    if (r[7] === true) a.show = true;
    const line = { item: str_(r[3]), unit: str_(r[4]) || 'г', qty: num_(r[5]) };
    if (str_(r[2]) === 'Результат') { if (!a.output) a.output = line; }
    else a.inputs.push(Object.assign(line, { key: r[6] === true, fixed: r[8] === true, clean: r[9] === true }));
  });
  return order.map(n => map[n]).filter(a => a.show && a.output && a.inputs.length).map(a => {
    if (!a.inputs.some(i => i.key)) a.inputs[0].key = true; // ключевое по умолчанию — первое сырьё
    delete a.show;
    return a;
  });
}

/**
 * Опись для инвентаризации.
 * Столбцы: Категория | Вид | Позиция | Ед. учёта | Объём тары | Вес пустой тары, г | Плотность | Показывать
 */
function inventoryItems_(ss) {
  return rows_(ss, SHEETS.invList)
    .filter(r => str_(r[2]) && r[7] === true)
    .map(r => ({
      category: str_(r[0]) || 'Прочее',
      kind: str_(r[1]),
      name: str_(r[2]),
      unit: ['мл', 'шт', 'г'].indexOf(str_(r[3])) >= 0 ? str_(r[3]) : 'мл',
      volume: num_(r[4]),
      tare: num_(r[5]),
      density: num_(r[6]),
    }));
}

/**
 * Отдаёт фото ТТК в виде base64.
 * Важно для безопасности: отдаём ТОЛЬКО файлы, которые указаны в листе ТТК.
 * Иначе любой, зная адрес скрипта, мог бы скачать любой файл с вашего Диска.
 */
function getTtkPhoto_(id) {
  id = str_(id);
  if (!id) return { ok: false, error: 'Нет id' };
  const allowed = rows_(ss_(), SHEETS.ttk).map(r => driveId_(r[7])).filter(Boolean);
  if (allowed.indexOf(id) === -1) return { ok: false, error: 'Фото не найдено в ТТК' };

  const blob = DriveApp.getFileById(id).getBlob();
  const bytes = blob.getBytes();
  if (bytes.length > MAX_TTK_PHOTO_BYTES) {
    return { ok: false, error: 'Фото больше 4 МБ — загрузите уменьшенную копию' };
  }
  return { ok: true, id, mime: blob.getContentType(), data: Utilities.base64Encode(bytes) };
}


/* =====================================================================
 *  ВХОД ПО PIN
 * ===================================================================== */

function login_(name, pin) {
  const check = checkPin_(name, pin);
  if (!check.ok) return check;
  return { ok: true, name: check.name, role: check.role };
}

/**
 * Проверка имени и PIN. Используется и при входе, и для КАЖДОЙ записи из очереди
 * (на одном телефоне могут работать разные бармены).
 * После 8 неверных попыток имя блокируется на 15 минут — от подбора PIN.
 */
function checkPin_(name, pin, staffCache) {
  name = str_(name);
  pin = str_(pin);
  if (!name || !pin) return { ok: false, error: 'Нужны имя и PIN' };

  const cache = CacheService.getScriptCache();
  const failKey = 'pinfail:' + name;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= PIN_FAIL_LIMIT) {
    return { ok: false, error: 'Слишком много неверных PIN. Подождите 15 минут.', code: 'locked' };
  }

  const staff = staffCache || rows_(ss_(), SHEETS.staff);
  const row = staff.find(r => str_(r[0]) === name);
  if (!row || row[3] !== true) return { ok: false, error: 'Сотрудник не найден или отключён', code: 'auth' };
  if (str_(row[1]) !== pin) {
    cache.put(failKey, String(fails + 1), PIN_FAIL_WINDOW_SEC);
    return { ok: false, error: 'Неверный PIN', code: 'auth' };
  }
  return { ok: true, name, role: str_(row[2]) || 'бармен' };
}


/* =====================================================================
 *  ЗАПИСЬ: очередь с телефона
 * ===================================================================== */

/**
 * records — массив записей. Каждая запись:
 *   { id, type: 'transfer'|'writeoff'|'photo', name, pin, createdAt, ...поля }
 * Ответ: { ok: true, results: [{ id, status: 'saved'|'duplicate'|'error', error }] }
 */
function submit_(records) {
  if (!Array.isArray(records) || records.length === 0) return { ok: false, error: 'Пустой запрос' };
  if (records.length > MAX_RECORDS_PER_REQUEST) return { ok: false, error: 'Слишком много записей за раз' };

  // Блокировка: пока этот запрос пишет, другие ждут (до 30 сек).
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'Таблица занята, повторите позже' };

  try {
    const ss = ss_();
    const staff = rows_(ss, SHEETS.staff); // читаем один раз на весь запрос
    const authMemo = {}; // одна проверка PIN на человека за запрос, а не на каждую строку
    const results = records.map(rec => {
      try {
        return saveOne_(ss, staff, authMemo, rec);
      } catch (err) {
        log_('ОШИБКА ЗАПИСИ', (rec && rec.id) + ': ' + err);
        return { id: rec && rec.id, status: 'error', error: 'Ошибка сервера: ' + err, retry: true };
      }
    });
    SpreadsheetApp.flush(); // гарантируем, что всё записано, до ответа телефону
    return { ok: true, results };
  } finally {
    lock.releaseLock();
  }
}

function saveOne_(ss, staff, authMemo, rec) {
  const id = str_(rec && rec.id);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return { id, status: 'error', error: 'Некорректный ID записи' };

  const authKey = str_(rec.name) + '\n' + str_(rec.pin);
  const auth = authMemo[authKey] || (authMemo[authKey] = checkPin_(rec.name, rec.pin, staff));
  if (!auth.ok) return { id, status: 'error', error: auth.error, code: auth.code };

  const type = rec.type;
  if (!ID_COLUMN[type]) return { id, status: 'error', error: 'Неизвестный тип записи: ' + type };

  // Админ: только переносы, списания и инвентаризация Gift-shop
  if (/^админ/i.test(auth.role)) {
    if (['transfer', 'writeoff', 'inventory'].indexOf(type) === -1) {
      return { id, status: 'error', error: 'Админу этот раздел недоступен' };
    }
    if (type === 'inventory') {
      const giftLocs = giftLocations_(rows_(ss, SHEETS.lists));
      const cat = str_(rec.category);
      if (giftLocs.indexOf(str_(rec.location)) === -1 || (cat !== 'Gift-shop' && cat !== 'Нет в описи')) {
        return { id, status: 'error', error: 'Админ считает только Gift-shop (' + giftLocs.join(', ') + ')' };
      }
    }
  }

  const sheetName = {
    transfer: SHEETS.transfers, writeoff: SHEETS.writeoffs,
    photo: SHEETS.photos, inventory: SHEETS.invCounts, processing: SHEETS.acts, processingClose: SHEETS.acts,
  }[type];
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { id, status: 'error', error: 'Нет листа «' + sheetName + '»' };

  // Защита от дублей: такой ID уже записан?
  if (idExists_(sheet, ID_COLUMN[type], id)) return { id, status: 'duplicate' };

  const created = parseDate_(rec.createdAt);
  const received = new Date();
  const comment = text_(rec.comment, 500);

  if (type === 'processingClose') return closeProcessing_(ss, sheet, auth, rec, id, received);

  if (type === 'transfer' || type === 'writeoff') {
    const item = text_(rec.item, 120);
    const qty = Number(rec.qty);
    const unit = str_(rec.unit);
    if (!item) return { id, status: 'error', error: 'Не указана позиция' };
    if (!(qty > 0 && qty < 1000000)) return { id, status: 'error', error: 'Некорректное количество' };
    if (UNITS.indexOf(unit) === -1) return { id, status: 'error', error: 'Некорректная единица' };

    if (type === 'transfer') {
      const dir = str_(rec.direction);
      if (DIRECTIONS.indexOf(dir) === -1) return { id, status: 'error', error: 'Некорректное направление' };
      // Дата | Сотрудник | Направление | Позиция | Кол-во | Ед. | Комментарий | Получено | ID
      addRow_(sheet, [created, auth.name, dir, item, qty, unit, comment, received, "'" + id]);
    } else {
      const reason = text_(rec.reason, 120);
      if (!reason) return { id, status: 'error', error: 'Не указана причина списания' };
      // Дата | Сотрудник | Позиция | Кол-во | Ед. | Причина | Комментарий | Получено | ID
      addRow_(sheet, [created, auth.name, item, qty, unit, reason, comment, received, "'" + id]);
    }
    return { id, status: 'saved' };
  }

  if (type === 'inventory') return saveInventory_(ss, sheet, auth, rec, id, created, received, comment);
  if (type === 'processing') return saveProcessing_(ss, sheet, auth, rec, id, created, received, comment);

  // type === 'photo'
  const zone = text_(rec.zone, 120);
  if (!zone) return { id, status: 'error', error: 'Не указана зона' };
  const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(String(rec.image || ''));
  if (!m) return { id, status: 'error', error: 'Нет фото или неверный формат' };
  const bytes = Utilities.base64Decode(m[3]);
  if (bytes.length > MAX_PHOTO_BYTES) return { id, status: 'error', error: 'Фото слишком большое' };

  const folder = photoFolderFor_(created);
  const ext = m[2] === 'png' ? 'png' : m[2] === 'webp' ? 'webp' : 'jpg';
  const fileName = Utilities.formatDate(created, 'Europe/Moscow', 'yyyy-MM-dd_HH-mm') +
    '_' + auth.name + '_' + str_(rec.zone).replace(/[\\/:*?"<>|']/g, '') + '_' + id.slice(0, 6) + '.' + ext;
  const file = folder.createFile(Utilities.newBlob(bytes, m[1], fileName));

  // Дата | Сотрудник | Зона | Фото | Комментарий | Получено | ID |
  // Проверка ИИ | Что не так | Замечание менеджера | Фото удалено | ID файла
  // (H–K заполняет проверка ИИ и автоудаление, L — служебный: какой файл на Диске)
  const photoRow = addRow_(sheet, [created, auth.name, zone, 'Открыть фото', comment, received, "'" + id,
    '', '', '', '', "'" + file.getId()]);
  // Делаем текст «Открыть фото» ссылкой на файл (без формулы — так не зависит от языка таблицы)
  sheet.getRange(photoRow, 4).setRichTextValue(
    SpreadsheetApp.newRichTextValue().setText('Открыть фото').setLinkUrl(file.getUrl()).build());
  return { id, status: 'saved', fileId: file.getId() };
}

/**
 * ИНВЕНТАРИЗАЦИЯ.
 * Бармен присылает: позицию, место, сколько полных бутылок и остаток в открытой
 * (либо в мл «на глаз»/по мерке, либо весом на весах в граммах).
 *
 * Итого считается здесь, на сервере, по данным из Описи:
 *   мл:  полные × объём + остаток
 *        остаток по весу = (вес − вес пустой тары) / плотность
 *   г:   то же, но плотность не нужна (вес и есть ответ)
 *   шт:  просто количество
 *
 * Если тот же сотрудник пересчитал ту же позицию на том же месте —
 * старая строка помечается «Актуально = FALSE», в итог идёт новая.
 */
function saveInventory_(ss, sheet, auth, rec, id, created, received, comment) {
  const lists = rows_(ss, SHEETS.lists);
  const active = lists.length ? str_(lists[0][2]) : '';
  if (!active) return { id, status: 'error', error: 'Сейчас нет активной инвентаризации' };
  if (str_(rec.session) !== active) {
    return { id, status: 'error', error: 'Инвентаризация «' + rec.session + '» уже закрыта' };
  }
  const location = text_(rec.location, 80);
  if (!location) return { id, status: 'error', error: 'Не указано место' };

  // Позиция «Нет в описи»: бармен сам вписал название и единицу, вводит общее количество
  const CUSTOM = 'Нет в описи';
  let item;
  if (str_(rec.category) === CUSTOM) {
    const name = str_(rec.item).slice(0, 120);
    const unit = str_(rec.unit);
    if (!name) return { id, status: 'error', error: 'Не указано название позиции' };
    if (['мл', 'г', 'шт'].indexOf(unit) === -1) return { id, status: 'error', error: 'Некорректная единица' };
    item = { category: CUSTOM, kind: '', name, unit, volume: 0, tare: 0, density: 0 };
  } else {
    item = inventoryItems_(ss).find(it => it.category === str_(rec.category) && it.name === str_(rec.item));
    if (!item) return { id, status: 'error', error: 'Позиции нет в описи: ' + rec.item };
  }

  const full = rec.full === '' || rec.full === null || rec.full === undefined ? 0 : Number(rec.full);
  const openMl = rec.openMl === '' || rec.openMl === null || rec.openMl === undefined ? null : Number(rec.openMl);
  const weight = rec.weight === '' || rec.weight === null || rec.weight === undefined ? null : Number(rec.weight);
  if (!(full >= 0 && full < 100000)) return { id, status: 'error', error: 'Некорректное число полных' };
  if (openMl !== null && !(openMl >= 0 && openMl < 100000)) return { id, status: 'error', error: 'Некорректный остаток' };
  if (weight !== null && !(weight >= 0 && weight < 100000)) return { id, status: 'error', error: 'Некорректный вес' };

  let open = 0;
  if (item.unit !== 'шт') {
    if (openMl !== null) {
      open = openMl;
    } else if (weight !== null) {
      if (!item.tare) return { id, status: 'error', error: 'В описи нет веса пустой тары для ' + item.name };
      const density = item.unit === 'г' ? 1 : item.density;
      if (!density) return { id, status: 'error', error: 'В описи нет плотности для ' + item.name };
      open = Math.max(0, (weight - item.tare) / density);
    }
  }
  if (full > 0 && item.unit !== 'шт' && !item.volume) {
    return { id, status: 'error', error: 'В описи нет объёма тары для ' + item.name };
  }
  const total = Math.round((item.unit === 'шт' ? full : full * item.volume + open) * 10) / 10;

  // Пересчёт: гасим прошлые строки этого сотрудника по этой позиции на этом месте
  const last = sheet.getLastRow();
  if (last >= 2) {
    const data = sheet.getRange(2, 1, last - 1, 13).getValues();
    const loc = str_(rec.location).slice(0, 80);
    data.forEach((r, i) => {
      if (str_(r[1]) === active && str_(r[2]) === auth.name && str_(r[3]) === loc &&
          str_(r[4]) === item.category && str_(r[6]) === item.name && r[12] === true) {
        sheet.getRange(i + 2, 13).setValue(false);
      }
    });
  }

  // Позиция не из Описи: помечаем комментарием (строка в таблице подсвечивается красным условным форматированием)
  const plainComment = comment ? comment.replace(/^'/, '') : '';
  const invComment = item.category === CUSTOM
    ? "'⚠ Нет в первичной описи" + (plainComment ? '. ' + plainComment : '')
    : comment;
  // Дата | Инвентаризация | Сотрудник | Место | Категория | Вид | Позиция | Полных | Открытая, мл |
  // Открытая, вес г | Итого | Ед. | Актуально | Комментарий | Получено | ID
  addRow_(sheet, [created, "'" + active, auth.name, location, "'" + item.category, item.kind ? "'" + item.kind : '',
    "'" + item.name, full, openMl === null ? '' : openMl, weight === null ? '' : weight,
    total, item.unit, true, invComment, received, "'" + id]);
  return { id, status: 'saved', total };
}

/**
 * АКТ ПЕРЕРАБОТКИ.
 * Приходит: act (название шаблона) и lines: [{ role: 'Сырьё'|'Результат', item, unit, qty }].
 * Пишем по строке на каждую позицию: так в «Своде переработки» легко сложить расход и приход.
 * Позиции и единицы обязаны совпадать с шаблоном — бармен не может «придумать» сырьё.
 */
function saveProcessing_(ss, sheet, auth, rec, id, created, received, comment) {
  const tpl = actTemplates_(ss).find(a => a.name === str_(rec.act));
  if (!tpl) return { id, status: 'error', error: 'Нет такого акта: ' + rec.act };
  const lines = Array.isArray(rec.lines) ? rec.lines : [];
  const allowed = tpl.inputs.map(i => 'Сырьё|' + i.item + '|' + i.unit).concat(['Результат|' + tpl.output.item + '|' + tpl.output.unit]);
  let inQty = 0, outQty = 0, keyQty = 0;
  for (const l of lines) {
    const k = str_(l.role) + '|' + str_(l.item) + '|' + str_(l.unit);
    if (allowed.indexOf(k) === -1) return { id, status: 'error', error: 'Позиция не из шаблона: ' + l.item };
    const q = Number(l.qty);
    if (!(q >= 0 && q < 1000000)) return { id, status: 'error', error: 'Некорректное количество: ' + l.item };
    const tplLine = tpl.inputs.find(i => i.item === str_(l.item));
    if (l.role === 'Сырьё' && tplLine && tplLine.clean) {
      const c = Number(l.clean);
      if (!(c > 0)) return { id, status: 'error', error: 'Не указан чистый вес: ' + l.item };
      if (c > q) return { id, status: 'error', error: 'Чистый вес больше грязного: ' + l.item };
    }
    if (l.role === 'Результат') outQty += q; else inQty += q;
    const keyLine = tpl.inputs.find(i => i.key);
    if (l.role === 'Сырьё' && keyLine && l.item === keyLine.item) keyQty = q;
  }
  // pending = «выход запишем позже»: кордиал ещё варится, фреш ещё жмут
  const pending = rec.pending === true;
  if (!(inQty > 0)) return { id, status: 'error', error: 'Не указано сырьё' };
  if (!pending && !(outQty > 0)) return { id, status: 'error', error: 'Не указан результат («стало»)' };
  if (pending) outQty = 0;

  // Выход в % считаем для простых актов (было → стало): 100 г мяты → 70 г листьев = 70%
  const yieldPct = tpl.type === 'простой' && keyQty > 0 && outQty > 0 ? Math.round(outQty / keyQty * 1000) / 10 : '';
  // Сырьё с очисткой: в «Кол-во» пишем грязный вес (он списывается),
  // в «Чистый вес» — после чистки, в «Выход, %» — процент чистого от грязного.
  lines.filter(l => Number(l.qty) > 0 || l.role === 'Результат').forEach((l, i) => {
    const c = Number(l.clean);
    const hasClean = l.role === 'Сырьё' && c > 0;
    const pct = l.role === 'Результат' ? yieldPct : (hasClean ? Math.round(c / Number(l.qty) * 1000) / 10 : '');
    const isOut = l.role === 'Результат';
    // M Статус | N Закрыл | O Когда закрыт — только у строки «Результат»
    const status = !isOut ? ['', '', ''] : pending ? ['⏳ В работе', '', ''] : ['✅ Закрыт', auth.name, received];
    addRow_(sheet, [created, auth.name, "'" + tpl.name, l.role, "'" + str_(l.item), isOut && pending ? '' : Number(l.qty),
      str_(l.unit), pct, i === 0 ? comment : '', received, "'" + id, hasClean ? c : ''].concat(status));
  });
  return { id, status: 'saved' };
}

/**
 * Закрытие акта, где выход записали позже. Закрыть может ЛЮБОЙ бармен.
 * rec: { actId, qty, comment }
 */
function closeProcessing_(ss, sheet, auth, rec, id, received) {
  const actId = str_(rec.actId);
  const qty = Number(rec.qty);
  if (!(qty > 0 && qty < 1000000)) return { id, status: 'error', error: 'Некорректный выход' };
  const last = sheet.getLastRow();
  const data = last < 2 ? [] : sheet.getRange(2, 1, last - 1, 16).getValues();
  const idx = data.findIndex(r => str_(r[10]) === actId && str_(r[3]) === 'Результат');
  // Акт ещё не дошёл до таблицы (например, его запись стоит в очереди на другом телефоне) — повторим позже
  if (idx === -1) return { id, status: 'error', error: 'Акт пока не найден в таблице', retry: true };
  const r = data[idx];
  if (str_(r[12]).indexOf('✅') === 0) {
    return { id, status: 'error', error: 'Акт уже закрыл(а) ' + str_(r[13]) + ': ' + r[5] + ' ' + str_(r[6]) };
  }
  // Выход в % — для простых актов: стало / было
  const tpl = actTemplates_(ss).find(a => a.name === str_(r[2]));
  let pct = '';
  if (tpl && tpl.type === 'простой') {
    const raw = data.find(x => str_(x[10]) === actId && str_(x[3]) === 'Сырьё');
    if (raw && Number(raw[5]) > 0) pct = Math.round(qty / Number(raw[5]) * 1000) / 10;
  }
  const row = idx + 2;
  const note = str_(rec.comment).slice(0, 300);
  const oldComment = str_(r[8]);
  sheet.getRange(row, 6).setValue(qty);
  sheet.getRange(row, 8).setValue(pct);
  if (note) sheet.getRange(row, 9).setValue("'" + (oldComment ? oldComment + ' | ' : '') + 'При закрытии: ' + note);
  sheet.getRange(row, 13, 1, 4).setValues([['✅ Закрыт', auth.name, received, "'" + id]]);
  return { id, status: 'saved' };
}

/**
 * Акты «в работе» — для экрана «Переработка».
 * Для каждого считаем ожидаемый выход: по рецепту (для актов по рецепту)
 * или по среднему проценту прошлых актов (для простых).
 */
function openActs_(ss) {
  const sheet = ss.getSheetByName(SHEETS.acts);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 16).getValues();
  const tpls = actTemplates_(ss);
  const out = [];
  data.forEach(r => {
    if (str_(r[3]) !== 'Результат' || str_(r[12]) !== '⏳ В работе') return;
    const actId = str_(r[10]);
    const raws = data.filter(x => str_(x[10]) === actId && str_(x[3]) === 'Сырьё')
      .map(x => ({ item: str_(x[4]), qty: num_(x[5]), unit: str_(x[6]), clean: num_(x[11]) }));
    const tpl = tpls.find(a => a.name === str_(r[2]));
    let expected = null, basis = '';
    if (tpl && tpl.type === 'по рецепту') {
      const key = tpl.inputs.find(i => i.key) || tpl.inputs[0];
      const kr = raws.find(x => x.item === key.item);
      const kq = kr ? (kr.clean || kr.qty) : 0;
      if (key.qty > 0 && tpl.output.qty > 0 && kq > 0) { expected = tpl.output.qty * kq / key.qty; basis = 'по рецепту'; }
    } else if (raws[0] && raws[0].qty > 0) {
      // средний выход по последним 10 закрытым актам этого шаблона
      const pcts = data.filter(x => str_(x[2]) === str_(r[2]) && str_(x[3]) === 'Результат' && Number(x[7]) > 0)
        .slice(-10).map(x => Number(x[7]));
      if (pcts.length) {
        const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
        expected = raws[0].qty * avg / 100;
        basis = 'средний выход прошлых актов ' + Math.round(avg) + '%';
      }
    }
    const date = r[0] instanceof Date ? r[0] : new Date(r[0]);
    out.push({ id: actId, act: str_(r[2]), name: str_(r[1]), date: isNaN(date) ? '' : date.toISOString(),
      item: str_(r[4]), unit: str_(r[6]), inputs: raws, comment: str_(r[8]),
      expected: expected ? Math.round(expected * 10) / 10 : null, basis });
  });
  return out;
}

/**
 * Дописать строку сразу после последней ЗАПОЛНЕННОЙ строки (смотрим по столбцу A «Дата»).
 * Обычный appendRow считает «заполненными» строки с пустыми галочками или форматированием
 * и дописывает в самый низ листа — так уже было с листом «Подсчёт».
 * Возвращает номер строки, в которую записали.
 */
function addRow_(sheet, values) {
  const max = sheet.getMaxRows();
  const colA = sheet.getRange(1, 1, max, 1).getValues();
  let last = 1; // строка заголовка
  for (let i = colA.length - 1; i >= 1; i--) {
    if (colA[i][0] !== '' && colA[i][0] !== null) { last = i + 1; break; }
  }
  const row = last + 1;
  if (row > max) sheet.insertRowsAfter(max, 50);
  sheet.getRange(row, 1, 1, values.length).setValues([values]);
  return row;
}

/** Есть ли уже такой ID в столбце? Ищем точное совпадение. */
function idExists_(sheet, col, id) {
  const last = sheet.getLastRow();
  if (last < 2) return false;
  return !!sheet.getRange(2, col, last - 1, 1)
    .createTextFinder(id).matchEntireCell(true).findNext();
}


/* =====================================================================
 *  ПАПКИ ДЛЯ ФОТО УБОРКИ
 *  Главная папка «Бар — фото уборки», внутри — по месяцам: 2026-11, 2026-12 ...
 * ===================================================================== */

function photoFolderFor_(date) {
  const props = PropertiesService.getScriptProperties();
  let rootId = props.getProperty('PHOTO_FOLDER_ID');
  let root;
  try { root = rootId && DriveApp.getFolderById(rootId); } catch (e) { root = null; }
  if (!root) {
    root = DriveApp.createFolder('Бар — фото уборки');
    props.setProperty('PHOTO_FOLDER_ID', root.getId());
  }
  const month = Utilities.formatDate(date, 'Europe/Moscow', 'yyyy-MM');
  const it = root.getFoldersByName(month);
  return it.hasNext() ? it.next() : root.createFolder(month);
}


/* =====================================================================
 *  РАЗОВАЯ НАСТРОЙКА — запустить вручную один раз из редактора
 *  (выбрать функцию setup в списке сверху и нажать «Выполнить»).
 *  Google попросит разрешения на доступ к Таблицам и Диску — это нормально.
 * ===================================================================== */

function setup() {
  const ss = ss_();
  // «Эталоны уборки» и листы викторины к обязательным не относятся:
  // эталоны необязательны, а листы викторины создаёт отдельная функция setupQuiz().
  // Листы дуэли и рейтинга создаются сами при первой дуэли (ensureDuelSheets_).
  const auto = ['refs', 'questions', 'disputes', 'duels', 'ratings', 'quizTries',
    'characters', 'itemCatalog', 'inventory'];
  const missing = Object.keys(SHEETS).filter(k => auto.indexOf(k) === -1)
    .map(k => SHEETS[k]).filter(n => !ss.getSheetByName(n));
  if (missing.length) throw new Error('В таблице нет листов: ' + missing.join(', '));
  const folder = photoFolderFor_(new Date());
  log_('Настройка', 'OK. Папка для фото: ' + folder.getUrl());
  Logger.log('Готово. Листы на месте. Папка для фото: ' + folder.getUrl());
}


/* =====================================================================
 *  ВИКТОРИНА — банк вопросов и обжалования
 * =====================================================================
 *
 *  Лист «Вопросы» (создаётся setupQuiz):
 *    id | категория | вопрос | A | B | C | D | правильный | пояснение |
 *    источник | статус | дата_добавления
 *    статус: «в игре» — показываем в приложении,
 *            «карантин» — после жалобы, больше не выдаём,
 *            «устарел» — вопрос устарел (ставит владелец).
 *
 *  Лист «Обжалования» (создаётся setupQuiz):
 *    дата | сотрудник | id_вопроса | вопрос | ответ_игрока | комментарий |
 *    статус | решение
 *    статус: «новое» / «разобрано» (решение пишет владелец).
 *
 *  В приложение уходят ТОЛЬКО вопросы «в игре» (?action=questions).
 *  Жалоба ({action:'dispute'}) пишет строку в «Обжалования» и уводит вопрос
 *  в «карантин», чтобы он больше не попадался игрокам.
 *  Банк вопросов правится в content/вопросы.tsv и пересобирается
 *  генератором tools/gen-questions.mjs → этот проект получает «Вопросы.gs».
 * ===================================================================== */

const QUIZ_COLUMNS = 12;   // A..L листа «Вопросы»
const DISPUTE_COLUMNS = 8; // A..H листа «Обжалования»
const QUIZ_HEADERS = ['id', 'категория', 'вопрос', 'A', 'B', 'C', 'D', 'правильный',
  'пояснение', 'источник', 'статус', 'дата_добавления'];
const DISPUTE_HEADERS = ['дата', 'сотрудник', 'id_вопроса', 'вопрос', 'ответ_игрока',
  'комментарий', 'статус', 'решение'];

/**
 * Разово: создаёт листы «Вопросы» и «Обжалования», пишет шапки и заливает
 * банк вопросов из «Вопросы.gs». Повторный запуск НИЧЕГО не дублирует:
 * вопросы добавляются только в пустой лист, шапки — только в пустые.
 */
function setupQuiz() {
  const ss = ss_();
  const created = [];
  let qs = ss.getSheetByName(SHEETS.questions);
  if (!qs) { qs = ss.insertSheet(SHEETS.questions); created.push(SHEETS.questions); }
  let ds = ss.getSheetByName(SHEETS.disputes);
  if (!ds) { ds = ss.insertSheet(SHEETS.disputes); created.push(SHEETS.disputes); }

  if (!str_(qs.getRange(1, 1).getValue())) {
    qs.getRange(1, 1, 1, QUIZ_COLUMNS).setValues([QUIZ_HEADERS]).setFontWeight('bold');
    qs.setFrozenRows(1);
  }
  if (!str_(ds.getRange(1, 1).getValue())) {
    ds.getRange(1, 1, 1, DISPUTE_COLUMNS).setValues([DISPUTE_HEADERS]).setFontWeight('bold');
    ds.setFrozenRows(1);
  }

  let added = 0;
  if (qs.getLastRow() < 2) {
    const now = new Date();
    // Все текстовые ячейки пишем через text_ (апостроф в начале): иначе Таблицы
    // разбирают ответы вида «2:1:1» как время, а «1860» — как число.
    const rows = QUIZ_QUESTIONS.map(q => [
      text_(q.id, 40), text_(q['категория'], 80), text_(q['вопрос'], 1000),
      text_(q.A, 300), text_(q.B, 300), text_(q.C, 300), text_(q.D, 300),
      str_(q['правильный']).toUpperCase(), text_(q['пояснение'], 1500), text_(q['источник'], 300),
      'в игре', now,
    ]);
    if (rows.length) {
      qs.getRange(2, 1, rows.length, QUIZ_COLUMNS).setValues(rows);
      added = rows.length;
    }
    // Читаемость листа: узкие служебные колонки, широкие текстовые
    qs.setColumnWidth(1, 70);
    qs.setColumnWidth(3, 460);
    qs.setColumnWidth(9, 460);
    qs.setColumnWidth(10, 300);
    qs.getRange('C:C').setWrap(true);
    qs.getRange('I:J').setWrap(true);
    ds.setColumnWidth(4, 460);
    ds.setColumnWidth(6, 300);
    ds.getRange('D:F').setWrap(true);
  }
  SpreadsheetApp.flush();

  const total = Math.max(0, qs.getLastRow() - 1);
  const msg = 'Листы: ' + (created.length ? 'созданы ' + created.join(', ') : 'уже были') +
    '. Вопросов в листе «' + SHEETS.questions + '»: ' + total +
    (added ? ' (добавлено ' + added + ')' : ' (лист был не пуст — банк не трогал)') + '.';
  log_('Викторина', 'setupQuiz: ' + msg);
  Logger.log('Готово. ' + msg);
  return msg;
}

/**
 * GET ?action=questions — вопросы «в игре» для приложения.
 * version меняется при любой правке статуса/правильного ответа:
 * по нему телефон понимает, что кэш вопросов устарел.
 */
function getQuestions_() {
  const sh = ss_().getSheetByName(SHEETS.questions);
  if (!sh || sh.getLastRow() < 2) return { ok: true, questions: [], version: 'empty' };

  const data = sh.getRange(2, 1, sh.getLastRow() - 1, QUIZ_COLUMNS).getValues();
  const questions = [];
  let versionSource = '';
  data.forEach(r => {
    const id = str_(r[0]);
    if (!id) return;
    // Пустой статус у строки, добавленной владельцем руками, считаем «в игре»
    const status = str_(r[10]) || 'в игре';
    // В version входит и текст: поправили опечатку или ответ — кэш на телефоне обновится
    versionSource += [id, r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], status].join('|') + ';';
    if (status !== 'в игре') return;

    const q = {
      id: id,
      'категория': str_(r[1]),
      'вопрос': str_(r[2]),
      A: str_(r[3]),
      B: str_(r[4]),
      C: str_(r[5]),
      D: str_(r[6]),
      'правильный': str_(r[7]).toUpperCase(),
      'пояснение': str_(r[8]),
      'источник': str_(r[9]),
    };
    // Битую строку не отдаём: без текста или с непонятной буквой играть нельзя
    if (!q['вопрос'] || !q.A || !q.B || !q.C || !q.D || 'ABCD'.indexOf(q['правильный']) === -1) return;
    questions.push(q);
  });

  return { ok: true, questions: questions, version: 'v' + questions.length + '-' + hash_(versionSource) };
}

/**
 * POST {action:'dispute', id, employee, answer, comment}
 * Пишет жалобу в «Обжалования» и ставит вопросу статус «карантин».
 * Повторная жалоба на тот же вопрос (пока прежняя «новое») вторую строку не создаёт.
 */
function dispute_(body) {
  const id = str_(body && body.id).slice(0, 40);
  if (!id) return { ok: false, error: 'Не указан id вопроса' };
  const employee = text_(body.employee, 80);
  const answer = text_(body.answer, 300);
  const comment = text_(body.comment, 500);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'Таблица занята, повторите позже', code: 'busy' };
  try {
    const ss = ss_();
    const qs = ss.getSheetByName(SHEETS.questions);
    const ds = ss.getSheetByName(SHEETS.disputes);
    if (!qs || !ds) return { ok: false, error: 'Нет листов викторины: запустите setupQuiz() в Apps Script' };

    const qData = qs.getLastRow() < 2 ? [] : qs.getRange(2, 1, qs.getLastRow() - 1, QUIZ_COLUMNS).getValues();
    const idx = qData.findIndex(r => str_(r[0]).replace(/^'/, '') === id);
    if (idx === -1) return { ok: false, error: 'Вопрос не найден: ' + id };

    const dData = ds.getLastRow() < 2 ? [] : ds.getRange(2, 1, ds.getLastRow() - 1, DISPUTE_COLUMNS).getValues();
    // Апостроф в начале ячейки — служебный (текст, а не формула), при чтении его может не быть
    const already = dData.find(r => str_(r[2]).replace(/^'/, '') === id && str_(r[6]) === 'новое');
    if (already) return { ok: true, duplicate: true };

    // Дата | сотрудник | id | вопрос | ответ игрока | комментарий | статус | решение
    addRow_(ds, [new Date(), employee, "'" + id, text_(qData[idx][2], 500), answer, comment, 'новое', '']);
    qs.getRange(idx + 2, 11).setValue('карантин'); // K — статус вопроса
    SpreadsheetApp.flush();
    log_('Викторина', 'Обжалован вопрос ' + id + ' — ушёл в карантин');
    return { ok: true, quarantined: id };
  } finally {
    lock.releaseLock();
  }
}

/** Короткий хеш строки (djb2) — для version в ответе ?action=questions. */
function hash_(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}


/* =====================================================================
 *  ВСПОМОГАТЕЛЬНОЕ
 * ===================================================================== */

function ss_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

/** Все строки листа без заголовка. */
function rows_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function num_(v) { const n = Number(v); return isFinite(n) && v !== '' && v !== null ? n : 0; }

function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }

/**
 * Текст от пользователя: обрезаем длину и ставим апостроф в начало.
 * Апостроф говорит таблице «это просто текст»: «1/2» не станет датой,
 * а «=…» не станет формулой. В ячейке апостроф не виден.
 */
function text_(v, maxLen) {
  const s = str_(v).slice(0, maxLen);
  return s ? "'" + s : '';
}

/** Время создания записи на телефоне. Если странное — берём время сервера. */
function parseDate_(iso) {
  const d = new Date(iso);
  const now = Date.now();
  if (isNaN(d.getTime())) return new Date();
  if (d.getTime() > now + 24 * 3600e3) return new Date();          // из будущего
  if (d.getTime() < now - 60 * 24 * 3600e3) return new Date();     // старше 60 дней
  return d;
}

/** Достаёт ID файла из ссылки Google Диска (или возвращает сам ID). */
function driveId_(v) {
  const s = str_(v);
  if (!s) return '';
  const m = /\/d\/([-\w]{20,})/.exec(s) || /[?&]id=([-\w]{20,})/.exec(s) || /^([-\w]{20,})$/.exec(s);
  return m ? m[1] : '';
}

/** Пишет строку в лист «Лог». Хранит последние ~2000 строк. */
function log_(event, details) {
  try {
    const sh = ss_().getSheetByName(SHEETS.log);
    if (!sh) return;
    sh.appendRow([new Date(), event, String(details).slice(0, 2000)]);
    if (sh.getLastRow() > 2200) sh.deleteRows(2, 200);
  } catch (e) { /* лог не должен ронять основную работу */ }
}



/* =====================================================================
 *  ПРОВЕРКА ФОТО УБОРКИ ИСКУССТВЕННЫМ ИНТЕЛЛЕКТОМ (Gemini)
 *
 *  Как работает:
 *    1. Бармен отправляет фото — оно сразу ложится в таблицу (как раньше).
 *    2. Раз в 10 минут срабатывает checkPhotos: берёт непроверенные фото,
 *       отправляет в Gemini вместе с эталоном зоны и пишет в таблицу:
 *         H «Проверка ИИ»:  ✅ Чисто / ⚠ Замечания / ⚠ Плохое фото
 *         I «Что не так»:   коротко, по-русски
 *    3. Раз в сутки (ночью) срабатывает cleanupPhotos: фото старше 30 дней
 *       уходят в корзину Диска, но ТОЛЬКО если ИИ сказал «✅ Чисто»
 *       и в столбце J «Замечание менеджера» пусто.
 *       Фото с замечаниями хранятся, пока вы сами их не удалите.
 *
 *  Настройка (один раз):
 *    а) Получить ключ: aistudio.google.com → Get API key → Create API key.
 *    б) В редакторе Apps Script: ⚙ Настройки проекта → Свойства скрипта →
 *       Добавить свойство: GEMINI_API_KEY = ваш ключ.
 *    в) Выбрать функцию setupPhotoCheck и нажать «Выполнить».
 *
 *  Эталоны: лист «Эталоны уборки» — Зона | Что проверять | Эталонное фото
 *  (ссылка на фото на Google Диске). Если эталона нет — ИИ проверяет по описанию.
 * ===================================================================== */

const PHOTO_COL = { status: 8, issues: 9, manager: 10, deleted: 11, fileId: 12 }; // H, I, J, K, L
const PHOTO_KEEP_DAYS = 30;            // через сколько дней удалять «чистые» фото
const CHECK_BATCH = 8;                 // сколько фото проверять за один запуск
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash']; // первая рабочая модель из списка

/** Запустить один раз: ставит расписание (проверка каждые 10 минут, чистка каждую ночь). */
function setupPhotoCheck() {
  if (!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')) {
    throw new Error('Сначала добавьте свойство GEMINI_API_KEY: ⚙ Настройки проекта → Свойства скрипта');
  }
  ScriptApp.getProjectTriggers()
    .filter(t => ['checkPhotos', 'cleanupPhotos'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkPhotos').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('cleanupPhotos').timeBased().atHour(5).everyDays(1).inTimezone('Europe/Moscow').create();
  const test = checkPhotos(); // сразу проверяем, что ключ работает
  log_('Проверка фото', 'Включена. ' + test);
  Logger.log('Готово: проверка каждые 10 минут, чистка каждую ночь в 5:00. ' + test);
}

/** Проверяет до CHECK_BATCH новых фото. Вызывается по расписанию. */
function checkPhotos() {
  const ss = ss_();
  const sheet = ss.getSheetByName(SHEETS.photos);
  if (!sheet || sheet.getLastRow() < 2) return 'Нет фото для проверки';
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) return 'Нет ключа GEMINI_API_KEY';

  const refs = photoRefs_(ss);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, PHOTO_COL.fileId).getValues();
  let done = 0;
  for (let i = 0; i < data.length && done < CHECK_BATCH; i++) {
    const r = data[i];
    const fileId = str_(r[PHOTO_COL.fileId - 1]);
    if (!fileId || str_(r[PHOTO_COL.status - 1]) || str_(r[PHOTO_COL.deleted - 1])) continue;
    const row = i + 2;
    let res;
    try {
      res = geminiCheck_(key, str_(r[2]), refs[str_(r[2]).toLowerCase()], DriveApp.getFileById(fileId).getBlob());
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/429|quota|RESOURCE_EXHAUSTED/i.test(msg)) { log_('Проверка фото', 'Лимит Gemini, продолжу позже'); break; }
      res = { status: '❓ Не проверено', issues: msg.slice(0, 200) };
    }
    sheet.getRange(row, PHOTO_COL.status, 1, 2).setValues([[res.status, res.issues ? "'" + res.issues : '']]);
    done++;
  }
  return 'Проверено фото: ' + done;
}

/** Эталоны: { 'бар 1 этаж': { what: 'что проверять', fileId } } */
function photoRefs_(ss) {
  const out = {};
  if (!ss.getSheetByName(SHEETS.refs)) return out;
  rows_(ss, SHEETS.refs).forEach(r => {
    const zone = str_(r[0]);
    if (zone) out[zone.toLowerCase()] = { what: str_(r[1]), fileId: driveId_(r[2]) };
  });
  return out;
}

/** Один запрос к Gemini: эталон (если есть) + проверяемое фото → вердикт. */
function geminiCheck_(key, zone, ref, blob) {
  const parts = [{ text:
    'Ты проверяешь фото уборки бара в джаз-клубе. Зона: «' + zone + '».\n' +
    (ref && ref.what ? 'Что должно быть: ' + ref.what + '\n' : '') +
    (ref && ref.fileId
      ? 'Первое фото — эталон (как выглядит идеально убранная зона). Второе — фото после уборки, его и оцени.\n'
      : 'Оцени фото после уборки.\n') +
    'Ищи: грязную посуду, бутылки и стаканы не на местах, мусор, пятна и лужи, грязные тряпки, ' +
    'неубранные продукты, открытые ёмкости. Не придирайся к освещению, ракурсу и мелким бликам.\n' +
    'photo_ok = false, если зону не видно: слишком темно, размыто, снято не то или кадр слишком узкий.\n' +
    'clean = true, только если убрано. issues — коротко по-русски, что не так и где (до 25 слов), ' +
    'пустая строка, если всё в порядке.' }];
  if (ref && ref.fileId) {
    try {
      const rb = DriveApp.getFileById(ref.fileId).getBlob();
      parts.push({ inline_data: { mime_type: rb.getContentType(), data: Utilities.base64Encode(rb.getBytes()) } });
    } catch (e) { /* эталон не открылся — проверяем без него */ }
  }
  parts.push({ inline_data: { mime_type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) } });

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { photo_ok: { type: 'BOOLEAN' }, clean: { type: 'BOOLEAN' }, issues: { type: 'STRING' } },
        required: ['photo_ok', 'clean', 'issues'],
      },
    },
  };

  // Сначала пробуем модель, которая сработала в прошлый раз (её можно задать и вручную: свойство GEMINI_MODEL)
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('GEMINI_MODEL');
  const models = saved ? [saved].concat(GEMINI_MODELS.filter(m => m !== saved)) : GEMINI_MODELS;
  let lastErr = '';
  for (const model of models) {
    const resp = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
      { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
        payload: JSON.stringify(payload), muteHttpExceptions: true });
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    if (code === 404) { lastErr = 'модель ' + model + ' не найдена'; continue; } // пробуем следующую
    if (code === 429) throw new Error('429 квота Gemini');
    if (code !== 200) throw new Error('Gemini ' + code + ': ' + body.slice(0, 150));
    const j = JSON.parse(body);
    const text = j.candidates && j.candidates[0] && j.candidates[0].content &&
      j.candidates[0].content.parts.map(p => p.text || '').join('');
    if (!text) throw new Error('Gemini не ответил (возможно, фото заблокировано фильтром)');
    if (saved !== model) props.setProperty('GEMINI_MODEL', model);
    const v = JSON.parse(text);
    const issues = str_(v.issues).slice(0, 300);
    if (!v.photo_ok) return { status: '⚠ Плохое фото', issues: issues || 'Зону не видно — переснять' };
    return v.clean ? { status: '✅ Чисто', issues } : { status: '⚠ Замечания', issues: issues || 'ИИ нашёл беспорядок' };
  }
  throw new Error(lastErr || 'Нет доступной модели Gemini');
}

/**
 * Автоудаление: фото старше 30 дней → в корзину Диска (там ещё 30 дней можно восстановить).
 * Удаляем ТОЛЬКО если «✅ Чисто» и нет замечания менеджера. Строка в таблице остаётся.
 */
function cleanupPhotos() {
  const sheet = ss_().getSheetByName(SHEETS.photos);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const border = Date.now() - PHOTO_KEEP_DAYS * 24 * 3600e3;
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, PHOTO_COL.fileId).getValues();
  let removed = 0;
  data.forEach((r, i) => {
    const date = r[0] instanceof Date ? r[0] : new Date(r[0]);
    if (isNaN(date.getTime()) || date.getTime() > border) return;
    if (str_(r[PHOTO_COL.status - 1]) !== '✅ Чисто') return;      // есть замечания или не проверено
    if (str_(r[PHOTO_COL.manager - 1])) return;                     // менеджер оставил замечание
    if (str_(r[PHOTO_COL.deleted - 1])) return;                     // уже удалено
    const fileId = str_(r[PHOTO_COL.fileId - 1]);
    if (!fileId) return;
    const row = i + 2;
    try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { /* файла уже нет */ }
    sheet.getRange(row, 4).setValue('фото удалено');
    sheet.getRange(row, PHOTO_COL.deleted).setValue(new Date());
    removed++;
  });
  if (removed) log_('Чистка фото', 'В корзину: ' + removed);
  return removed;
}


/* =====================================================================
 *  ДУЭЛЬ v1 — два сотрудника, комната по коду, серверный счёт
 * =====================================================================
 *
 *  Живого соединения нет: клиент опрашивает doGet ?action=duelState
 *  раз в 3 секунды. Всё, что влияет на исход, считает сервер:
 *    — состояние матча лежит в CacheService (ключ duel:<id>, TTL 6 часов);
 *    — код комнаты — отдельный ключ duelcode:<КОД> → id;
 *    — время ответа и порядок ответов фиксирует сервер (Date.now()),
 *      время телефона не используется;
 *    — правильный ответ НЕ уходит в состояние, пока раунд не закрыт.
 *
 *  Правила (ПЛАН-ОБНОВЛЕНИЙ §3): 10 HP, урон 1, раунд 30 с, окно блока
 *  7 с после первого правильного ответа, максимум 15 раундов, ожидание
 *  соперника 2 минуты. Elo: 1000 старт, K=32, ничья = 0.5 очка.
 *
 *  Листы «Дуэли» и «Рейтинг» создаются автоматически при первой дуэли.
 *  Строки тестовых матчей помечаются кодом, начинающимся с TEST
 *  (duelCreate c test:true — только для проверки, приложение его не шлёт).
 * ===================================================================== */

const DUEL_HP = 10;
const DUEL_DAMAGE = 1;
const DUEL_ROUND_SEC = 30;
const DUEL_ROUND_MS = DUEL_ROUND_SEC * 1000;
const DUEL_BLOCK_MS = 7000;
const DUEL_MAX_ROUNDS = 15;
const DUEL_WAIT_MS = 2 * 60 * 1000;
const DUEL_PAUSE_MS = 3000;          // разбор раунда, потом следующий вопрос
const DUEL_TTL_SEC = 6 * 3600;
const DUEL_ELO_K = 32;
const DUEL_ELO_START = 1000;
const DUEL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без I, O, 0, 1

const DUEL_HEADERS = ['дата', 'код', 'игрок_1', 'игрок_2', 'hp_1', 'hp_2',
  'раундов', 'победитель', 'длительность_сек'];

// «Рейтинг»: сначала дуэльные колонки (их порядок нельзя менять — там уже данные),
// затем агрегаты викторины. Новые колонки только ДОПИСЫВАЮТСЯ справа.
const RATING_DUEL_HEADERS = ['сотрудник', 'рейтинг', 'побед', 'поражений', 'матчей', 'последний_матч'];
const RATING_QUIZ_HEADERS = ['викторина_попыток', 'викторина_лучший', 'викторина_средний', 'викторина_последняя'];
const RATING_HEADERS = RATING_DUEL_HEADERS.concat(RATING_QUIZ_HEADERS);
const RATING_DUEL_COLUMNS = RATING_DUEL_HEADERS.length;

// Сырые попытки викторины: attemptId — первая колонка, чтобы ловить дубли.
const QUIZ_TRY_HEADERS = ['attempt_id', 'дата', 'сотрудник', 'верно', 'всего', 'секунд', 'версия_банка'];
const QUIZ_TRY_COLUMNS = QUIZ_TRY_HEADERS.length;

/** Общая обёртка: одна дуэль меняется одним игроком за раз. */
function duelLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'Сервер занят, повторите через пару секунд', code: 'busy' };
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function duelCacheKey_(id) { return 'duel:' + id; }
function duelCodeKey_(code) { return 'duelcode:' + code; }

function duelLoad_(id) {
  id = str_(id);
  if (!id) return null;
  const raw = CacheService.getScriptCache().get(duelCacheKey_(id));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function duelSave_(m) {
  if (!m || !m.id) return;
  const cache = CacheService.getScriptCache();
  cache.put(duelCacheKey_(m.id), JSON.stringify(m), DUEL_TTL_SEC);
  if (m.code) cache.put(duelCodeKey_(m.code), m.id, DUEL_TTL_SEC);
}

function duelDrop_(m) {
  if (!m || !m.id) return;
  const cache = CacheService.getScriptCache();
  cache.remove(duelCacheKey_(m.id));
  if (m.code) cache.remove(duelCodeKey_(m.code));
}

function duelByCode_(code) {
  code = str_(code).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9]{4,10}$/.test(code)) return null;
  const id = CacheService.getScriptCache().get(duelCodeKey_(code));
  return id ? duelLoad_(id) : null;
}

function duelRand_(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += DUEL_CODE_ALPHABET.charAt(Math.floor(Math.random() * DUEL_CODE_ALPHABET.length));
  return s;
}

function duelNewCode_(test) {
  return (test ? 'TEST' : '') + duelRand_(test ? 2 : 6);
}

function duelShuffle_(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** Только активные сотрудники: имя из листа «Сотрудники», галочка «Работает». */
function isActiveEmployee_(name) {
  name = str_(name);
  if (!name) return false;
  return rows_(ss_(), SHEETS.staff).some(r => str_(r[0]) === name && r[3] === true);
}

/** Листы дуэли и рейтинга. Создаются при первом обращении, шапки не дублируются. */
function ensureDuelSheets_(ss) {
  ss = ss || ss_();
  let ds = ss.getSheetByName(SHEETS.duels);
  if (!ds) {
    ds = ss.insertSheet(SHEETS.duels);
    ds.getRange(1, 1, 1, DUEL_HEADERS.length).setValues([DUEL_HEADERS]).setFontWeight('bold');
    ds.setFrozenRows(1);
    ds.setColumnWidth(1, 140);
    ds.setColumnWidth(2, 90);
    ds.setColumnWidth(3, 160);
    ds.setColumnWidth(4, 160);
    ds.setColumnWidth(8, 160);
  }
  let rs = ss.getSheetByName(SHEETS.ratings);
  if (!rs) {
    rs = ss.insertSheet(SHEETS.ratings);
    rs.getRange(1, 1, 1, RATING_HEADERS.length).setValues([RATING_HEADERS]).setFontWeight('bold');
    rs.setFrozenRows(1);
    rs.setColumnWidth(1, 180);
    rs.setColumnWidth(6, 150);
    for (let i = 0; i < RATING_QUIZ_HEADERS.length; i++) rs.setColumnWidth(RATING_DUEL_COLUMNS + 1 + i, 150);
  }
  return { duels: ds, ratings: rs };
}

/** Текущий рейтинг сотрудника по листу «Рейтинг» (без создания строки). */
function duelRatingOf_(ratings, name) {
  const r = ratings[name];
  return r && r.rating > 0 ? r.rating : DUEL_ELO_START;
}

function duelReadRatings_(ss) {
  const sh = ss.getSheetByName(SHEETS.ratings);
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, RATING_DUEL_COLUMNS).getValues().forEach((r, i) => {
    const name = str_(r[0]);
    if (!name) return;
    out[name] = {
      name, row: i + 2,
      rating: num_(r[1]) > 0 ? Math.round(num_(r[1])) : DUEL_ELO_START,
      wins: num_(r[2]), losses: num_(r[3]), matches: num_(r[4]), last: r[5],
    };
  });
  return out;
}

/** Elo: ожидаемый счёт и новая оценка. Ничья — 0.5. */
function duelElo_(myRating, oppRating, score) {
  const expected = 1 / (1 + Math.pow(10, (oppRating - myRating) / 400));
  return Math.max(0, Math.round(myRating + DUEL_ELO_K * (score - expected)));
}

/** GET ?action=duelRating&employee= — короткая карточка рейтинга для экрана дуэли. */
function duelRating_(employee) {
  employee = str_(employee);
  if (!employee) return { ok: false, error: 'Не указан сотрудник' };
  if (!isActiveEmployee_(employee)) return { ok: false, error: 'Сотрудник не найден или отключён', code: 'auth' };
  try {
    const ss = ss_();
    ensureDuelSheets_(ss);
    const ratings = duelReadRatings_(ss);
    const mine = ratings[employee];
    const all = Object.keys(ratings).map(n => ratings[n].rating).sort((a, b) => b - a);
    const place = mine ? all.indexOf(mine.rating) + 1 : 0;
    return {
      ok: true, employee,
      rating: mine ? mine.rating : DUEL_ELO_START,
      wins: mine ? mine.wins : 0,
      losses: mine ? mine.losses : 0,
      matches: mine ? mine.matches : 0,
      place: place,
      players: all.length,
    };
  } catch (e) {
    return { ok: false, error: 'Не удалось прочитать рейтинг: ' + e };
  }
}

/** Вопросы для дуэли: только «в игре», с правильным ответом — он остаётся на сервере. */
function duelQuestionPool_() {
  const sh = ss_().getSheetByName(SHEETS.questions);
  if (!sh || sh.getLastRow() < 2) return [];
  const out = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, QUIZ_COLUMNS).getValues().forEach(r => {
    const id = str_(r[0]);
    if (!id) return;
    const status = str_(r[10]) || 'в игре';
    if (status !== 'в игре') return;
    const q = {
      id,
      'категория': str_(r[1]),
      'вопрос': str_(r[2]),
      A: str_(r[3]), B: str_(r[4]), C: str_(r[5]), D: str_(r[6]),
      correct: str_(r[7]).toUpperCase(),
      'пояснение': str_(r[8]),
      'источник': str_(r[9]),
    };
    if (!q['вопрос'] || !q.A || !q.B || !q.C || !q.D || 'ABCD'.indexOf(q.correct) === -1) return;
    out.push(q);
  });
  return out;
}

/* ---------- Создание комнаты и вход ---------- */

function duelCreate_(body) {
  const employee = str_(body && body.employee);
  if (!employee) return { ok: false, error: 'Не указан сотрудник' };
  if (!isActiveEmployee_(employee)) return { ok: false, error: 'Дуэль доступна только сотрудникам', code: 'auth' };

  return duelLock_(() => {
    const pool = duelQuestionPool_();
    if (!pool.length) return { ok: false, error: 'В банке нет вопросов «в игре» — дуэль пока недоступна' };

    const now = Date.now();
    const ss = ss_();
    ensureDuelSheets_(ss);
    const ratings = duelReadRatings_(ss);

    const test = body.test === true;
    let code = '';
    for (let i = 0; i < 20; i++) {
      code = duelNewCode_(test);
      if (!CacheService.getScriptCache().get(duelCodeKey_(code))) break;
    }

    const maxRounds = Math.min(DUEL_MAX_ROUNDS, pool.length);
    const m = {
      id: 'd' + now.toString(36) + duelRand_(8),
      code,
      createdAt: now,
      startedAt: 0,
      finishedAt: 0,
      status: 'waiting',
      players: [{ name: employee, hp: DUEL_HP }],
      questions: duelShuffle_(pool).slice(0, maxRounds),
      maxRounds,
      round: 0,
      roundState: null,
      lastRound: null,
      nextRoundAt: 0,
      winner: null,
      ratings: {},
      ratingChanges: null,
    };
    m.ratings[employee] = duelRatingOf_(ratings, employee);
    duelSave_(m);
    log_('Дуэль', 'Создана комната ' + code + ' (' + employee + ')');

    return {
      ok: true, code, duelId: m.id, role: 1, status: 'waiting',
      now, expiresAt: now + DUEL_WAIT_MS, myRating: m.ratings[employee],
    };
  });
}

function duelJoin_(body) {
  const employee = str_(body && body.employee);
  const code = str_(body && body.code).toUpperCase().replace(/\s+/g, '');
  if (!employee) return { ok: false, error: 'Не указан сотрудник' };
  if (!code) return { ok: false, error: 'Введите код комнаты' };
  if (!isActiveEmployee_(employee)) return { ok: false, error: 'Дуэль доступна только сотрудникам', code: 'auth' };

  return duelLock_(() => {
    const m = duelByCode_(code);
    if (!m) return { ok: false, error: 'Комната не найдена или уже закрыта', code: 'notfound' };

    const idx = m.players.findIndex(p => p.name === employee);
    if (idx >= 0) {
      // Повторный вход того же игрока (закрыл приложение, вернулся по ссылке)
      const now = Date.now();
      if (m.status === 'waiting' && now - m.createdAt > DUEL_WAIT_MS) {
        duelDrop_(m);
        return { ok: false, error: 'Ожидание истекло — создайте новую комнату', code: 'expired' };
      }
      if (m.status === 'playing') duelTick_(m, now);
      duelSave_(m);
      return {
        ok: true, duelId: m.id, role: idx + 1, status: m.status, code: m.code,
        now, myRating: duelRatingOf_(m.ratings, employee),
      };
    }

    if (m.status === 'finished') return { ok: false, error: 'Матч уже закончился', code: 'finished' };
    if (m.status !== 'waiting' || m.players.length >= 2) {
      return { ok: false, error: 'Комната занята — матч уже идёт', code: 'busy' };
    }
    const now = Date.now();
    if (now - m.createdAt > DUEL_WAIT_MS) {
      duelDrop_(m);
      return { ok: false, error: 'Комната сгорела — на создание новой есть 2 минуты', code: 'expired' };
    }

    const ss = ss_();
    ensureDuelSheets_(ss);
    m.players.push({ name: employee, hp: DUEL_HP });
    m.ratings[employee] = duelRatingOf_(duelReadRatings_(ss), employee);
    m.status = 'playing';
    m.startedAt = now;
    m.round = 0;
    duelStartRound_(m, now);
    duelSave_(m);
    log_('Дуэль', 'Комната ' + m.code + ': ' + m.players[0].name + ' × ' + employee);

    return {
      ok: true, duelId: m.id, role: 2, status: 'playing', code: m.code,
      now, myRating: m.ratings[employee],
    };
  });
}

/* ---------- Раунд ---------- */

function duelStartRound_(m, now) {
  if (m.round >= m.maxRounds) return;
  m.round += 1;
  const q = m.questions[m.round - 1];
  m.roundState = {
    n: m.round,
    startedAt: now,
    deadline: now + DUEL_ROUND_MS,
    answers: [],
    resolved: false,
    result: null,
  };
  m.nextRoundAt = 0;
  m.lastRound = m.lastRound || null;
}

/**
 * Ленивое продвижение матча: вызывается при каждом опросе/ответе.
 * Никаких триггеров нет — время проверяем по серверным часам.
 */
function duelTick_(m, now) {
  if (!m || m.status !== 'playing') return;
  let guard = 0;
  while (guard++ < 8) {
    if (!m.roundState) {
      duelStartRound_(m, now);
      continue;
    }
    const r = m.roundState;

    if (r.resolved) {
      if (now < (m.nextRoundAt || 0)) return;                 // идёт разбор раунда
      if (m.round >= m.maxRounds) { duelFinish_(m, now); return; }
      duelStartRound_(m, now);
      continue;
    }

    const outcome = duelEvalRound_(m, now);
    if (!outcome) return;                                     // раунд ещё не решён
    duelApplyRound_(m, outcome);
    if (m.players.some(p => p.hp <= 0) || m.round >= m.maxRounds) {
      duelFinish_(m, now);
      return;
    }
    m.nextRoundAt = now + DUEL_PAUSE_MS;
    return;
  }
}

/**
 * Итог раунда или null, если ждать ещё есть смысл.
 * correct: правильные ответы; answers уже с серверным временем.
 */
function duelEvalRound_(m, now) {
  const r = m.roundState;
  const ans = r.answers.slice().sort((a, b) => (a.at - b.at) || (a.seq - b.seq));

  if (!ans.length) return now >= r.deadline ? { kind: 'none' } : null;

  if (ans.length >= 2) {
    const first = ans[0], second = ans[1];
    if (first.correct && second.correct) {
      const blocked = (second.at - first.at) <= DUEL_BLOCK_MS;
      return blocked
        ? { kind: 'blocked', first: first.name, second: second.name }
        : { kind: 'damage', attacker: first.name, first: first.name, second: second.name };
    }
    if (first.correct) return { kind: 'damage', attacker: first.name };
    if (second.correct) return { kind: 'damage', attacker: second.name };
    return { kind: 'none' };
  }

  const only = ans[0];
  if (!only.correct) {
    // Первый ошибся, второй ещё может ответить правильно — ждём дедлайн
    return now >= r.deadline ? { kind: 'none' } : null;
  }
  // Пока правильный ответ один, ждём до дедлайна: второй ещё может успеть
  // ответить (в окне — блок, позже — урон всё равно первому). Так его ответ
  // не теряется и попадает в разбор раунда.
  return now >= r.deadline ? { kind: 'damage', attacker: only.name } : null;
}

function duelApplyRound_(m, outcome) {
  const r = m.roundState;
  const q = m.questions[r.n - 1];
  const oppName = name => {
    const p = m.players.find(x => x.name !== name);
    return p ? p.name : '';
  };

  let attacker = null, victim = null, blocked = false;
  if (outcome.kind === 'damage') {
    attacker = outcome.attacker;
    victim = oppName(attacker);
    const p = m.players.find(x => x.name === victim);
    if (p) p.hp = Math.max(0, p.hp - DUEL_DAMAGE);
  } else if (outcome.kind === 'blocked') {
    blocked = true;
  }

  r.resolved = true;
  r.result = {
    n: r.n,
    correct: q.correct,
    correctText: q[q.correct],
    explanation: q['пояснение'],
    answers: r.answers.map(a => ({ name: a.name, choice: a.choice, correct: a.correct, at: a.at })),
    first: r.answers.length ? r.answers.slice().sort((a, b) => (a.at - b.at) || (a.seq - b.seq))[0].name : null,
    attacker,
    victim,
    blocked,
    timeout: r.answers.length === 0,
  };
  m.lastRound = r.result;
}

/** POST {action:'duelAnswer'} — ответ принимает только сервер, один раз на раунд. */
function duelAnswer_(body) {
  const employee = str_(body && body.employee);
  const id = str_(body && body.duelId);
  const round = Number(body && body.round);
  const choice = str_(body && body.choice).toUpperCase();
  if (!employee) return { ok: false, error: 'Не указан сотрудник' };
  if (!id) return { ok: false, error: 'Не указан матч' };
  if ('ABCD'.indexOf(choice) === -1) return { ok: false, error: 'Некорректный вариант ответа' };

  return duelLock_(() => {
    const m = duelLoad_(id);
    if (!m) return { ok: false, error: 'Матч не найден или уже истёк', code: 'notfound' };
    if (!m.players.some(p => p.name === employee)) {
      return { ok: false, error: 'Вы не участник этого матча', code: 'auth' };
    }

    const now = Date.now();
    duelTick_(m, now);

    if (m.status !== 'playing') {
      duelSave_(m);
      return { ok: false, error: 'Матч уже закончился', code: 'finished' };
    }
    const r = m.roundState;
    if (!r || r.n !== round) {
      duelSave_(m);
      return { ok: false, error: 'Этот раунд уже закончился', code: 'round' };
    }
    if (r.resolved) {
      duelSave_(m);
      return { ok: false, error: now > r.deadline ? 'Время вышло — ответ не принят' : 'Раунд уже закрыт', code: 'round' };
    }
    if (now > r.deadline) {
      duelTick_(m, now);
      duelSave_(m);
      return { ok: false, error: 'Время вышло — ответ не принят', code: 'late' };
    }
    if (r.answers.some(a => a.name === employee)) {
      duelSave_(m);
      return { ok: false, error: 'Ответ уже отправлен — изменить нельзя', code: 'answered' };
    }

    const q = m.questions[r.n - 1];
    r.answers.push({
      name: employee,
      choice,
      at: now,
      correct: choice === q.correct,
      seq: r.answers.length + 1,
    });
    duelTick_(m, now); // мог сразу закрыть раунд
    duelSave_(m);

    return { ok: true, accepted: true, round: r.n, at: now };
  });
}

/* ---------- Состояние для опроса ---------- */

/** GET ?action=duelState&duelId=&employee= */
function duelState_(id, employee) {
  id = str_(id);
  employee = str_(employee);
  if (!id) return { ok: false, error: 'Не указан матч' };
  if (!employee) return { ok: false, error: 'Не указан сотрудник' };

  return duelLock_(() => {
    const m = duelLoad_(id);
    if (!m) return { ok: false, error: 'Матч не найден — возможно, он уже завершился или истёк', code: 'notfound' };
    if (!m.players.some(p => p.name === employee)) {
      return { ok: false, error: 'Вы не участник этого матча', code: 'auth' };
    }

    const now = Date.now();
    if (m.status === 'waiting' && now - m.createdAt > DUEL_WAIT_MS) {
      duelDrop_(m);
      return { ok: false, error: 'Ожидание истекло — комната закрыта', code: 'expired' };
    }
    if (m.status === 'playing') {
      duelTick_(m, now);
      duelSave_(m);
    }
    return duelStateFor_(m, employee, now);
  });
}

/** Состояние без правильного ответа текущего раунда. */
function duelStateFor_(m, name, now) {
  const me = m.players.find(p => p.name === name);
  const opp = m.players.find(p => p.name !== name) || null;
  const out = {
    ok: true,
    duelId: m.id,
    code: m.code,
    status: m.status,
    round: m.round,
    maxRounds: m.maxRounds,
    now,
    myName: name,
    myHp: me ? me.hp : 0,
    oppHp: opp ? opp.hp : null,
    opponent: opp ? opp.name : '',
    myRating: duelRatingOf_(m.ratings, name),
    oppRating: opp ? duelRatingOf_(m.ratings, opp.name) : null,
    question: null,
    myAnswer: null,
    oppAnswered: false,
    lastRound: duelLastFor_(m, name),
    result: null,
    deadline: m.status === 'waiting' ? m.createdAt + DUEL_WAIT_MS : 0,
    pauseUntil: 0,
  };

  if (m.status === 'playing') {
    const r = m.roundState;
    if (r) {
      out.deadline = r.deadline;
      out.pauseUntil = m.nextRoundAt || 0;
      if (!r.resolved) {
        const q = m.questions[r.n - 1];
        // Никаких correct/пояснений до закрытия раунда: иначе рейтинг накручивается.
        out.question = {
          id: q.id, 'категория': q['категория'], 'вопрос': q['вопрос'],
          A: q.A, B: q.B, C: q.C, D: q.D,
        };
        const mine = r.answers.find(a => a.name === name);
        out.myAnswer = mine ? mine.choice : null;
        out.oppAnswered = r.answers.some(a => a.name !== name);
      }
    }
  }

  if (m.status === 'finished') {
    out.result = {
      winner: !m.winner ? 'draw' : (m.winner === name ? 'me' : 'opponent'),
      winnerName: m.winner || '',
      myHp: me ? me.hp : 0,
      oppHp: opp ? opp.hp : 0,
      rounds: m.round,
    };
    const ch = m.ratingChanges && m.ratingChanges[name];
    const oppCh = m.ratingChanges && opp ? m.ratingChanges[opp.name] : null;
    out.rating = ch ? { before: ch.before, after: ch.after, delta: ch.after - ch.before } : null;
    out.oppRatingChange = oppCh ? oppCh.after - oppCh.before : null;
  }
  return out;
}

/** Последний закрытый раунд в терминах «я / соперник». Без правильного ответа, пока раунд идёт. */
function duelLastFor_(m, name) {
  const res = m.lastRound;
  if (!res) return null;
  const opp = m.players.find(p => p.name !== name);
  const mine = (res.answers || []).find(a => a.name === name);
  const theirs = opp ? (res.answers || []).find(a => a.name === opp.name) : null;
  return {
    n: res.n,
    correct: res.correct,
    correctText: res.correctText,
    explanation: res.explanation,
    myChoice: mine ? mine.choice : null,
    oppChoice: theirs ? theirs.choice : null,
    oppAnswered: !!theirs,
    blocked: !!res.blocked,
    damage: res.victim ? (res.victim === name ? 'me' : 'opponent') : null,
    by: res.attacker ? (res.attacker === name ? 'me' : 'opponent') : null,
    first: res.first ? (res.first === name ? 'me' : 'opponent') : null,
    timeout: !!res.timeout,
  };
}

/* ---------- Завершение, история, Elo ---------- */

function duelFinish_(m, now) {
  if (m.status === 'finished') return;
  m.status = 'finished';
  m.finishedAt = now;
  m.nextRoundAt = 0;
  if (m.roundState) m.roundState.resolved = true;

  const p1 = m.players[0], p2 = m.players[1];
  if (!p2) { m.status = 'waiting'; return; } // матч без соперника не завершается

  let winner = null;
  if (p1.hp <= 0 && p2.hp > 0) winner = p2.name;
  else if (p2.hp <= 0 && p1.hp > 0) winner = p1.name;
  else if (p1.hp > p2.hp) winner = p1.name;
  else if (p2.hp > p1.hp) winner = p2.name;
  m.winner = winner;

  try {
    const ss = ss_();
    ensureDuelSheets_(ss);
    const sh = ss.getSheetByName(SHEETS.ratings);
    const ratings = duelReadRatings_(ss);
    const r1 = duelRatingOf_(ratings, p1.name);
    const r2 = duelRatingOf_(ratings, p2.name);
    const s1 = winner === null ? 0.5 : (winner === p1.name ? 1 : 0);
    const s2 = 1 - s1;
    const n1 = duelElo_(r1, r2, s1);
    const n2 = duelElo_(r2, r1, s2);
    m.ratingChanges = {};
    m.ratingChanges[p1.name] = { before: r1, after: n1 };
    m.ratingChanges[p2.name] = { before: r2, after: n2 };

    const stamp = new Date(now);
    [ [p1, r1, n1, s1], [p2, r2, n2, s2] ].forEach(([p, before, after, score]) => {
      const old = ratings[p.name];
      const wins = (old ? old.wins : 0) + (score === 1 ? 1 : 0);
      const losses = (old ? old.losses : 0) + (score === 0 ? 1 : 0);
      const matches = (old ? old.matches : 0) + 1;
      if (old) {
        // Пишем только дуэльные колонки: агрегаты викторины справа не трогаем.
        sh.getRange(old.row, 1, 1, RATING_DUEL_COLUMNS)
          .setValues([[text_(p.name, 80), after, wins, losses, matches, stamp]]);
      } else {
        addRow_(sh, [text_(p.name, 80), after, wins, losses, matches, stamp]);
      }
    });

    const ds = ss.getSheetByName(SHEETS.duels);
    const started = m.startedAt || m.createdAt;
    addRow_(ds, [
      new Date(started), "'" + m.code, text_(p1.name, 80), text_(p2.name, 80),
      p1.hp, p2.hp, m.round, winner ? text_(winner, 80) : 'ничья',
      Math.max(0, Math.round((now - started) / 1000)),
    ]);
    SpreadsheetApp.flush();
    log_('Дуэль', 'Матч ' + m.code + ' завершён: ' + p1.name + ' ' + p1.hp + ' — ' + p2.hp + ' ' + p2.name +
      (winner ? ', победитель ' + winner : ', ничья'));
  } catch (e) {
    log_('Дуэль', 'ОШИБКА записи результата ' + m.code + ': ' + e);
  }
}

/** GET ?action=duelCancel&duelId=&employee= — отмена ожидания создателем. */
function duelCancel_(id, employee) {
  id = str_(id);
  employee = str_(employee);
  if (!id) return { ok: false, error: 'Не указан матч' };
  return duelLock_(() => {
    const m = duelLoad_(id);
    if (!m) return { ok: true, cancelled: true };
    if (m.status !== 'waiting') return { ok: false, error: 'Матч уже начался — отменить нельзя', code: 'playing' };
    if (employee && m.players.length && m.players[0].name !== employee) {
      return { ok: false, error: 'Отменить ожидание может только создатель', code: 'auth' };
    }
    duelDrop_(m);
    log_('Дуэль', 'Ожидание ' + m.code + ' отменено');
    return { ok: true, cancelled: true };
  });
}


/* =====================================================================
 *  РЕЙТИНГ ВИКТОРИНЫ
 * =====================================================================
 *
 *  Лист «Викторина» — сырые попытки:
 *    attempt_id | дата | сотрудник | верно | всего | секунд | версия_банка
 *  attempt_id придумывает телефон; повторная отправка того же id не создаёт
 *  вторую строку (идемпотентность при обрыве сети).
 *
 *  Лист «Рейтинг» — те же строки, что у дуэли, плюс четыре колонки СПРАВА:
 *    викторина_попыток | викторина_лучший | викторина_средний | викторина_последняя
 *  Порядок дуэльных колонок не меняется: там уже есть данные.
 *  «лучший» и «средний» — проценты (0…100), «последняя» — дата попытки.
 * ===================================================================== */

function quizLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'Сервер занят, повторите через пару секунд', code: 'busy' };
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Создаёт «Викторину» и дописывает недостающие колонки в «Рейтинг». */
function ensureQuizSheets_(ss) {
  ss = ss || ss_();
  const base = ensureDuelSheets_(ss); // гарантирует «Рейтинг» с полной шапкой
  let qs = ss.getSheetByName(SHEETS.quizTries);
  if (!qs) {
    qs = ss.insertSheet(SHEETS.quizTries);
    qs.getRange(1, 1, 1, QUIZ_TRY_COLUMNS).setValues([QUIZ_TRY_HEADERS]).setFontWeight('bold');
    qs.setFrozenRows(1);
    qs.setColumnWidth(1, 220);
    qs.setColumnWidth(3, 160);
    qs.setColumnWidth(7, 160);
  }
  const rs = base.ratings;
  const have = rs.getRange(1, RATING_DUEL_COLUMNS + 1, 1, RATING_QUIZ_HEADERS.length).getValues()[0];
  if (!str_(have[0])) {
    rs.getRange(1, RATING_DUEL_COLUMNS + 1, 1, RATING_QUIZ_HEADERS.length)
      .setValues([RATING_QUIZ_HEADERS]).setFontWeight('bold');
    for (let i = 0; i < RATING_QUIZ_HEADERS.length; i++) {
      rs.setColumnWidth(RATING_DUEL_COLUMNS + 1 + i, 150);
    }
  }
  return { results: qs, ratings: rs };
}

function round1_(v) { return Math.round(v * 10) / 10; }

/** Агрегаты одного сотрудника по сырым попыткам. */
function quizAggregates_(sh, employee) {
  const zero = { attempts: 0, best: 0, bestCorrect: 0, bestTotal: 0, average: 0, lastAt: '' };
  if (!sh || sh.getLastRow() < 2) return zero;
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, QUIZ_TRY_COLUMNS).getValues();
  let attempts = 0, sum = 0, bestPct = -1, bestCorrect = 0, bestTotal = 0, last = null;
  data.forEach(r => {
    const name = str_(r[2]).replace(/^'/, '');
    if (name !== employee) return;
    const correct = num_(r[3]);
    const total = num_(r[4]);
    if (!(total > 0) || correct < 0 || correct > total) return;
    const pct = correct / total * 100;
    attempts++;
    sum += pct;
    if (pct > bestPct || (pct === bestPct && correct > bestCorrect)) {
      bestPct = pct; bestCorrect = correct; bestTotal = total;
    }
    const d = r[1] instanceof Date ? r[1] : new Date(r[1]);
    if (!isNaN(d.getTime()) && (!last || d.getTime() > last.getTime())) last = d;
  });
  if (!attempts) return zero;
  return {
    attempts,
    best: round1_(bestPct),
    bestCorrect, bestTotal,
    average: round1_(sum / attempts),
    lastAt: last ? last.toISOString() : '',
  };
}

/** Пишет агрегаты в «Рейтинг», не трогая дуэльные колонки 1–6. */
function updateQuizRatingRow_(ss, employee, agg) {
  const sh = ss.getSheetByName(SHEETS.ratings);
  const stamp = agg.lastAt ? new Date(agg.lastAt) : '';
  if (sh.getLastRow() >= 2) {
    const data = sh.getRange(2, 1, sh.getLastRow() - 1, RATING_DUEL_COLUMNS).getValues();
    const idx = data.findIndex(r => str_(r[0]).replace(/^'/, '') === employee);
    if (idx >= 0) {
      sh.getRange(idx + 2, RATING_DUEL_COLUMNS + 1, 1, RATING_QUIZ_HEADERS.length)
        .setValues([[agg.attempts, agg.best, agg.average, stamp]]);
      return;
    }
  }
  // Сотрудник ещё не играл дуэль — заводим строку с дуэльными значениями по умолчанию.
  addRow_(sh, [text_(employee, 80), DUEL_ELO_START, 0, 0, 0, '',
    agg.attempts, agg.best, agg.average, stamp]);
}

/**
 * POST {action:'quizResult', attemptId, employee, correct, total, seconds, bankVersion}
 * Пишет попытку и возвращает личный рекорд: {ok, best, attempts, ...}.
 * Повторный attemptId возвращает те же агрегаты без новой строки.
 */
function quizResult_(body) {
  const attemptId = str_(body && body.attemptId);
  const employee = str_(body && body.employee);
  const correct = Number(body && body.correct);
  const total = Number(body && body.total);
  const seconds = Number(body && body.seconds);
  const bankVersion = str_(body && body.bankVersion).slice(0, 80);

  if (!/^[A-Za-z0-9-]{8,64}$/.test(attemptId)) return { ok: false, error: 'Некорректный attemptId' };
  if (!employee) return { ok: false, error: 'Не указан сотрудник' };
  if (!isActiveEmployee_(employee)) return { ok: false, error: 'Сотрудник не найден или отключён', code: 'auth' };
  if (!Number.isInteger(total) || total <= 0 || total > 1000) return { ok: false, error: 'Некорректное число вопросов' };
  if (!Number.isInteger(correct) || correct < 0 || correct > total) return { ok: false, error: 'Некорректное число верных ответов' };
  if (!isFinite(seconds) || seconds < 0 || seconds > 3600) return { ok: false, error: 'Некорректное время попытки' };

  return quizLock_(() => {
    const ss = ss_();
    const { results: sh } = ensureQuizSheets_(ss);

    if (idExists_(sh, 1, attemptId)) {
      const agg = quizAggregates_(sh, employee);
      return Object.assign({ ok: true, duplicate: true }, agg);
    }

    addRow_(sh, [
      "'" + attemptId, new Date(), text_(employee, 80),
      correct, total, round1_(seconds), text_(bankVersion, 80),
    ]);
    const agg = quizAggregates_(sh, employee);
    updateQuizRatingRow_(ss, employee, agg);
    SpreadsheetApp.flush();
    log_('Викторина', 'Результат: ' + employee + ' ' + correct + '/' + total + ' за ' + round1_(seconds) + ' с');
    return Object.assign({ ok: true, duplicate: false }, agg);
  });
}


/* =====================================================================
 *  ПЕРСОНАЛИЗАЦИЯ: ПЕРСОНАЖИ, ВНЕШНИЙ ВИД, ПРЕДМЕТЫ
 * =====================================================================
 *
 *  ЭТО ТОЛЬКО ОСНОВАНИЕ. Механика ВЫКЛЮЧЕНА: предметы не влияют ни на
 *  викторину, ни на дуэль. Сервер только читает листы и отдаёт профиль.
 *
 *  Листы (создаются при первом обращении):
 *    Персонажи: сотрудник | имя_персонажа | аватар | цвет | эмблема | дата_создания
 *    Предметы:  код | название | описание | слот | редкость |
 *               эффект_тип | эффект_параметр | эффект_условие | эффект_значение | активен
 *    Инвентарь: сотрудник | код_предмета | получен_дата | источник | экипирован
 *
 *  Эффект — строка данных, а не код. Новый предмет добавляется в «Предметы»
 *  без правки JavaScript. Применение эффектов когда-нибудь будет в
 *  applyItemEffects_() — сейчас она возвращает нули и нигде не вызывается.
 * ===================================================================== */

const CHARACTER_HEADERS = ['сотрудник', 'имя_персонажа', 'аватар', 'цвет', 'эмблема', 'дата_создания'];
const ITEM_HEADERS = ['код', 'название', 'описание', 'слот', 'редкость',
  'эффект_тип', 'эффект_параметр', 'эффект_условие', 'эффект_значение', 'активен'];
const INVENTORY_HEADERS = ['сотрудник', 'код_предмета', 'получен_дата', 'источник', 'экипирован'];

// Примеры-пустышки: показывают формат, но механика выключена.
const ITEM_SEEDS = [
  ['vine_expert', 'Винный знаток', 'Пример: +1 урона на вопросах категории «Вино». Механика пока выключена.',
    'аксессуар', 'редкий', 'урон', 'категория', 'Вино', 1, true],
  ['silver_shaker', 'Серебряный шейкер', 'Пример: +2 секунды к раунду в дружеском матче. Механика пока выключена.',
    'инструмент', 'необычный', 'время', 'раунд', 'дружеский', 2, true],
  ['barman_shield', 'Щит бармена', 'Пример: один щит за матч в дружеском режиме. Механика пока выключена.',
    'аксессуар', 'редкий', 'щит', 'матч', 'дружеский', 1, true],
  ['leather_notebook', 'Кожаный блокнот', 'Пример косметики: аксессуар персонажа.',
    'аксессуар', 'обычный', 'косметика', 'аксессуар', 'всегда', '', true],
  ['mentor_badge', 'Значок наставника', 'Пример косметики: эмблема персонажа.',
    'эмблема', 'обычный', 'косметика', 'эмблема', 'всегда', '', true],
];

function ensureProfileSheets_(ss) {
  ss = ss || ss_();

  let characters = ss.getSheetByName(SHEETS.characters);
  if (!characters) {
    characters = ss.insertSheet(SHEETS.characters);
    characters.getRange(1, 1, 1, CHARACTER_HEADERS.length).setValues([CHARACTER_HEADERS]).setFontWeight('bold');
    characters.setFrozenRows(1);
    characters.setColumnWidth(1, 180);
    characters.setColumnWidth(2, 180);
  }

  let itemCatalog = ss.getSheetByName(SHEETS.itemCatalog);
  if (!itemCatalog) {
    itemCatalog = ss.insertSheet(SHEETS.itemCatalog);
    itemCatalog.getRange(1, 1, 1, ITEM_HEADERS.length).setValues([ITEM_HEADERS]).setFontWeight('bold');
    itemCatalog.setFrozenRows(1);
    itemCatalog.setColumnWidth(1, 150);
    itemCatalog.setColumnWidth(2, 180);
    itemCatalog.setColumnWidth(3, 360);
    itemCatalog.setColumnWidth(8, 160);
  }
  if (itemCatalog.getLastRow() < 2) {
    itemCatalog.getRange(2, 1, ITEM_SEEDS.length, ITEM_HEADERS.length).setValues(ITEM_SEEDS);
  }

  let inventory = ss.getSheetByName(SHEETS.inventory);
  if (!inventory) {
    inventory = ss.insertSheet(SHEETS.inventory);
    inventory.getRange(1, 1, 1, INVENTORY_HEADERS.length).setValues([INVENTORY_HEADERS]).setFontWeight('bold');
    inventory.setFrozenRows(1);
    inventory.setColumnWidth(1, 180);
    inventory.setColumnWidth(3, 150);
    inventory.setColumnWidth(4, 160);
  }

  return { characters, itemCatalog, inventory };
}

function bool_(v) {
  if (v === true) return true;
  const s = str_(v).toLowerCase();
  return s === 'true' || s === 'да' || s === '1';
}

function isoDate_(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? str_(v) : d.toISOString();
}

function readItemCatalog_(ss) {
  const sh = ss.getSheetByName(SHEETS.itemCatalog);
  const out = [];
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, ITEM_HEADERS.length).getValues().forEach(r => {
    const code = str_(r[0]);
    if (!code) return;
    out.push({
      code,
      name: str_(r[1]),
      description: str_(r[2]),
      slot: str_(r[3]),
      rarity: str_(r[4]),
      effect: {
        type: str_(r[5]),
        param: str_(r[6]),
        condition: str_(r[7]),
        value: num_(r[8]),
      },
      active: bool_(r[9]),
    });
  });
  return out;
}

function readCharacter_(ss, employee) {
  const sh = ss.getSheetByName(SHEETS.characters);
  const empty = { employee, name: '', avatar: '', color: '', emblem: '', createdAt: '' };
  if (!sh || sh.getLastRow() < 2) return empty;
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, CHARACTER_HEADERS.length).getValues();
  const r = rows.find(x => str_(x[0]).replace(/^'/, '') === employee);
  if (!r) return empty;
  return {
    employee,
    name: str_(r[1]),
    avatar: str_(r[2]),
    color: str_(r[3]),
    emblem: str_(r[4]),
    createdAt: isoDate_(r[5]),
  };
}

function readInventory_(ss, employee, catalog) {
  const sh = ss.getSheetByName(SHEETS.inventory);
  if (!sh || sh.getLastRow() < 2) return [];
  const byCode = {};
  catalog.forEach(it => { byCode[it.code] = it; });
  const out = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, INVENTORY_HEADERS.length).getValues().forEach(r => {
    if (str_(r[0]).replace(/^'/, '') !== employee) return;
    const code = str_(r[1]);
    if (!code) return;
    const item = byCode[code] || null;
    out.push({
      code,
      name: item ? item.name : code,
      description: item ? item.description : '',
      slot: item ? item.slot : '',
      rarity: item ? item.rarity : '',
      effect: item ? item.effect : { type: '', param: '', condition: '', value: 0 },
      active: item ? item.active : false,
      receivedAt: isoDate_(r[2]),
      source: str_(r[3]),
      equipped: bool_(r[4]),
    });
  });
  return out;
}

/** GET ?action=profile&employee= — профиль без начисления и без механики. */
function getProfile_(employee) {
  employee = str_(employee);
  if (!employee) return { ok: false, error: 'Не указан сотрудник' };
  if (!isActiveEmployee_(employee)) return { ok: false, error: 'Сотрудник не найден или отключён', code: 'auth' };
  try {
    const ss = ss_();
    ensureProfileSheets_(ss);
    const catalog = readItemCatalog_(ss);
    const inventory = readInventory_(ss, employee, catalog);
    return {
      ok: true,
      employee,
      character: readCharacter_(ss, employee),
      equipped: inventory.filter(x => x.equipped),
      inventory,
      catalog,
    };
  } catch (e) {
    return { ok: false, error: 'Не удалось прочитать профиль: ' + e };
  }
}

/**
 * Применение эффектов предметов. ПОКА ВЫКЛЮЧЕНО: всегда возвращает нули.
 * Включать здесь и вызывать из:
 *   — duelApplyRound_() — урон (effect.type === 'урон');
 *   — duelStartRound_() — время раунда (effect.type === 'время');
 *   — duelTick_()/duelAnswer_() — щит (effect.type === 'щит');
 *   — подсчёта результата одиночной викторины (если решим давать бонусы там).
 * Правило: фильтр по режиму (рейтинговый/дружеский) и условию, затем
 * сложение значений с ограничениями. В рейтинговой дуэли бонусов быть не должно.
 */
function applyItemEffects_(context, equippedItems) {
  // context: { mode: 'duel'|'quiz', rated: true|false, category: 'Вино', ... }
  // equippedItems: строки из getProfile_().equipped.
  return { damage: 0, seconds: 0, shield: 0 };
}
