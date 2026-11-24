// =====================================================================
//  ЛОКАЛЬНЫЕ ТЕСТЫ СТОП-ЛИСТА ПО ФОТО (без сети и без Google)
//
//  Реальное фото владельца — снимок экрана планшета с двумя колонками:
//  «Блюда на остатке» (позиция + количество) и «СТОП-ЛИСТ» (позиции).
//  Тесты проверяют:
//    * промпт и схему ответа (stock[name, qty] + stop[name] + unreadable);
//    * разбор ответа: qty null вместо выдуманного нуля, дубликаты, «не читается»;
//    * названия с объёмом не сливаются: «0,3 Курпфайц» ≠ «0,5 Курпфайц»;
//    * дни в стопе в разрезе этаж + позиция; повторы в день, пропуск, выпадение;
//    * недочёты по остаткам: «нет в стопе при нулевом остатке» и «в стопе,
//      а остаток есть» — на реальных названиях с фото;
//    * снимок через submit: пишутся обе колонки и этаж, квота/сбой не роняют;
//    * ручной ввод с этажом и дублями;
//    * config.stopList по этажам и ?action=stopList с историей;
//    * регрессию: обычное фото уборки по-прежнему проверяется на чистоту.
//
//  Запуск: node tools/test-stop-list.mjs
// =====================================================================

import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const CODE = fs.readFileSync(new URL('../apps-script/Код.gs', import.meta.url), 'utf8');

// ---------- таблица-заглушка ----------
class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    this.sheet = sheet; this.row = row; this.col = col;
    this.numRows = numRows; this.numCols = numCols;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet.get(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getValue() { return this.sheet.get(this.row, this.col); }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  setValues(values) {
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return this;
  }
  setFontWeight() { return this; }
  setNumberFormat() { return this; }
  setDataValidation() { return this; }
  setRichTextValue(v) {
    this.sheet.set(this.row, this.col, v && v.text !== undefined ? v.text : String(v));
    return this;
  }
  createTextFinder(text) {
    const sheet = this.sheet, row = this.row, col = this.col, rows = this.numRows;
    return {
      matchEntireCell() { return this; },
      findNext() {
        for (let i = 0; i < rows; i++) {
          if (String(sheet.get(row + i, col)) === String(text)) return {};
        }
        return null;
      },
    };
  }
}

class FakeSheet {
  constructor(name, headers = [], rows = []) {
    this.name = name;
    this.cells = headers.length ? [headers.slice()] : [];
    rows.forEach(r => this.cells.push(r.slice()));
  }
  getName() { return this.name; }
  getLastRow() {
    let last = 0;
    this.cells.forEach((r, i) => {
      if (r.some(v => v !== '' && v !== null && v !== undefined)) last = i + 1;
    });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.cells.forEach(r => r.forEach((v, i) => {
      if (v !== '' && v !== null && v !== undefined) last = Math.max(last, i + 1);
    }));
    return last;
  }
  getMaxRows() { return Math.max(this.cells.length, 1000); }
  getMaxColumns() { return Math.max(this.getLastColumn(), 30); }
  getRange(row, col, numRows = 1, numCols = 1) { return new FakeRange(this, row, col, numRows, numCols); }
  insertRowsAfter() {}
  deleteRows() {}
  deleteRow(row) {
    if (row >= 1 && row <= this.cells.length) this.cells.splice(row - 1, 1);
  }
  setFrozenRows() {}
  setColumnWidth() {}
  appendRow(values) {
    const row = this.getLastRow() + 1;
    values.forEach((v, i) => this.set(row, i + 1, v));
  }
  get(row, col) {
    const r = this.cells[row - 1];
    return r && r[col - 1] !== undefined ? r[col - 1] : '';
  }
  set(row, col, v) {
    while (this.cells.length < row) this.cells.push([]);
    const r = this.cells[row - 1];
    while (r.length < col) r.push('');
    // Таблицы показывают «'текст» без апострофа: он только формат ячейки.
    r[col - 1] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
  }
}

class FakeSpreadsheet {
  constructor(sheets = []) {
    this.sheets = new Map();
    sheets.forEach(([name, headers, rows]) => this.sheets.set(name, new FakeSheet(name, headers, rows)));
  }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) {
    if (this.sheets.has(name)) throw new Error('лист уже есть: ' + name);
    const sh = new FakeSheet(name);
    this.sheets.set(name, sh);
    return sh;
  }
}

// ---------- заглушки сервисов ----------
const state = {
  log: [], ss: null, fetchCalls: [], fetchHandler: null,
  folders: new Map(), files: new Map(), props: new Map(),
};
let seq = 0;

/** Москва = UTC+3, без перехода на летнее время. */
function moscow(date) { return new Date(new Date(date).getTime() + 3 * 3600 * 1000); }
function fmtDate(date, fmt) {
  const d = moscow(date);
  const p = n => String(n).padStart(2, '0');
  const y = d.getUTCFullYear(), mo = p(d.getUTCMonth() + 1), da = p(d.getUTCDate());
  const hh = p(d.getUTCHours()), mi = p(d.getUTCMinutes());
  if (fmt === 'yyyy-MM-dd') return `${y}-${mo}-${da}`;
  if (fmt === 'HH:mm') return `${hh}:${mi}`;
  if (fmt === 'yyyy-MM') return `${y}-${mo}`;
  if (fmt === 'yyyy-MM-dd_HH-mm') return `${y}-${mo}-${da}_${hh}-${mi}`;
  return `${y}-${mo}-${da} ${hh}:${mi}`;
}

function folderObj(id) {
  return {
    getId: () => id,
    getUrl: () => 'https://drive.google.com/drive/folders/' + id,
    getFoldersByName: (name) => {
      const kids = (state.folders.get(id) || { kids: [] }).kids
        .filter(k => state.folders.get(k) && state.folders.get(k).name === name);
      let i = 0;
      return { hasNext: () => i < kids.length, next: () => folderObj(kids[i++]) };
    },
    createFolder: (name) => {
      const nid = 'folder-' + (++seq);
      state.folders.set(nid, { name, kids: [], files: [] });
      state.folders.get(id).kids.push(nid);
      return folderObj(nid);
    },
    createFile: (blob) => {
      const fid = 'file-' + (++seq);
      state.files.set(fid, { name: blob.getName ? blob.getName() : '', bytes: blob.getBytes() });
      state.folders.get(id).files.push(fid);
      return fileObj(fid);
    },
  };
}

