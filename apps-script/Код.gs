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
  refs:      'Эталоны уборки',      // зона → этаж, что проверять, эталонное фото (для ИИ-проверки)
  refPhotos: 'Эталоны — фото',      // несколько эталонных снимков на зону (для ИИ-проверки)
  questions: 'Вопросы',             // банк вопросов викторины (создаётся setupQuiz)
  disputes:  'Обжалования',         // жалобы на вопросы викторины (создаётся setupQuiz)
  duels:     'Дуэли',               // история матчей (создаётся автоматически)
  ratings:   'Рейтинг',             // Elo дуэли + агрегаты викторины (создаётся автоматически)
  quizTries: 'Викторина',           // сырые попытки викторины (создаётся автоматически)
  characters: 'Персонажи',          // персонаж сотрудника (создаётся автоматически)
  itemCatalog: 'Предметы',          // каталог предметов и эффектов (создаётся автоматически)
  inventory: 'Инвентарь',           // полученные предметы и экипировка (создаётся автоматически)
  shelfLife: 'Сроки хранения',      // сроки хранения заготовок для этикетки 30×20 (создаётся автоматически)
  facts:     'Факты',               // факт дня на главном экране (создаётся автоматически)
  checklists: 'Чек-листы',          // списки пунктов, которые правит владелец (создаётся автоматически)
  checklistMarks: 'Чек-листы — отметки', // история прохождений (создаётся автоматически)
  settings:  'Настройки',           // разделы приложения вкл/выкл (создаётся автоматически)
  pairs:     'Пары позиций',        // позиции, которые взвешивают вместе: мята — листья и ветки
  stopList:  'Стоп-лист',           // что закончилось: фото стоп-листа, позиции, дни в стопе
  stopStock: 'Стоп-лист — остатки', // количества из колонки «Блюда на остатке» (справка)
  kitchen:   'Кухня',               // позиции кухни и служебные строки: в стоп-лист бара не идут
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
  stoplist: 11, // Стоп-лист: K «id» (после «этаж»)
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
    if (action === 'photoVerdict') return json_(getPhotoVerdict_(e.parameter.id));
    if (action === 'photos') return json_(getPhotoHistory_(e.parameter.limit));
    if (action === 'stopList') return json_(getStopList_());
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
    if (body.action === 'checklistSave') return json_(checklistSave_(body));
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

  // Сроки хранения заготовок (для этикетки 30×20). Отдаём вместе со справочником,
  // чтобы телефон не делал отдельный запрос перед каждой печатью.
  const shelfLife = shelfLife_(ss);

  // Факт дня. Отдаём вместе со справочником: приложение не делает отдельный
  // запрос на старте и не ждёт его. Ошибка в листе «Факты» не должна ломать
  // справочник — тогда просто не будет строки.
  let factOfDay = null;
  try {
    factOfDay = factOfDay_(ss);
  } catch (e) {
    log_('Факт дня', 'не прочитан: ' + String(e && e.stack || e));
  }

  // Оформление приложения: «Списки»!F2 — обычное / зимнее / авто (пусто = авто)
  const theme = lists.length ? str_(lists[0][5]) : '';

  // Чек-листы: отдаём вместе со справочником, отдельного запроса на старте нет.
  // Ошибка в листе «Чек-листы» не должна ломать config — тогда списков просто нет.
  let checklists = [];
  try {
    checklists = checklists_(ss);
  } catch (e) {
    log_('Чек-листы', 'не прочитаны: ' + String(e && e.stack || e));
  }

  // Проверка фото: этажи зон и эталонные снимки. Старое поле «zones» остаётся
  // прежним массивом строк — новые поля только добавляются, старый клиент не ломается.
  // Миграция этажей и листа эталонов идёт здесь же и повторный вызов ничего не дублирует.
  let photoZones = zones.map(z => ({ zone: z, floor: '' }));
  let photoRefs = [];
  try {
    photoMigrate_(ss);
    photoZones = photoZones_(ss, zones);
    photoRefs = photoRefSummaries_(photoZones, photoRefPhotosAll_(ss));
  } catch (e) {
    log_('Проверка фото', 'этажи/эталоны не прочитаны: ' + String(e && e.stack || e));
  }

  // Флаги разделов: лист «Настройки». Нет листа, нет ключа или ошибка чтения —
  // раздел включён. Иначе опечатка в таблице могла бы оставить бар без приложения.
  let features = featuresDefault_();
  try {
    features = features_(ss);
  } catch (e) {
    log_('Настройки', 'не прочитаны, все разделы включены: ' + String(e && e.stack || e));
  }

  // Пары позиций (мята: листья и ветки). Ошибка чтения не ломает config —
  // приложение просто покажет одно поле, как раньше.
  let pairs = [];
  try {
    pairs = pairs_(ss);
  } catch (e) {
    log_('Пары позиций', 'не прочитаны: ' + String(e && e.stack || e));
  }

  // Стоп-лист: текущий список с числом дней в стопе, недочёты, настройки.
  // Истории по позициям здесь нет — она приходит отдельным action=stopList.
  // Ошибка в листе «Стоп-лист» не ломает справочник: просто не будет раздела.
  let stopList = null;
  try {
    stopList = stopListPublic_(stopListState_(ss), false);
  } catch (e) {
    log_('Стоп-лист', 'не прочитан: ' + String(e && e.stack || e));
  }

  return {
    theme, ok: true, employees, items, reasons, zones, ttk, inventory, acts, shelfLife, factOfDay, checklists,
    photoZones, photoRefs, photoRefLimit: PHOTO_MAX_REFS,
    features,
    pairs,
    stopList,
    directions: DIRECTIONS, units: UNITS };
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

/* =====================================================================
 *  ФЛАГИ РАЗДЕЛОВ — что показывать в приложении
 * =====================================================================
 *
 *  Лист «Настройки» (создаётся автоматически при первом чтении config):
 *    ключ | значение | комментарий
 *
 *  Значение: «вкл» / «выкл» (регистр не важен). Пусто = «вкл».
 *  Нет листа или нет ключа — раздел ВКЛЮЧЁН: опечатка в таблице не должна
 *  оставить бар без приложения. Неизвестное значение тоже считается
 *  включённым, а в «Лог» пишется предупреждение.
 *
 *  Флаги — только про вход в раздел. Очередь отправляется как раньше:
 *  записи, уже сохранённые на телефоне (викторина, чек-листы и т. п.),
 *  уходят на сервер независимо от флагов. Сервер записи не отклоняет.
 * ===================================================================== */

const SETTINGS_HEADERS = ['ключ', 'значение', 'комментарий'];

/** Ключи таблицы → поля config.features. Порядок = порядок строк в листе. */
const FEATURE_KEYS = [
  { code: 'quiz',       key: 'раздел_викторина',     note: 'Викторина — вопросы смены' },
  { code: 'duel',       key: 'раздел_дуэль',         note: 'Дуэль — игра на двоих' },
  { code: 'checklists', key: 'раздел_чеклисты',      note: 'Чек-листы — смены и заготовки' },
  { code: 'acts',       key: 'раздел_акты',          note: 'Переработка — акты и этикетки' },
  { code: 'photo',      key: 'раздел_фото',          note: 'Фото уборки — зоны после смены' },
  { code: 'stoplist',   key: 'раздел_стоплист',      note: 'Стоп-лист — что закончилось, дни в стопе' },
  { code: 'inventory',  key: 'раздел_инвентаризация', note: 'Инвентаризация — подсчёт остатков' },
  { code: 'ttk',        key: 'раздел_ттк',           note: 'ТТК — рецептуры' },
  { code: 'transfer',   key: 'раздел_перенос',       note: 'Перенос — кухня ⇄ бар' },
  { code: 'writeoff',   key: 'раздел_списание',      note: 'Списание — бой, порча, проливы' },
];

/** Все разделы включены — ответ по умолчанию, если лист не прочитался. */
function featuresDefault_() {
  const out = {};
  FEATURE_KEYS.forEach(function (f) { out[f.code] = true; });
  return out;
}

/**
 * «вкл» → true, «выкл» → false, пусто / непонятное → true.
 * Сравниваем по началу слова: «выкл.», «ВЫКЛ», «off», «нет» тоже поймутся.
 */
function featureOn_(v) {
  const s = str_(v).toLowerCase().replace(/[\s.]+$/g, '');
  if (!s) return true;
  if (/^(выкл|off|нет|no|false|0)/.test(s)) return false;
  if (/^(вкл|on|да|yes|true|1)/.test(s)) return true;
  return true;
}

/** Колонки ищутся по названиям в шапке — порядок можно менять. */
function settingsHeader_(sh) {
  const width = Math.max(sh.getLastColumn(), SETTINGS_HEADERS.length);
  const head = sh.getRange(1, 1, 1, width).getValues()[0].map(str_);
  return {
    key: head.indexOf(SETTINGS_HEADERS[0]),
    value: head.indexOf(SETTINGS_HEADERS[1]),
  };
}

/**
 * Все строки, которые должны быть в «Настройках»: ключи разделов + настройки
 * стоп-листа (числа и флаги проверок). Порядок = порядок на новом листе.
 */
function settingsSeedRows_() {
  const rows = FEATURE_KEYS.map(function (f) { return { key: f.key, value: 'вкл', note: f.note }; });
  STOP_SETTINGS.forEach(function (s) { rows.push({ key: s.key, value: s.value, note: s.note }); });
  return rows;
}

/**
 * Лист «Настройки»: создаёт и один раз заполняет ключами.
 * Существующий лист не перезаписывает — значения владельца остаются.
 * Недостающие ключи (раздел «стоп-лист» и настройки стоп-листа)
 * дописываются в конец: обновление кода не стирает правки владельца.
 */
function ensureSettingsSheet_(ss) {
  let sh = ss.getSheetByName(SHEETS.settings);
  if (sh) {
    ensureSettingsExtraRows_(sh);
    return sh;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return null;
  try {
    sh = ss.getSheetByName(SHEETS.settings);
    if (sh) { ensureSettingsExtraRows_(sh); return sh; }
    sh = ss.insertSheet(SHEETS.settings);
    sh.getRange(1, 1, 1, SETTINGS_HEADERS.length).setValues([SETTINGS_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 240);
    sh.setColumnWidth(2, 110);
    sh.setColumnWidth(3, 380);
    const seed = settingsSeedRows_();
    const rows = seed.map(function (s) { return [text_(s.key, 80), text_(s.value, 40), text_(s.note, 200)]; });
    sh.getRange(2, 1, rows.length, SETTINGS_HEADERS.length).setValues(rows);
    // Выпадающий список, чтобы не приходилось угадывать написание; вписать своё всё равно можно.
    sh.getRange(2, 2, Math.max(rows.length, 50), 1)
      .setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(['вкл', 'выкл'], true).build());
    log_('Настройки', 'создан лист «' + SHEETS.settings + '», ключей: ' + seed.length);
    ensureSettingsExtraRows_(sh);
    return sh;
  } catch (e) {
    sh = ss.getSheetByName(SHEETS.settings);
    if (sh) return sh;
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Дописывает в «Настройки» недостающие строки (новые ключи разделов и
 * настройки стоп-листа). Существующие ключи не трогает.
 */
function ensureSettingsExtraRows_(sh) {
  if (!sh) return 0;
  try {
    dropCanceledSettings_(sh);
    const h = settingsHeader_(sh);
    const keyCol = h.key < 0 ? 0 : h.key;
    const last = sh.getLastRow();
    const have = {};
    if (last >= 2) {
      sh.getRange(2, keyCol + 1, last - 1, 1).getValues().forEach(function (r) {
        const k = str_(r[0]);
        if (k) have[k] = true;
      });
    }
    const add = settingsSeedRows_().filter(function (s) { return !have[s.key]; });
    if (!add.length) return 0;
    sh.getRange(last + 1, 1, add.length, SETTINGS_HEADERS.length)
      .setValues(add.map(function (s) { return [text_(s.key, 80), text_(s.value, 40), text_(s.note, 200)]; }));
    log_('Настройки', 'дописаны ключи: ' + add.map(function (s) { return s.key; }).join(', '));
    return add.length;
  } catch (e) {
    log_('Настройки', 'ключи не дописаны: ' + e);
    return 0;
  }
}

/**
 * Убирает из «Настроек» ключи отменённых проверок (их добавила прошлая
 * версия, владелец их не заводил). Чужие строки не трогаем: удаляем только
 * точное совпадение ключа из STOP_CANCELED_SETTINGS.
 */
function dropCanceledSettings_(sh) {
  const h = settingsHeader_(sh);
  const keyCol = h.key < 0 ? 0 : h.key;
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const keys = sh.getRange(2, keyCol + 1, last - 1, 1).getValues();
  let removed = 0;
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = str_(keys[i][0]);
    if (STOP_CANCELED_SETTINGS.indexOf(k) === -1) continue;
    sh.deleteRow(i + 2);
    removed++;
  }
  if (removed) log_('Настройки', 'удалены отменённые ключи: ' + removed);
  return removed;
}

/** Значения из «Настроек»: { 'раздел_викторина': 'выкл', ... }. */
function settingsValues_(ss) {
  const sh = ensureSettingsSheet_(ss);
  if (!sh) return {};
  const h = settingsHeader_(sh);
  if (h.value < 0) return {};
  const keyCol = h.key < 0 ? 0 : h.key;
  const out = {};
  rows_(ss, SHEETS.settings).forEach(function (r) {
    const k = str_(r[keyCol]);
    if (k) out[k] = r[h.value];
  });
  return out;
}

/** {quiz:true, duel:false, ...} — всегда все девять ключей. */
function features_(ss) {
  const values = settingsValues_(ss);
  const out = {};
  FEATURE_KEYS.forEach(function (f) {
    const raw = str_(values[f.key]);
    out[f.code] = featureOn_(raw);
    // Значение не распознали — раздел оставили включённым, но след в «Логе» нужен.
    if (raw && !/^(вкл|выкл|on|off|да|нет|yes|no|true|false|1|0)/i.test(raw)) {
      log_('Настройки', 'непонятное значение у «' + f.key + '»: «' + raw + '» — считаю «вкл»');
    }
  });
  return out;
}

/** Ручной запуск из редактора: создать лист «Настройки» и заполнить ключами. */
function setupSettings() {
  const sh = ensureSettingsSheet_(ss_());
  log_('Настройки', 'setupSettings: ' + (sh ? 'лист готов' : 'лист не создан'));
}


/* =====================================================================
 *  ПАРЫ ПОЗИЦИЙ — что взвешивают вместе (мята: листья и ветки)
 * =====================================================================
 *
 *  Лист «Пары позиций» (создаётся автоматически при первом чтении config):
 *    позиция_A | позиция_B | доля_A | доля_B | активен | комментарий
 *
 *  Доли — от общей массы: A + B = 1.0. Пример для мяты: 0.6 / 0.4.
 *  Это стартовое значение, владелец поправит его по факту взвешивания.
 *  Если сумма не равна 1.0, сервер НЕ падает: нормализует доли и пишет
 *  предупреждение в «Лог». Приложение получает уже нормализованные доли.
 *
 *  В форме акта позиция из активной пары показывается двумя полями
 *  («листья, г» / «ветки, г»), и ввод в любое поле пересчитывает второе.
 *  В акт пишутся оба значения и то, какое поле взвешено вручную:
 *  «Акты переработки», новые колонки Q–V (см. ACT_PAIR_HEADERS).
 *
 *  На расчёт выхода акта пара НЕ влияет: в «Сырьё»/«Результат» идёт
 *  количество позиции своей строки (например, листья), вторая доля —
 *  справочная (ветки — отход). Это сохраняет прежние формулы выхода.
 * ===================================================================== */

const PAIR_HEADERS = ['позиция_A', 'позиция_B', 'доля_A', 'доля_B', 'активен', 'комментарий'];

/** Первое заполнение: мята. Дальше владелец добавляет строки сам, код не нужен. */
const PAIR_SEED = [
  { a: 'Мята (листья)', b: 'Мята (ветки)', shareA: 0.6, shareB: 0.4,
    note: 'стартовое значение 0.6 / 0.4 — поправьте по факту взвешивания' },
];

const ACT_PAIR_HEADERS = ['пара_позиция', 'пара_кол-во', 'доля_A', 'доля_B', 'взвешено', 'всего, г'];

/** Пустая галочка = пара включена; «нет»/«выкл»/0 — выключена. */
function pairActive_(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = str_(v).toLowerCase().replace(/[\s.]+$/g, '');
  if (!s) return true;
  return !/^(нет|выкл|off|no|false|0)/.test(s);
}

/** Сравнение названий позиций: регистр, «ё», лишние пробелы. */
function sameName_(a, b) {
  const k = function (v) { return str_(v).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim(); };
  return !!k(a) && k(a) === k(b);
}

/** Колонки ищутся по названиям в шапке — порядок можно менять. */
function pairsHeader_(sh) {
  const width = Math.max(sh.getLastColumn(), PAIR_HEADERS.length);
  const head = sh.getRange(1, 1, 1, width).getValues()[0].map(str_);
  return {
    a: head.indexOf(PAIR_HEADERS[0]),
    b: head.indexOf(PAIR_HEADERS[1]),
    shareA: head.indexOf(PAIR_HEADERS[2]),
    shareB: head.indexOf(PAIR_HEADERS[3]),
    active: head.indexOf(PAIR_HEADERS[4]),
    note: head.indexOf(PAIR_HEADERS[5]),
  };
}

/** Лист «Пары позиций»: создаёт и один раз заполняет парой для мяты. */
function ensurePairsSheet_(ss) {
  let sh = ss.getSheetByName(SHEETS.pairs);
  if (sh) return sh;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return null;
  try {
    sh = ss.getSheetByName(SHEETS.pairs);
    if (sh) return sh;
    sh = ss.insertSheet(SHEETS.pairs);
    sh.getRange(1, 1, 1, PAIR_HEADERS.length).setValues([PAIR_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 220);
    sh.setColumnWidth(2, 220);
    sh.setColumnWidth(3, 80);
    sh.setColumnWidth(4, 80);
    sh.setColumnWidth(5, 80);
    sh.setColumnWidth(6, 420);
    seedPairs_(sh);
    log_('Пары позиций', 'создан лист «' + SHEETS.pairs + '», пар: ' + PAIR_SEED.length);
    return sh;
  } catch (e) {
    sh = ss.getSheetByName(SHEETS.pairs);
    if (sh) return sh;
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** Пишет стартовую пару для мяты и ставит галочку «активен». */
function seedPairs_(sh) {
  const rows = PAIR_SEED.map(function (p) {
    return [text_(p.a, 120), text_(p.b, 120), p.shareA, p.shareB, true, text_(p.note, 300)];
  });
  sh.getRange(2, 1, rows.length, PAIR_HEADERS.length).setValues(rows);
  sh.getRange(2, 5, rows.length, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
}

/**
 * Активные пары с нормализованными долями:
 * [{ a, b, shareA, shareB, comment }].
 * Неверные строки (пусто, одинаковые позиции, доля ≤ 0) пропускаются с записью в «Лог».
 */
function pairs_(ss) {
  const sh = ensurePairsSheet_(ss);
  if (!sh) return [];
  const h = pairsHeader_(sh);
  if (h.a < 0 || h.b < 0 || h.shareA < 0 || h.shareB < 0) return [];

  const out = [];
  const seen = {};
  rows_(ss, SHEETS.pairs).forEach(function (r) {
    const a = str_(r[h.a]);
    const b = str_(r[h.b]);
    if (!a || !b) return;
    if (sameName_(a, b)) {
      log_('Пары позиций', 'пропущена пара с одинаковыми позициями: ' + a);
      return;
    }
    if (!pairActive_(h.active >= 0 ? r[h.active] : true)) return;
    let sa = num_(r[h.shareA]);
    let sb = num_(r[h.shareB]);
    if (!(sa > 0) || !(sb > 0)) {
      log_('Пары позиций', 'пропущена пара без долей: ' + a + ' / ' + b);
      return;
    }
    const sum = sa + sb;
    if (Math.abs(sum - 1) > 0.001) {
      const origSum = sum;
      sa = sa / sum;
      sb = sb / sum;
      log_('Пары позиций', 'сумма долей ' + Math.round(origSum * 1000) / 1000 + ' у «' + a + ' / ' + b +
        '» — доли нормализованы: ' + Math.round(sa * 1000) / 1000 + ' / ' + Math.round(sb * 1000) / 1000);
    }
    // Одна позиция — одна пара: первая активная строка выигрывает, остальные в «Лог».
    const ka = str_(a).toLowerCase();
    const kb = str_(b).toLowerCase();
    if (seen[ka] || seen[kb]) {
      log_('Пары позиций', 'пропущена вторая пара для той же позиции: ' + a + ' / ' + b);
      return;
    }
    seen[ka] = true;
    seen[kb] = true;
    out.push({
      a: a, b: b,
      shareA: Math.round(sa * 1000) / 1000,
      shareB: Math.round(sb * 1000) / 1000,
      comment: h.note >= 0 ? str_(r[h.note]) : '',
    });
  });
  return out;
}

/** Сторона пары для позиции: { name, share, isA } или null. */
function pairSide_(pair, name) {
  if (sameName_(pair.a, name)) return { name: pair.a, share: pair.shareA, isA: true };
  if (sameName_(pair.b, name)) return { name: pair.b, share: pair.shareB, isA: false };
  return null;
}

/**
 * Данные пары из строки акта. Возвращает null, если пары нет, она выключена
 * или данные неверные — тогда строка сохраняется как обычная, без пары.
 *
 * line.pair = { item: '<вторая позиция>', qty: <граммы>, source: 'own'|'other' }.
 * source = 'own' — взвесили позицию этой строки, второе значение считаем;
 * source = 'other' — взвесили вторую позицию, количество строки пересчитываем.
 */
function actPairForLine_(pairs, line, baseQty) {
  const p = line && line.pair;
  if (!p || typeof p !== 'object') return null;
  const item = str_(line.item);
  const partner = str_(p.item);
  if (!item || !partner) return null;

  const pair = (pairs || []).find(function (x) {
    return (sameName_(x.a, item) && sameName_(x.b, partner)) ||
           (sameName_(x.b, item) && sameName_(x.a, partner));
  });
  if (!pair) {
    log_('Пары позиций', 'в акте нет активной пары «' + item + '» / «' + partner + '» — строка без пары');
    return null;
  }
  const side = pairSide_(pair, item);
  const other = pairSide_(pair, partner);
  if (!side || !other) return null;

  const source = str_(p.source) === 'other' ? 'other' : 'own';
  let ownQty = Math.round(Number(baseQty) || 0);
  let partnerQty = 0;
  if (source === 'other') {
    const weighed = Number(p.qty);
    if (!(weighed >= 0 && weighed < 1000000)) return null;
    partnerQty = Math.round(weighed);
    ownQty = Math.round(partnerQty * side.share / other.share);
  } else {
    partnerQty = Math.round(ownQty * other.share / side.share);
  }
  if (!(ownQty >= 0) || !(partnerQty >= 0) || ownQty + partnerQty <= 0) return null;

  return {
    item: other.name,             // вторая позиция (например, «Мята (ветки)»)
    qty: partnerQty,              // её граммы
    shareA: pair.shareA,
    shareB: pair.shareB,
    weighed: source === 'own' ? side.name : other.name,
    total: ownQty + partnerQty,
    ownQty: ownQty,
  };
}

/** Колонки пары в «Актах переработки»: { 'пара_позиция': 17, ... } (1 = A). */
function actPairColumns_(sheet) {
  const width = Math.max(sheet.getLastColumn(), 16);
  const head = sheet.getRange(1, 1, 1, width).getValues()[0].map(str_);
  const idx = {};
  ACT_PAIR_HEADERS.forEach(function (name) { idx[name] = head.indexOf(name) + 1; }); // 0 → «нет»
  return idx;
}

/**
 * Дописывает колонки Q–V в «Акты переработки», если их нет.
 * Существующие A–P не трогает, порядок и формулы не меняет.
 */
function ensureActPairColumns_(sheet) {
  let idx = actPairColumns_(sheet);
  if (idx[ACT_PAIR_HEADERS[0]] > 0) return idx;

  const width = Math.max(sheet.getLastColumn(), 16);
  const head = sheet.getRange(1, 1, 1, width).getValues()[0].map(str_);
  let last = 0;
  head.forEach(function (v, i) { if (str_(v)) last = i + 1; });
  const start = Math.max(last, 16) + 1;
  sheet.getRange(1, start, 1, ACT_PAIR_HEADERS.length)
    .setValues([ACT_PAIR_HEADERS]).setFontWeight('bold');
  for (let i = 0; i < ACT_PAIR_HEADERS.length; i++) sheet.setColumnWidth(start + i, i === 0 ? 160 : 100);
  log_('Пары позиций', 'в «' + SHEETS.acts + '» добавлены колонки ' + start + '–' + (start + ACT_PAIR_HEADERS.length - 1));
  return actPairColumns_(sheet);
}

/** Значения Q–V для строки акта (пустые, если пары нет). */
function actPairRow_(pair) {
  if (!pair) return ['', '', '', '', '', ''];
  return [text_(pair.item, 120), pair.qty, pair.shareA, pair.shareB, text_(pair.weighed, 120), pair.total];
}

/** Ручной запуск из редактора: создать «Пары позиций» и колонки Q–V в актах. */
function setupPairs() {
  const ss = ss_();
  const sh = ensurePairsSheet_(ss);
  const acts = ss.getSheetByName(SHEETS.acts);
  if (acts) ensureActPairColumns_(acts);
  log_('Пары позиций', 'setupPairs: ' + (sh ? 'лист готов' : 'лист не создан') +
    (acts ? ', колонки акта готовы' : ', листа актов нет'));
}


/* =====================================================================
 *  СРОКИ ХРАНЕНИЯ — справочник для этикетки 30×20
 * =====================================================================
 *
 *  Лист «Сроки хранения» (создаётся автоматически при первом чтении config):
 *    заготовка | короткое_имя | срок_часов | примечание | активен
 *
 *  «заготовка» — название результата акта (по нему ищем строку).
 *  «короткое_имя» — что печатать на этикетке вместо полного названия;
 *  пусто — печатаем полное. Это решение владельца, а не обрезка в приложении:
 *  «Кордиал Лимонграсс–Бузина–Лаванда» на 30 мм целиком не читается.
 *  Срок — в часах, можно дробный (0,5 = 30 минут).
 *  «активен» — галочка; снятая галочка убирает строку из config, но не удаляет.
 *
 *  Первое заполнение — из названий результатов актов переработки и ТТК
 *  со сроком 24 часа и пометкой «значение по умолчанию, проверьте»:
 *  цифры должны быть настоящими, их знает только владелец. Короткие имена
 *  не выдумываем — колонка остаётся пустой, её заполняет владелец.
 * ===================================================================== */

const SHELF_LIFE_DEFAULT_HOURS = 24;
const SHELF_LIFE_NOTE = 'значение по умолчанию, проверьте';
const SHELF_LIFE_HEADERS = ['заготовка', 'короткое_имя', 'срок_часов', 'примечание', 'активен'];

/** Колонки ищутся по названиям в шапке — порядок не ломается при правках владельца. */
function shelfLifeHeader_(sh) {
  const width = Math.max(sh.getLastColumn(), SHELF_LIFE_HEADERS.length);
  const head = sh.getRange(1, 1, 1, width).getValues()[0].map(str_);
  return {
    name: head.indexOf(SHELF_LIFE_HEADERS[0]),
    short: head.indexOf(SHELF_LIFE_HEADERS[1]),
    hours: head.indexOf(SHELF_LIFE_HEADERS[2]),
    note: head.indexOf(SHELF_LIFE_HEADERS[3]),
    active: head.indexOf(SHELF_LIFE_HEADERS[4]),
  };
}

/**
 * Лист «Сроки хранения»: находит или создаёт, приводит шапку к текущему
 * формату (5 колонок), пишет первое заполнение.
 * Повторный запуск ничего не дублирует и не переставляет данные.
 */
function ensureShelfLifeSheet_(ss) {
  let sh = ss.getSheetByName(SHEETS.shelfLife);
  if (!sh) {
    try {
      sh = ss.insertSheet(SHEETS.shelfLife);
    } catch (e) {
      // Параллельный запрос успел создать лист — просто берём его
      sh = ss.getSheetByName(SHEETS.shelfLife);
    }
    if (!sh) throw new Error('Не удалось создать лист «' + SHEETS.shelfLife + '»');
    log_('Сроки хранения', 'создан лист «' + SHEETS.shelfLife + '»');
  }

  let h = shelfLifeHeader_(sh);
  if (h.name === -1 || h.hours === -1) {
    // Пустой лист или шапки нет — пишем шапку целиком
    sh.getRange(1, 1, 1, SHELF_LIFE_HEADERS.length).setValues([SHELF_LIFE_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 300);
    sh.setColumnWidth(2, 220);
    sh.setColumnWidth(4, 300);
    h = shelfLifeHeader_(sh);
  } else if (h.short === -1) {
    // Старый формат (4 колонки, без «короткое_имя»): вставляем колонку B,
    // чтобы остальные данные не поехали. Проверяем по шапке, поэтому
    // повторный запуск колонку не добавит.
    sh.insertColumnBefore(2);
    sh.getRange(1, 2).setValue(SHELF_LIFE_HEADERS[1]).setFontWeight('bold');
    sh.setColumnWidth(2, 220);
    log_('Сроки хранения', 'добавлена колонка «короткое_имя»');
    h = shelfLifeHeader_(sh);
  }

  if (sh.getLastRow() < 2) seedShelfLife_(ss, sh);
  return h;
}

/** Первое заполнение справочника: результаты актов + названия из ТТК, все по 24 ч. */
function seedShelfLife_(ss, sh) {
  const names = [];
  const seen = {};
  const add = function (v) {
    const n = str_(v);
    if (!n) return;
    const key = n.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
    if (seen[key]) return;
    seen[key] = true;
    names.push(n);
  };
  actTemplates_(ss).forEach(function (a) { if (a.output) add(a.output.item); });
  rows_(ss, SHEETS.ttk).forEach(function (r) { add(r[0]); });
  if (!names.length) return 0;

  const values = names.map(function (n) {
    // короткое_имя пустое: на этикетке печатается полное название,
    // пока владелец не напишет своё
    return [text_(n, 200), '', SHELF_LIFE_DEFAULT_HOURS, SHELF_LIFE_NOTE, true];
  });
  sh.getRange(2, 1, values.length, SHELF_LIFE_HEADERS.length).setValues(values);
  log_('Сроки хранения', 'заполнено строк: ' + values.length + ' (по ' + SHELF_LIFE_DEFAULT_HOURS + ' ч)');
  return values.length;
}

/**
 * Справочник сроков для телефона: только активные строки.
 * Пустой или нулевой срок считаем «не задан» и отдаём 24 ч —
 * приложение тогда подставляет 24 и честно пишет об этом на экране.
 */
function shelfLife_(ss) {
  const h = ensureShelfLifeSheet_(ss);
  return rows_(ss, SHEETS.shelfLife)
    .filter(function (r) { return str_(r[h.name]) && r[h.active] !== false; })
    .map(function (r) {
      const hours = num_(r[h.hours]);
      return {
        name: str_(r[h.name]),
        short: h.short >= 0 ? str_(r[h.short]) : '',
        hours: hours > 0 ? hours : SHELF_LIFE_DEFAULT_HOURS,
        note: h.note >= 0 ? str_(r[h.note]) : '',
      };
    });
}

/* =====================================================================
 *  ФАКТ ДНЯ — одна строка на главном экране
 * =====================================================================
 *
 *  Лист «Факты» (создаётся автоматически при первом чтении справочника):
 *    id | текст | источник | активен | дата_показа
 *
 *  «текст» — одна короткая фраза (до 180 символов), «источник» — книга,
 *  сайт или документ, откуда факт взят. «активен» — галочка.
 *  «дата_показа» бэкенд пишет сам, когда факт реально ушёл в приложение:
 *  по ней видно, какие факты ещё не показывались.
 *
 *  Выбор — только на сервере и только по дате:
 *    номер дня по UTC+3 (Москва) по модулю числа активных фактов,
 *    сортировка по id. Двое барменов в один момент видят один и тот же
 *    факт, а на следующий день — следующий.
 *
 *  Факт приходит вместе с config, отдельного запроса на старте нет.
 *  Пустой лист или все галочки сняты — возвращаем null, строки в
 *  приложении просто нет.
 * ===================================================================== */

const FACT_HEADERS = ['id', 'текст', 'источник', 'активен', 'дата_показа'];
const FACT_MAX_TEXT = 180;
const FACT_DAY_MS = 24 * 3600 * 1000;
const FACT_TZ_OFFSET_MS = 3 * 3600 * 1000; // UTC+3: в Москве нет перехода на летнее время

/**
 * Первое заполнение листа. 40 фактов: 25 общих (история баров, коктейлей
 * и джаза) и 15 про бар ESSE — из чек-листов и коктейльной карты «Лето 25».
 * Все тексты короче 180 символов. Спорные версии происхождения помечены
 * словами «связывают» / «по распространённой версии».
 */
const FACTS_SEED = [
  { text: 'В 1806 году «коктейль» впервые определили как смесь спиртного, сахара, воды и биттеров.',
    source: 'The Balance and Columbian Repository, 13.05.1806' },
  { text: 'На открытии смены на 2 этаже ESSE включают подачу газа к пиву.',
    source: 'Чек листы бармена Эссе — Открытие 2 этаж' },
  { text: 'Одно из первых печатных упоминаний слова cocktail — 1798 год, лондонская The Morning Post.',
    source: 'The Morning Post and Gazetteer, 20.03.1798' },
  { text: 'Морс в ESSE готовят из 800 г клюквы, 400 г сахара и 500 мл горячей воды.',
    source: 'Чек листы бармена Эссе — Лайн-чек' },
  { text: 'Первый в США сборник рецептов бармена — «How to Mix Drinks» Джерри Томаса, 1862 год.',
    source: 'Jerry Thomas, How to Mix Drinks (1862)' },
  { text: 'Малиновую заготовку в ESSE делают из 500 г малины и 500 мл малинового сиропа.',
    source: 'Чек листы бармена Эссе — Лайн-чек' },
  { text: 'Биттеры Angostura создал в 1824 году врач Иоганн Зигерт в Венесуэле.',
    source: 'Angostura — Our Story' },
  { text: 'Имбирная заготовка ESSE — равные части имбиря, лимона и мёда, по 300 г.',
    source: 'Чек листы бармена Эссе — Лайн-чек' },
  { text: 'Вермут как категорию придумал в Турине в 1786 году Антонио Бенедетто Карпано.',
    source: 'Carpano — The History' },
  { text: 'Кордиал «Красный дракон» в ESSE готовят в су-виде 1 час при 57 °C.',
    source: 'Чек листы бармена Эссе — Лайн-чек' },
  { text: 'Sazerac — официальный коктейль Нового Орлеана с 2008 года.',
    source: 'Louisiana State Legislature, Act 928 (2008)' },
  { text: 'В грейпфрутовую пену ESSE кладут 6 г бентонита и 3 г ксантановой камеди.',
    source: 'Чек листы бармена Эссе — Лайн-чек' },
  { text: 'Рецепт «Дайкири» связывают с американским инженером Дженнингсом Коксом и 1898 годом.',
    source: 'Wikipedia — Daiquiri' },
  { text: 'Заготовку для «Кровавой мэри» в ESSE готовят в су-виде 3 часа при 53 °C.',
    source: 'Чек листы бармена Эссе — Лайн-чек' },
  { text: 'Американский бар Harry’s New York Bar открылся в Париже в 1911 году.',
    source: 'The New York Times, 24.11.1961' },
  { text: 'В кордиале «Грейпфрут–клюква–тимьян» ESSE всего 1 г тимьяна.',
    source: 'Чек листы бармена Эссе — Лайн-чек' },
  { text: 'Франция запретила абсент в 1915 году и снова разрешила его производство в 2011-м.',
    source: 'Radio France, 16.03.1915' },
  { text: 'Облепиховую заготовку ESSE пробивают с 150 г груши.',
    source: 'Чек листы бармена Эссе — Лайн-чек' },
  { text: 'Первые записи джаза сделала в 1917 году Original Dixieland Jass Band.',
    source: 'The New York Times, 28.06.1987' },
  { text: 'Бойлер от накипи в баре ESSE чистят раз в две недели.',
    source: 'Чек листы бармена Эссе — Уборка' },
  { text: 'В США сухой закон действовал с 1920 по 1933 год.',
    source: 'Wikipedia — Prohibition in the United States' },
  { text: 'Коктейль «Опунция IV» вдохновлён альбомом IV группы BADBADNOTGOOD.',
    source: 'Лето 25 — Опунция IV' },
  { text: '«Кровавую мэри», по распространённой версии, придумал в 1921 году Фернан Петио в Harry’s New York Bar.',
    source: 'RTBF — Bloody Mary' },
  { text: '«Лавандовый туман» построен на ощущении пространства в поздних альбомах Джона Колтрейна.',
    source: 'Лето 25 — Лавандовый туман' },
  { text: 'Cotton Club открылся в Гарлеме в 1923 году.',
    source: 'Oxford Reference — Cotton Club' },
  { text: 'Коктейль «Эманон» назван в честь альбома Уэйна Шортера о путешествии без карты.',
    source: 'Лето 25 — Эманон' },
  { text: '«Мимозу» связывают с парижским Ritz и барменом Фрэнком Мейером, около 1925 года.',
    source: 'Wikipedia — Mimosa (cocktail)' },
  { text: '«Бардо» вдохновлён альбомом A Humdrum Star группы GoGo Penguin.',
    source: 'Лето 25 — Бардо' },
  { text: 'В 1934 году в Калифорнии открылись Don the Beachcomber и Trader Vic’s — будущие тики-бары.',
    source: 'WGBH — Tiki Drink Culture' },
  { text: '«Полуночный блюз» посвящён альбому Black Coffee Пегги Ли.',
    source: 'Лето 25 — Полуночный блюз' },
  { text: 'Village Vanguard открылся в Нью-Йорке в 1935 году.',
    source: 'The New York Times, 22.02.2015' },
  { text: 'Лейбл Blue Note основан в Нью-Йорке в 1939 году.',
    source: 'Blue Note Records — 80th Anniversary' },
  { text: 'По распространённой версии, «Московский мул» придумали в 1941 году в лос-анджелесском баре Cock ’n Bull.',
    source: 'Oxford Reference — Moscow Mule' },
  { text: '«Беллини» создал Джузеппе Чиприани в Венеции в 1948 году.',
    source: 'Cipriani — Heritage' },
  { text: 'Ньюпортский джазовый фестиваль впервые прошёл в 1954 году.',
    source: 'The New York Times, 03.07.1993' },
  { text: 'Montreux Jazz Festival основал Клод Нобс в 1967 году.',
    source: 'The New York Times, 12.01.2013' },
  { text: 'Первый «Мишлен» выпустили в 1900 году как бесплатный справочник для автомобилистов.',
    source: 'Michelin Guide — History' },
  { text: 'Звёзды «Мишлен» впервые появились в 1926 году.',
    source: 'Michelin Guide — History' },
  { text: 'В 1806 году Фредерик Тюдор начал возить лёд из Бостона в Карибы.',
    source: 'Gavin Weightman, The Frozen Water Trade' },
  { text: 'Слово restaurant во французском сначала означало укрепляющий бульон, а не заведение.',
    source: 'Merriam-Webster — The History of Restaurant' },
];

/** Колонки ищем по названиям в шапке — порядок не ломается при правках владельца. */
function factsHeader_(sh) {
  const width = Math.max(sh.getLastColumn(), FACT_HEADERS.length);
  const head = sh.getRange(1, 1, 1, width).getValues()[0].map(str_);
  return {
    id: head.indexOf(FACT_HEADERS[0]),
    text: head.indexOf(FACT_HEADERS[1]),
    source: head.indexOf(FACT_HEADERS[2]),
    active: head.indexOf(FACT_HEADERS[3]),
    shown: head.indexOf(FACT_HEADERS[4]),
  };
}

/** Галочка (true), а также «да»/«true»/«1» — на случай, если владелец впишет текст. */
function factActive_(v) {
  if (v === true) return true;
  const s = str_(v).toLowerCase();
  return s === 'да' || s === 'true' || s === '1' || s === 'yes' || s === 'истина';
}

/**
 * Лист «Факты». Если листа нет — создаёт и один раз заполняет 40 фактами.
 * Если лист есть, но пуст, ничего не досеивает: пустой лист = «факта нет»
 * (так владелец может временно выключить строку, не удаляя лист).
 */
function ensureFactsSheet_(ss) {
  let sh = ss.getSheetByName(SHEETS.facts);
  if (sh) return sh;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return null;
  try {
    sh = ss.getSheetByName(SHEETS.facts);
    if (sh) return sh;
    sh = ss.insertSheet(SHEETS.facts);
    sh.getRange(1, 1, 1, FACT_HEADERS.length).setValues([FACT_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 70);
    sh.setColumnWidth(2, 620);
    sh.setColumnWidth(3, 320);
    sh.setColumnWidth(4, 80);
    sh.setColumnWidth(5, 120);
    seedFacts_(sh);
    log_('Факт дня', 'создан лист «' + SHEETS.facts + '», фактов: ' + FACTS_SEED.length);
    return sh;
  } catch (e) {
    // Параллельный запрос мог создать лист первым — берём уже готовый
    sh = ss.getSheetByName(SHEETS.facts);
    if (sh) return sh;
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** Записывает 40 стартовых фактов и ставит галочки-чекбоксы в колонке «активен». */
function seedFacts_(sh) {
  const rows = FACTS_SEED.map(function (f, i) {
    return [
      text_('f' + String(i + 1).padStart(3, '0'), 20),
      text_(f.text, FACT_MAX_TEXT),
      text_(f.source, 300),
      true,
      '',
    ];
  });
  sh.getRange(2, 1, rows.length, FACT_HEADERS.length).setValues(rows);
  sh.getRange(2, 4, rows.length, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  sh.getRange(2, 5, rows.length, 1).setNumberFormat('@'); // дата_показа — текст ISO
}

/** Детерминированный выбор по номеру дня: сортировка по id, затем по модулю. */
function pickFactForDay_(facts, day) {
  if (!facts || !facts.length) return null;
  const sorted = facts.slice().sort(function (a, b) {
    return a.id.localeCompare(b.id, 'en', { numeric: true });
  });
  return sorted[Math.abs(day) % sorted.length];
}

/** Факт дня: { id, text, source } или null. */
function factOfDay_(ss) {
  const sh = ensureFactsSheet_(ss);
  if (!sh) return null;
  const h = factsHeader_(sh);
  if (h.id < 0 || h.text < 0 || h.active < 0) return null;

  const facts = rows_(ss, SHEETS.facts)
    .filter(function (r) {
      return str_(r[h.id]) && str_(r[h.text]) && factActive_(r[h.active]);
    })
    .map(function (r) {
      return {
        id: str_(r[h.id]),
        text: str_(r[h.text]),
        source: h.source >= 0 ? str_(r[h.source]) : '',
      };
    });

  if (!facts.length) return null;

  const now = new Date();
  const day = Math.floor((now.getTime() + FACT_TZ_OFFSET_MS) / FACT_DAY_MS);
  const fact = pickFactForDay_(facts, day);
  if (fact) markFactShown_(sh, h, fact.id, now);
  return fact;
}

/** Пишет дату показа (UTC+3) в строку факта, но не чаще одного раза в день. */
function markFactShown_(sh, h, id, now) {
  if (h.shown < 0) return;
  const last = sh.getLastRow();
  if (last < 2) return;

  const ids = sh.getRange(2, h.id + 1, last - 1, 1).getValues();
  let row = -1;
  for (let i = 0; i < ids.length; i++) {
    if (str_(ids[i][0]) === id) { row = i + 2; break; }
  }
  if (row < 0) return;

  const cell = sh.getRange(row, h.shown + 1);
  const today = Utilities.formatDate(now, 'Europe/Moscow', 'yyyy-MM-dd');
  const cur = cell.getValue();
  const curText = cur instanceof Date
    ? Utilities.formatDate(cur, 'Europe/Moscow', 'yyyy-MM-dd')
    : str_(cur).slice(0, 10);
  if (curText === today) return;
  cell.setValue(today);
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
 *  ЧЕК-ЛИСТЫ
 * =====================================================================
 *
 *  Что это: списки пунктов, которые бармен отмечает на смене. Содержимое —
 *  данные, а не код: владелец добавляет и правит пункты прямо в таблице.
 *
 *  Два листа (создаются сами при первом чтении справочника):
 *    «Чек-листы» — что отмечать:
 *      список | порядок | пункт | подсказка | фото_обязательно | активен
 *    «Чек-листы — отметки» — история прохождений:
 *      дата | время | сотрудник | список | прогон_id | пункт | отмечено |
 *      комментарий | фото
 *
 *  Списки уходят в приложение вместе с config (?action=config), поэтому на
 *  старте нет отдельного запроса. Если лист пуст или все галочки сняты —
 *  массив пустой, приложение просто не рисует плитку.
 *
 *  Идемпотентность: прогон_id придумывает телефон. Повторная отправка того
 *  же прогона не создаёт вторую строку для того же пункта (runId + пункт).
 *  Это важно при плохой сети: запрос мог дойти, а ответ — нет.
 *
 *  Фото: если пункт с «фото_обязательно = да» пришёл без фото, строку всё
 *  равно пишем (работа бармена не должна пропадать), а в комментарий
 *  добавляем «нет фото (обязательно)» — владелец увидит. Файлы лежат на
 *  Диске в папке «Бар — фото чек-листов» по месяцам, в листе — ссылка.
 * ===================================================================== */

const CHECKLIST_HEADERS = ['список', 'порядок', 'пункт', 'подсказка', 'фото_обязательно', 'активен'];
const CHECKLIST_MARK_HEADERS = ['дата', 'время', 'сотрудник', 'список', 'прогон_id', 'пункт', 'отмечено', 'комментарий', 'фото'];
const CHECKLIST_MAX_ITEMS = 200;
const CHECKLIST_MAX_TEXT = 200;
const CHECKLIST_MAX_HINT = 300;
const CHECKLIST_MAX_COMMENT = 500;

/**
 * Стартовые списки. Это только первый посев: дальше владелец правит лист
 * «Чек-листы». Формулировки повелительные и конкретные — чтобы было понятно,
 * что именно проверить.
 */
const CHECKLIST_SEED = [
  {
    list: 'Открытие бара',
    items: [
      { text: 'Протереть витрину и полки', hint: 'Стекло без разводов, бутылки подписаны и стоят по местам.', photo: true },
      { text: 'Включить кассу и проверить терминал', hint: 'Касса включается, терминал видит сеть, чек печатается.', photo: false },
      { text: 'Проверить запас льда', hint: 'Лёдница полная, лёд не слипся.', photo: false },
      { text: 'Протереть стаканы и бокалы', hint: 'Посуда без пятен и сколов, бокалы под коктейли на месте.', photo: false },
      { text: 'Проверить чистоту туалета', hint: 'Бумага, мыло, полотенца, зеркало; при необходимости убрать.', photo: true },
      { text: 'Включить музыку и проверить звук', hint: 'Плейлист смены, громкость в зале и на баре.', photo: false },
      { text: 'Разложить меню и барные карты', hint: 'Меню чистые, без старых вкладок; на столах и на баре.', photo: false },
      { text: 'Проверить свет в зале и на баре', hint: 'Перегоревшие лампы заменить, подсветку витрины включить.', photo: false },
      { text: 'Заправить салфетки и трубочки', hint: 'Держатели на баре и в зале заполнены.', photo: false },
      { text: 'Проверить свежесть цитрусов и гарниров', hint: 'Лимон, лайм, апельсин нарезаны; вялое убрать.', photo: false },
      { text: 'Подготовить станцию: соки, сиропы, биттеры', hint: 'Всё под рукой, дозаторы заправлены, бутылки протёрты.', photo: false },
      { text: 'Проверить запас бокалов под коктейли', hint: 'Хватит на смену; битые убрать.', photo: false },
    ],
  },
  {
    list: 'Закрытие бара',
    items: [
      { text: 'Сдать кассу и снять Z-отчёт', hint: 'Наличные пересчитаны, Z-отчёт распечатан и подписан.', photo: false },
      { text: 'Выключить кофе-машину и промыть группу', hint: 'Промывка выполнена, пар закрыт, машина выключена.', photo: false },
      { text: 'Помыть полы в баре и зале', hint: 'Без липких пятен, мусор по углам убран.', photo: true },
      { text: 'Протереть барную стойку', hint: 'Стойка, кассовая зона и рабочая поверхность без следов.', photo: false },
      { text: 'Вымыть и убрать посуду', hint: 'Бокалы и стаканы вымыты, сушатся или убраны.', photo: false },
      { text: 'Закрыть смену в системе', hint: 'Все заказы закрыты, смена завершена.', photo: false },
      { text: 'Выключить свет и музыку', hint: 'Зал, бар и подсветка выключены; музыка остановлена.', photo: false },
      { text: 'Проверить входную дверь и сигнализацию', hint: 'Дверь закрыта на ключ, сигнализация поставлена.', photo: false },
      { text: 'Вынести мусор', hint: 'Мусорные пакеты заменены, коробки вынесены.', photo: false },
      { text: 'Убрать продукты и заготовки в холодильник', hint: 'Всё подписано и закрыто; ничего не осталось на столе.', photo: false },
      { text: 'Закрыть и опечатать бар', hint: 'Алкоголь и дорогая посуда убраны, бар закрыт на ключ.', photo: false },
      { text: 'Проверить туалет перед закрытием', hint: 'Чисто, бумага и мыло есть, вода закрыта.', photo: true },
    ],
  },
  {
    list: 'Заготовки',
    items: [
      { text: 'Сварить сахарный сироп', hint: 'Пропорция 1:1, остудить и перелить в бутылку.', photo: false },
      { text: 'Нарезать цитрусы для гарниров', hint: 'Лимон, лайм, апельсин — на смену и в контейнеры.', photo: false },
      { text: 'Сварить морс', hint: 'По рецептуре бара, остудить и убрать в холодильник.', photo: false },
      { text: 'Подписать заготовки этикетками 30×20', hint: 'Название и дата изготовления на каждой ёмкости.', photo: true },
      { text: 'Убрать заготовки в холодильник', hint: 'Всё на своих полках, крышки закрыты.', photo: false },
      { text: 'Записать заготовки в журнал переработки', hint: 'Акты переработки созданы, выход записан.', photo: false },
    ],
  },
];

/** Активен ли пункт: снятая галочка (false) или «нет» выключают строку. */
function checklistActive_(v) {
  if (v === false) return false;
  const s = str_(v).toLowerCase();
  return !(s === 'нет' || s === 'no' || s === '0' || s === 'false' || s === 'выкл');
}

/** Нужно ли фото: галочка или «да»/«true»/«1». */
function checklistPhoto_(v) {
  if (v === true) return true;
  const s = str_(v).toLowerCase();
  return s === 'да' || s === 'true' || s === '1' || s === 'yes' || s === 'истина';
}

/** Сколько пунктов в стартовом наборе (для сообщений setupChecklists). */
function checklistSeedCount_() {
  let n = 0;
  CHECKLIST_SEED.forEach(function (group) { n += group.items.length; });
  return n;
}

/**
 * Листы чек-листов. Создаются при первом чтении справочника; повторные
 * вызовы ничего не делают и не дублируют. Если лист уже существует, но пуст,
 * он НЕ досеивается: так владелец может временно убрать все пункты.
 */
function ensureChecklistSheets_(ss) {
  ss = ss || ss_();
  let lists = ss.getSheetByName(SHEETS.checklists);
  let marks = ss.getSheetByName(SHEETS.checklistMarks);
  if (lists && marks) return { lists: lists, marks: marks };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { lists: lists, marks: marks };
  try {
    lists = ss.getSheetByName(SHEETS.checklists);
    marks = ss.getSheetByName(SHEETS.checklistMarks);
    let createdList = false;

    if (!lists) {
      lists = ss.insertSheet(SHEETS.checklists);
      createdList = true;
    }
    if (!marks) marks = ss.insertSheet(SHEETS.checklistMarks);

    if (!str_(lists.getRange(1, 1).getValue())) {
      lists.getRange(1, 1, 1, CHECKLIST_HEADERS.length).setValues([CHECKLIST_HEADERS]).setFontWeight('bold');
      lists.setFrozenRows(1);
      lists.setColumnWidth(1, 180);
      lists.setColumnWidth(2, 80);
      lists.setColumnWidth(3, 380);
      lists.setColumnWidth(4, 460);
      lists.setColumnWidth(5, 130);
      lists.setColumnWidth(6, 90);
      lists.getRange('C:D').setWrap(true);
    }
    if (!str_(marks.getRange(1, 1).getValue())) {
      marks.getRange(1, 1, 1, CHECKLIST_MARK_HEADERS.length).setValues([CHECKLIST_MARK_HEADERS]).setFontWeight('bold');
      marks.setFrozenRows(1);
      marks.setColumnWidth(1, 100);
      marks.setColumnWidth(2, 80);
      marks.setColumnWidth(3, 140);
      marks.setColumnWidth(4, 180);
      marks.setColumnWidth(5, 260);
      marks.setColumnWidth(6, 380);
      marks.setColumnWidth(7, 90);
      marks.setColumnWidth(8, 380);
      marks.setColumnWidth(9, 260);
      marks.getRange('F:F').setWrap(true);
      marks.getRange('H:H').setWrap(true);
    }
    if (createdList) {
      seedChecklists_(lists);
      log_('Чек-листы', 'создан лист «' + SHEETS.checklists + '», пунктов: ' + checklistSeedCount_());
    }
    SpreadsheetApp.flush();
    return { lists: lists, marks: marks };
  } catch (e) {
    // Параллельный запрос мог создать листы первым — берём уже готовые
    lists = ss.getSheetByName(SHEETS.checklists);
    marks = ss.getSheetByName(SHEETS.checklistMarks);
    if (lists && marks) return { lists: lists, marks: marks };
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** Записывает стартовые списки. Вызывается только для нового/пустого листа. */
function seedChecklists_(sh) {
  const rows = [];
  CHECKLIST_SEED.forEach(function (group) {
    group.items.forEach(function (it, i) {
      rows.push([
        text_(group.list, 80),
        i + 1,
        text_(it.text, CHECKLIST_MAX_TEXT),
        text_(it.hint, CHECKLIST_MAX_HINT),
        text_(it.photo ? 'да' : 'нет', 3),
        true,
      ]);
    });
  });
  if (!rows.length) return 0;
  sh.getRange(2, 1, rows.length, CHECKLIST_HEADERS.length).setValues(rows);
  sh.getRange(2, 6, rows.length, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  return rows.length;
}

/**
 * Списки для config: [{name, items:[{text, hint, photo}]}].
 * Внутри списка сортировка по «порядок» (при равенстве — по строке листа),
 * сами списки идут в порядке первого появления в листе.
 */
function checklists_(ss) {
  const sheets = ensureChecklistSheets_(ss);
  if (!sheets.lists) return [];

  const data = rows_(ss, SHEETS.checklists);
  const map = {};
  const order = [];
  data.forEach(function (r) {
    const name = str_(r[0]);
    const text = str_(r[2]);
    if (!name || !text) return;
    if (!checklistActive_(r[5])) return;
    if (!map[name]) {
      map[name] = { name: name, items: [] };
      order.push(name);
    }
    map[name].items.push({
      text: text,
      hint: str_(r[3]),
      photo: checklistPhoto_(r[4]),
      _order: num_(r[1]),
      _row: map[name].items.length,
    });
  });

  return order.map(function (name) {
    const list = map[name];
    list.items.sort(function (a, b) { return (a._order - b._order) || (a._row - b._row); });
    return {
      name: list.name,
      items: list.items.map(function (it) {
        return { text: it.text, hint: it.hint, photo: it.photo };
      }),
    };
  });
}

/**
 * Разово: создать листы чек-листов и залить стартовые списки.
 * Повторный запуск ничего не дублирует; пустой существующий лист досеивает.
 */
function setupChecklists() {
  const ss = ss_();
  const sheets = ensureChecklistSheets_(ss);
  if (!sheets.lists || !sheets.marks) throw new Error('Не удалось создать листы чек-листов');
  if (sheets.lists.getLastRow() < 2) seedChecklists_(sheets.lists);
  SpreadsheetApp.flush();
  const items = Math.max(0, sheets.lists.getLastRow() - 1);
  const lists = checklists_(ss).length;
  const msg = 'Листы чек-листов готовы. Списков: ' + lists + ', пунктов: ' + items + '.';
  log_('Чек-листы', 'setupChecklists: ' + msg);
  Logger.log('Готово. ' + msg);
  return msg;
}

/** Папка для фото чек-листов: «Бар — фото чек-листов» / 2026-11 / файлы. */
function checklistPhotoFolderFor_(date) {
  const props = PropertiesService.getScriptProperties();
  const rootId = props.getProperty('CHECKLIST_PHOTO_FOLDER_ID');
  let root;
  try { root = rootId && DriveApp.getFolderById(rootId); } catch (e) { root = null; }
  if (!root) {
    root = DriveApp.createFolder('Бар — фото чек-листов');
    props.setProperty('CHECKLIST_PHOTO_FOLDER_ID', root.getId());
  }
  const month = Utilities.formatDate(date, 'Europe/Moscow', 'yyyy-MM');
  const it = root.getFoldersByName(month);
  return it.hasNext() ? it.next() : root.createFolder(month);
}

/** Безопасная часть имени файла: без запрещённых символов, не длиннее max. */
function checklistFilePart_(s, max) {
  return str_(s).replace(/[\\/:*?"<>|']/g, '').replace(/\s+/g, ' ').slice(0, max);
}

/** Сохраняет фото пункта на Диск. Возвращает {file} или {error}. */
function saveChecklistPhoto_(dataUrl, employee, list, itemText, runId, date) {
  const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(str_(dataUrl));
  if (!m) return { error: 'неверный формат фото' };
  let bytes;
  try {
    bytes = Utilities.base64Decode(m[3]);
  } catch (e) {
    return { error: 'не удалось прочитать фото' };
  }
  if (!bytes.length) return { error: 'пустое фото' };
  if (bytes.length > MAX_PHOTO_BYTES) return { error: 'фото больше 6 МБ' };

  const folder = checklistPhotoFolderFor_(date);
  const ext = m[2] === 'png' ? 'png' : m[2] === 'webp' ? 'webp' : 'jpg';
  const fileName = Utilities.formatDate(date, 'Europe/Moscow', 'yyyy-MM-dd_HH-mm') + '_' +
    checklistFilePart_(employee, 30) + '_' + checklistFilePart_(list, 40) + '_' +
    checklistFilePart_(itemText, 40) + '_' + runId.slice(0, 6) + '.' + ext;
  const file = folder.createFile(Utilities.newBlob(bytes, m[1], fileName));
  return { file: file };
}

/** Уже записанные пункты этого прогона: Set текстов (идемпотентность). */
function checklistExisting_(sh, runId) {
  const last = sh.getLastRow();
  const set = new Set();
  if (last < 2) return set;
  const values = sh.getRange(2, 5, last - 1, 2).getValues(); // E прогон_id, F пункт
  values.forEach(function (r) {
    if (str_(r[0]).replace(/^'/, '') === runId) set.add(str_(r[1]).replace(/^'/, ''));
  });
  return set;
}

/**
 * POST {action:'checklistSave', id, runId, employee, pin?, list, startedAt,
 *       items:[{пункт, отмечено, комментарий, фото?}]}
 *
 * Пишет по строке на каждый пункт (и отмеченные, и нет — владелец видит,
 * что осталось). Повтор с тем же runId и пунктом не дублирует строку.
 * PIN необязателен (как у результата викторины), но если пришёл — проверяем.
 */
function checklistSave_(body) {
  body = body || {};
  const runId = str_(body.runId);
  const id = str_(body.id) || runId;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(runId)) return { ok: false, error: 'Некорректный runId' };

  const employee = str_(body.employee).slice(0, 80);
  if (!employee) return { ok: false, error: 'Не указан сотрудник' };
  const list = str_(body.list).slice(0, 80);
  if (!list) return { ok: false, error: 'Не указан список' };

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return { ok: false, error: 'Нет пунктов' };
  if (items.length > CHECKLIST_MAX_ITEMS) return { ok: false, error: 'Слишком много пунктов' };

  const clean = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const text = str_(it['пункт'] !== undefined ? it['пункт'] : it.text).slice(0, CHECKLIST_MAX_TEXT);
    if (!text) return { ok: false, error: 'Пустой пункт в списке' };
    const mark = it['отмечено'] !== undefined ? it['отмечено'] : it.checked;
    const checked = mark === true || mark === 1 || str_(mark).toLowerCase() === 'да' || str_(mark).toLowerCase() === 'true';
    const comment = str_(it['комментарий'] !== undefined ? it['комментарий'] : it.comment).slice(0, CHECKLIST_MAX_COMMENT);
    const photo = str_(it['фото'] !== undefined ? it['фото'] : it.photo);
    clean.push({ text: text, checked: checked, comment: comment, photo: photo });
  }

  const ss = ss_();
  const sheets = ensureChecklistSheets_(ss);
  if (!sheets.lists || !sheets.marks) return { ok: false, error: 'Листы чек-листов не готовы' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'Таблица занята, повторите позже', code: 'busy' };
  try {
    // Сотрудник: PIN проверяем, только если он пришёл (приложение всегда шлёт PIN сессии)
    const staff = rows_(ss, SHEETS.staff);
    const pin = str_(body.pin);
    if (pin) {
      const auth = checkPin_(employee, pin, staff);
      if (!auth.ok) return { ok: false, error: auth.error, code: auth.code };
    } else {
      const row = staff.find(function (r) { return str_(r[0]) === employee && r[3] === true; });
      if (!row) return { ok: false, error: 'Сотрудник не найден или отключён', code: 'auth' };
    }

    const created = parseDate_(body.startedAt);
    const timeText = Utilities.formatDate(created, 'Europe/Moscow', 'HH:mm');

    // Какие пункты этого списка требуют фото — берём из листа, а не с телефона
    const required = new Set();
    rows_(ss, SHEETS.checklists).forEach(function (r) {
      if (str_(r[0]) === list && str_(r[2]) && checklistPhoto_(r[4]) && checklistActive_(r[5])) {
        required.add(str_(r[2]));
      }
    });

    const sh = sheets.marks;
    const existing = checklistExisting_(sh, runId);
    let saved = 0;
    let duplicates = 0;
    const noPhoto = [];

    clean.forEach(function (it) {
      if (existing.has(it.text)) { duplicates++; return; }

      let file = null;
      let photoNote = '';
      if (it.checked && it.photo) {
        const res = saveChecklistPhoto_(it.photo, employee, list, it.text, runId, created);
        if (res.file) file = res.file;
        else photoNote = 'фото не сохранено: ' + res.error;
      }
      if (it.checked && required.has(it.text) && !file) {
        noPhoto.push(it.text);
        if (!photoNote) photoNote = 'нет фото (обязательно)';
      }

      const notes = [];
      if (photoNote) notes.push(photoNote);
      if (it.comment) notes.push(it.comment);

      // Дата | время | сотрудник | список | прогон_id | пункт | отмечено | комментарий | фото
      const row = addRow_(sh, [
        created,
        text_(timeText, 10),
        text_(employee, 80),
        text_(list, 80),
        text_(runId, 64),
        text_(it.text, CHECKLIST_MAX_TEXT),
        it.checked ? 'да' : 'нет',
        text_(notes.join('. '), CHECKLIST_MAX_COMMENT),
        file ? text_(file.getName(), 200) : '',
      ]);
      if (file) {
        sh.getRange(row, 9).setRichTextValue(
          SpreadsheetApp.newRichTextValue().setText(file.getName()).setLinkUrl(file.getUrl()).build());
      }
      saved++;
    });

    SpreadsheetApp.flush();
    if (saved) {
      log_('Чек-листы', 'Прогон ' + runId + ' · ' + list + ' · ' + employee + ': записано ' + saved +
        (duplicates ? ', уже было ' + duplicates : '') + (noPhoto.length ? ', без фото: ' + noPhoto.length : ''));
    }
    return {
      ok: true,
      id: id,
      runId: runId,
      saved: saved,
      duplicates: duplicates,
      duplicate: saved === 0 && duplicates > 0,
      noPhoto: noPhoto,
      results: [{ id: id, status: saved > 0 ? 'saved' : 'duplicate' }],
    };
  } finally {
    lock.releaseLock();
  }
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
    stoplist: SHEETS.stopList,
  }[type];
  let sheet = ss.getSheetByName(sheetName);
  // «Стоп-лист» создаётся сам: запись не должна пропасть, если лист ещё не создан.
  if (!sheet && type === 'stoplist') {
    try { sheet = ensureStopSheet_(ss); } catch (e) { log_('Стоп-лист', 'лист не создан: ' + e); }
  }
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
  if (type === 'stoplist') return saveStopListItem_(ss, sheet, auth, rec, id, created, received, comment);

  if (type === 'photo') return savePhoto_(ss, sheet, auth, rec, id, created, received, comment);
}

/**
 * ФОТО УБОРКИ. Сначала файл на Диске и строка в листе — потом проверка.
 * Даже если Gemini ответил ошибкой, запись остаётся, а в лист пишется
 * «не проверено» и причина. Проверка не блокирует сохранение.
 *
 * Снимок, помеченный как стоп-лист (rec.stopList === true или зона
 * «Стоп-лист»), сохраняется так же, но на чистоту зоны НЕ проверяется:
 * вместо вердикта он уходит на распознавание текста, а позиции пишутся
 * в лист «Стоп-лист». Любая ошибка распознавания — строка «не распознано»
 * с причиной; фото и запись остаются.
 */
function savePhoto_(ss, sheet, auth, rec, id, created, received, comment) {
  const zonePlain = str_(rec.zone).slice(0, 120);
  const zone = text_(zonePlain, 120);
  if (!zone) return { id, status: 'error', error: 'Не указана зона' };
  const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(String(rec.image || ''));
  if (!m) return { id, status: 'error', error: 'Нет фото или неверный формат' };
  const bytes = Utilities.base64Decode(m[3]);
  if (bytes.length > MAX_PHOTO_BYTES) return { id, status: 'error', error: 'Фото слишком большое' };
  const stopList = rec.stopList === true || photoZoneKey_(zonePlain) === photoZoneKey_(STOP_ZONE);

  const folder = photoFolderFor_(created);
  const ext = m[2] === 'png' ? 'png' : m[2] === 'webp' ? 'webp' : 'jpg';
  const fileName = Utilities.formatDate(created, 'Europe/Moscow', 'yyyy-MM-dd_HH-mm') +
    '_' + auth.name + '_' + zonePlain.replace(/[\\/:*?"<>|']/g, '') + '_' + id.slice(0, 6) + '.' + ext;
  const file = folder.createFile(Utilities.newBlob(bytes, m[1], fileName));

  // Дата | Сотрудник | Зона | Фото | Комментарий | Получено | ID |
  // Проверка ИИ | Что не так | Замечание менеджера | Фото удалено | ID файла
  // M–S — структурированный вердикт (создаются при первом фото / setupPhotoCheck)
  const photoRow = addRow_(sheet, [created, auth.name, zone, 'Открыть фото', comment, received, "'" + id,
    '', '', '', '', "'" + file.getId()]);
  // Делаем текст «Открыть фото» ссылкой на файл (без формулы — так не зависит от языка таблицы)
  sheet.getRange(photoRow, 4).setRichTextValue(
    SpreadsheetApp.newRichTextValue().setText('Открыть фото').setLinkUrl(file.getUrl()).build());

  // Стоп-лист: чистоту зоны не проверяем, распознаём текст. Эталоны не нужны.
  // Этаж — часть записи: стоп-лист свой на каждом этаже.
  if (stopList) {
    const stopFloor = stopFloorNorm_(rec.floor || rec['этаж']) || '1';
    const res = stopListRecognize_(Utilities.newBlob(bytes, m[1], fileName), file.getId());
    let saved = { stop: [], stock: [], excluded: [], day: stopDayKey_(created), floor: stopFloor };
    try {
      saved = stopListSavePhotoRows_(ss, auth, id, created, file.getUrl(), stopFloor, res);
    } catch (e) {
      log_('Стоп-лист', 'позиции не записались: ' + e);
    }
    const summary = stopPhotoSummary_(res, saved);
    writeStopPhotoVerdict_(sheet, photoRow, res, summary);
    return {
      id, status: 'saved', fileId: file.getId(), zone: zonePlain,
      verdict: {
        level: res.ok ? 'stoplist' : 'unclear',
        verdict: 'стоп-лист',
        confidence: null,
        notes: summary,
        items: [],
        model: res.model || '',
        checkedAt: new Date().toISOString(),
        reference: '',
        references: [],
        error: res.ok ? '' : str_(res.reason),
      },
      stoplist: {
        ok: !!res.ok, reason: str_(res.reason), unreadable: str_(res.unreadable),
        model: str_(res.model),
        day: saved.day || stopDayKey_(created),
        floor: saved.floor || stopFloor,
        stop: saved.stop || [],
        stock: saved.stock || [],
        excluded: saved.excluded || [],
        summary: summary,
      },
    };
  }

  // Сначала фото и строка уже сохранены — дальше проверка. Любая её ошибка
  // не отменяет запись: вердикт будет «не проверено» с причиной.
  // Эталоны: до трёх активных из листа «Эталоны — фото»; если там пусто —
  // старая одиночная ссылка из «Эталонов уборки» (колонка C), как раньше.
  let ref = null;
  let refList = [];
  try {
    ref = photoRefFor_(photoRefs_(ss), zonePlain);
    refList = photoRefPhotosFor_(ss, zonePlain).forCheck;
  } catch (e) { log_('Проверка фото', 'эталоны не прочитаны: ' + e); }
  if (!refList.length && ref && ref.fileId) refList = [ref];
  const floor = ref ? ref.floor : '';
  let verdict;
  try {
    verdict = checkPhoto_(zonePlain, Utilities.newBlob(bytes, m[1], fileName), refList, file.getId(), ref && ref.what);
  } catch (e) {
    log_('Проверка фото', 'неожиданная ошибка: ' + e);
    verdict = photoUnchecked_(String(e && e.message || e), refList);
  }
  writePhotoVerdict_(sheet, photoRow, verdict, floor);
  return { id, status: 'saved', fileId: file.getId(), zone: zonePlain, verdict: photoPublic_(verdict) };
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
 * Приходит: act (название шаблона) и lines: [{ role: 'Сырьё'|'Результат', item, unit, qty, pair? }].
 * Пишем по строке на каждую позицию: так в «Своде переработки» легко сложить расход и приход.
 * Позиции и единицы обязаны совпадать с шаблоном — бармен не может «придумать» сырьё.
 *
 * Пара (мята: листья/ветки) — только справочные колонки Q–V. В «Кол-во» идёт
 * количество своей позиции (листья), вторая доля (ветки) в сумму расхода и в
 * выход НЕ входит: ветки — отход, а не результат. Формулы выхода не меняются.
 */
function saveProcessing_(ss, sheet, auth, rec, id, created, received, comment) {
  const tpl = actTemplates_(ss).find(a => a.name === str_(rec.act));
  if (!tpl) return { id, status: 'error', error: 'Нет такого акта: ' + rec.act };
  const lines = Array.isArray(rec.lines) ? rec.lines : [];
  const allowed = tpl.inputs.map(i => 'Сырьё|' + i.item + '|' + i.unit).concat(['Результат|' + tpl.output.item + '|' + tpl.output.unit]);
  const pairList = pairs_(ss); // один раз на запрос
  const prepared = [];
  let inQty = 0, outQty = 0, keyQty = 0;
  let hasPair = false;

  for (const l of lines) {
    const k = str_(l.role) + '|' + str_(l.item) + '|' + str_(l.unit);
    if (allowed.indexOf(k) === -1) return { id, status: 'error', error: 'Позиция не из шаблона: ' + l.item };
    let q = Number(l.qty);
    if (!(q >= 0 && q < 1000000)) return { id, status: 'error', error: 'Некорректное количество: ' + l.item };

    const tplLine = tpl.inputs.find(i => i.item === str_(l.item));
    const isClean = l.role === 'Сырьё' && tplLine && tplLine.clean;
    let clean = Number(l.clean);

    // Пара: сервер сам пересчитывает вторую долю, клиенту на слово не верим.
    // База пересчёта — то, что реально взвесили: чистый вес, если сырьё чистили.
    const base = isClean ? clean : q;
    const pair = actPairForLine_(pairList, l, base);
    if (pair) {
      hasPair = true;
      if (isClean) clean = pair.ownQty; else q = pair.ownQty;
    }

    if (isClean) {
      if (!(clean > 0)) return { id, status: 'error', error: 'Не указан чистый вес: ' + l.item };
      if (clean > q) return { id, status: 'error', error: 'Чистый вес больше грязного: ' + l.item };
    }
    if (l.role === 'Результат') outQty += q; else inQty += q;
    const keyLine = tpl.inputs.find(i => i.key);
    if (l.role === 'Сырьё' && keyLine && l.item === keyLine.item) keyQty = q;
    prepared.push({ l, q, clean: isClean ? clean : 0, pair });
  }

  // pending = «выход запишем позже»: кордиал ещё варится, фреш ещё жмут
  const pending = rec.pending === true;
  if (!(inQty > 0)) return { id, status: 'error', error: 'Не указано сырьё' };
  if (!pending && !(outQty > 0)) return { id, status: 'error', error: 'Не указан результат («стало»)' };
  if (pending) outQty = 0;

  // Выход в % считаем для простых актов (было → стало): 100 г мяты → 70 г листьев = 70%
  const yieldPct = tpl.type === 'простой' && keyQty > 0 && outQty > 0 ? Math.round(outQty / keyQty * 1000) / 10 : '';
  // Колонки пары добавляем один раз и только если в акте правда есть пара.
  const pairCols = hasPair ? ensureActPairColumns_(sheet) : null;

  // Сырьё с очисткой: в «Кол-во» пишем грязный вес (он списывается),
  // в «Чистый вес» — после чистки, в «Выход, %» — процент чистого от грязного.
  prepared.filter(p => p.q > 0 || p.l.role === 'Результат').forEach((p, i) => {
    const l = p.l;
    const c = p.clean;
    const hasClean = l.role === 'Сырьё' && c > 0;
    const pct = l.role === 'Результат' ? yieldPct : (hasClean ? Math.round(c / p.q * 1000) / 10 : '');
    const isOut = l.role === 'Результат';
    // M Статус | N Закрыл | O Когда закрыт — только у строки «Результат»
    const status = !isOut ? ['', '', ''] : pending ? ['⏳ В работе', '', ''] : ['✅ Закрыт', auth.name, received];
    const row = addRow_(sheet, [created, auth.name, "'" + tpl.name, l.role, "'" + str_(l.item), isOut && pending ? '' : p.q,
      str_(l.unit), pct, i === 0 ? comment : '', received, "'" + id, hasClean ? c : ''].concat(status));
    // Q–V: вторая позиция пары, её граммы, доли, что взвешено и общая масса.
    // Пишем по названиям колонок, а не по номеру: владелец может их переставить.
    if (pairCols) {
      const vals = actPairRow_(p.pair);
      ACT_PAIR_HEADERS.forEach(function (name, k) {
        if (pairCols[name] > 0) sheet.getRange(row, pairCols[name]).setValue(vals[k]);
      });
    }
  });
  return { id, status: 'saved' };
}

/**
 * Закрытие акта, где выход записали позже. Закрыть может ЛЮБОЙ бармен.
 * rec: { actId, qty, comment, pair? } — pair, если у результата есть пара.
 */
function closeProcessing_(ss, sheet, auth, rec, id, received) {
  const actId = str_(rec.actId);
  let qty = Number(rec.qty);
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
  // Пара у результата: количество листьев остаётся в F, ветки — в Q–V.
  const pair = rec.pair && typeof rec.pair === 'object' && tpl
    ? actPairForLine_(pairs_(ss), { item: tpl.output.item, pair: rec.pair }, qty)
    : null;
  if (pair) qty = pair.ownQty;
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
  if (pair) {
    const cols = ensureActPairColumns_(sheet);
    const vals = actPairRow_(pair);
    ACT_PAIR_HEADERS.forEach(function (name, i) {
      if (cols[name] > 0) sheet.getRange(row, cols[name]).setValue(vals[i]);
    });
  }
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
  // Листы дуэли и рейтинга создаются сами при первой дуэли (ensureDuelSheets_),
  // «Сроки хранения» — при первом чтении справочника (ensureShelfLifeSheet_).
  const auto = ['refs', 'refPhotos', 'questions', 'disputes', 'duels', 'ratings', 'quizTries',
    'characters', 'itemCatalog', 'inventory', 'shelfLife', 'facts', 'checklists', 'checklistMarks',
    'settings', 'stopList', 'stopStock', 'kitchen'];
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
 *  ПРОВЕРКА ФОТО УБОРКИ (Gemini) — синхронная, при загрузке фото
 *
 *  Как работает:
 *    1. Бармен отправляет фото — файл сразу ложится на Диск, строка —
 *       в лист «Фото уборки». Это происходит ДО проверки: даже если
 *       Gemini недоступен, фото и запись уже сохранены.
 *    2. Сразу после записи сервер отправляет фото в Gemini и пишет вердикт:
 *         H «Проверка ИИ»:  ✅ Чисто / ⚠ Замечания / ⛔ Критично / ❓ …
 *         I «Что не так»:   коротко, по-русски
 *         M «вердикт»:      ok / warn / crit / unclear / не проверено
 *         N «уверенность»:  0…1
 *         O «замечания»:    «crit: …; warn: …»
 *         P «модель»:       например gemini-flash-lite-latest
 *         Q «проверено_в»:  дата и время проверки
 *         R «эталон»:       ссылка(и) на эталон или «нет»
 *         S «этаж»:         1 / 2 / пусто
 *    3. Триггеров нет: 5 фото в день проверяются за секунды. Расписание
 *       и автоудаление старых фото больше не используются — фото остаются
 *       доказательством для разбора.
 *
 *  Настройка (один раз):
 *    а) ⚙ Настройки проекта → Свойства скрипта → GEMINI_API_KEY = ключ.
 *    б) Выбрать функцию setupPhotoCheck и нажать «Выполнить» — она добавляет
 *       колонки M–S, колонку «этаж» в «Эталоны уборки», создаёт лист
 *       «Эталоны — фото» и проверяет, что ключ на месте.
 *
 *  Эталоны: «Эталоны уборки» — Зона | Что проверять | Эталонное фото | этаж.
 *  Несколько снимков на зону — лист «Эталоны — фото»:
 *    зона | порядок | ссылка_на_фото | ракурс | активен
 *  В запрос уходят до 3 активных эталонов (первые по «порядок») + фото смены:
 *  всего не больше 4 изображений. Если активных эталонов нет — проверяем
 *  по тексту критериев, как раньше. Если все ссылки битые — вердикт unclear
 *  с причиной, а не падение и не проверка «вслепую».
 *
 *  Ответ модели — строго JSON:
 *    {"verdict":"ok|warn|crit|unclear","confidence":0…1,
 *     "items":[{"criterion":"…","level":"ok|warn|crit|unclear","comment":"…"}]}
 *  Итог считает СЕРВЕР, а не модель: любой crit → crit; иначе warn → warn;
 *  иначе ok. confidence < 0.5 → unclear. Невалидный JSON → unclear.
 *  Ошибка API → «не проверено» + причина; запись всё равно сохраняется.
 * ===================================================================== */

const PHOTO_COL = { status: 8, issues: 9, manager: 10, deleted: 11, fileId: 12 }; // H, I, J, K, L
const PHOTO_EXTRA_HEADERS = ['вердикт', 'уверенность', 'замечания', 'модель', 'проверено_в', 'эталон', 'этаж'];
const PHOTO_EXTRA_KEYS = ['verdict', 'confidence', 'notes', 'model', 'checkedAt', 'reference', 'floor'];
const PHOTO_CONFIDENCE_MIN = 0.5;      // ниже — общий вердикт unclear
const PHOTO_MAX_ITEMS = 30;            // больше пунктов от модели не принимаем
const PHOTO_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Первая — рабочая (проверена 22.11.2026). 24.11.2026 на 3 картинках
// gemini-3.8-flash ответил за 178 с, поэтому он теперь последний: сначала
// пробуем лёгкие flash-lite, и только потом медленный запас.
const GEMINI_MODELS = ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];
const PHOTO_STATUS = {
  ok: '✅ Чисто', warn: '⚠ Замечания', crit: '⛔ Критично',
  unclear: '❓ Непонятно', unchecked: '❓ Не проверено',
};
const PHOTO_GENERIC_CRITERIA = [
  'Нет мусора и грязной посуды',
  'Нет пятен и луж',
  'Нет лишних вещей и неубранного инструмента',
  'Поверхности сухие и протёртые',
];
// Новые листы/колонки эталонов. Формат «этаж»: 1 или 2 (принимаем и «1 этаж»).
const REFS_FLOOR_HEADER = 'этаж';
const REF_PHOTO_HEADERS = ['зона', 'порядок', 'ссылка_на_фото', 'ракурс', 'активен'];
const PHOTO_MAX_REFS = 3;             // больше трёх эталонов в один запрос не отправляем
const PHOTO_MAX_IMAGES = 4;           // 1 фото смены + до 3 эталонов

/**
 * Запустить один раз вручную: добавляет колонку «этаж» в «Эталоны уборки»,
 * создаёт лист «Эталоны — фото», колонки вердикта M–S и проверяет ключ.
 * Ничего не проверяет и не ставит триггеров — проверка идёт при загрузке фото.
 */
function setupPhotoCheck() {
  const ss = ss_();
  const sheet = ss.getSheetByName(SHEETS.photos);
  if (!sheet) throw new Error('Нет листа «' + SHEETS.photos + '»');

  const cols = ensurePhotoColumns_(sheet);
  // Единый формат времени проверки для уже существующих строк (и новых).
  sheet.getRange(2, cols.checkedAt, Math.max(sheet.getMaxRows() - 1, 1), 1)
    .setNumberFormat('dd.MM.yyyy HH:mm');
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const where = PHOTO_EXTRA_KEYS.map(k => k + '=' + columnLetter_(cols[k])).join(', ');
  let refMsg = '';
  try { refMsg = ' ' + setupPhotoRefs(); } catch (e) {
    refMsg = ' Эталоны: ОШИБКА ' + e;
    log_('Проверка фото', 'setupPhotoRefs: ' + String(e && e.stack || e));
  }
  const msg = 'Колонки проверки фото: ' + where + '. Ключ Gemini: ' + (key ? 'есть' : 'НЕТ') +
    '. Проверка идёт при загрузке фото, триггеры не нужны.' + refMsg;
  log_('Проверка фото', msg);
  Logger.log(msg);
  return msg;
}

/** Буква столбца по номеру: 13 → M. */
function columnLetter_(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Карта столбцов листа «Фото уборки». Старые H–L фиксированы, новые
 * M–R ищутся по названию в шапке; если create — дописываются в конец.
 * Так повторный запуск не создаёт вторые «вердикт» и «замечания».
 */
function photoColumnMap_(sheet, create) {
  const minWidth = Math.max(sheet.getLastColumn(), PHOTO_COL.fileId);
  const headers = sheet.getRange(1, 1, 1, minWidth).getValues()[0].map(v => str_(v).toLowerCase());
  const cols = {
    status: PHOTO_COL.status, issues: PHOTO_COL.issues, manager: PHOTO_COL.manager,
    deleted: PHOTO_COL.deleted, fileId: PHOTO_COL.fileId,
  };
  let width = minWidth;
  PHOTO_EXTRA_HEADERS.forEach((name, i) => {
    let idx = headers.indexOf(name.toLowerCase());
    if (idx < 0 && create) {
      idx = width;
      width++;
      sheet.getRange(1, idx + 1).setValue(name).setFontWeight('bold');
      headers.push(name.toLowerCase());
      log_('Проверка фото', 'Добавлена колонка ' + columnLetter_(idx + 1) + ' «' + name + '»');
    }
    if (idx >= 0) cols[PHOTO_EXTRA_KEYS[i]] = idx + 1;
  });
  return cols;
}

/** Создаёт недостающие колонки M–R и возвращает их номера. */
function ensurePhotoColumns_(sheet) {
  const cols = photoColumnMap_(sheet, true);
  const missing = PHOTO_EXTRA_KEYS.filter(k => !cols[k]);
  if (missing.length) throw new Error('Не удалось создать колонки: ' + missing.join(', '));
  return cols;
}

/** Эталоны: { 'бар': { zone, what, fileId, url, floor } } */
function photoRefs_(ss) {
  const out = {};
  const sh = ss.getSheetByName(SHEETS.refs);
  if (!sh) return out;
  const cols = refsColumnMap_(sh);
  if (!cols.zone) return out;
  rows_(ss, SHEETS.refs).forEach(r => {
    const zone = str_(r[cols.zone - 1]);
    if (!zone) return;
    out[photoZoneKey_(zone)] = {
      zone: zone,
      what: cols.what ? str_(r[cols.what - 1]) : '',
      fileId: cols.photo ? driveId_(r[cols.photo - 1]) : '',
      url: cols.photo ? str_(r[cols.photo - 1]) : '',
      floor: cols.floor ? photoFloorNorm_(r[cols.floor - 1]) : '',
    };
  });
  return out;
}

function photoZoneKey_(zone) {
  return str_(zone).toLowerCase().replace(/\s+/g, ' ');
}

function photoRefFor_(refs, zone) {
  return (refs && refs[photoZoneKey_(zone)]) || null;
}

/* --- колонки и этажи «Эталонов уборки» ----------------------------- */

// Как узнать колонки по шапке. Так код понимает и старую схему
// «Зона | Что проверять | Эталонное фото | этаж», и новую
// «этаж | зона | критерии | эталонное_фото».
const REFS_COLUMN_KEYS = {
  floor: ['этаж', 'floor'],
  zone: ['зона'],
  what: ['критерии', 'что проверять'],
  photo: ['эталонное_фото', 'эталонное фото', 'ссылка_на_фото'],
};

/** Номер колонки (с 1) по названию шапки; 0 — колонки нет. */
function refsColumnMap_(sheet) {
  const width = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, width).getValues()[0]
    .map(v => str_(v).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' '));
  const cols = { floor: 0, zone: 0, what: 0, photo: 0 };
  Object.keys(cols).forEach(key => {
    const words = REFS_COLUMN_KEYS[key];
    const idx = headers.findIndex(h => h && words.some(w => h.indexOf(w) >= 0));
    if (idx >= 0) cols[key] = idx + 1;
  });
  // Совсем старая шапка без узнаваемых названий — читаем как раньше.
  if (!cols.zone && !cols.what && !cols.photo) {
    cols.zone = 1;
    cols.what = 2;
    cols.photo = 3;
  }
  return cols;
}

/**
 * «1», «1 этаж», «2 ЭТАЖ» → '1' / '2'. Пусто → ''.
 * Нечисловой текст («цоколь») остаётся как есть.
 */
function photoFloorNorm_(v) {
  const s = str_(v).toLowerCase().replace(/ё/g, 'е');
  if (!s) return '';
  const m = /(\d+)/.exec(s);
  if (m) return String(Number(m[1]));
  return s.slice(0, 40);
}

/** Этаж по умолчанию: из названия («Бар 2 этаж» → 2), иначе 1. */
function photoFloorDefault_(zone) {
  const s = str_(zone).toLowerCase().replace(/ё/g, 'е');
  const m = /(\d+)\s*этаж/.exec(s);
  return m ? String(Number(m[1])) : '1';
}

/** Подпись этажа для логов: '1' → '1 этаж'. */
function photoFloorLabel_(floor) {
  const f = str_(floor);
  if (!f) return 'без этажа';
  return /^\d+$/.test(f) ? f + ' этаж' : f;
}

/** Заполняет пустые этажи: по названию зоны, иначе 1. Возвращает число строк. */
function fillPhotoFloors_(sheet, cols) {
  const last = sheet.getLastRow();
  if (last < 2 || !cols.floor || !cols.zone) return 0;
  const zones = sheet.getRange(2, cols.zone, last - 1, 1).getValues();
  const floors = sheet.getRange(2, cols.floor, last - 1, 1).getValues();
  let filled = 0;
  for (let i = 0; i < zones.length; i++) {
    if (!str_(zones[i][0]) || str_(floors[i][0])) continue;
    sheet.getRange(i + 2, cols.floor).setValue(photoFloorDefault_(str_(zones[i][0])));
    filled++;
  }
  if (filled) log_('Проверка фото', 'Этажи заполнены по умолчанию: ' + filled);
  return filled;
}

/**
 * Разово готовит данные для эталонов: колонку «этаж» и лист «Эталоны — фото».
 * Для новой схемы колонка «этаж» уже первая — ничего не меняет.
 * Для старой (без этажа) — дописывает в конец и заполняет 1/2.
 */
function photoMigrate_(ss) {
  const sh = ss.getSheetByName(SHEETS.refs);
  let filled = 0;
  if (sh && str_(sh.getRange(1, 1).getValue())) {
    let cols = refsColumnMap_(sh);
    if (!cols.floor) {
      const width = Math.max(sh.getLastColumn(), 1);
      sh.getRange(1, width + 1).setValue(REFS_FLOOR_HEADER).setFontWeight('bold');
      sh.setColumnWidth(width + 1, 90);
      cols = refsColumnMap_(sh);
      if (cols.floor) filled = fillPhotoFloors_(sh, cols);
      log_('Проверка фото', 'Добавлена колонка ' + columnLetter_(width + 1) + ' «этаж» в «' + SHEETS.refs + '»');
    }
  }
  ensureRefPhotosSheet_(ss);
  return filled;
}

/** Лист «Эталоны — фото»: создаётся при первом обращении, шапка не дублируется. */
function ensureRefPhotosSheet_(ss) {
  let sh = ss.getSheetByName(SHEETS.refPhotos);
  if (sh) {
    if (!str_(sh.getRange(1, 1).getValue())) {
      sh.getRange(1, 1, 1, REF_PHOTO_HEADERS.length).setValues([REF_PHOTO_HEADERS]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    return sh;
  }
  sh = ss.insertSheet(SHEETS.refPhotos);
  sh.getRange(1, 1, 1, REF_PHOTO_HEADERS.length).setValues([REF_PHOTO_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 180);
  sh.setColumnWidth(3, 420);
  sh.setColumnWidth(4, 220);
  sh.setColumnWidth(5, 80);
  log_('Проверка фото', 'Создан лист «' + SHEETS.refPhotos + '»');
  return sh;
}

/**
 * Активен ли эталон. Пустая ячейка = активен: иначе владельцу пришлось бы
 * ставить галочку в каждой строке, а забытая галочка молча отключала бы эталон.
 */
function refPhotoActive_(v) {
  if (v === false) return false;
  if (v === null || v === undefined || v === '') return true;
  if (v === true) return true;
  const s = str_(v).toLowerCase().replace(/ё/g, 'е');
  return !(s === 'нет' || s === 'false' || s === '0' || s === 'no' || s === 'неактивен');
}

/**
 * Строки листа «Эталоны — фото»: одна строка = один эталон.
 * Пустой «порядок» уходит в конец, внутри порядок — как в таблице.
 */
function photoRefPhotosAll_(ss) {
  const sh = ensureRefPhotosSheet_(ss);
  if (sh.getLastRow() < 2) return [];
  const width = Math.max(sh.getLastColumn(), REF_PHOTO_HEADERS.length);
  return sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues()
    .map((r, i) => ({
      row: i + 2,
      zone: str_(r[0]),
      order: num_(r[1]),
      hasOrder: str_(r[1]) !== '',
      url: str_(r[2]),
      fileId: driveId_(r[2]),
      aspect: str_(r[3]).slice(0, 120),
      active: refPhotoActive_(r[4]),
    }))
    .filter(r => r.zone && (r.url || r.fileId));
}

/** Активные эталоны зоны: первые по «порядок», но не больше PHOTO_MAX_REFS. */
function photoRefPhotosFor_(ss, zone) {
  const key = photoZoneKey_(zone);
  const all = photoRefPhotosAll_(ss).filter(r => photoZoneKey_(r.zone) === key);
  const active = all.filter(r => r.active);
  active.sort((a, b) => {
    const ao = a.hasOrder ? a.order : 1e9;
    const bo = b.hasOrder ? b.order : 1e9;
    return ao - bo || a.row - b.row;
  });
  return {
    forCheck: active.slice(0, PHOTO_MAX_REFS),
    activeCount: active.length,
    total: all.length,
    skipped: Math.max(0, active.length - PHOTO_MAX_REFS),
  };
}

/** Зоны с этажами для приложения: сначала «Списки»!B, затем зоны только из эталонов. */
function photoZones_(ss, listZones) {
  const refs = photoRefs_(ss);
  const out = [];
  const seen = {};
  (listZones || []).forEach(z => {
    const k = photoZoneKey_(z);
    if (!k || seen[k]) return;
    seen[k] = true;
    out.push({ zone: z, floor: refs[k] ? refs[k].floor : '' });
  });
  Object.keys(refs).forEach(k => {
    if (seen[k]) return;
    seen[k] = true;
    out.push({ zone: refs[k].zone, floor: refs[k].floor });
  });
  return out;
}

/** Сколько активных эталонов у каждой зоны (для config, без ссылок). */
function photoRefSummaries_(zones, refRows) {
  const counts = {};
  (refRows || []).forEach(r => {
    const k = photoZoneKey_(r.zone);
    if (!counts[k]) counts[k] = { active: 0, total: 0 };
    counts[k].total++;
    if (r.active) counts[k].active++;
  });
  return (zones || []).map(z => {
    const c = counts[photoZoneKey_(z.zone)] || { active: 0, total: 0 };
    return { zone: z.zone, floor: z.floor, active: c.active, total: c.total };
  });
}

/**
 * Разово: колонка «этаж» + лист «Эталоны — фото».
 * Можно запустить вручную из редактора Apps Script как setupPhotoCheck().
 */
function setupPhotoRefs() {
  const ss = ss_();
  const existed = !!ss.getSheetByName(SHEETS.refPhotos);
  const filled = photoMigrate_(ss);
  const sh = ss.getSheetByName(SHEETS.refs);
  const cols = sh ? refsColumnMap_(sh) : { floor: 0 };
  const msg = 'Эталоны: лист «' + SHEETS.refPhotos + '» ' + (existed ? 'на месте' : 'создан') +
    '; колонка «этаж» ' + (cols.floor ? columnLetter_(cols.floor) : 'НЕТ') +
    (filled ? '; этажи заполнены по умолчанию: ' + filled : '') + '.';
  Logger.log(msg);
  log_('Проверка фото', msg);
  return msg;
}

/**
 * Критерии зоны из «Эталонов уборки»: одна строка — один пункт.
 * Сначала снимаем маркеры «1.», «2)», «—», «•», потом режем строку по «;»
 * и концам предложений. Так работает и старый абзац, и новый список.
 */
function splitPhotoCriteria_(what) {
  const s = str_(what);
  if (!s) return [];
  const out = [];
  s.replace(/\r/g, '').split('\n').forEach(line => {
    const clean = line.replace(/^\s*(?:[-–—•*]|\d+[.)])\s*/, '').trim();
    if (!clean) return;
    clean.split(/;\s*|[.!?]\s+/).forEach(part => {
      const item = str_(part).replace(/[.;!?]+$/, '').trim();
      if (item) out.push(item);
    });
  });
  return out.slice(0, 12);
}

/** Промпт: критерии зоны + жёсткие правила + схема ответа. refCount — число эталонов. */
function buildPhotoPrompt_(zone, criteria, refCount) {
  const list = criteria && criteria.length ? criteria : PHOTO_GENERIC_CRITERIA;
  const n = Math.max(0, Math.min(PHOTO_MAX_REFS, Number(refCount) || (refCount ? 1 : 0)));
  const hasRef = n > 0;
  const photoNo = n + 1;
  const lines = [
    'Ты проверяешь фото уборки бара в джаз-клубе. Зона: «' + str_(zone) + '».',
    hasRef
      ? (n === 1
        ? 'На изображении 1 — эталон: как выглядит убранная зона. На изображении 2 — фото после уборки. Оценивай ТОЛЬКО изображение 2.'
        : 'На изображениях 1–' + n + ' — эталоны этой зоны с разных ракурсов. На изображении ' + photoNo +
          ' — фото после уборки. Оценивай ТОЛЬКО изображение ' + photoNo + '.')
      : 'На изображении — фото зоны после уборки.',
    hasRef
      ? 'Эталон — образец состава и порядка, а не шаблон для попиксельного сравнения. Ракурс, свет, фон и расстановка предметов на эталоне и на фото могут отличаться — это не нарушение.'
      : '',
    hasRef
      ? 'Сравнивай по составу и порядку и оценивай признаки: чистота поверхностей, отсутствие мусора и грязной посуды, посуда убрана, контейнеры чистые, инвентарь на своих местах. Не требуй совпадения кадра с эталоном.'
      : '',
    'Что проверять (критерии зоны):',
  ];
  list.forEach((c, i) => lines.push((i + 1) + ') ' + c));
  lines.push(
    '',
    'Правила:',
    '1. Смотри только на то, что видно на фото. Если пункта не видно — не додумывай, ставь этому пункту level "unclear".',
    '2. Если фото тёмное, размытое или снято не то — тоже "unclear" для пункта, а не "crit".',
    '3. Не описывай и не оценивай людей на фото. Если человек попал в кадр — не делай выводов о нём и не упоминай его; оценивай только зону и предметы.',
    '4. Нарушение — это грязь, мусор, еда, грязная посуда, открытые продукты, лишние вещи, неубранный инструмент.',
    '5. Для каждого нарушения укажи, где оно: «слева на стойке», «под решёткой», «у дальнего края». Без «где» нарушение не считается.',
    '6. level: "crit" — грязь, еда или мусор рядом с продуктами, грязная посуда, лужи на рабочей поверхности; "warn" — порядок и эстетика (пустая тара, чеки, личные вещи, коврик, коробки); "ok" — чисто; "unclear" — не видно или не уверен.',
    '7. Верни ТОЛЬКО JSON, без текста вокруг и без markdown, по схеме:',
    '{"verdict":"ok|warn|crit|unclear","confidence":0.0,"items":[{"criterion":"пункт","level":"ok|warn|crit|unclear","comment":"что видно и где"}]}',
    '8. confidence — число от 0 до 1, насколько уверен в оценке. Если не уверен — ниже.',
    '9. verdict — общий итог; сервер всё равно пересчитает его по пунктам.',
  );
  return lines.join('\n');
}

/**
 * Приводит refs (объект или массив) к массиву эталонов, не больше PHOTO_MAX_REFS.
 * Строки с битой ссылкой не выбрасываем здесь: их надо честно показать в причине.
 */
function photoRefArray_(refs) {
  if (!refs) return [];
  const arr = Array.isArray(refs) ? refs : [refs];
  const limit = Math.min(PHOTO_MAX_REFS, PHOTO_MAX_IMAGES - 1);
  return arr.filter(r => r && (r.fileId || r.url)).slice(0, limit);
}

function photoRefUrls_(refs) {
  return photoRefArray_(refs).map(r => str_(r.url)).filter(Boolean);
}

/** Человеческая причина, почему эталоны не открылись. */
function photoRefsFailReason_(failed) {
  return (failed || []).map((f, i) => {
    const label = str_(f.ref && (f.ref.aspect || f.ref.zone)) || ('эталон ' + (i + 1));
    return label + ': ' + str_(f.error || 'файл не открылся').slice(0, 80);
  }).join('; ').slice(0, 400);
}

/** Превью Диска (~512 px по длинной стороне) для повтора после таймаута. */
function photoShrinkParts_(sources) {
  const out = [];
  for (const s of sources || []) {
    if (!s || !s.fileId) return null;
    let thumb = null;
    try { thumb = DriveApp.getFileById(s.fileId).getThumbnail(); } catch (e) { thumb = null; }
    if (!thumb) return null;
    const bytes = thumb.getBytes();
    if (!bytes || !bytes.length) return null;
    out.push({
      inline_data: {
        mime_type: thumb.getContentType() || 'image/jpeg',
        data: Utilities.base64Encode(bytes),
      },
    });
  }
  return out.length ? out : null;
}

/**
 * Один запрос к Gemini: фото смены + до трёх эталонов зоны (всего до 4 картинок).
 * Возвращает {model, items, confidence, references, elapsedMs},
 * {invalid:true, reason, model} или {refsUnavailable:true, reason, refs}.
 * Бросает ошибку только при сетевой/HTTP-ошибке — её ловит checkPhoto_.
 */
function geminiPhotoCheck_(key, zone, refs, blob, fileId, what) {
  const refList = photoRefArray_(refs);
  const criteria = splitPhotoCriteria_(str_(what) || (refList[0] && refList[0].what) || '');

  const imageParts = [];
  const sources = [];        // параллельно imageParts: откуда картинка (для 512px-повтора)
  const loadedRefs = [];
  const failedRefs = [];
  refList.forEach(r => {
    if (!r.fileId) {
      failedRefs.push({ ref: r, error: 'нет ссылки на файл Диска' });
      return;
    }
    try {
      const rb = DriveApp.getFileById(r.fileId).getBlob();
      imageParts.push({ inline_data: { mime_type: rb.getContentType(), data: Utilities.base64Encode(rb.getBytes()) } });
      sources.push({ fileId: r.fileId });
      loadedRefs.push(r);
    } catch (e) {
      failedRefs.push({ ref: r, error: String(e && e.message || e) });
      log_('Проверка фото', 'эталон не открылся (' + (r.aspect || r.zone || r.fileId) + '): ' + e);
    }
  });
  if (failedRefs.length) log_('Проверка фото', 'эталонов не открылось: ' + failedRefs.length);
  // Все эталоны зоны битые: не отправляем фото «без эталонов» молча, а честно
  // говорим «непонятно» с причиной — владелец увидит, что ссылку надо поправить.
  if (refList.length && !loadedRefs.length) {
    return {
      refsUnavailable: true,
      reason: photoRefsFailReason_(failedRefs),
      refs: refList,
    };
  }

  imageParts.push({ inline_data: { mime_type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) } });
  sources.push({ fileId: fileId || '' });

  const requestParts = [{ text: buildPhotoPrompt_(zone, criteria, loadedRefs.length) }].concat(imageParts);
  const generationConfig = {
    temperature: 0,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'OBJECT',
      properties: {
        verdict: { type: 'STRING', enum: ['ok', 'warn', 'crit', 'unclear'] },
        confidence: { type: 'NUMBER' },
        items: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              criterion: { type: 'STRING' },
              level: { type: 'STRING', enum: ['ok', 'warn', 'crit', 'unclear'] },
              comment: { type: 'STRING' },
            },
            required: ['criterion', 'level', 'comment'],
          },
        },
      },
      required: ['verdict', 'confidence', 'items'],
    },
  };

  // Сначала модель, которая сработала в прошлый раз (можно задать GEMINI_MODEL),
  // затем рабочий запас из GEMINI_MODELS.
  const props = PropertiesService.getScriptProperties();
  const saved = str_(props.getProperty('GEMINI_MODEL'));
  const models = (saved ? [saved] : []).concat(GEMINI_MODELS.filter(m => m !== saved));

  const started = Date.now();
  // getSmallParts вызывается только при ошибке/таймауте: превью Диска
  // ~512 px готовятся лениво, чтобы обычный быстрый запрос не платил за них.
  const answer = runGeminiModels_(models, key, requestParts, generationConfig,
    () => photoShrinkParts_(sources));
  const elapsedMs = Date.now() - started;

  // Медленную модель не запоминаем: иначе следующий бармен будет ждать её снова.
  if (saved !== answer.model) {
    if (elapsedMs < 30000) props.setProperty('GEMINI_MODEL', answer.model);
    else log_('Проверка фото', 'Модель ' + answer.model + ' ответила за ' + elapsedMs + ' мс — не запоминаем как основную');
  }
  log_('Проверка фото', 'Gemini ' + answer.model + ': ' + elapsedMs + ' мс, изображений ' +
    (loadedRefs.length + 1) + (failedRefs.length ? ', эталонов не открылось: ' + failedRefs.length : '') +
    (answer.usedSmall ? ', повтор 512 px' : ''));

  const v = validatePhotoAnswer_(answer.text, criteria);
  if (!v.ok) {
    return { invalid: true, reason: v.reason, model: answer.model, references: photoRefUrls_(loadedRefs), elapsedMs: elapsedMs };
  }
  return {
    model: answer.model, items: v.items, confidence: v.confidence,
    references: photoRefUrls_(loadedRefs), elapsedMs: elapsedMs,
  };
}

/**
 * Перебор моделей: 404/500/503 — следующая, 429 — сразу ошибка квоты.
 * Если модель ответила 500/503 или сеть упала, а картинок несколько —
 * та же модель один раз повторяется с уменьшенными до ~512 px картинками.
 */
function runGeminiModels_(models, key, parts, generationConfig, getSmallParts, label) {
  const where = str_(label) || 'Проверка фото';
  let lastErr = '';
  let useSmall = false;
  const switchToSmall = () => {
    if (useSmall || typeof getSmallParts !== 'function') return false;
    const small = getSmallParts();
    if (!small) return false;
    useSmall = true;
    parts = [parts[0]].concat(small);
    log_(where, 'Повтор с уменьшенными до 512 px картинками: ' + small.length);
    return true;
  };
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    let resp;
    try {
      resp = geminiRequest_(model, key, { contents: [{ parts: parts }], generationConfig: generationConfig });
    } catch (e) {
      if (e && e.photoRetry && switchToSmall()) { i--; continue; }
      throw e;
    }
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    if (code === 404 || code === 500 || code === 503) {
      lastErr = 'модель ' + model + ': HTTP ' + code + ' ' + body.slice(0, 120);
      if ((code === 500 || code === 503) && switchToSmall()) { i--; continue; }
      continue;
    }
    if (code === 429) throw new Error('429 квота Gemini');
    if (code !== 200) throw new Error('Gemini HTTP ' + code + ': ' + body.slice(0, 150));
    return { model: model, text: parseGeminiAnswer_(resp), usedSmall: useSmall };
  }
  throw new Error(lastErr || 'Нет доступной модели Gemini');
}

function geminiRequest_(model, key, payload) {
  try {
    return UrlFetchApp.fetch(PHOTO_GEMINI_BASE + '/models/' + model + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
  } catch (e) {
    const err = new Error('Gemini не ответил: ' + e);
    err.photoRetry = true; // сеть/таймаут — можно попробовать превью
    throw err;
  }
}

function parseGeminiAnswer_(resp) {
  let j;
  try { j = JSON.parse(resp.getContentText()); } catch (e) { throw new Error('Gemini вернул не JSON'); }
  const cand = j.candidates && j.candidates[0];
  if (!cand) {
    const why = j.promptFeedback ? ' ' + JSON.stringify(j.promptFeedback).slice(0, 120) : '';
    throw new Error('Gemini не вернул ответ' + why);
  }
  const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini вернул пустой ответ');
  return text;
}

/** Убирает markdown-обёртку и берёт первый JSON-объект из ответа. */
function photoJsonText_(text) {
  let s = str_(text);
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  return a >= 0 && b > a ? s.slice(a, b + 1) : s;
}

/**
 * Проверка ответа модели. Невалидный JSON/схема — {ok:false}, а не исключение:
 * вызывающая сторона превратит это в вердикт unclear.
 */
function validatePhotoAnswer_(text, criteria) {
  let obj;
  try { obj = JSON.parse(photoJsonText_(text)); } catch (e) { return { ok: false, reason: 'ответ не JSON' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'ответ не объект' };
  const conf = Number(obj.confidence);
  if (!isFinite(conf) || conf < 0 || conf > 1) return { ok: false, reason: 'confidence вне 0…1' };
  const rawItems = Array.isArray(obj.items) ? obj.items.slice(0, PHOTO_MAX_ITEMS) : [];
  if (!rawItems.length) return { ok: false, reason: 'нет пунктов items' };
  const items = rawItems.map((it, i) => ({
    criterion: str_(it && it.criterion).slice(0, 200) || (criteria && criteria[i]) || ('пункт ' + (i + 1)),
    level: normalizePhotoLevel_(it && it.level),
    comment: str_(it && it.comment).slice(0, 300),
  }));
  return { ok: true, confidence: conf, items: items };
}

function normalizePhotoLevel_(v) {
  const s = str_(v).toLowerCase();
  if (s === 'ok' || s === 'warn' || s === 'crit' || s === 'unclear' || s === 'na') return s;
  if (s === 'чисто' || s === 'норма') return 'ok';
  if (s === 'замечание' || s === 'внимание') return 'warn';
  if (s === 'критично' || s === 'критический') return 'crit';
  return 'unclear';
}

/**
 * Правила вердикта — на сервере, не в модели:
 * любой crit → crit; иначе warn → warn; иначе ok.
 * confidence < 0.5 → unclear. Если ни один пункт не виден — тоже unclear.
 */
function photoVerdictLevel_(items, confidence) {
  const conf = Number(confidence);
  if (!isFinite(conf) || conf < PHOTO_CONFIDENCE_MIN) return 'unclear';
  const levels = (items || []).map(i => i.level);
  if (levels.indexOf('crit') >= 0) return 'crit';
  if (levels.indexOf('warn') >= 0) return 'warn';
  if (levels.indexOf('ok') >= 0) return 'ok';
  return 'unclear';
}

/** «crit: грязная посуда на стойке; warn: пустая бутылка у края» */
function photoNotes_(items, level) {
  const bad = (items || []).filter(i => i.level === 'crit' || i.level === 'warn');
  if (bad.length) {
    return bad.map(i => i.level + ': ' + (str_(i.comment) || str_(i.criterion))).join('; ').slice(0, 1000);
  }
  // Если общий вердикт unclear — показываем, чего именно не видно.
  if (level === 'unclear') {
    const u = (items || []).filter(i => i.level === 'unclear' || i.level === 'na')[0];
    if (u) return ('unclear: ' + (str_(u.comment) || str_(u.criterion))).slice(0, 500);
    return 'unclear: модель не увидела критерии зоны';
  }
  return '';
}

/** Вердикт по уже прочитанному ответу модели (отдельно — чтобы тестировать без сети). */
function photoFromGeminiResult_(res, refs) {
  if (!res) return photoUnchecked_('пустой ответ Gemini', refs);
  const urls = Array.isArray(res.references) ? res.references : photoRefUrls_(refs);
  if (res.refsUnavailable) {
    return {
      level: 'unclear', confidence: '', items: [],
      notes: 'эталон не открылся: ' + str_(res.reason || 'файл не найден').slice(0, 300),
      model: '', references: urls,
      checkedAt: new Date(), error: '',
    };
  }
  if (res.invalid) {
    return {
      level: 'unclear', confidence: '', items: [],
      notes: 'ответ модели не разобран: ' + res.reason,
      model: res.model || '', references: urls,
      checkedAt: new Date(), error: '',
    };
  }
  const level = photoVerdictLevel_(res.items, res.confidence);
  return {
    level: level,
    confidence: res.confidence,
    items: res.items,
    notes: photoNotes_(res.items, level),
    model: res.model || '',
    references: urls,
    checkedAt: new Date(),
    error: '',
  };
}

/** Точка входа: никогда не бросает — иначе фото потеряется из-за проверки. */
function checkPhoto_(zone, blob, refs, fileId, what) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) return photoUnchecked_('не задан ключ GEMINI_API_KEY', refs);
  try {
    const res = geminiPhotoCheck_(key, zone, refs, blob, fileId, what);
    return photoFromGeminiResult_(res, res && res.refsUnavailable ? res.refs : refs);
  } catch (e) {
    const msg = String(e && e.message || e);
    log_('Проверка фото', 'Gemini: ' + msg.slice(0, 300));
    return photoUnchecked_(msg, refs);
  }
}

function photoUnchecked_(reason, refs) {
  const msg = str_(reason).slice(0, 300) || 'неизвестная ошибка';
  const urls = photoRefUrls_(refs);
  return {
    level: 'unchecked', confidence: '', items: [],
    notes: 'причина: ' + msg, model: '',
    references: urls, reference: urls[0] || 'нет',
    checkedAt: new Date(), error: msg,
  };
}

/** Что отдать телефону: без лишних деталей, но с пунктами для карточки. */
function photoPublic_(v) {
  const unchecked = v.level === 'unchecked';
  return {
    level: unchecked ? 'unclear' : v.level,
    verdict: unchecked ? 'не проверено' : v.level,
    confidence: v.confidence === '' || v.confidence === null || v.confidence === undefined ? null : v.confidence,
    notes: v.notes || '',
    issues: v.notes || '',
    items: v.items || [],
    model: v.model || '',
    checkedAt: v.checkedAt instanceof Date ? v.checkedAt.toISOString() : '',
    reference: v.reference || '',
    references: v.references || [],
    error: v.error || '',
  };
}

/**
 * Запись вердикта в строку листа. Старые H/I заполняем человеческим текстом,
 * новые M–S — машинными полями. Ошибка записи не отменяет сохранение фото.
 */
function writePhotoVerdict_(sheet, row, v, floor) {
  try {
    const cols = ensurePhotoColumns_(sheet);
    const checkedAt = v.checkedAt instanceof Date ? v.checkedAt : new Date();
    const notes = str_(v.notes).slice(0, 1000);
    const verdict = v.level === 'unchecked' ? 'не проверено' : v.level;
    const status = PHOTO_STATUS[v.level] || PHOTO_STATUS.unchecked;

    sheet.getRange(row, PHOTO_COL.status).setValue(status);
    sheet.getRange(row, PHOTO_COL.issues).setValue(text_(notes, 500));
    sheet.getRange(row, cols.verdict).setValue(verdict);
    sheet.getRange(row, cols.confidence).setValue(
      v.confidence === '' || v.confidence === null || v.confidence === undefined ? '' : Number(v.confidence));
    sheet.getRange(row, cols.notes).setValue(text_(notes, 1000));
    sheet.getRange(row, cols.model).setValue(str_(v.model).slice(0, 80));
    sheet.getRange(row, cols.checkedAt).setNumberFormat('dd.MM.yyyy HH:mm').setValue(checkedAt);

    const urls = Array.isArray(v.references) && v.references.length
      ? v.references.map(str_).filter(Boolean).slice(0, PHOTO_MAX_REFS)
      : (function () {
        const one = str_(v.reference);
        return /^https?:\/\//.test(one) ? [one] : [];
      })();
    const refCell = sheet.getRange(row, cols.reference);
    if (!urls.length) {
      refCell.setValue('нет');
    } else if (urls.length === 1) {
      refCell.setRichTextValue(
        SpreadsheetApp.newRichTextValue().setText('эталон').setLinkUrl(urls[0]).build());
    } else {
      // Несколько эталонов: одна ссылка на каждый, чтобы владелец открыл нужный.
      const labels = urls.map((u, i) => 'эталон ' + (i + 1));
      const text = labels.join(' · ');
      const rt = SpreadsheetApp.newRichTextValue().setText(text);
      let at = 0;
      labels.forEach((label, i) => {
        rt.setLinkUrl(at, at + label.length, urls[i]);
        at += label.length + 3; // ' · '
      });
      refCell.setRichTextValue(rt.build());
    }
    if (cols.floor) sheet.getRange(row, cols.floor).setValue(str_(floor));
  } catch (e) {
    log_('Проверка фото', 'вердикт не записался в лист: ' + e);
  }
}

/** GET ?action=photoVerdict&id=… — вердикт по ID записи (для карточки и истории). */
function getPhotoVerdict_(id) {
  const wanted = str_(id);
  if (!wanted) return { ok: false, error: 'Не указан ID записи' };
  const sheet = ss_().getSheetByName(SHEETS.photos);
  if (!sheet || sheet.getLastRow() < 2) return { ok: false, error: 'Фото не найдено' };
  const width = Math.max(sheet.getLastColumn(), PHOTO_COL.fileId);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  for (let i = data.length - 1; i >= 0; i--) {
    if (str_(data[i][ID_COLUMN.photo - 1]) !== wanted) continue;
    return { ok: true, photo: photoFromRow_(sheet, data[i]) };
  }
  return { ok: false, error: 'Фото не найдено' };
}

/** GET ?action=photos&limit=20 — последние снимки без имён сотрудников. */
function getPhotoHistory_(limit) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const sheet = ss_().getSheetByName(SHEETS.photos);
  if (!sheet || sheet.getLastRow() < 2) return { ok: true, photos: [] };
  const width = Math.max(sheet.getLastColumn(), PHOTO_COL.fileId);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  const photos = [];
  for (let i = data.length - 1; i >= 0 && photos.length < n; i--) {
    const r = data[i];
    if (!str_(r[0]) || !str_(r[2])) continue;
    photos.push(photoFromRow_(sheet, r));
  }
  return { ok: true, photos: photos };
}

/** Строка листа → объект для телефона. Имя сотрудника не отдаём. */
function photoFromRow_(sheet, r) {
  const cols = photoColumnMap_(sheet, false);
  const raw = cols.verdict ? str_(r[cols.verdict - 1]) : '';
  const level = photoLevelFromSheet_(raw);
  const dated = r[0] instanceof Date ? r[0] : new Date(r[0]);
  let checked = null;
  if (cols.checkedAt) {
    const cv = r[cols.checkedAt - 1];
    checked = cv instanceof Date ? cv : (cv ? new Date(cv) : null);
  }
  const rawConf = cols.confidence ? r[cols.confidence - 1] : '';
  const conf = rawConf === '' || rawConf === null || rawConf === undefined ? null : Number(rawConf);
  const notes = cols.notes ? str_(r[cols.notes - 1]) : '';
  return {
    id: str_(r[ID_COLUMN.photo - 1]),
    at: dated && !isNaN(dated.getTime()) ? dated.toISOString() : '',
    zone: str_(r[2]),
    level: level,
    verdict: raw,
    confidence: conf !== null && isFinite(conf) ? conf : null,
    notes: notes,
    issues: notes,
    model: cols.model ? str_(r[cols.model - 1]) : '',
    checkedAt: checked && !isNaN(checked.getTime()) ? checked.toISOString() : '',
    reference: cols.reference ? str_(r[cols.reference - 1]) : '',
    floor: cols.floor ? str_(r[cols.floor - 1]) : '',
  };
}

function photoLevelFromSheet_(v) {
  const s = str_(v).toLowerCase();
  if (s === 'ok' || s === 'warn' || s === 'crit' || s === 'unclear') return s;
  if (s === 'не проверено' || s === 'непроверено') return 'unchecked';
  if (s === 'плохое фото') return 'unclear';
  if (s === 'стоп-лист' || s === 'стоплист') return 'stoplist';
  return '';
}


/* =====================================================================
 *  СТОП-ЛИСТ ПО ФОТО — две колонки, этажи, дни в стопе
 * =====================================================================
 *
 *  Реальное фото владельца: снимок экрана планшета (POS), две колонки:
 *    «Блюда на остатке» — позиция и количество (0.00 = закончилось);
 *    «СТОП-ЛИСТ»        — только позиции, без количеств.
 *
 *  АКТИВНЫЙ СТОП — ОБЪЕДИНЕНИЕ (уточнение владельца):
 *    стоп = позиции правой колонки ∪ позиции с нулевым остатком слева.
 *    Ноль слева САМ ПО СЕБЕ значит «в стопе», даже если справа позиции нет.
 *    Позиция с нулём слева и без строки справа — нормальная ситуация, а не
 *    ошибка. Сравнивать колонки и выводить из этого «недочёты» НЕЛЬЗЯ —
 *    такая проверка была ошибочной и удалена.
 *    Задача раздела одна: сколько дней подряд позиция стоит в стопе.
 *
 *  КУХНЯ
 *    В стоп-лист бара входят только барные позиции. Блюда кухни и служебные
 *    строки кассы («Комментарий на бар») отсекаются по данным листа «Кухня»
 *    (позиция | активен | комментарий), а не кодом: владелец дополняет
 *    список сам. Сравнение — по нормализованному названию (регистр, «ё»,
 *    кавычки, дефисы, лишние пробелы), поэтому «Торт Три Шоколада» и
 *    «торт три шоколада» отсекаются одинаково.
 *    Недочёты по уборке — отдельная функция (проверка фото уборки), здесь
 *    они не дублируются.
 *
 *  ЭТАЖИ
 *    Стоп-лист свой на каждом этаже (владелец: «добавить каждому этажу
 *    этот пункт»). На экране фото — выбор этажа до снимка; в листе
 *    «Стоп-лист» — колонка «этаж»; дни считаются в разрезе этаж + позиция.
 *    То, что в стопе на втором этаже, не значит стоп на первом.
 *
 *  ЛИСТЫ
 *    «Стоп-лист»:
 *      дата | смена/время | сотрудник | позиция | позиция_в_справочнике |
 *      перечёркнута | уверенность | фото | источник | этаж |
 *      id | день | модель | заметка        ← служебные, справа
 *      первые девять колонок — как в задании, «этаж» добавлен десятым.
 *      Строка = позиция активного стопа (фото или ручной ввод), источник
 *      «фото» или «ручной ввод»; в заметке видно, пришла ли позиция из
 *      остатка 0. Строка без позиции и с источником «не распознано» —
 *      отметка, что снимок был, но текст не прочитался; «пустой стоп» —
 *      снимок прочитан, барных позиций в стопе нет (день всё равно с данными).
 *    «Стоп-лист — остатки» (создаётся автоматически):
 *      дата | смена/время | сотрудник | этаж | позиция | количество |
 *      фото | id | день | модель
 *      Справка: что и сколько было в колонке «Блюда на остатке». На счёт
 *      дней не влияет — но по ней видно, откуда взялась позиция с нулём.
 *    «Кухня» (создаётся автоматически, заполняется владельцем):
 *      позиция | активен | комментарий
 *      Пустой «активен» = активен; «выкл»/«нет»/0 — позиция снова считается
 *      барной (если ошиблись).
 *
 *  НАЗВАНИЯ
 *    Модель пишет как видно, с объёмом и «бут.». Объём отличает позиции
 *    («0,3 Курпфайц» ≠ «0,5 Курпфайц»), поэтому его НЕ отрезаем.
 *    Приведение — только регистр, «ё», кавычки, дефисы, лишние пробелы и
 *    маркер списка («1. », «- »). Справочник используется для подсказки;
 *    сравнение — точное, по падежам и по опечаткам с порогом, но только
 *    когда числа в названиях совпадают: 0,3 и 0,5 никогда не сливаются.
 *    Не сопоставилось — позиция пишется как есть и помечается
 *    «нет в справочнике».
 *
 *  ДНИ В СТОПЕ (в разрезе этаж + позиция)
 *    «День с данными» — календарная дата по Москве, на которую есть хотя бы
 *    одна запись стоп-листа ЭТОГО этажа (в том числе «пустой стоп»). Одна
 *    позиция = одна запись в день: повторный снимок в тот же день счётчик
 *    не увеличивает (но обновляет данные).
 *    Идём по дням с данными от последнего к первому: позиция есть и не
 *    перечёркнута → +1; день с данными, где позиции нет → счёт закончен;
 *    дня с данными нет вовсе → день не считаем и счёт не обрываем (видно
 *    в gaps). Если позиция выпала, счётчик обнуляется, но прошлый отрезок
 *    остаётся в истории («была N дней до этого»).
 *
 *  НАСТРОЙКИ (только помечаем, ничего не блокируем)
 *    стоплист_проверять_долго            вкл — «долго в стопе»
 *    стоплист_проверять_преждевременно   вкл — «убрано преждевременно»
 *    стоплист_проверять_справочник        вкл — «нет в справочнике»
 *    стоплист_проверять_данные            вкл — «нет данных за смену»
 *    стоплист_долго_дней                   3 — порог «долго»
 *    стоплист_преждевременно_дней          2 — окно «убрали и вернули»
 *    стоплист_пропуск_обрывает           выкл — строгий режим пропуска дня
 *    стоплист_история_дней                30 — сколько дней истории в приложении
 * ===================================================================== */

const STOP_ZONE = 'Стоп-лист';

// Лист «Стоп-лист». Первые девять колонок — как в задании, дальше служебные.
const STOP_HEADERS = ['дата', 'смена/время', 'сотрудник', 'позиция', 'позиция_в_справочнике',
  'перечёркнута', 'уверенность', 'фото', 'источник', 'этаж', 'id', 'день', 'модель', 'заметка'];
const STOP_HEADER_KEYS = ['date', 'time', 'employee', 'name', 'catalog', 'crossed', 'confidence',
  'photo', 'source', 'floor', 'id', 'day', 'model', 'note'];

// Лист остатков из колонки «Блюда на остатке» (справка: сколько было).
const STOP_STOCK_HEADERS = ['дата', 'смена/время', 'сотрудник', 'этаж', 'позиция',
  'количество', 'фото', 'id', 'день', 'модель'];
const STOP_STOCK_KEYS = ['date', 'time', 'employee', 'floor', 'name', 'qty', 'photo', 'id', 'day', 'model'];

// Лист «Кухня»: позиции, которые в стоп-лист бара не входят (блюда кухни
// и служебные строки кассы). Список ведёт владелец — код его только читает.
const STOP_KITCHEN_HEADERS = ['позиция', 'активен', 'комментарий'];
const STOP_KITCHEN_SEED = [
  { name: 'Равиоли с лососем', note: 'кухня' },
  { name: 'Салат с утиным филе', note: 'кухня' },
  { name: 'Торт Три Шоколада', note: 'кухня' },
  { name: 'Утиное филе на гриле', note: 'кухня' },
  { name: 'Тапас с лососем', note: 'кухня' },
  { name: 'Чиз-кейк "Нью-Йорк"', note: 'кухня' },
  { name: 'Штрудель Яблочный', note: 'кухня' },
  { name: 'Комментарий на бар', note: 'служебная строка кассы, не позиция' },
];

const STOP_SOURCE_PHOTO = 'фото';
const STOP_SOURCE_MANUAL = 'ручной ввод';
const STOP_SOURCE_UNREADABLE = 'не распознано';
// Снимок распознан, но барных позиций в стопе нет: день всё равно «с данными».
const STOP_SOURCE_EMPTY = 'пустой стоп';
const STOP_MAX_ITEMS = 60;            // больше позиций с одного снимка не принимаем
const STOP_ANALYSIS_DAYS = 180;       // старше — в расчёт дней не берём
const STOP_DEFAULT_LONG_DAYS = 3;
const STOP_DEFAULT_PREMATURE_DAYS = 2;
const STOP_DEFAULT_HISTORY_DAYS = 30;
const STOP_STANDARD_FLOORS = ['1', '2'];

/** Настройки стоп-листа: дописываются в лист «Настройки», если их там нет. */
const STOP_SETTINGS = [
  { key: 'стоплист_долго_дней', value: '3',
    note: 'стоп-лист: с какого числа дней подряд позиция считается «долго в стопе»' },
  { key: 'стоплист_преждевременно_дней', value: '2',
    note: 'стоп-лист: вернулась в течение стольких дней после «убрали» — «убрано преждевременно» (1–3)' },
  { key: 'стоплист_проверять_долго', value: 'вкл', note: 'недочёт «долго в стопе» — показывать' },
  { key: 'стоплист_проверять_преждевременно', value: 'вкл', note: 'недочёт «убрано преждевременно» — показывать' },
  { key: 'стоплист_проверять_справочник', value: 'вкл', note: 'недочёт «нет в справочнике» — показывать' },
  { key: 'стоплист_проверять_данные', value: 'вкл', note: 'недочёт «нет данных за смену» (снимок не распознан) — показывать' },
  { key: 'стоплист_пропуск_обрывает', value: 'выкл',
    note: 'стоп-лист: «вкл» — день без снимка обрывает счёт дней; «выкл» — пропуск не обрывает, но виден как «без данных»' },
  { key: 'стоплист_история_дней', value: '30', note: 'стоп-лист: сколько дней истории позиции показывать в приложении' },
];

// Проверки, которые владелец отменил. Строки, оставшиеся в «Настройках»
// от прошлых версий, удаляются при чтении — чтобы не сбивать с толку.
const STOP_CANCELED_SETTINGS = ['стоплист_проверять_нулевой_остаток', 'стоплист_проверять_остаток_в_стопе'];

/* ---------- листы и их колонки -------------------------------------- */

/** Лист «Стоп-лист»: создаётся сам, шапка не дублируется, «этаж» — миграцией. */
function ensureStopSheet_(ss) {
  let sh = ss.getSheetByName(SHEETS.stopList);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.stopList);
    log_('Стоп-лист', 'создан лист «' + SHEETS.stopList + '»');
  }
  const width = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1, 1, 1, width).getValues()[0]
    .map(v => str_(v).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' '));
  const want = STOP_HEADERS.map(h => h.replace(/ё/g, 'е'));
  const empty = sh.getLastRow() < 2;
  const same = want.every(function (h, i) { return head[i] === h; });

  if (empty && !same) {
    // Данных нет — просто пишем новую шапку (в том числе добавляем «этаж»).
    const cols = Math.max(sh.getLastColumn(), STOP_HEADERS.length);
    const row = STOP_HEADERS.concat(new Array(Math.max(0, cols - STOP_HEADERS.length)).fill(''));
    sh.getRange(1, 1, 1, row.length).setValues([row]).setFontWeight('bold');
    log_('Стоп-лист', 'шапка «' + SHEETS.stopList + '» приведена к новой схеме (этаж)');
  } else if (!empty) {
    // Есть данные — порядок не трогаем, недостающие колонки дописываем справа.
    const have = {};
    head.forEach(function (h) { if (h) have[h] = true; });
    let at = sh.getLastColumn();
    STOP_HEADERS.forEach(function (name) {
      if (have[name.replace(/ё/g, 'е')]) return;
      at++;
      sh.getRange(1, at).setValue(name).setFontWeight('bold');
      log_('Стоп-лист', 'в «' + SHEETS.stopList + '» добавлена колонка «' + name + '»');
    });
  }
  if (empty) {
    const widths = [110, 90, 150, 230, 230, 110, 100, 80, 130, 80, 250, 100, 150, 280];
    widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Лист «Стоп-лист — остатки»: создаётся сам при первой записи/чтении. */
function ensureStopStockSheet_(ss) {
  let sh = ss.getSheetByName(SHEETS.stopStock);
  if (sh) {
    if (!str_(sh.getRange(1, 1).getValue())) {
      sh.getRange(1, 1, 1, STOP_STOCK_HEADERS.length).setValues([STOP_STOCK_HEADERS]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    return sh;
  }
  sh = ss.insertSheet(SHEETS.stopStock);
  sh.getRange(1, 1, 1, STOP_STOCK_HEADERS.length).setValues([STOP_STOCK_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  const widths = [110, 90, 150, 80, 260, 100, 80, 250, 100, 150];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  log_('Стоп-лист', 'создан лист «' + SHEETS.stopStock + '»');
  return sh;
}

/**
 * Лист «Кухня»: позиции, которых в стоп-листе бара быть не должно.
 * Создаётся сам и один раз заполняется блюдами с реального фото и служебной
 * строкой кассы. Дальше список ведёт владелец — код только читает:
 * добавил строку — позиция перестала попадать в стоп-лист.
 */
function ensureKitchenSheet_(ss) {
  let sh = ss.getSheetByName(SHEETS.kitchen);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.kitchen);
    log_('Стоп-лист', 'создан лист «' + SHEETS.kitchen + '»');
  }
  if (!str_(sh.getRange(1, 1).getValue())) {
    sh.getRange(1, 1, 1, STOP_KITCHEN_HEADERS.length).setValues([STOP_KITCHEN_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 280);
    sh.setColumnWidth(2, 100);
    sh.setColumnWidth(3, 320);
  }
  if (sh.getLastRow() < 2) {
    const rows = STOP_KITCHEN_SEED.map(function (k) {
      return [stopCell_(k.name), 'вкл', k.note];
    });
    sh.getRange(2, 1, rows.length, STOP_KITCHEN_HEADERS.length).setValues(rows);
    log_('Стоп-лист', 'в «Кухню» записаны стартовые позиции: ' + rows.length);
  }
  return sh;
}

/** Карта колонок «Кухни» по шапке: позиция | активен | комментарий. */
function stopKitchenColumnMap_(sheet) {
  return stopMapByHeaders_(sheet, STOP_KITCHEN_HEADERS, ['name', 'active', 'note']);
}

/** Активная ли строка «Кухни»: пусто = активна, «выкл»/«нет»/0 — нет. */
function stopKitchenActive_(v) {
  if (v === false) return false;
  if (v === true) return true;
  const s = str_(v).toLowerCase().replace(/[\s.]+$/g, '');
  if (!s) return true;
  return !/^(выкл|off|нет|no|false|0)/.test(s);
}

/**
 * Множество кухонных позиций: { ключ: как записано у владельца }.
 * Ключ — нормализованное название (регистр, «ё», кавычки, дефисы, пробелы),
 * поэтому «Торт Три Шоколада» и «торт три шоколада» — одно и то же.
 */
function stopKitchenSet_(ss) {
  const out = { keys: {}, names: [] };
  let sh = null;
  try { sh = ensureKitchenSheet_(ss); } catch (e) {
    log_('Стоп-лист', 'лист «Кухня» не создан: ' + e);
    return out;
  }
  if (!sh || sh.getLastRow() < 2) return out;
  const cols = stopKitchenColumnMap_(sh);
  const width = Math.max(sh.getLastColumn(), STOP_KITCHEN_HEADERS.length);
  sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues().forEach(function (r) {
    const name = stopPlain_(r[cols.name - 1]);
    if (!name) return;
    if (!stopKitchenActive_(r[cols.active - 1])) return;
    const key = stopNameKey_(name);
    if (!key) return;
    if (!out.keys[key]) { out.keys[key] = name; out.names.push(name); }
  });
  return out;
}

/** Кухонная ли позиция (по нормализованному ключу). */
function stopIsKitchen_(name, kitchen) {
  const key = stopNameKey_(name);
  return !!(key && kitchen && kitchen.keys[key]);
}

/** Колонки листа «Стоп-лист» по шапке (порядок можно менять). */
function stopColumnMap_(sheet) {
  return stopMapByHeaders_(sheet, STOP_HEADERS, STOP_HEADER_KEYS);
}

/** Колонки листа «Стоп-лист — остатки» по шапке. */
function stopStockColumnMap_(sheet) {
  return stopMapByHeaders_(sheet, STOP_STOCK_HEADERS, STOP_STOCK_KEYS);
}

function stopMapByHeaders_(sheet, headers, keys) {
  const width = Math.max(sheet.getLastColumn(), headers.length);
  const head = sheet.getRange(1, 1, 1, width).getValues()[0]
    .map(v => str_(v).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' '));
  const out = {};
  headers.forEach(function (name, i) {
    const idx = head.indexOf(name.toLowerCase().replace(/ё/g, 'е'));
    out[keys[i]] = idx >= 0 ? idx + 1 : i + 1;
  });
  return out;
}

/** Дописать строки блоком; возвращает номер первой записанной строки. */
function stopAppendRows_(sheet, rows) {
  if (!rows || !rows.length) return 0;
  const max = sheet.getMaxRows();
  const colA = sheet.getRange(1, 1, max, 1).getValues();
  let last = 1;
  for (let i = colA.length - 1; i >= 1; i--) {
    if (str_(colA[i][0])) { last = i + 1; break; }
  }
  const start = last + 1;
  if (start + rows.length - 1 > max) sheet.insertRowsAfter(max, Math.max(50, rows.length));
  sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
  return start;
}

/** Строка для ячейки: начинается с «=»/«+»/«−»/«@» — апостроф, чтобы не стала формулой. */
function stopCell_(v) {
  const s = str_(v);
  return s && /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** Обратно: убираем апостроф, который таблица могла сохранить как текст. */
function stopPlain_(v) {
  return str_(v).replace(/^'/, '');
}

/** Строки листа «Стоп-лист» в виде объектов. */
function stopRows_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const cols = stopColumnMap_(sheet);
  const width = Math.max(sheet.getLastColumn(), STOP_HEADERS.length);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  const out = [];
  data.forEach((r, i) => {
    const rawDate = r[cols.date - 1];
    const date = rawDate instanceof Date ? rawDate : (rawDate ? new Date(rawDate) : null);
    const day = str_(r[cols.day - 1]) ||
      (date && !isNaN(date.getTime()) ? stopDayKey_(date) : '');
    if (!day) return;
    const name = stopPlain_(r[cols.name - 1]);
    const source = str_(r[cols.source - 1]) || STOP_SOURCE_PHOTO;
    // Строка без позиции — только отметка дня: «не распознано» или «пустой стоп».
    if (!name && source !== STOP_SOURCE_UNREADABLE && source !== STOP_SOURCE_EMPTY) return;
    const rawConf = r[cols.confidence - 1];
    const conf = rawConf === '' || rawConf === null || rawConf === undefined ? null : Number(rawConf);
    out.push({
      row: i + 2, at: date, day: day, time: str_(r[cols.time - 1]),
      employee: stopPlain_(r[cols.employee - 1]),
      floor: stopFloorNorm_(r[cols.floor - 1]),
      name: name, catalog: stopPlain_(r[cols.catalog - 1]),
      crossed: stopCrossed_(r[cols.crossed - 1]),
      confidence: conf !== null && isFinite(conf) ? conf : null,
      photo: str_(r[cols.photo - 1]), source: source,
      id: stopPlain_(r[cols.id - 1]),
      model: str_(r[cols.model - 1]), note: stopPlain_(r[cols.note - 1]),
    });
  });
  return out;
}

/** Строки листа «Стоп-лист — остатки» в виде объектов. */
function stopStockRows_(ss) {
  const sh = ss.getSheetByName(SHEETS.stopStock);
  if (!sh || sh.getLastRow() < 2) return [];
  const cols = stopStockColumnMap_(sh);
  const width = Math.max(sh.getLastColumn(), STOP_STOCK_HEADERS.length);
  const out = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues().forEach((r, i) => {
    const rawDate = r[cols.date - 1];
    const date = rawDate instanceof Date ? rawDate : (rawDate ? new Date(rawDate) : null);
    const day = str_(r[cols.day - 1]) ||
      (date && !isNaN(date.getTime()) ? stopDayKey_(date) : '');
    if (!day) return;
    const name = stopPlain_(r[cols.name - 1]);
    if (!name) return;
    const rawQty = r[cols.qty - 1];
    const qty = rawQty === '' || rawQty === null || rawQty === undefined ? null : stopQty_(rawQty);
    out.push({
      row: i + 2, day: day, time: str_(r[cols.time - 1]),
      employee: stopPlain_(r[cols.employee - 1]),
      floor: stopFloorNorm_(r[cols.floor - 1]),
      name: name, qty: qty,
      id: stopPlain_(r[cols.id - 1]),
      model: str_(r[cols.model - 1]),
    });
  });
  return out;
}

/* ---------- даты и этажи -------------------------------------------- */

/** Календарный день по Москве: Date → «2026-11-24». */
function stopDayKey_(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!d || isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, 'Europe/Moscow', 'yyyy-MM-dd');
}

/** «2026-11-24» + n дней → «2026-11-25». */
function stopDayAdd_(day, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str_(day));
  if (!m) return '';
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + Number(delta || 0) * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Сколько дней от from до to (to − from). Пустые даты → 0. */
function stopDayDiff_(from, to) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str_(from));
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str_(to));
  if (!a || !b) return 0;
  return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86400000);
}

/** Этаж: «1», «1 этаж», «2 ЭТАЖ» → '1'/'2'; пусто → ''. */
function stopFloorNorm_(v) {
  const s = str_(v).toLowerCase().replace(/ё/g, 'е');
  if (!s) return '';
  const m = /(\d+)/.exec(s);
  if (m) return String(Number(m[1]));
  return s.slice(0, 40);
}

/** Подпись этажа: '1' → «1 этаж». */
function stopFloorLabel_(floor) {
  const f = str_(floor);
  if (!f) return 'Без этажа';
  return /^\d+$/.test(f) ? f + ' этаж' : f;
}

/* ---------- нормализация названий ----------------------------------- */

/**
 * Ключ сравнения названий. Приводим ТОЛЬКО то, что не меняет позицию:
 *   • маркер списка («1. », «- », «• »);
 *   • регистр («Вишнёвка» = «ВИШНЕВКА»);
 *   • «ё» → «е» и «Ё» → «Е» (после toLowerCase это одно и то же) —
 *     «Вишнёвка 40мл» и «Вишневка 40мл» одна позиция;
 *   • кавычки, дефисы, точки, запятые и другие знаки → пробел;
 *   • несколько пробелов → один.
 * НЕ приводим (это разные позиции): объёмы и числа («0,3» ≠ «0,5», «40мл»),
 * слова («Вино белое» ≠ «Вино белое сухое»), «бут.»/«0,150» и прочие приставки.
 * Ключ используется только для сравнения — в лист и на экран идёт исходное
 * написание (см. stopGroupState_).
 */
function stopNameKey_(s) {
  return stopStripMarker_(s).toLowerCase().replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-я]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** «1. Джин Монки» → «Джин Монки»; «- Лайм» → «Лайм». «1,5» не трогаем. */
function stopStripMarker_(s) {
  return str_(s).replace(/^\s*(?:\d{1,3}[.)\]:]|[-–—•*·])\s+/, '').trim();
}

/** Числа из названия, нормализованные: «0,3» → 0.3, «33%» → 33. */
function stopNumbers_(s) {
  const out = [];
  const re = /\d+(?:[.,]\d+)?/g;
  let m;
  while ((m = re.exec(str_(s))) !== null) {
    const n = Number(String(m[0]).replace(',', '.'));
    if (isFinite(n)) out.push(n);
  }
  return out.sort(function (a, b) { return a - b; });
}

/** Совпадают ли числа в двух названиях (объём, размер, год — часть позиции). */
function stopSameNumbers_(a, b) {
  const na = stopNumbers_(a);
  const nb = stopNumbers_(b);
  if (na.length !== nb.length) return false;
  for (let i = 0; i < na.length; i++) if (na[i] !== nb[i]) return false;
  return true;
}

// Окончания для грубого «усечения падежей». Длинные — раньше коротких.
const STOP_ENDINGS = ['ями', 'ами', 'иях', 'ией', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими',
  'ах', 'ях', 'ов', 'ев', 'ий', 'ый', 'ой', 'ая', 'ое', 'ые', 'ых', 'ым', 'ом', 'ем',
  'ам', 'ям', 'ия', 'ию', 'ии', 'ую', 'юю', 'а', 'я', 'ы', 'и', 'о', 'е', 'у', 'ю', 'ь'];

function stopStemWord_(word) {
  const w = str_(word);
  if (w.length <= 3) return w;
  for (let i = 0; i < STOP_ENDINGS.length; i++) {
    const e = STOP_ENDINGS[i];
    if (w.length - e.length >= 3 && w.slice(w.length - e.length) === e) {
      return w.slice(0, w.length - e.length);
    }
  }
  return w;
}

/** Ключ без окончаний: «Лимоны» → «лимон», «сиропа» → «сироп». */
function stopStemKey_(s) {
  return stopNameKey_(s).split(' ').map(stopStemWord_).join(' ');
}

/**
 * Справочник для сопоставления: все позиции листа «Справочник» с названием.
 * Галочка «Показывать» здесь не важна: скрытая позиция всё равно существует.
 */
function stopDictionary_(ss) {
  const list = [];
  const byKey = {};
  const byStem = {};
  try {
    rows_(ss, SHEETS.items).forEach(r => {
      const name = str_(r[0]);
      if (!name) return;
      const key = stopNameKey_(name);
      if (!key || byKey[key]) return;
      byKey[key] = name;
      const stem = stopStemKey_(name);
      if (!byStem[stem]) byStem[stem] = name;
      list.push({ name: name, key: key, stem: stem, nums: stopNumbers_(name) });
    });
  } catch (e) {
    log_('Стоп-лист', 'справочник не прочитан: ' + e);
  }
  return { list: list, byKey: byKey, byStem: byStem };
}

/**
 * Название → позиция справочника: {name, how} или null.
 * Сравниваем ровно две вещи:
 *   1) нормализованный ключ (регистр, «ё»→«е», пробелы, кавычки, дефисы,
 *      маркер списка) — точное совпадение;
 *   2) усечённые падежи («Лимоны» → «Лимон»), но только когда числа в
 *      названиях совпадают: «0,3 Курпфайц» и «0,5 Курпфайц» не сливаются.
 * Опечатки, перестановки слов, лишние/недостающие слова и «похожесть»
 * сознательно НЕ сравниваем: «Сидр» и «Сидер» — разные позиции, «Вино белое»
 * и «Вино белое сухое» — тоже. Не сопоставилось — позиция сохраняется как
 * написана и получает «нет в справочнике».
 */
function stopMatchName_(name, dict) {
  const key = stopNameKey_(name);
  if (!key || !dict) return null;
  if (dict.byKey[key]) return { name: dict.byKey[key], how: 'exact' };
  const stem = stopStemKey_(name);
  const stemHit = dict.byStem[stem];
  if (stemHit && stopSameNumbers_(name, stemHit)) return { name: stemHit, how: 'stem' };
  return null;
}

/** «true»/«да»/«перечёркнута» → true; пусто/«нет»/false → false. */
function stopCrossed_(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  const s = str_(v).toLowerCase().replace(/[\s.]+$/g, '');
  if (!s) return false;
  return /^(true|да|1|yes|перечеркн|перечёркн|вычеркн|crossed|зачеркн)/.test(s);
}

/** Количество из ответа модели: 3.00 → 3, 0.00 → 0, мусор → null (не 0!). */
function stopQty_(v) {
  if (v === null || v === undefined || v === '') return null;
  let n;
  if (typeof v === 'number') n = v;
  else {
    const s = str_(v).replace(',', '.').replace(/\s/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    n = Number(s);
  }
  if (!isFinite(n) || n < 0 || n >= 1000000) return null;
  return Math.round(n * 1000) / 1000;
}

/* ---------- распознавание: промпт и схема ответа -------------------- */

/**
 * Промпт распознавания. Две колонки, ничего не выдумывать и не путать
 * колонки; объём и «бут.» — часть названия, их не отрезать.
 */
function buildStopListPrompt_() {
  return [
    'Ты распознаёшь экран планшета (или распечатку) со стоп-листом бара. На снимке две колонки:',
    '  • слева — «Блюда на остатке»: название и количество (например «0,150 Домен Брюне Шинон   3.00»);',
    '  • справа — «СТОП-ЛИСТ»: только названия, без количеств.',
    'Твоя задача — прочитать обе колонки и не перепутать их.',
    '',
    'Правила:',
    '1. Правая колонка целиком идёт в "stop": каждая строка — отдельная позиция, количества у неё нет.',
    '2. Левая колонка целиком идёт в "stock": name — название без числа-количества, qty — число из конца строки (3.00 → 3, 0.00 → 0). Если количество не читается, не выдумывай: не указывай qty совсем (пустое значение лучше нуля).',
    '3. Пиши названия ТАК, КАК НАПИСАНО: сохраняй регистр, «бут.», объёмы («0,3», «0,33», «40мл»), кавычки, дефисы, сокращения и опечатки. Не исправляй, не переводи, не раскрывай сокращения и не отрезай объём от названия: объём различает позиции («0,3 Курпфайц» и «0,5 Курпфайц» — разные позиции).',
    '4. Не придумывай позиции и не переноси строки между колонками. Если строка не читается (блик, смазано, обрезано краем) — не угадывай: перечисли в "unreadable", что именно не прочитано.',
    '5. Заголовки колонок («Блюда на остатке», «СТОП-ЛИСТ»), дату, время и подписи в списки не включай.',
    '6. Служебную строку внутри списка оставляй как написано (например «Комментарий на бар») — решает человек.',
    '7. Фото экрана часто с бликами и под углом: читай внимательно; если уверенности нет — строка идёт в "unreadable", а не в списки.',
    '8. Верни ТОЛЬКО JSON, без markdown и текста вокруг, строго по схеме:',
    '{"stock":[{"name":"строка как написана","qty":3.0}],"stop":[{"name":"строка как написана"}],"unreadable":""}',
    '9. Если на фото нет ни одной колонки (не тот кадр) — оба списка пустые, unreadable: "на фото нет стоп-листа".',
  ].join('\n');
}

/** Схема ответа: stock[name, qty] + stop[name] + unreadable. */
function stopGenerationConfig_() {
  return {
    temperature: 0,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'OBJECT',
      properties: {
        stock: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
              qty: { type: 'NUMBER' },
            },
            required: ['name'],
          },
        },
        stop: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
            },
            required: ['name'],
          },
        },
        unreadable: { type: 'STRING' },
      },
      required: ['stock', 'stop', 'unreadable'],
    },
  };
}