function fileObj(id) {
  return {
    getId: () => id,
    getUrl: () => 'https://drive.google.com/file/d/' + id + '/view',
    getBlob: () => ({
      getContentType: () => 'image/jpeg',
      getBytes: () => (state.files.get(id) || { bytes: [1, 2, 3] }).bytes,
    }),
    getThumbnail: () => null,
  };
}

const sandbox = {
  console,
  Logger: { log: (m) => state.log.push(String(m)) },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (state.props.has(k) ? state.props.get(k) : null),
      setProperty: (k, v) => state.props.set(k, String(v)),
      deleteProperty: (k) => state.props.delete(k),
    }),
  },
  Utilities: {
    formatDate: (d, tz, fmt) => fmtDate(d, fmt),
    base64Encode: b => Buffer.from(b).toString('base64'),
    base64Decode: s => Uint8Array.from(Buffer.from(String(s), 'base64')),
    newBlob: (bytes, mime, name) => ({
      getBytes: () => bytes, getContentType: () => mime, getName: () => name || '',
    }),
  },
  UrlFetchApp: {
    fetch: (url, options) => {
      state.fetchCalls.push({ url, options });
      if (!state.fetchHandler) throw new Error('нет мока fetch');
      return state.fetchHandler(url, options, state.fetchCalls.length);
    },
  },
  DriveApp: {
    getFolderById: (id) => {
      if (!state.folders.has(id)) throw new Error('нет папки ' + id);
      return folderObj(id);
    },
    createFolder: (name) => {
      const id = 'folder-' + (++seq);
      state.folders.set(id, { name, kids: [], files: [] });
      return folderObj(id);
    },
    getFileById: (id) => {
      if (!state.files.has(id)) throw new Error('нет файла ' + id);
      return fileObj(id);
    },
  },
  SpreadsheetApp: {
    openById: () => state.ss,
    flush: () => {},
    newDataValidation: () => {
      const obj = {
        requireCheckbox() { return obj; },
        requireValueInList() { return obj; },
        build() { return {}; },
      };
      return obj;
    },
    newRichTextValue: () => {
      const obj = {
        text: '', url: '', links: [],
        setText(t) { this.text = t; return this; },
        setLinkUrl(a, b, c) {
          if (b === undefined) this.url = a;
          else this.links.push([a, b, c]);
          return this;
        },
        build() { return { text: this.text, url: this.url, links: this.links }; },
      };
      return obj;
    },
  },
  ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {} },
  ContentService: { createTextOutput: (s) => ({ setMimeType: () => s }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
};

vm.createContext(sandbox);
vm.runInContext(CODE, sandbox, { filename: 'Код.gs' });
sandbox.log_ = (event, details) => state.log.push(event + ': ' + details);
// const в vm не попадает в контекст — забираем константы явно.
sandbox.STOP_HEADERS = vm.runInContext('STOP_HEADERS', sandbox);
sandbox.STOP_STOCK_HEADERS = vm.runInContext('STOP_STOCK_HEADERS', sandbox);
sandbox.STOP_SETTINGS = vm.runInContext('STOP_SETTINGS', sandbox);

// ---------- вспомогательное ----------
const HEADERS = {
  staff: ['Имя', 'PIN (4–6 цифр)', 'Роль', 'Активен'],
  items: ['Позиция', 'Ед.', 'Категория', 'Показывать'],
  lists: ['Причины списания', 'Зоны уборки', 'Активная инвентаризация', 'Места инвентаризации', 'Места Gift-shop', 'Оформление приложения'],
  ttk: ['Название', 'Категория', 'Бокал', 'Метод', 'Ингредиенты', 'Гарнир', 'Подача и заметки', 'Фото', 'Показывать'],
  acts: ['Дата', 'Сотрудник', 'Акт', 'Роль', 'Позиция', 'Кол-во', 'Ед.', 'Выход %', 'Комментарий',
    'Получено', 'ID акта', 'Чистый вес', 'Статус', 'Закрыл', 'Когда закрыт', 'ID закрытия'],
  tpl: ['Акт', 'Тип', 'Роль', 'Позиция', 'Ед.', 'Кол-во по рецепту', 'Ключевое', 'Показывать',
    'Постоянное (не пересчитывать)', 'Чистить (вес до и после)'],
  invList: ['Категория', 'Вид', 'Позиция', 'Ед. учёта', 'Объём тары', 'Вес пустой тары, г', 'Плотность', 'Показывать'],
  photos: ['Дата', 'Сотрудник', 'Зона', 'Фото', 'Комментарий', 'Получено', 'ID записи',
    'Проверка ИИ', 'Что не так', 'Замечание менеджера', 'Фото удалено', 'ID файла'],
  settings: ['ключ', 'значение', 'комментарий'],
};

const ITEMS = [
  ['Курпфайц нефильтрованное', 'мл', 'Пиво', true],
  ['Домен Брюне Шинон', 'мл', 'Вино', true],
  ['Лимоны', 'г', 'Фрукты', true],
  ['Просекко', 'мл', 'Игристое', true],
  ['Сливки', 'мл', 'Молочное', true],
];

function makeSs(extra) {
  const ss = new FakeSpreadsheet([
    ['Сотрудники', HEADERS.staff, [['Анна', '1234', 'бармен', true], ['Борис', '5678', 'админ', true]]],
    ['Справочник', HEADERS.items, ITEMS],
    ['Списки', HEADERS.lists, [['Бой', 'Бар 1 этаж', '', 'Склад', 'Кабинет', 'обычное']]],
    ['ТТК', HEADERS.ttk, []],
    ['Шаблоны переработки', HEADERS.tpl, []],
    ['Опись', HEADERS.invList, []],
    ['Акты переработки', HEADERS.acts, []],
    ['Лог', ['Время', 'Событие', 'Детали'], []],
    ['Сроки хранения', ['заготовка', 'короткое_имя', 'срок_часов', 'примечание', 'активен'], []],
    ['Чек-листы', ['список', 'порядок', 'пункт', 'подсказка', 'фото_обязательно', 'активен'], []],
    ['Чек-листы — отметки', ['дата', 'время', 'сотрудник', 'список', 'прогон_id', 'пункт', 'отмечено', 'комментарий', 'фото'], []],
    ['Факты', ['id', 'текст', 'источник', 'активен', 'дата_показа'], []],
    ['Эталоны уборки', ['этаж', 'зона', 'критерии', 'эталонное_фото'], []],
    ['Фото уборки', HEADERS.photos, []],
  ]);
  for (const [name, spec] of Object.entries(extra || {})) {
    ss.sheets.set(name, new FakeSheet(name, spec[0], spec[1] || []));
  }
  return ss;
}

const results = [];
function test(name, fn) {
  state.log = [];
  state.fetchCalls = [];
  state.props.set('GEMINI_API_KEY', 'test-key'); // ключ в свойствах скрипта, как на бою
  try { fn(); results.push(['OK', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + (e && e.message || e)]); }
}
function apiResponse(code, body) {
  return {
    getResponseCode: () => code,
    getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
function geminiOk(obj) {
  return apiResponse(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
}
const rowsOf = (ss, name) => {
  const sh = ss.getSheetByName(name);
  if (!sh) return [];
  return sh.cells.slice(1).filter(r => r.some(v => v !== '' && v !== null && v !== undefined));
};
const sheetOf = (ss, name) => ss.getSheetByName(name);
const payloadOf = (n) => JSON.parse(state.fetchCalls[n || 0].options.payload);
const promptOf = (n) => payloadOf(n).contents[0].parts[0].text;

const B64 = Buffer.from([1, 2, 3, 4]).toString('base64');
const dataUrl = () => 'data:image/jpeg;base64,' + B64;

const today = () => sandbox.stopDayKey_(new Date());
const dayAgo = (n) => sandbox.stopDayAdd_(today(), -n);

/** Строка в «Стоп-лист» напрямую: проверяем формулы без сети и Gemini. */
function addStopRow(ss, o) {
  const sh = sandbox.ensureStopSheet_(ss);
  const day = o.day || today();
  sandbox.stopAppendRows_(sh, [[
    new Date(day + 'T20:00:00+03:00'), o.time || '23:00', o.employee || 'Анна',
    o.name, o.catalog || '', !!o.crossed, o.confidence === undefined ? '' : o.confidence,
    o.photo || '', o.source || 'фото', o.floor || '1', o.id ? "'" + o.id : '', day,
    o.model || 'gemini-flash-lite-latest', o.note || '',
  ]]);
}

/** Строка в «Стоп-лист — остатки» (архив количеств, на счёт дней не влияет). */
function addStockRow(ss, o) {
  const sh = sandbox.ensureStopStockSheet_(ss);
  const day = o.day || today();
  sandbox.stopAppendRows_(sh, [[
    new Date(day + 'T20:00:00+03:00'), o.time || '23:00', o.employee || 'Анна',
    o.floor || '1', o.name, o.qty === null || o.qty === undefined ? '' : o.qty,
    '', o.id ? "'" + o.id : '', day, o.model || 'gemini-flash-lite-latest',
  ]]);
}

/**
 * Снимок стоп-листа «как с планшета» на нужный день: пишет объединение
 * (правая колонка + нулевые остатки), отсекает кухню. Возвращает результат
 * stopListSavePhotoRows_ — по нему проверяем, что попало в лист.
 */
function photoSave(ss, o) {
  const day = o.day || today();
  const created = new Date(day + 'T' + (o.time || '23:00') + ':00+03:00');
  let n = (photoSave.seq = (photoSave.seq || 0) + 1);
  return sandbox.stopListSavePhotoRows_(ss, { name: o.employee || 'Анна' },
    o.id || 'photo-' + String(1000 + n) + '-abcd', created, '', o.floor || '1', {
      ok: true, model: 'gemini-flash-lite-latest', unreadable: '', reason: '',
      stop: (o.stop || []).map(name => ({ name: name })),
      stock: (o.stock || []).map(x => ({ name: x[0], qty: x[1] })),
    });
}

function setSetting(ss, key, value) {
  sandbox.ensureSettingsSheet_(ss);
  const sh = sheetOf(ss, 'Настройки');
  for (let r = 2; r <= sh.cells.length; r++) {
    if (String(sh.get(r, 1)) === key) { sh.set(r, 2, value); return true; }
  }
  return false;
}

const floorOf = (st, floor) => st.floors.find(f => f.floor === floor);

// =====================================================================
//  A. ПРОМПТ И СХЕМА ОТВЕТА
// =====================================================================
test('промпт: две колонки, объём не отрезать, ничего не выдумывать', () => {
  const p = sandbox.buildStopListPrompt_();
  assert.match(p, /Блюда на остатке/);
  assert.match(p, /СТОП-ЛИСТ/);
  assert.match(p, /не отрезай объём/i);
  assert.match(p, /0,3 Курпфайц.*0,5 Курпфайц/s);
  assert.match(p, /Не придумывай позиции/);
  assert.match(p, /unreadable/);
  assert.match(p, /\{"stock":\[\{"name"/);
  assert.match(p, /"qty"/);
  // справочник в промпт не подмешиваем — нормализация на сервере
  assert.doesNotMatch(p, /справочник/i);
});

test('схема ответа: stock[name, qty] + stop[name] + unreadable', () => {
  const cfg = sandbox.stopGenerationConfig_();
  assert.equal(cfg.responseMimeType, 'application/json');
  assert.equal(cfg.temperature, 0);
  const s = cfg.responseSchema;
  assert.deepEqual(Object.keys(s.properties), ['stock', 'stop', 'unreadable']);
  assert.deepEqual(Object.keys(s.properties.stock.items.properties), ['name', 'qty']);
  assert.deepEqual(Array.from(s.properties.stock.items.required), ['name']); // qty необязателен
  assert.deepEqual(Object.keys(s.properties.stop.items.properties), ['name']);
  assert.deepEqual(Array.from(s.required), ['stock', 'stop', 'unreadable']);
});

// =====================================================================
//  B. РАЗБОР ОТВЕТА МОДЕЛИ
// =====================================================================
test('ответ с двумя колонками разбирается: stock с qty, stop без количеств', () => {
  const v = sandbox.validateStopListAnswer_(JSON.stringify({
    stock: [
      { name: '0,150 Домен Брюне Шинон', qty: 3 },
      { name: 'Чиз-кейк "Нью-Йорк"', qty: 0 },
    ],
    stop: [
      { name: '0,3 Курпфайц нефильтрованное' },
      { name: '0,5 Курпфайц нефильтрованное' },
    ],
    unreadable: '',
  }));
  assert.equal(v.ok, true);
  assert.equal(v.stock.length, 2);
  assert.equal(v.stock[0].qty, 3);
  assert.equal(v.stock[1].qty, 0);          // 0.00 — это закончилось, не «пусто»
  assert.equal(v.stop.length, 2);
  assert.equal(v.stop[0].name, '0,3 Курпфайц нефильтрованное');
});

test('количество не читается — qty null, а не 0', () => {
  const v = sandbox.validateStopListAnswer_(JSON.stringify({
    stock: [
      { name: 'Сидр без числа' },
      { name: 'Странное', qty: 'много' },
      { name: 'Отрицательное', qty: -2 },
      { name: 'С запятой', qty: '1,500' },
    ],
    stop: [{ name: 'Вишневка 40мл' }],
    unreadable: '',
  }));
  assert.equal(v.ok, true);
  assert.equal(v.stock[0].qty, null);
  assert.equal(v.stock[1].qty, null);
  assert.equal(v.stock[2].qty, null);
  assert.equal(v.stock[3].qty, 1.5);
});

test('markdown-обёртка, дубликаты и мусор не ломают разбор', () => {
  const v = sandbox.validateStopListAnswer_('```json\n' + JSON.stringify({
    stock: [{ name: 'Лимоны', qty: 2 }, { name: 'лимоны', qty: 2 }, { name: '' }],
    stop: [{ name: 'Вишневка 40мл' }, { name: 'вишневка 40мл' }, {}],
    unreadable: '',
  }) + '\n```');
  assert.equal(v.ok, true);
  assert.equal(v.stock.length, 1);
  assert.equal(v.stop.length, 1);
});

test('«не читается» без позиций — причина, а не ошибка разбора', () => {
  const v = sandbox.validateStopListAnswer_(JSON.stringify({ stock: [], stop: [], unreadable: 'блик на экране' }));
  assert.equal(v.ok, false);
  assert.equal(v.empty, true);
  assert.match(v.reason, /блик/);
});

test('мусор вместо JSON — invalid, а не исключение', () => {
  assert.equal(sandbox.validateStopListAnswer_('не json').ok, false);
  assert.equal(sandbox.validateStopListAnswer_(JSON.stringify({})).ok, false);
  assert.equal(sandbox.validateStopListAnswer_(JSON.stringify({ stock: 'нет', stop: 'нет' })).ok, false);
});

// =====================================================================
//  C. НОРМАЛИЗАЦИЯ: ОБЪЁМ РАЗЛИЧАЕТ ПОЗИЦИИ
// =====================================================================
test('ключ названия: регистр, «ё», знаки, маркер списка — объём остаётся', () => {
  assert.equal(sandbox.stopNameKey_('  0,3  Курпфайц   нефильтрованное '), '0 3 курпфайц нефильтрованное');
  assert.equal(sandbox.stopNameKey_('1. Вишневка 40мл'), 'вишневка 40мл');
  assert.equal(sandbox.stopNameKey_('бут. Лондон Прайд'), 'бут лондон прайд');
  assert.equal(sandbox.stopNameKey_('Щёлочь'), 'щелочь');
});

test('числа в названии — часть позиции: 0,3 и 0,5 не сливаются', () => {
  assert.deepEqual(Array.from(sandbox.stopNumbers_('0,3 Курпфайц нефильтрованное')), [0.3]);
  assert.deepEqual(Array.from(sandbox.stopNumbers_('Вишневка 40мл')), [40]);
  assert.equal(sandbox.stopSameNumbers_('0,3 Курпфайц', '0,5 Курпфайц'), false);
  assert.equal(sandbox.stopSameNumbers_('0,3 Курпфайц', '0,3 Курпфайц'), true);
  assert.equal(sandbox.stopSameNumbers_('Сидр', 'Сидр 0,33'), false);
});

test('сопоставление со справочником не отрезает объём и не путает объёмы', () => {
  const ss = makeSs();
  state.ss = ss;
  const dict = sandbox.stopDictionary_(ss);
  assert.equal(sandbox.stopMatchName_('КУРПФАЙЦ НЕФИЛЬТРОВАННОЕ', dict).name, 'Курпфайц нефильтрованное');
  assert.equal(sandbox.stopMatchName_('0,3 Курпфайц нефильтрованное', dict), null);
  assert.equal(sandbox.stopMatchName_('0,5 Курпфайц нефильтрованное', dict), null);
  // Опечатка без чисел — можно, с другим числом — нельзя.
  assert.equal(sandbox.stopMatchName_('Курпфайц нефильтрованое', dict).name, 'Курпфайц нефильтрованное');
  assert.equal(sandbox.stopMatchName_('Домен Брюне Шинон 0,150', dict), null);
  assert.equal(sandbox.stopMatchName_('Сливки 33%', dict), null);
});

test('«сливки» находит «Сливки», а «Сливки 33%» — отдельная позиция', () => {
  const ss = makeSs();
  state.ss = ss;
  const dict = sandbox.stopDictionary_(ss);
  assert.equal(sandbox.stopMatchName_('сливки', dict).name, 'Сливки');
  assert.equal(sandbox.stopMatchName_('Сливки 33%', dict), null);
});

// =====================================================================
//  D. ДНИ В СТОПЕ: ЭТАЖ + ПОЗИЦИЯ
// =====================================================================
test('дни: этажи считаются отдельно', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(2), floor: '1', name: 'Курпфайц', catalog: 'Курпфайц' });
  addStopRow(ss, { day: dayAgo(1), floor: '1', name: 'Курпфайц', catalog: 'Курпфайц' });
  addStopRow(ss, { day: today(), floor: '1', name: 'Курпфайц', catalog: 'Курпфайц' });
  addStopRow(ss, { day: today(), floor: '2', name: 'Курпфайц', catalog: 'Курпфайц' });
  const st = sandbox.stopListState_(ss);
  const f1 = floorOf(st, '1');
  const f2 = floorOf(st, '2');
  assert.equal(f1.current[0].days, 3);
  assert.equal(f2.floor, '2');
  assert.equal(f2.current[0].days, 1);
  // Стоп на втором этаже не тянет первый и наоборот.
  assert.equal(f1.current[0].totalDays, 3);
  assert.equal(f2.current[0].totalDays, 1);
});

test('дни: снимок второго этажа не двигает счёт первого', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(1), floor: '1', name: 'Лимоны', catalog: 'Лимоны' });
  photoSave(ss, { floor: '2', stop: ['Просекко'] });
  const st = sandbox.stopListState_(ss);
  assert.equal(floorOf(st, '1').current[0].days, 1);   // сегодня данных 1 этажа нет
  assert.equal(floorOf(st, '2').current.length, 1);
  assert.equal(floorOf(st, '2').current[0].name, 'Просекко');
});

test('дни: повторный снимок в тот же день не удваивает счётчик', () => {
  const ss = makeSs();
  state.ss = ss;
  ['21:00', '23:30'].forEach(t => addStopRow(ss, { day: today(), floor: '1', time: t, name: 'Вишневка 40мл' }));
  addStopRow(ss, { day: dayAgo(1), floor: '1', name: 'Вишневка 40мл' });
  const p = floorOf(sandbox.stopListState_(ss), '1').current[0];
  assert.equal(p.days, 2);
  assert.equal(p.records, 3);
});

test('дни: пропуск дня не обрывает счёт, виден в gaps; строгий режим обрывает', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(3), floor: '1', name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: dayAgo(1), floor: '1', name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: today(), floor: '1', name: 'Лимоны', catalog: 'Лимоны' });
  const soft = floorOf(sandbox.stopListState_(ss), '1').current[0];
  assert.equal(soft.days, 3);
  assert.equal(soft.span, 4);
  assert.equal(soft.gaps, 1);

  assert.ok(setSetting(ss, 'стоплист_пропуск_обрывает', 'вкл'));
  const strict = floorOf(sandbox.stopListState_(ss), '1').current[0];
  assert.equal(strict.days, 2);
  assert.equal(strict.since, dayAgo(1));
  assert.equal(floorOf(sandbox.stopListState_(ss), '1').positions[0].totalDays, 3);
});