/**
 * Разбор ответа модели. Невалидный JSON/схема — {ok:false, reason}, а не
 * исключение: вызывающая сторона запишет «не распознано».
 */
function validateStopListAnswer_(text) {
  let obj;
  try { obj = JSON.parse(photoJsonText_(text)); } catch (e) { return { ok: false, reason: 'ответ не JSON' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'ответ не объект' };
  const unreadable = str_(obj.unreadable).slice(0, 400);

  const stock = [];
  const stockSeen = {};
  (Array.isArray(obj.stock) ? obj.stock : []).slice(0, STOP_MAX_ITEMS * 2).forEach(it => {
    const name = stopStripMarker_(str_(it && it.name)).slice(0, 160);
    if (!name) return;
    const qty = stopQty_(it && it.qty);
    const key = stopNameKey_(name) + '#' + (qty === null ? '' : qty);
    if (stockSeen[key]) return;
    stockSeen[key] = true;
    stock.push({ name: name, qty: qty });
  });

  const stop = [];
  const stopSeen = {};
  (Array.isArray(obj.stop) ? obj.stop : []).slice(0, STOP_MAX_ITEMS * 2).forEach(it => {
    const name = stopStripMarker_(str_(it && it.name)).slice(0, 160);
    if (!name) return;
    const key = stopNameKey_(name);
    if (!key || stopSeen[key]) return;
    stopSeen[key] = true;
    stop.push({ name: name });
  });

  if (!stock.length && !stop.length) {
    return { ok: false, empty: true, reason: unreadable || 'модель не вернула позиции' };
  }
  return {
    ok: true,
    stock: stock.slice(0, STOP_MAX_ITEMS),
    stop: stop.slice(0, STOP_MAX_ITEMS),
    unreadable: unreadable,
  };
}

/**
 * Один снимок → обе колонки. Никогда не бросает: любая ошибка (нет ключа,
 * квота 429, таймаут, мусор в ответе) превращается в {ok:false, reason},
 * чтобы фото всё равно сохранилось.
 */
function stopListRecognize_(blob, fileId) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const empty = { stock: [], stop: [], unreadable: '', model: '', reason: '' };
  if (!key) {
    return Object.assign({}, empty, { ok: false, reason: 'не задан ключ GEMINI_API_KEY' });
  }
  try {
    const parts = [
      { text: buildStopListPrompt_() },
      { inline_data: { mime_type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) } },
    ];
    const generationConfig = stopGenerationConfig_();
    const props = PropertiesService.getScriptProperties();
    const saved = str_(props.getProperty('GEMINI_MODEL'));
    const models = (saved ? [saved] : []).concat(GEMINI_MODELS.filter(m => m !== saved));
    const answer = runGeminiModels_(models, key, parts, generationConfig,
      () => photoShrinkParts_([{ fileId: fileId }]), 'Стоп-лист');
    const v = validateStopListAnswer_(answer.text);
    if (!v.ok) {
      const reason = v.empty ? (str_(v.reason) || 'на фото нет читаемых позиций')
        : 'ответ модели не разобран: ' + v.reason;
      log_('Стоп-лист', reason);
      return Object.assign({}, empty, {
        ok: false, reason: reason, unreadable: v.empty ? str_(v.reason) : '', model: answer.model,
      });
    }
    log_('Стоп-лист', 'Gemini ' + answer.model + ': остатков ' + v.stock.length +
      ', стоп-лист ' + v.stop.length + (v.unreadable ? ', есть нечитаемое' : ''));
    return {
      ok: true, stock: v.stock, stop: v.stop, unreadable: v.unreadable,
      model: answer.model, reason: '',
    };
  } catch (e) {
    const msg = String(e && e.message || e);
    const quota = /429|квот/i.test(msg);
    log_('Стоп-лист', 'Gemini: ' + msg.slice(0, 300));
    return Object.assign({}, empty, {
      ok: false, reason: (quota ? 'квота Gemini (429): ' : '') + msg.slice(0, 200),
    });
  }
}

/* ---------- запись распознанного в листы ---------------------------- */

/** Короткая подпись для строки «Фото уборки» и экрана результата. */
function stopPhotoSummary_(res, saved) {
  if (!res || !res.ok) return 'не распознано: ' + str_(res && res.reason).slice(0, 200);
  const stopCount = (saved && saved.stop ? saved.stop.length : 0);
  const stockCount = (saved && saved.stock ? saved.stock.length : 0);
  const fromStock = (saved && saved.stop ? saved.stop.filter(i => i.origin === 'stock').length : 0);
  const unknown = (saved && saved.stop ? saved.stop.filter(i => !i.inCatalog).length : 0);
  const excluded = (saved && saved.excluded ? saved.excluded.length : 0);
  const parts = ['в стопе: ' + stopCount];
  if (fromStock) parts.push('из них по остатку 0: ' + fromStock);
  parts.push('остатки: ' + stockCount);
  if (excluded) parts.push('кухня отсечена: ' + excluded);
  if (unknown) parts.push('нет в справочнике: ' + unknown);
  let s = parts.join(', ');
  if (res.unreadable) s += '; не прочитано: ' + res.unreadable;
  return s.slice(0, 500);
}

/**
 * Пишет снимок: активный стоп (объединение правой колонки и нулевых остатков)
 * — в «Стоп-лист», количества — в «Стоп-лист — остатки» (справка).
 * Кухня и служебные строки отсекаются по листу «Кухня».
 * Возвращает {stop, stock, excluded, day, floor}.
 */