test('дни: выпала — счёт 0, история осталась; вернулась — новый отрезок', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(4), floor: '1', name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: dayAgo(3), floor: '1', name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: dayAgo(2), floor: '1', name: 'Просекко', catalog: 'Просекко' });
  addStopRow(ss, { day: today(), floor: '1', name: 'Лимоны', catalog: 'Лимоны' });
  const st = sandbox.stopListState_(ss);
  const lime = st.floors.find(f => f.floor === '1').positions.find(p => p.name === 'Лимоны');
  assert.equal(lime.days, 1);          // вернулась сегодня
  assert.equal(lime.totalDays, 3);     // два дня до этого + сегодня
  assert.equal(lime.streaks.length, 2);
  assert.equal(lime.returned, true);
  assert.ok(lime.premature, 'вернулась через 2 дня после «убрали» — преждевременно');
  assert.equal(lime.premature.removedAt, dayAgo(2));
  assert.equal(lime.premature.returnedAt, today());
  assert.equal(lime.premature.gapDays, 2);
});

test('перечеркнули руками — не в стопе; вернулась через день — «убрано преждевременно»', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(3), floor: '1', name: 'Просекко', catalog: 'Просекко' });
  addStopRow(ss, { day: dayAgo(2), floor: '1', name: 'Просекко', catalog: 'Просекко' });
  addStopRow(ss, { day: dayAgo(1), floor: '1', name: 'Просекко', catalog: 'Просекко', crossed: true });
  addStopRow(ss, { day: today(), floor: '1', name: 'Просекко', catalog: 'Просекко' });
  const p = floorOf(sandbox.stopListState_(ss), '1').current[0];
  assert.equal(p.days, 1);
  assert.equal(p.wasCrossed, true);
  assert.equal(p.premature.removedAt, dayAgo(1));
  assert.equal(p.premature.returnedAt, today());
  assert.equal(p.premature.beforeDays, 2);
});