function stopListSavePhotoRows_(ss, auth, id, created, fileUrl, floor, res) {
  const sh = ensureStopSheet_(ss);
  const cols = stopColumnMap_(sh);
  const stockSh = ensureStopStockSheet_(ss);
  const stockCols = stopStockColumnMap_(stockSh);
  const dict = stopDictionary_(ss);
  const kitchen = stopKitchenSet_(ss);
  const day = stopDayKey_(created);
  const fl = stopFloorNorm_(floor);
  const time = Utilities.formatDate(created, 'Europe/Moscow', 'HH:mm');
  const model = str_(res && res.model).slice(0, 80);

  const items = [];
  const stockItems = [];
  const excluded = [];

  if (res && res.ok) {
    // 1. Левая колонка: количества (справка) и кандидаты в стоп по нулю.
    const stockRows = [];
    (res.stock || []).forEach(it => {
      const shown = stopStripMarker_(it.name);
      if (!shown) return;
      if (stopIsKitchen_(shown, kitchen)) {
        if (excluded.indexOf(shown) < 0) excluded.push(shown);
        return;
      }
      stockRows.push([created, time, stopCell_(auth.name), fl, stopCell_(shown),
        it.qty === null || it.qty === undefined ? '' : it.qty, '', "'" + id, day, model]);
      stockItems.push({ name: shown, qty: it.qty === undefined ? null : it.qty, floor: fl });
    });

    // 2. Активный стоп = правая колонка ∪ позиции с нулевым остатком.
    const active = [];
    const seen = {};
    const addActive = function (name, origin) {
      const shown = stopStripMarker_(name);
      if (!shown) return;
      if (stopIsKitchen_(shown, kitchen)) {
        if (excluded.indexOf(shown) < 0) excluded.push(shown);
        return;
      }
      const key = stopNameKey_(shown);
      if (!key) return;
      if (seen[key]) {
        // Позиция уже в стопе; если она из правой колонки — источник важнее.
        if (origin === 'stop') seen[key].origin = 'stop';
        return;
      }
      seen[key] = { name: shown, origin: origin };
      active.push(seen[key]);
    };
    (res.stop || []).forEach(it => addActive(it.name, 'stop'));
    (res.stock || []).forEach(it => {
      if (it.qty === 0) addActive(it.name, 'stock');
    });

    // 3. Запись активного стопа.
    const rows = [];
    active.forEach(it => {
      const match = stopMatchName_(it.name, dict);
      const canonical = match ? match.name : '';
      const notes = [];
      if (it.origin === 'stock') notes.push('из остатка 0');
      if (!canonical) notes.push('нет в справочнике');
      const note = notes.join('; ');
      rows.push([created, time, stopCell_(auth.name), stopCell_(it.name), stopCell_(canonical),
        false, '', '', STOP_SOURCE_PHOTO, fl, "'" + id, day, model, stopCell_(note)]);
      items.push({
        name: it.name, canonical: canonical, inCatalog: !!canonical,
        crossedOut: false, confidence: null, note: note, floor: fl, origin: it.origin,
      });
    });
    if (rows.length) {
      const start = stopAppendRows_(sh, rows);
      stopLinkPhoto_(sh, cols.photo, start, rows.length, fileUrl);
    } else {
      // Снимок прочитан, но барных позиций в стопе нет: день с данными.
      stopAppendRows_(sh, [[created, time, stopCell_(auth.name), '', '', false, '', '',
        STOP_SOURCE_EMPTY, fl, "'" + id, day, model, stopCell_('стоп-лист пуст')]]);
    }

    // 4. Остатки — справка (на счёт дней не влияют).
    if (stockRows.length) {
      const start = stopAppendRows_(stockSh, stockRows);
      stopLinkPhoto_(stockSh, stockCols.photo, start, stockRows.length, fileUrl);
    }
  } else {
    // Снимок был, текст не прочитался: отметка в «Стоп-листе», чтобы день
    // не считался данными, а в недочётах появилось «нет данных за смену».
    stopAppendRows_(sh, [[created, time, stopCell_(auth.name), '', '', false, '', '',
      STOP_SOURCE_UNREADABLE, fl, "'" + id, day, model, stopCell_(str_(res && res.reason).slice(0, 300))]]);
  }

  return {
    stop: items, stock: stockItems, excluded: excluded,
    day: day, floor: fl,
  };
}

/** Ссылка на снимок в колонке «фото» — для каждой записанной строки. */
function stopLinkPhoto_(sheet, col, start, count, fileUrl) {
  if (!start || !fileUrl) return;
  for (let i = 0; i < count; i++) {
    try {
      sheet.getRange(start + i, col).setRichTextValue(
        SpreadsheetApp.newRichTextValue().setText('фото').setLinkUrl(fileUrl).build());
    } catch (e) {
      sheet.getRange(start + i, col).setValue(fileUrl);
    }
  }
}

/** Поля вердикта в строке «Фото уборки» для снимка стоп-листа. */
function writeStopPhotoVerdict_(sheet, row, res, summary) {
  try {
    const cols = ensurePhotoColumns_(sheet);
    sheet.getRange(row, PHOTO_COL.status).setValue('📋 Стоп-лист');
    sheet.getRange(row, PHOTO_COL.issues).setValue(text_(summary, 500));
    sheet.getRange(row, cols.verdict).setValue('стоп-лист');
    sheet.getRange(row, cols.confidence).setValue('');
    sheet.getRange(row, cols.notes).setValue(text_(summary, 1000));
    sheet.getRange(row, cols.model).setValue(str_(res && res.model).slice(0, 80));
    sheet.getRange(row, cols.checkedAt).setNumberFormat('dd.MM.yyyy HH:mm').setValue(new Date());
  } catch (e) {
    log_('Стоп-лист', 'вердикт фото не записался: ' + e);
  }
}