test('«долго в стопе»: порог из настроек', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(1), floor: '1', name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: today(), floor: '1', name: 'Лимоны', catalog: 'Лимоны' });
  let st = sandbox.stopListState_(ss);
  assert.equal(st.settings.longDays, 3);
  assert.equal(floorOf(st, '1').current[0].long, false);
  assert.ok(setSetting(ss, 'стоплист_долго_дней', '2'));
  st = sandbox.stopListState_(ss);
  assert.equal(floorOf(st, '1').current[0].long, true);
  assert.equal(floorOf(st, '1').long.length, 1);
});

test('недочёт номенклатуры: позиции нет в справочнике — помечена', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: today(), floor: '1', name: 'Саке' });
  const f1 = floorOf(sandbox.stopListState_(ss), '1');
  assert.equal(f1.current[0].inCatalog, false);
  assert.equal(f1.missingCatalog.length, 1);
  assert.equal(f1.issuesCount >= 1, true);
});

test('недочёт «нет данных за смену»: нечитаемый снимок', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(1), floor: '1', name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: today(), floor: '2', name: '', source: 'не распознано', note: 'квота Gemini (429)' });
  const st = sandbox.stopListState_(ss);
  const f2 = floorOf(st, '2');
  assert.equal(f2.noData.length, 1);
  assert.match(f2.noData[0].reason, /квот/i);
  assert.equal(f2.totals.daysWithData, 0);
  assert.equal(floorOf(st, '1').current[0].days, 1);
});