/* ---------- ручной ввод --------------------------------------------- */

/**
 * Ручной ввод позиции (когда фото не читается) — обычная запись из очереди
 * с телефона: type = 'stoplist'. Этаж — обязателен (по умолчанию 1).
 * Повторная та же позиция в тот же день, на том же этаже и с тем же
 * признаком «перечёркнута» второй строкой не пишется.
 */
function saveStopListItem_(ss, sheet, auth, rec, id, created, received, comment) {
  const name = stopStripMarker_(str_(rec.item)).slice(0, 160);
  if (!name) return { id, status: 'error', error: 'Не указана позиция стоп-листа' };
  const floor = stopFloorNorm_(rec.floor) || '1';
  const crossed = rec.crossedOut === true;
  const day = stopDayKey_(created);
  const dict = stopDictionary_(ss);
  // Кухня в стоп-лист бара не идёт: список ведёт владелец в листе «Кухня».
  if (stopIsKitchen_(name, stopKitchenSet_(ss))) {
    return { id, status: 'error', error: '«' + name + '» — позиция кухни, в стоп-лист бара не идёт' };
  }
  const match = stopMatchName_(name, dict);
  const canonical = match ? match.name : '';
  const key = stopNameKey_(canonical || name);

  const dayRows = stopRows_(sheet).filter(r => r.day === day && r.floor === floor && r.name);
  const same = dayRows.find(r => stopNameKey_(r.catalog || r.name) === key && r.crossed === crossed);
  if (same) return { id, status: 'duplicate' };

  const note = canonical ? (comment ? comment.slice(0, 200) : '') : 'нет в справочнике';
  stopAppendRows_(sheet, [[created, Utilities.formatDate(created, 'Europe/Moscow', 'HH:mm'),
    stopCell_(auth.name), stopCell_(name), stopCell_(canonical), crossed, '', '',
    STOP_SOURCE_MANUAL, floor, "'" + id, day, '', stopCell_(note)]]);
  log_('Стоп-лист', 'ручной ввод (' + stopFloorLabel_(floor) + '): ' + name +
    (canonical && canonical !== name ? ' → ' + canonical : '') + (crossed ? ' (перечёркнута)' : ''));
  return {
    id, status: 'saved',
    stoplist: { manual: true, item: name, canonical: canonical, crossed: crossed, day: day, floor: floor },
  };
}