// =====================================================================
//  E. АКТИВНЫЙ СТОП = ОБЪЕДИНЕНИЕ, КУХНЯ ОТСЕКАЕТСЯ
// =====================================================================
test('активный стоп: ноль слева сам по себе значит «в стопе»', () => {
  const ss = makeSs();
  state.ss = ss;
  const saved = photoSave(ss, {
    stock: [['Сидр Эйбрахолс', 0], ['Домен Брюне', 3]],
  });
  assert.equal(saved.stop.length, 1);
  assert.equal(saved.stop[0].origin, 'stock');
  const f1 = floorOf(sandbox.stopListState_(ss), '1');
  assert.equal(f1.current.length, 1);
  assert.equal(f1.current[0].name, 'Сидр Эйбрахолс');
  assert.equal(f1.current[0].days, 1);
});

test('активный стоп: правая колонка и ноль слева объединяются, дубль не двоится', () => {
  const ss = makeSs();
  state.ss = ss;
  const saved = photoSave(ss, {
    stop: ['Вишневка 40мл'],
    stock: [['Вишневка 40мл', 0], ['Сидр', 0]],
  });
  assert.equal(saved.stop.length, 2);
  const byName = {};
  saved.stop.forEach(i => { byName[i.name] = i; });
  assert.equal(byName['Вишневка 40мл'].origin, 'stop');
  assert.equal(byName['Сидр'].origin, 'stock');
  const f1 = floorOf(sandbox.stopListState_(ss), '1');
  assert.equal(f1.current.length, 2);
});

test('кухня отсекается и из правой колонки, и из нулевого остатка', () => {
  const ss = makeSs();
  state.ss = ss;
  const saved = photoSave(ss, {
    stop: ['Равиоли с лососем', 'Вишневка 40мл'],
    stock: [['Чиз-кейк "Нью-Йорк"', 0], ['Сидр', 0]],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(saved.excluded)).sort(),
    ['Равиоли с лососем', 'Чиз-кейк "Нью-Йорк"']);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.stop.map(i => i.name))).sort(),
    ['Вишневка 40мл', 'Сидр']);
  const f1 = floorOf(sandbox.stopListState_(ss), '1');
  assert.deepEqual(JSON.parse(JSON.stringify(f1.current.map(p => p.name).sort())),
    ['Вишневка 40мл', 'Сидр']);
  assert.equal(f1.totals.daysWithData, 1);
});

test('кухня: сравнение по нормализованному названию — регистр, кавычки, пробелы', () => {
  const ss = makeSs({ 'Кухня': [['позиция', 'активен', 'комментарий'], [
    ['Торт Три Шоколада', 'вкл', ''],
    ['Чиз-кейк "Нью-Йорк"', 'вкл', ''],
  ]] });
  state.ss = ss;
  const kitchen = sandbox.stopKitchenSet_(ss);
  assert.equal(sandbox.stopIsKitchen_('торт три шоколада', kitchen), true);
  assert.equal(sandbox.stopIsKitchen_('ТОРТ   ТРИ ШОКОЛАДА', kitchen), true);
  assert.equal(sandbox.stopIsKitchen_('Чиз-кейк Нью-Йорк', kitchen), true); // без кавычек
  assert.equal(sandbox.stopIsKitchen_('Штрудель Яблочный', kitchen), false);
});

test('кухня: «выкл» возвращает позицию в стоп-лист', () => {
  const ss = makeSs({ 'Кухня': [['позиция', 'активен', 'комментарий'], [
    ['Торт Три Шоколада', 'выкл', 'ошиблись, это бар'],
  ]] });
  state.ss = ss;
  assert.equal(sandbox.stopIsKitchen_('Торт Три Шоколада', sandbox.stopKitchenSet_(ss)), false);
});

test('кухня заводится сама: стартовый список и служебная строка кассы', () => {
  const ss = makeSs();
  state.ss = ss;
  const kitchen = sandbox.stopKitchenSet_(ss);
  assert.equal(sandbox.stopIsKitchen_('Комментарий на бар', kitchen), true);
  assert.equal(sandbox.stopIsKitchen_('Утиное филе на гриле', kitchen), true);
  assert.equal(sandbox.stopIsKitchen_('0,3 Курпфайц нефильтрованное', kitchen), false);
  assert.ok(rowsOf(ss, 'Кухня').length >= 8);
});

test('пустой стоп после кухни: день остаётся данными и обрывает серию', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(1), floor: '1', name: 'Вишневка 40мл', id: 'stop-0001-abcd' });
  // Второй день: в обеих колонках только кухня — значит барный стоп пуст.
  photoSave(ss, { stop: ['Равиоли с лососем'], stock: [['Чиз-кейк "Нью-Йорк"', 0]] });
  const rows = rowsOf(ss, 'Стоп-лист');
  const idx = {};
  sandbox.STOP_HEADERS.forEach((h, i) => { idx[h] = i; });
  const todayRows = rows.filter(r => r[idx['день']] === today());
  assert.equal(todayRows.length, 1);
  assert.equal(todayRows[0][idx['источник']], 'пустой стоп');
  assert.equal(todayRows[0][idx['позиция']], '');

  const f1 = floorOf(sandbox.stopListState_(ss), '1');
  assert.equal(f1.current.length, 0);
  assert.equal(f1.totals.daysWithData, 2);
  const pos = f1.positions.find(p => p.name === 'Вишневка 40мл');
  assert.equal(pos.days, 0);
  assert.equal(pos.totalDays, 1);
});

test('дни по объединению: день справа, день по нулевому остатку — два дня', () => {
  const ss = makeSs();
  state.ss = ss;
  photoSave(ss, { day: dayAgo(1), stop: ['Вишневка 40мл'] });
  photoSave(ss, { stock: [['Вишневка 40мл', 0]] });
  const p = floorOf(sandbox.stopListState_(ss), '1').current[0];
  assert.equal(p.name, 'Вишневка 40мл');
  assert.equal(p.days, 2);
});

test('реальное фото: 13 стоп + 8 остатков → 9 барных в стопе, 8 кухни отсечено', () => {
  const ss = makeSs();
  state.ss = ss;
  const stock = [
    ['0,150 Домен Брюне Шинон', 3],
    ['бут. Фрисленд Шираз/Гренаш', 1],
    ['бут.Сидр КЛУБНИКА/ЛАЙМ', 1],
    ['бут.Сидр Эйбрахолс яблочный сух.', 0],
    ['Настойка черная смородина 40мл', 7],
    ['Тапас с лососем', 2],
    ['Чиз-кейк "Нью-Йорк"', 0],
    ['Штрудель Яблочный', 4],
  ];
  const stop = [
    '0,3 Курпфайц нефильтрованное',
    '0,5 Курпфайц нефильтрованное',
    'бут. Бридог ИПА 0,33',
    'бут. Лондон Прайд',
    'бут. Флорис Крик',
    'Вишневка 40мл',
    'Комментарий на бар',
    'Равиоли с лососем',
    'Салат с утиным филе',
    'Торт Три Шоколада',
    'Утиное филе на гриле',
    'Хреновуха 40мл',
    'Черноплодная рябина 40мл',
  ];
  const saved = photoSave(ss, { stop: stop, stock: stock });
  // 8 барных из правой колонки + «Сидр Эйбрахолс» с нулевым остатком.
  assert.equal(saved.stop.length, 9);
  assert.equal(saved.excluded.length, 8);
  const names = saved.stop.map(p => p.name);
  assert.ok(names.includes('бут.Сидр Эйбрахолс яблочный сух.'));
  assert.ok(!names.includes('Чиз-кейк "Нью-Йорк"'));
  assert.ok(!names.includes('Комментарий на бар'));
  assert.ok(!names.includes('Равиоли с лососем'));
  const f1 = floorOf(sandbox.stopListState_(ss), '1');
  assert.equal(f1.current.length, 9);
  assert.equal(f1.totals.daysWithData, 1);
});

test('отменённые проверки остатков удаляются из «Настроек»', () => {
  const ss = makeSs();
  state.ss = ss;
  const sh = sandbox.ensureSettingsSheet_(ss);
  const rows = sh.cells.length;
  sh.getRange(rows + 1, 1, 2, 3).setValues([
    ['стоплист_проверять_нулевой_остаток', 'вкл', 'старое'],
    ['стоплист_проверять_остаток_в_стопе', 'вкл', 'старое'],
  ]);
  sandbox.ensureSettingsSheet_(ss);
  const keys = rowsOf(ss, 'Настройки').map(r => r[0]);
  assert.equal(keys.indexOf('стоплист_проверять_нулевой_остаток'), -1);
  assert.equal(keys.indexOf('стоплист_проверять_остаток_в_стопе'), -1);
  assert.ok(keys.includes('стоплист_проверять_долго'));
});