/* ---------- расчёт: дни в стопе, история, недочёты ------------------ */

/** Настройки стоп-листа из листа «Настройки» (с умолчаниями и границами). */
function stopSettings_(ss) {
  let values = {};
  try { values = settingsValues_(ss); } catch (e) { values = {}; }
  const num = function (key, def, min, max) {
    const raw = str_(values[key]).replace(',', '.');
    const n = Number(raw);
    if (!raw || !isFinite(n) || n <= 0) return def;
    return Math.min(Math.max(Math.round(n), min), max);
  };
  const gapRaw = str_(values['стоплист_пропуск_обрывает']);
  return {
    longDays: num('стоплист_долго_дней', STOP_DEFAULT_LONG_DAYS, 1, 60),
    prematureDays: num('стоплист_преждевременно_дней', STOP_DEFAULT_PREMATURE_DAYS, 1, 14),
    historyDays: num('стоплист_история_дней', STOP_DEFAULT_HISTORY_DAYS, 1, 365),
    gapBreaks: gapRaw ? featureOn_(gapRaw) : false,
    checks: {
      long: featureOn_(values['стоплист_проверять_долго']),
      premature: featureOn_(values['стоплист_проверять_преждевременно']),
      catalog: featureOn_(values['стоплист_проверять_справочник']),
      data: featureOn_(values['стоплист_проверять_данные']),
    },
  };
}

/**
 * Как показывать позицию. Правило владельца: на экране — исходное написание,
 * а не «причёсанное» справочником или нормализацией. Поэтому берём написание
 * первого появления в записях (строки листа идут в порядке добавления, то есть
 * по времени); справочник — только для тега «нет в справочнике».
 */
function stopPickName_(names, first) {
  if (first) return first;
  let best = '', bestN = -1;
  Object.keys(names || {}).forEach(k => {
    if (names[k] > bestN) { bestN = names[k]; best = k; }
  });
  return best;
}

/**
 * Состояние одной позиции: streaks, текущий счёт, «убрано преждевременно»,
 * история по дням. dataDays — все дни с данными ЭТОГО этажа (по возрастанию).
 */
function stopGroupState_(g, dataDays, lastDataDay, today, settings) {
  const streaks = [];
  let cur = null;
  dataDays.forEach(day => {
    const d = g.days[day];
    if (d && d.present) {
      if (cur && settings.gapBreaks && stopDayDiff_(cur.to, day) > 1) {
        streaks.push(cur);
        cur = null;
      }
      if (!cur) cur = { from: day, to: day, days: 0 };
      cur.to = day;
      cur.days++;
    } else if (cur) {
      // В этот день данные есть, а позиции нет — её убрали, счёт закончен.
      streaks.push(cur);
      cur = null;
    }
  });
  if (cur) streaks.push(cur);
  streaks.forEach(s => {
    s.span = stopDayDiff_(s.from, s.to) + 1;
    s.gaps = Math.max(0, s.span - s.days);
  });

  const current = streaks.length && streaks[streaks.length - 1].to === lastDataDay
    ? streaks[streaks.length - 1] : null;
  const crossedDays = Object.keys(g.crossedDays || {}).sort();
  const removedAt = crossedDays.length ? crossedDays[crossedDays.length - 1] : '';

  // «Убрано преждевременно»: позиция пропала (её убрали, в том числе
  // перечеркнули руками) и вернулась в течение N дней. Считаем от дня,
  // когда её убрали, а не от последнего дня, когда она была в стопе.
  let premature = null;
  for (let i = 1; i < streaks.length; i++) {
    const before = streaks[i - 1];
    const after = streaks[i];
    let removalDay = '';
    for (let j = 0; j < dataDays.length; j++) {
      const d = dataDays[j];
      if (stopDayDiff_(before.to, d) > 0 && stopDayDiff_(d, after.from) > 0) { removalDay = d; break; }
    }
    const crossedBetween = crossedDays.filter(d => stopDayDiff_(before.to, d) > 0 && stopDayDiff_(d, after.from) > 0).sort();
    const removedAt = removalDay || crossedBetween[0] || before.to;
    const gap = stopDayDiff_(removedAt, after.from);
    if (gap < 1 || gap > settings.prematureDays) continue;
    premature = {
      removedAt: removedAt,
      returnedAt: after.from,
      gapDays: gap,
      beforeDays: before.days,
    };
  }

  const allDays = Object.keys(g.days).sort();
  const history = g.records
    .filter(r => stopDayDiff_(r.day, today) <= settings.historyDays)
    .sort((a, b) => (a.day === b.day ? String(a.time).localeCompare(String(b.time)) : a.day.localeCompare(b.day)))
    .map(r => ({ day: r.day, crossed: r.crossed, source: r.source, name: r.name }));

  return {
    name: stopPickName_(g.names, g.firstName),
    canonical: g.canonical || '',
    inCatalog: !!g.canonical,
    fromStock: !!g.fromStock,
    days: current ? current.days : 0,
    since: current ? current.from : '',
    span: current ? current.span : 0,
    gaps: current ? current.gaps : 0,
    long: !!(current && settings.checks.long && current.days >= settings.longDays),
    wasCrossed: crossedDays.length > 0,
    removedAt: removedAt,
    premature: premature,
    returned: streaks.length >= 2,
    lastReturnAt: streaks.length >= 2 ? streaks[streaks.length - 1].from : '',
    streaks: streaks.map(s => ({ from: s.from, to: s.to, days: s.days, span: s.span, gaps: s.gaps })),
    totalDays: streaks.reduce((a, s) => a + s.days, 0),
    lastSeen: allDays.length ? allDays[allDays.length - 1] : '',
    records: g.records.length,
    history: history,
  };
}

/**
 * Состояние одного этажа: позиции стоп-листа, дни, недочёты, остатки.
 * rowsF — строки «Стоп-листа» этого этажа, stockF — строки остатков.
 */
function stopFloorState_(floor, rowsF, stockF, settings, today, dict) {
  const dataDays = [];
  const seenDay = {};
  const noData = [];
  let photos = 0;
  let manual = 0;
  const photoIds = {};

  rowsF.forEach(r => {
    if (!r.name) {
      if (r.source === STOP_SOURCE_UNREADABLE) {
        noData.push({ day: r.day, time: r.time, reason: r.note || 'не распознано', employee: r.employee });
        return;
      }
      if (r.source === STOP_SOURCE_EMPTY) {
        // Снимок прочитан, барных позиций в стопе нет: день с данными без позиций.
        if (!seenDay[r.day]) { seenDay[r.day] = true; dataDays.push(r.day); }
        photos++;
        if (r.id) photoIds[r.id] = true;
      }
      return;
    }
    if (!seenDay[r.day]) { seenDay[r.day] = true; dataDays.push(r.day); }
    if (r.source === STOP_SOURCE_MANUAL) manual++;
    else {
      photos++;
      if (r.id) photoIds[r.id] = true;
    }
  });
  dataDays.sort();
  noData.sort((a, b) => (a.day === b.day ? String(a.time).localeCompare(String(b.time)) : b.day.localeCompare(a.day)));
  const lastDataDay = dataDays.length ? dataDays[dataDays.length - 1] : '';

  // Группы: одна позиция справочника (или одно ненайденное название) = группа.
  const groups = {};
  const order = [];
  rowsF.forEach(r => {
    if (!r.name) return;
    const rematch = !r.catalog ? stopMatchName_(r.name, dict) : null;
    const canonical = r.catalog || (rematch ? rematch.name : '');
    const gkey = canonical ? 'c:' + stopNameKey_(canonical) : 'r:' + stopNameKey_(r.name);
    if (!gkey || gkey === 'r:') return;
    if (!groups[gkey]) {
      groups[gkey] = {
        key: gkey, canonical: canonical, names: {}, days: {}, records: [],
        crossedDays: {}, fromStock: false, firstName: '',
      };
      order.push(gkey);
    }
    const g = groups[gkey];
    if (!g.canonical && canonical) g.canonical = canonical;
    if (!g.firstName) g.firstName = r.name;
    if (!g.fromStock && /из остатка 0/.test(r.note || '')) g.fromStock = true;
    const label = canonical || r.name;
    g.names[label] = (g.names[label] || 0) + 1;
    const d = g.days[r.day] || (g.days[r.day] = { present: false, crossed: false, records: 0 });
    if (r.crossed) d.crossed = true; else d.present = true;
    d.records++;
    if (r.crossed) g.crossedDays[r.day] = true;
    g.records.push(r);
  });

  const positions = order.map(k => stopGroupState_(groups[k], dataDays, lastDataDay, today, settings));
  const current = positions.filter(p => p.days > 0)
    .sort((a, b) => (b.days - a.days) || String(a.name).localeCompare(String(b.name), 'ru'));

  const missingCatalog = current.filter(p => !p.inCatalog);
  const long = current.filter(p => p.long);
  const premature = positions.filter(p => p.premature);
  const returned = positions.filter(p => p.returned && p.days > 0);

  const issuesCount =
    (settings.checks.long ? long.length : 0) +
    (settings.checks.premature ? premature.length : 0) +
    (settings.checks.catalog ? missingCatalog.length : 0) +
    (settings.checks.data ? noData.length : 0);

  return {
    floor: floor,
    positions: positions,
    current: current,
    long: long,
    premature: premature,
    missingCatalog: missingCatalog,
    returned: returned,
    noData: noData.slice(0, 10),
    issuesCount: issuesCount,
    totals: {
      positions: positions.length,
      inStop: current.length,
      daysWithData: dataDays.length,
      photos: photos,
      photoShots: Object.keys(photoIds).length,
      manual: manual,
      unreadable: noData.length,
      lastDay: lastDataDay,
    },
  };
}

/**
 * Полное состояние стоп-листа: по каждому этажу — текущий список с днями,
 * долгожители, «убрано преждевременно», «нет в справочнике», «нет данных».
 * Остатки в расчёт не входят: нулевой остаток уже превратился в позицию
 * стопа при записи снимка.
 */
function stopListState_(ss) {
  const settings = stopSettings_(ss);
  const stopSh = ensureStopSheet_(ss);
  // Листы создаём заранее: владелец должен видеть их в таблице до первого
  // снимка (ошибка создания не должна ломать чтение).
  try { ensureStopStockSheet_(ss); } catch (e) { log_('Стоп-лист', 'лист остатков не создан: ' + e); }
  try { ensureKitchenSheet_(ss); } catch (e) { log_('Стоп-лист', 'лист «Кухня» не создан: ' + e); }
  const rows = stopRows_(stopSh);
  const today = stopDayKey_(new Date());
  const dict = stopDictionary_(ss);

  const inWindow = function (r) {
    if (!r.day) return false;
    const back = stopDayDiff_(r.day, today);
    return back >= -1 && back <= STOP_ANALYSIS_DAYS;
  };

  const byFloor = {};
  const order = [];
  const ensureFloor = function (f) {
    if (!byFloor[f]) { byFloor[f] = { stop: [] }; order.push(f); }
    return byFloor[f];
  };
  // Оба этажа показываем всегда: даже пустой стоп — это ответ.
  STOP_STANDARD_FLOORS.forEach(ensureFloor);
  rows.filter(inWindow).forEach(r => ensureFloor(r.floor).stop.push(r));

  order.sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    const fa = isFinite(na), fb = isFinite(nb);
    if (fa && fb && na !== nb) return na - nb;
    if (fa !== fb) return fa ? -1 : 1;
    return String(a).localeCompare(String(b), 'ru');
  });

  const floors = order.map(f => stopFloorState_(f, byFloor[f].stop, [], settings, today, dict));
  const history = {};
  let positions = 0, inStop = 0, photos = 0, manual = 0, unreadable = 0;
  floors.forEach(fs => {
    history[fs.floor] = {};
    fs.positions.forEach(p => { history[fs.floor][p.name] = p.history; });
    positions += fs.totals.positions;
    inStop += fs.totals.inStop;
    photos += fs.totals.photos;
    manual += fs.totals.manual;
    unreadable += fs.totals.unreadable;
  });

  return {
    today: today,
    settings: settings,
    floors: floors,
    history: history,
    totals: {
      floors: floors.length,
      positions: positions,
      inStop: inStop,
      photos: photos,
      manual: manual,
      unreadable: unreadable,
    },
  };
}

/** Позиция для телефона: без внутренних полей, но со всем нужным для экрана. */
function stopItemPublic_(p, floor) {
  return {
    floor: floor || '',
    name: p.name,
    canonical: p.canonical || '',
    inCatalog: !!p.inCatalog,
    fromStock: !!p.fromStock,
    days: p.days,
    since: p.since,
    span: p.span,
    gaps: p.gaps,
    long: !!p.long,
    wasCrossed: !!p.wasCrossed,
    removedAt: p.removedAt || '',
    premature: p.premature
      ? { removedAt: p.premature.removedAt, returnedAt: p.premature.returnedAt,
        gapDays: p.premature.gapDays, beforeDays: p.premature.beforeDays }
      : null,
    returned: !!p.returned,
    lastReturnAt: p.lastReturnAt || '',
    streaks: (p.streaks || []).map(s => ({ from: s.from, to: s.to, days: s.days, gaps: s.gaps || 0 })),
    totalDays: p.totalDays,
    lastSeen: p.lastSeen || '',
    records: p.records,
  };
}

/**
 * Ответ телефону. withHistory = true — отдельный запрос (?action=stopList),
 * false — компактная версия для config (история по позициям не влезает).
 */
function stopListPublic_(state, withHistory) {
  const floors = state.floors.map(f => ({
    floor: f.floor,
    label: stopFloorLabel_(f.floor),
    current: f.current.map(p => stopItemPublic_(p, f.floor)),
    long: f.long.map(p => stopItemPublic_(p, f.floor)),
    premature: f.premature.map(p => stopItemPublic_(p, f.floor)),
    missingCatalog: f.missingCatalog.map(p => stopItemPublic_(p, f.floor)),
    returned: f.returned.map(p => stopItemPublic_(p, f.floor)),
    noData: f.noData,
    issuesCount: f.issuesCount,
    totals: f.totals,
  }));
  const out = {
    ok: true,
    today: state.today,
    updatedAt: new Date().toISOString(),
    settings: state.settings,
    floors: floors,
    summary: floors.map(f => ({
      floor: f.floor, label: f.label,
      inStop: f.current.length, long: f.long.length, issues: f.issuesCount,
    })),
    totals: state.totals,
  };
  if (withHistory) out.history = state.history;
  return out;
}

/** GET ?action=stopList — текущий список по этажам, дни, история, недочёты. */
function getStopList_() {
  try {
    return stopListPublic_(stopListState_(ss_()), true);
  } catch (e) {
    log_('Стоп-лист', 'не прочитан: ' + String(e && e.stack || e));
    return { ok: false, error: 'Не удалось прочитать стоп-лист: ' + e };
  }
}

/** Ручной запуск из редактора: создать листы и строки настроек. */
function setupStopList() {
  const ss = ss_();
  const sh = ensureStopSheet_(ss);
  const stock = ensureStopStockSheet_(ss);
  const kitchen = ensureKitchenSheet_(ss);
  ensureSettingsSheet_(ss);
  const msg = 'Стоп-лист: лист «' + SHEETS.stopList + '» ' +
    (sh.getLastRow() < 2 ? 'пустой' : 'строк: ' + (sh.getLastRow() - 1)) +
    '; остатки: ' + (stock.getLastRow() < 2 ? 'пусто' : 'строк: ' + (stock.getLastRow() - 1)) +
    '; кухня: ' + Math.max(0, kitchen.getLastRow() - 1) + ' поз.' +
    '; ключ Gemini: ' + (PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') ? 'есть' : 'НЕТ') + '.';
  Logger.log(msg);
  log_('Стоп-лист', msg);
  return msg;
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