// =====================================================================
//  F. СНИМОК СТОП-ЛИСТА ЧЕРЕЗ SUBMIT
// =====================================================================
test('снимок: объединение пишется, кухня отсекается, этаж сохраняется', () => {
  const ss = makeSs();
  state.ss = ss;
  state.fetchHandler = () => geminiOk({
    stock: [
      { name: '0,150 Домен Брюне Шинон', qty: 3 },
      { name: 'бут.Сидр Эйбрахолс', qty: 0 },     // ноль слева → в стоп
      { name: 'Чиз-кейк "Нью-Йорк"', qty: 0 },    // кухня → отсекается
    ],
    stop: [
      { name: '0,3 Курпфайц нефильтрованное' },
      { name: 'Вишневка 40мл' },
    ],
    unreadable: '',
  });
  const rec = {
    id: 'photo-1001-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Стоп-лист', stopList: true, floor: '2', image: dataUrl(),
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'saved');
  assert.equal(r.verdict.level, 'stoplist');
  assert.match(r.verdict.notes, /в стопе: 3/);
  assert.match(r.verdict.notes, /из них по остатку 0: 1/);
  assert.match(r.verdict.notes, /кухня отсечена: 1/);
  assert.equal(r.stoplist.floor, '2');
  assert.equal(r.stoplist.stop.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(r.stoplist.stop.map(i => i.origin))).sort(),
    ['stock', 'stop', 'stop']);
  assert.equal(r.stoplist.excluded.length, 1);
  assert.equal(r.stoplist.excluded[0], 'Чиз-кейк "Нью-Йорк"');
  assert.equal(r.stoplist.stock.length, 2);   // Домен и Сидр: чиз-кейк — кухня

  const stopRows = rowsOf(ss, 'Стоп-лист');
  assert.equal(stopRows.length, 3);
  const idx = {};
  sandbox.STOP_HEADERS.forEach((h, i) => { idx[h] = i; });
  stopRows.forEach(row => {
    assert.equal(row[idx['этаж']], '2');
    assert.equal(row[idx['источник']], 'фото');
    assert.equal(row[idx['id']], 'photo-1001-abcd');
    assert.equal(row[idx['день']], today());
  });
  const sidr = stopRows.find(row => /Сидр/.test(String(row[idx['позиция']])));
  assert.match(String(sidr[idx['заметка']]), /из остатка 0/);

  const stockRows = rowsOf(ss, 'Стоп-лист — остатки');
  assert.equal(stockRows.length, 2);
  const sidx = {};
  sandbox.STOP_STOCK_HEADERS.forEach((h, i) => { sidx[h] = i; });
  assert.equal(stockRows[0][sidx['этаж']], '2');
  const qty = stockRows.map(x => x[sidx['количество']]).sort((a, b) => a - b);
  assert.deepEqual(JSON.parse(JSON.stringify(qty)), [0, 3]);

  // Промпт — про две колонки, а не про чистоту зоны.
  assert.match(promptOf(0), /Блюда на остатке/);
  assert.doesNotMatch(promptOf(0), /фото уборки/i);
});

test('снимок: повторный тот же ID — duplicate, второго распознавания нет', () => {
  const ss = makeSs();
  state.ss = ss;
  state.fetchHandler = () => geminiOk({ stock: [], stop: [{ name: 'Лимоны' }], unreadable: '' });
  const rec = {
    id: 'photo-1002-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Стоп-лист', stopList: true, floor: '1', image: dataUrl(),
  };
  assert.equal(sandbox.submit_([rec]).results[0].status, 'saved');
  assert.equal(sandbox.submit_([rec]).results[0].status, 'duplicate');
  assert.equal(rowsOf(ss, 'Стоп-лист').length, 1);
  assert.equal(state.fetchCalls.length, 1);
});

test('снимок: квота 429 — «не распознано», фото и запись на месте', () => {
  const ss = makeSs();
  state.ss = ss;
  state.fetchHandler = () => apiResponse(429, 'quota exceeded');
  const rec = {
    id: 'photo-1003-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Стоп-лист', stopList: true, floor: '1', image: dataUrl(),
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'saved');
  assert.equal(r.verdict.level, 'unclear');
  assert.match(r.verdict.error, /квот/i);
  assert.equal(r.stoplist.ok, false);
  assert.equal(rowsOf(ss, 'Фото уборки').length, 1);
  const rows = rowsOf(ss, 'Стоп-лист');
  assert.equal(rows.length, 1);
  const idx = {};
  sandbox.STOP_HEADERS.forEach((h, i) => { idx[h] = i; });
  assert.equal(rows[0][idx['источник']], 'не распознано');
  assert.equal(rows[0][idx['этаж']], '1');
  assert.match(String(rows[0][idx['заметка']]), /квот/i);
});

test('снимок: «не читается» — причина в листе', () => {
  const ss = makeSs();
  state.ss = ss;
  state.fetchHandler = () => geminiOk({ stock: [], stop: [], unreadable: 'сильный блик, текст не виден' });
  const rec = {
    id: 'photo-1004-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Стоп-лист', stopList: true, floor: '2', image: dataUrl(),
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'saved');
  assert.match(r.stoplist.reason, /блик/);
  const rows = rowsOf(ss, 'Стоп-лист');
  assert.equal(rows.length, 1);
  const idx = {};
  sandbox.STOP_HEADERS.forEach((h, i) => { idx[h] = i; });
  assert.equal(rows[0][idx['источник']], 'не распознано');
  assert.match(String(rows[0][idx['заметка']]), /блик/);
});

test('снимок без этажа не падает: этаж по умолчанию 1', () => {
  const ss = makeSs();
  state.ss = ss;
  state.fetchHandler = () => geminiOk({ stop: [{ name: 'Лимоны' }], unreadable: '' });
  const rec = {
    id: 'photo-1005-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Стоп-лист', stopList: true, image: dataUrl(),
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'saved');
  assert.equal(r.stoplist.floor, '1');
  assert.equal(floorOf(sandbox.stopListState_(ss), '1').current.length, 1);
});

test('регрессия: обычное фото уборки по-прежнему проверяется на чистоту', () => {
  const ss = makeSs();
  state.ss = ss;
  state.fetchHandler = () => geminiOk({
    verdict: 'ok', confidence: 0.9,
    items: [{ criterion: 'Стойка', level: 'ok', comment: 'сухо' }],
  });
  const rec = {
    id: 'photo-1006-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Бар 1 этаж', image: dataUrl(),
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'saved');
  assert.equal(r.verdict.level, 'ok');
  assert.match(promptOf(0), /проверяешь фото уборки/i);
  assert.equal(rowsOf(ss, 'Стоп-лист').length, 0);
});

// =====================================================================
//  G. РУЧНОЙ ВВОД
// =====================================================================
test('ручной ввод: позиция и этаж сохраняются, справочник подсказывает', () => {
  const ss = makeSs();
  state.ss = ss;
  const rec = {
    id: 'manual-1001-abcd', type: 'stoplist', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), item: 'курпфайц нефильтрованное', floor: '2',
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'saved');
  assert.equal(r.stoplist.floor, '2');
  const rows = rowsOf(ss, 'Стоп-лист');
  const idx = {};
  sandbox.STOP_HEADERS.forEach((h, i) => { idx[h] = i; });
  assert.equal(rows[0][idx['позиция']], 'курпфайц нефильтрованное');
  assert.equal(rows[0][idx['позиция_в_справочнике']], 'Курпфайц нефильтрованное');
  assert.equal(rows[0][idx['этаж']], '2');
  assert.equal(rows[0][idx['источник']], 'ручной ввод');
});

test('ручной ввод: дубль в тот же день на том же этаже, но не на другом', () => {
  const ss = makeSs();
  state.ss = ss;
  const base = { type: 'stoplist', name: 'Анна', pin: '1234', createdAt: new Date().toISOString(), item: 'Саке' };
  assert.equal(sandbox.submit_([{ ...base, id: 'manual-1002-abcd', floor: '1' }]).results[0].status, 'saved');
  assert.equal(sandbox.submit_([{ ...base, id: 'manual-1003-abcd', floor: '1' }]).results[0].status, 'duplicate');
  assert.equal(sandbox.submit_([{ ...base, id: 'manual-1004-abcd', floor: '2' }]).results[0].status, 'saved');
  assert.equal(rowsOf(ss, 'Стоп-лист').length, 2);
});

test('ручной ввод: «уже убрали» — отдельная строка с перечёркиванием', () => {
  const ss = makeSs();
  state.ss = ss;
  const base = { type: 'stoplist', name: 'Анна', pin: '1234', createdAt: new Date().toISOString(), item: 'Лимоны', floor: '1' };
  sandbox.submit_([{ ...base, id: 'manual-1005-abcd' }]);
  const r = sandbox.submit_([{ ...base, id: 'manual-1006-abcd', crossedOut: true }]).results[0];
  assert.equal(r.status, 'saved');
  const rows = rowsOf(ss, 'Стоп-лист');
  const idx = {};
  sandbox.STOP_HEADERS.forEach((h, i) => { idx[h] = i; });
  assert.equal(rows.length, 2);
  assert.equal(rows[1][idx['перечёркнута']], true);
});

test('ручной ввод: без позиции — отказ; админу раздел недоступен', () => {
  const ss = makeSs();
  state.ss = ss;
  const empty = sandbox.submit_([{
    id: 'manual-1007-abcd', type: 'stoplist', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), item: '  ', floor: '1',
  }]).results[0];
  assert.equal(empty.status, 'error');
  const admin = sandbox.submit_([{
    id: 'manual-1008-abcd', type: 'stoplist', name: 'Борис', pin: '5678',
    createdAt: new Date().toISOString(), item: 'Лимоны', floor: '1',
  }]).results[0];
  assert.equal(admin.status, 'error');
  assert.match(admin.error, /недоступ/);
  assert.equal(rowsOf(ss, 'Стоп-лист').length, 0);
});

test('ручной ввод: кухонную позицию не принимаем и говорим почему', () => {
  const ss = makeSs();
  state.ss = ss;
  const r = sandbox.submit_([{
    id: 'manual-1009-abcd', type: 'stoplist', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), item: 'торт три шоколада', floor: '1',
  }]).results[0];
  assert.equal(r.status, 'error');
  assert.match(r.error, /кухн/i);
  assert.equal(rowsOf(ss, 'Стоп-лист').length, 0);
});

// =====================================================================
//  H. CONFIG И action=stopList
// =====================================================================
test('config.stopList: этажи, дни по объединению, без истории', () => {
  const ss = makeSs();
  state.ss = ss;
  photoSave(ss, { floor: '1', stop: ['Вишневка 40мл'], stock: [['Сидр', 0]] });
  photoSave(ss, { floor: '2', stop: ['Просекко'] });
  const cfg = sandbox.getConfig_(ss);
  assert.ok(cfg.stopList && cfg.stopList.ok);
  assert.equal(cfg.stopList.floors.length, 2);
  const f1 = cfg.stopList.floors.find(f => f.floor === '1');
  assert.deepEqual(JSON.parse(JSON.stringify(f1.current.map(p => p.name).sort())),
    ['Вишневка 40мл', 'Сидр']);
  assert.equal(cfg.stopList.history, undefined);
  assert.equal(cfg.stopList.summary.length, 2);
  assert.equal(typeof cfg.features.stoplist, 'boolean');
});

test('action=stopList: история по этажам', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(1), floor: '2', name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: today(), floor: '2', name: 'Лимоны', catalog: 'Лимоны' });
  const full = sandbox.getStopList_();
  assert.equal(full.ok, true);
  assert.ok(full.history['2']);
  assert.equal(full.history['2']['Лимоны'].length, 2);
});

test('битая шапка «Стоп-листа» не ломает config', () => {
  const ss = makeSs();
  state.ss = ss;
  ss.sheets.set('Стоп-лист', new FakeSheet('Стоп-лист', ['что-то'], [['мусор']]));
  const cfg = sandbox.getConfig_(ss);
  assert.equal(cfg.ok, true);
  assert.ok(Array.isArray(cfg.items));
});

test('шапка пустого листа приводится к схеме с «этаж»', () => {
  const ss = makeSs();
  state.ss = ss;
  const sh = ss.insertSheet('Стоп-лист');
  sh.cells = [['дата', 'смена/время', 'сотрудник', 'позиция', 'позиция_в_справочнике',
    'перечёркнута', 'уверенность', 'фото', 'источник', 'id', 'день', 'модель', 'заметка']];
  const fixed = sandbox.ensureStopSheet_(ss);
  const head = fixed.cells[0];
  assert.equal(head[0], 'дата');
  assert.equal(head[9], 'этаж');
  assert.equal(head[10], 'id');
});

// =====================================================================
//  ИТОГ
// =====================================================================
let failed = 0;
for (const [status, name] of results) {
  if (status !== 'OK') failed++;
  console.log((status === 'OK' ? '✓ ' : '✗ ') + name);
}
console.log('');
console.log(failed ? `${results.length - failed} из ${results.length} прошли, ${failed} упало` : `${results.length} из ${results.length} тестов прошли`);
process.exit(failed ? 1 : 0);
