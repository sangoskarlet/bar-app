// =====================================================================
//  ЛОКАЛЬНЫЕ ТЕСТЫ СТОП-ЛИСТА ПО ФОТО (без сети и без Google)
//
//  Загружает apps-script/Код.gs в песочницу Node, подменяет сервисы
//  Apps Script таблицей-заглушкой и проверяет:
//    * промпт распознавания и схему ответа (name/crossed_out/confidence/unreadable);
//    * разбор ответа модели: мусор, пустой список, дубликаты, «не читается»;
//    * нормализацию названий: регистр, «ё», падежи, опечатки, «нет в справочнике»;
//    * подсчёт дней в стопе: повторы в один день, пропуск дня, выпадение,
//      возврат после «убрали», «долго в стопе», история;
//    * снимок стоп-листа через submit: фото сохраняется, чистоты не проверяет,
//      квота 429 и нечитаемое фото не роняют смену;
//    * ручной ввод позиции и его дубли;
//    * config.stopList и отдельный ?action=stopList с историей;
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
const state = { log: [], ss: null, fetchCalls: [], fetchHandler: null, folders: new Map(), files: new Map(), props: new Map() };
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
        text: '',
        url: '',
        links: [],
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
  ['Джин Монки 47', 'мл', 'Крепкий алкоголь', true],
  ['Лимоны', 'г', 'Фрукты', true],
  ['Просекко', 'мл', 'Игристое', true],
  ['Мята (листья)', 'г', 'Зелень', true],
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

/** Строка в «Стоп-лист» напрямую: так проверяем формулы без сети и Gemini. */
function addStopRow(ss, o) {
  const sh = sandbox.ensureStopSheet_(ss);
  const day = o.day || today();
  sandbox.stopAppendRows_(sh, [[
    new Date(day + 'T20:00:00+03:00'), o.time || '23:00', o.employee || 'Анна',
    o.name, o.catalog || '', !!o.crossed,
    o.confidence === undefined ? 0.9 : o.confidence,
    o.photo || '', o.source || 'фото', o.id ? "'" + o.id : '', day,
    o.model || 'gemini-flash-lite-latest', o.note || '',
  ]]);
}

function setSetting(ss, key, value) {
  sandbox.ensureSettingsSheet_(ss);
  const sh = sheetOf(ss, 'Настройки');
  for (let r = 2; r <= sh.cells.length; r++) {
    if (String(sh.get(r, 1)) === key) { sh.set(r, 2, value); return true; }
  }
  return false;
}

// =====================================================================
//  A. ПРОМПТ И СХЕМА ОТВЕТА
// =====================================================================
test('промпт: только чтение как написано, запрет выдумывать, unreadable, перечёркивание', () => {
  const p = sandbox.buildStopListPrompt_();
  assert.match(p, /ТАК, КАК ОНИ НАПИСАНЫ/);
  assert.match(p, /Не придумывай позиции/);
  assert.match(p, /unreadable/);
  assert.match(p, /перечёркнута/);
  assert.match(p, /crossed_out/);
  assert.match(p, /{"items":\[\{"name"/);
  assert.match(p, /confidence/);
  // Не просим нормализовать и не подсказываем справочник — это работа сервера.
  assert.doesNotMatch(p, /справочник/i);
  assert.doesNotMatch(p, /падеж/i);
});

test('схема ответа: items[name, crossed_out, confidence] + unreadable', () => {
  const cfg = sandbox.stopGenerationConfig_();
  assert.equal(cfg.responseMimeType, 'application/json');
  assert.equal(cfg.temperature, 0);
  const s = cfg.responseSchema;
  assert.deepEqual(Object.keys(s.properties), ['items', 'unreadable']);
  assert.deepEqual(Object.keys(s.properties.items.items.properties), ['name', 'crossed_out', 'confidence']);
  assert.deepEqual(Array.from(s.properties.items.items.required), ['name', 'crossed_out', 'confidence']);
  assert.deepEqual(Array.from(s.required), ['items', 'unreadable']);
  assert.equal(s.properties.items.items.properties.crossed_out.type, 'BOOLEAN');
});

// =====================================================================
//  B. РАЗБОР ОТВЕТА МОДЕЛИ
// =====================================================================
test('валидный ответ: позиции, перечёркнутость (bool и «да»), уверенность', () => {
  const v = sandbox.validateStopListAnswer_(JSON.stringify({
    items: [
      { name: 'Джин Монки', crossed_out: false, confidence: 0.94 },
      { name: 'Просекко', crossed_out: 'да', confidence: 2 },
      { name: 'Саке', crossed_out: true, confidence: 'ноль' },
    ],
    unreadable: '',
  }));
  assert.equal(v.ok, true);
  assert.equal(v.items.length, 3);
  assert.equal(v.items[0].crossed, false);
  assert.equal(v.items[1].crossed, true);
  assert.equal(v.items[1].confidence, null);   // 2 — вне 0…1
  assert.equal(v.items[2].confidence, null);   // не число
  assert.equal(v.items[2].crossed, true);
});

test('markdown-обёртка вокруг JSON не мешает', () => {
  const v = sandbox.validateStopListAnswer_('```json\n{"items":[{"name":"Лимоны","crossed_out":false,"confidence":0.8}],"unreadable":""}\n```');
  assert.equal(v.ok, true);
  assert.equal(v.items[0].name, 'Лимоны');
});

test('дубликаты названий в ответе не удваиваются', () => {
  const v = sandbox.validateStopListAnswer_(JSON.stringify({
    items: [
      { name: 'Лимоны', crossed_out: false, confidence: 0.9 },
      { name: 'лимоны', crossed_out: false, confidence: 0.8 },
    ],
    unreadable: '',
  }));
  assert.equal(v.ok, true);
  assert.equal(v.items.length, 1);
});

test('«не читается» без позиций — не ошибка разбора, а причина', () => {
  const v = sandbox.validateStopListAnswer_(JSON.stringify({ items: [], unreadable: 'почерк не читается' }));
  assert.equal(v.ok, false);
  assert.equal(v.empty, true);
  assert.match(v.reason, /почерк/);
});

test('мусор вместо JSON и пустой объект — invalid, а не исключение', () => {
  assert.equal(sandbox.validateStopListAnswer_('совсем не json').ok, false);
  assert.equal(sandbox.validateStopListAnswer_(JSON.stringify({})).ok, false);
  assert.equal(sandbox.validateStopListAnswer_(JSON.stringify({ items: 'нет' })).ok, false);
});

// =====================================================================
//  C. НОРМАЛИЗАЦИЯ НАЗВАНИЙ
// =====================================================================
test('ключ названия: регистр, «ё», знаки, лишние пробелы', () => {
  assert.equal(sandbox.stopNameKey_('  Мята (листья)  '), 'мята листья');
  assert.equal(sandbox.stopNameKey_('СЫР «Пармезан»'), 'сыр пармезан');
  assert.equal(sandbox.stopNameKey_('Кола 0,5'), sandbox.stopNameKey_('кола 0.5'));
  assert.equal(sandbox.stopNameKey_('Щёлочь'), 'щелочь');
});

test('сопоставление: точное, падежи, опечатка, «слишком далеко» — нет', () => {
  const ss = makeSs();
  state.ss = ss;
  const dict = sandbox.stopDictionary_(ss);
  assert.equal(sandbox.stopMatchName_('лимоны', dict).name, 'Лимоны');
  assert.equal(sandbox.stopMatchName_('ЛИМОНОВ', dict).name, 'Лимоны');   // падеж → усечение
  assert.equal(sandbox.stopMatchName_('Просеко', dict).name, 'Просекко'); // опечатка 1 буква
  assert.equal(sandbox.stopMatchName_('Джин', dict), null);               // далеко от «Джин Монки 47»
  assert.equal(sandbox.stopMatchName_('Саке', dict), null);
  assert.equal(sandbox.stopMatchName_('', dict), null);
});

test('маркер списка с фото не мешает: «1. Джин Монки 47 0,5» → «Джин Монки 47»', () => {
  const ss = makeSs();
  state.ss = ss;
  const dict = sandbox.stopDictionary_(ss);
  assert.equal(sandbox.stopStripMarker_('1. Джин Монки'), 'Джин Монки');
  assert.equal(sandbox.stopStripMarker_('2) Лайм'), 'Лайм');
  assert.equal(sandbox.stopStripMarker_('- Тоник'), 'Тоник');
  assert.equal(sandbox.stopStripMarker_('1,5 литра сока'), '1,5 литра сока'); // не маркер
  assert.equal(sandbox.stopNameKey_('1. Джин Монки'), 'джин монки');
  // Именно так ответила модель на печатном образце — позиция должна найтись.
  const m = sandbox.stopMatchName_('1. Джин Монки 47 0,5', dict);
  assert.ok(m, 'позиция сопоставлена');
  assert.equal(m.name, 'Джин Монки 47');
  // Объём в конце не мешает, а целое число в названии сохраняется.
  assert.equal(sandbox.stopMatchName_('Джин Монки 47 0,5 л', dict).name, 'Джин Монки 47');
  assert.equal(sandbox.stopMatchName_('Джин Монки 47', dict).name, 'Джин Монки 47');
});

test('дешёвое сопоставление (для чтения истории) не считает опечатки', () => {
  const ss = makeSs();
  state.ss = ss;
  const dict = sandbox.stopDictionary_(ss);
  assert.equal(sandbox.stopMatchName_('лимоны', dict, true).name, 'Лимоны');
  assert.equal(sandbox.stopMatchName_('Просеко', dict, true), null);
});

test('начало названия по границе слова: «Клюква с/м» → «Клюква», «Сливки 33%» → «Сливки»', () => {
  const ss = makeSs({ 'Справочник': [HEADERS.items, [
    ['Клюква', 'г', 'Ягоды', true],
    ['Сливки', 'мл', 'Молочное', true],
    ['Мята (листья)', 'г', 'Зелень', true],
    ['Мята (ветки)', 'г', 'Зелень', true],
    ['Лимон', 'шт', 'Фрукты', true],
  ]] });
  state.ss = ss;
  const dict = sandbox.stopDictionary_(ss);
  assert.equal(sandbox.stopMatchName_('Клюква с/м', dict).name, 'Клюква');
  assert.equal(sandbox.stopMatchName_('сливки 33%', dict).name, 'Сливки');
  assert.equal(sandbox.stopMatchName_('мята лист.', dict).name, 'Мята (листья)');
  // Середину слова не трогаем: «Лимонный фреш» — не «Лимон».
  assert.equal(sandbox.stopMatchName_('Лимонный фреш', dict), null);
  // И короткое имя не подтягиваем к длинному: «Джин» — не «Джин Монки 47».
  assert.equal(sandbox.stopMatchName_('Джин', dict), null);
});

test('порог опечатки зависит от длины названия', () => {
  assert.equal(sandbox.stopMaxDist_('ром', 'ром'), 0);
  assert.equal(sandbox.stopMaxDist_('джин', 'джин'), 0);
  assert.equal(sandbox.stopMaxDist_('виски', 'виски'), 1);
  assert.equal(sandbox.stopMaxDist_('просекко', 'просекко'), 1);
  assert.equal(sandbox.stopMaxDist_('безалкогольное', 'безалкогольное'), 2);
  assert.equal(sandbox.stopMaxDist_('шампанское брют сухое', 'шампанское брют сухое'), 3);
});

test('расстояние Левенштейна — как надо', () => {
  assert.equal(sandbox.stopLevenshtein_('лимоны', 'лимоны'), 0);
  assert.equal(sandbox.stopLevenshtein_('лимоны', 'лимон'), 1);
  assert.equal(sandbox.stopLevenshtein_('просеко', 'просекко'), 1);
  assert.equal(sandbox.stopLevenshtein_('', 'абв'), 3);
});

// =====================================================================
//  D. ДНИ В СТОПЕ, ИСТОРИЯ, НЕДОЧЁТЫ
// =====================================================================
test('дни: три дня подряд, повторный снимок в тот же день не удваивает', () => {
  const ss = makeSs();
  state.ss = ss;
  ['Джин Монки 47'].forEach(n => {
    addStopRow(ss, { day: dayAgo(2), name: n, catalog: n });
    addStopRow(ss, { day: dayAgo(1), name: n, catalog: n });
    addStopRow(ss, { day: today(), name: n, catalog: n, time: '21:00' });
    addStopRow(ss, { day: today(), name: n, catalog: n, time: '23:30' });
  });
  const st = sandbox.stopListState_(ss);
  const p = st.current[0];
  assert.equal(p.name, 'Джин Монки 47');
  assert.equal(p.days, 3);
  assert.equal(p.since, dayAgo(2));
  assert.equal(p.records, 4);
  assert.equal(p.returned, false);
});

test('дни: пропуск дня без данных не обрывает счёт, но виден в gaps', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(3), name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: dayAgo(1), name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: today(), name: 'Лимоны', catalog: 'Лимоны' });
  const p = sandbox.stopListState_(ss).current[0];
  assert.equal(p.days, 3);   // три смены с данными
  assert.equal(p.span, 4);   // календарный отрезок 4 дня
  assert.equal(p.gaps, 1);   // один день без данных
});

test('дни: позиция выпала на день (данные есть, её нет) — счёт обнулился, история осталась', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(3), name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: dayAgo(2), name: 'Лимоны', catalog: 'Лимоны' });
  // Следующие две смены данные есть, но лимонов в стопе нет.
  addStopRow(ss, { day: dayAgo(1), name: 'Просекко', catalog: 'Просекко' });
  addStopRow(ss, { day: today(), name: 'Просекко', catalog: 'Просекко' });
  const st = sandbox.stopListState_(ss);
  const lime = st.positions.find(p => p.name === 'Лимоны');
  assert.equal(lime.days, 0, 'сейчас не в стопе');
  assert.equal(lime.totalDays, 2, 'два дня до этого — в истории');
  assert.equal(lime.streaks.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(lime.streaks[0])),
    { from: dayAgo(3), to: dayAgo(2), days: 2, span: 2, gaps: 0 });
  assert.equal(st.current.length, 1);
  assert.equal(st.current[0].name, 'Просекко');
});

test('дни: перечеркнули — не в стопе; вернулась через день — «убрано преждевременно»', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(3), name: 'Просекко', catalog: 'Просекко' });
  addStopRow(ss, { day: dayAgo(2), name: 'Просекко', catalog: 'Просекко' });
  addStopRow(ss, { day: dayAgo(1), name: 'Просекко', catalog: 'Просекко', crossed: true });
  addStopRow(ss, { day: today(), name: 'Просекко', catalog: 'Просекко' });
  const st = sandbox.stopListState_(ss);
  const p = st.current[0];
  assert.equal(p.days, 1);
  assert.equal(p.wasCrossed, true);
  assert.ok(p.premature, 'признак «убрано преждевременно» есть');
  assert.equal(p.premature.removedAt, dayAgo(1));
  assert.equal(p.premature.returnedAt, today());
  assert.equal(p.premature.gapDays, 1);
  assert.equal(p.premature.beforeDays, 2);
  assert.equal(st.premature.length, 1);
  assert.equal(st.premature[0].name, 'Просекко');
});

test('дни: перечеркнули и не вернули — счёт 0, в текущем списке нет', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(2), name: 'Просекко', catalog: 'Просекко' });
  addStopRow(ss, { day: dayAgo(1), name: 'Просекко', catalog: 'Просекко', crossed: true });
  addStopRow(ss, { day: today(), name: 'Лимоны', catalog: 'Лимоны' });
  const st = sandbox.stopListState_(ss);
  const p = st.positions.find(x => x.name === 'Просекко');
  assert.equal(p.days, 0);
  assert.equal(p.wasCrossed, true);
  assert.equal(p.premature, null);
  assert.equal(p.removedAt, dayAgo(1));
});

test('«долго в стопе»: порог берётся из настроек (по умолчанию 3)', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(1), name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: today(), name: 'Лимоны', catalog: 'Лимоны' });
  let st = sandbox.stopListState_(ss);
  assert.equal(st.settings.longDays, 3);
  assert.equal(st.current[0].long, false);
  assert.equal(st.long.length, 0);

  assert.ok(setSetting(ss, 'стоплист_долго_дней', '2'));
  st = sandbox.stopListState_(ss);
  assert.equal(st.settings.longDays, 2);
  assert.equal(st.current[0].long, true);
  assert.equal(st.long[0].name, 'Лимоны');
});

test('настройки: мусор и крайние значения не роняют расчёт', () => {
  const ss = makeSs();
  state.ss = ss;
  setSetting(ss, 'стоплист_долго_дней', 'пять');
  setSetting(ss, 'стоплист_преждевременно_дней', '0');
  setSetting(ss, 'стоплист_история_дней', '1000');
  const s = sandbox.stopSettings_(ss);
  assert.equal(s.longDays, 3);          // мусор → умолчание
  assert.equal(s.prematureDays, 2);     // 0 → умолчание
  assert.equal(s.historyDays, 365);     // сверх предела — обрезано
});

test('флаги проверок: выключенный «долго» не помечает, остальное на месте', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(2), name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: dayAgo(1), name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: today(), name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: today(), name: 'Саке' });
  setSetting(ss, 'стоплист_долго_дней', '2');
  setSetting(ss, 'стоплист_проверять_долго', 'выкл');
  const st = sandbox.stopListState_(ss);
  assert.equal(st.settings.checks.long, false);
  assert.equal(st.current.find(p => p.name === 'Лимоны').long, false);
  assert.equal(st.long.length, 0);
  // «нет в справочнике» всё ещё считается — флаг другой.
  assert.equal(st.settings.checks.catalog, true);
  assert.equal(st.missingCatalog[0].name, 'Саке');
});

test('недочёт номенклатуры: позиции нет в справочнике — помечена, но остаётся в списке', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: today(), name: 'Саке', note: 'нет в справочнике' });
  const st = sandbox.stopListState_(ss);
  assert.equal(st.current.length, 1);
  assert.equal(st.current[0].inCatalog, false);
  assert.equal(st.missingCatalog.length, 1);
  assert.equal(st.missingCatalog[0].days, 1);
});

test('позиция появилась в справочнике позже — история подхватывает её при чтении', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: today(), name: 'Саке' }); // в справочнике такой позиции нет
  const before = sandbox.stopListState_(ss);
  assert.equal(before.current[0].inCatalog, false);
  assert.equal(before.missingCatalog.length, 1);
  // Владелец добавил позицию в справочник — старые записи сразу считаются своими.
  ss.getSheetByName('Справочник').appendRow(['саке', 'мл', 'Крепкий алкоголь', true]);
  const after = sandbox.stopListState_(ss);
  assert.equal(after.current[0].inCatalog, true);
  assert.equal(after.current[0].name, 'саке');
  assert.equal(after.missingCatalog.length, 0);
});

test('недочёт «нет данных за смену»: нечитаемый снимок — строка и отметка, дни не считаются', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(1), name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: today(), name: '', source: 'не распознано', note: 'квота Gemini (429)' });
  const st = sandbox.stopListState_(ss);
  assert.equal(st.noData.length, 1);
  assert.equal(st.noData[0].day, today());
  assert.match(st.noData[0].reason, /квот/i);
  // День без позиций не считается данными: у лимонов счёт идёт от прошлого дня.
  assert.equal(st.current[0].days, 1);
  assert.equal(st.totals.unreadable, 1);
  assert.equal(st.totals.daysWithData, 1);
});

test('история позиции: сколько раз и когда, в пределах настроенного окна', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(2), name: 'Лимоны', catalog: 'Лимоны', time: '22:00' });
  addStopRow(ss, { day: dayAgo(1), name: 'Лимоны', catalog: 'Лимоны', crossed: true, time: '23:00' });
  addStopRow(ss, { day: today(), name: 'Лимоны', catalog: 'Лимоны', source: 'ручной ввод', time: '23:40' });
  const st = sandbox.stopListState_(ss);
  const h = st.history['Лимоны'];
  assert.equal(h.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(h.map(x => x.day))), [dayAgo(2), dayAgo(1), today()]);
  assert.equal(h[1].crossed, true);
  assert.equal(h[2].source, 'ручной ввод');
  assert.ok(setSetting(ss, 'стоплист_история_дней', '1'));
  const st2 = sandbox.stopListState_(ss);
  // «1 день» = сегодня и вчера: более старые записи в историю экрана не идут.
  assert.equal(st2.history['Лимоны'].length, 2);
});

test('одна позиция = одна группа: разные написания одного справочника не дублируются', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(1), name: 'лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: today(), name: 'ЛИМОНОВ', catalog: 'Лимоны' });
  const st = sandbox.stopListState_(ss);
  assert.equal(st.positions.length, 1);
  assert.equal(st.current[0].days, 2);
  assert.equal(st.current[0].name, 'Лимоны');
});

// =====================================================================
//  E. СНИМОК СТОП-ЛИСТА (submit → фото → распознавание → лист)
// =====================================================================
test('снимок: фото сохраняется, чистоты не проверяет, позиции пишутся в «Стоп-лист»', () => {
  const ss = makeSs();
  state.ss = ss;
  state.fetchHandler = () => geminiOk({
    items: [
      { name: 'лимоны', crossed_out: false, confidence: 0.95 },
      { name: 'Просеко', crossed_out: true, confidence: 0.8 },
      { name: 'Саке', crossed_out: false, confidence: 0.6 },
    ],
    unreadable: '',
  });
  const rec = {
    id: 'photo-0001-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Стоп-лист', stopList: true, image: dataUrl(),
  };
  const res = sandbox.submit_([rec]);
  const r = res.results[0];
  assert.equal(r.status, 'saved');
  assert.equal(r.verdict.level, 'stoplist');
  assert.equal(r.verdict.verdict, 'стоп-лист');
  assert.match(r.verdict.notes, /распознано позиций: 3/);
  assert.equal(r.stoplist.ok, true);
  assert.equal(r.stoplist.items.length, 3);
  assert.equal(r.stoplist.day, today());

  // Фото: одна строка, зона «Стоп-лист», вердикт «стоп-лист».
  const ph = rowsOf(ss, 'Фото уборки');
  assert.equal(ph.length, 1);
  assert.equal(ph[0][2], 'Стоп-лист');
  assert.equal(ph[0][7], '📋 Стоп-лист');
  assert.equal(ph[0][12], 'стоп-лист');
  assert.match(String(ph[0][14]), /распознано позиций: 3/);

  // Стоп-лист: три строки, две сопоставлены со справочником.
  const rows = rowsOf(ss, 'Стоп-лист');
  assert.equal(rows.length, 3);
  const by = {};
  rows.forEach(x => { by[x[3]] = x; });
  assert.equal(by['лимоны'][4], 'Лимоны');
  assert.equal(by['лимоны'][5], false);
  assert.equal(by['Просеко'][4], 'Просекко');
  assert.equal(by['Просеко'][5], true);
  assert.equal(by['Саке'][4], '');
  assert.equal(by['Саке'][12], 'нет в справочнике');
  assert.equal(by['Саке'][8], 'фото');
  assert.equal(by['Саке'][9], 'photo-0001-abcd');
  assert.equal(by['Саке'][10], today());
  assert.equal(by['Саке'][11], 'gemini-flash-lite-latest');
  assert.equal(by['Саке'][7], 'фото'); // ссылка на снимок

  // Промпт — стоп-листа, а не проверки чистоты зоны.
  assert.match(promptOf(0), /распознаёшь стоп-лист/i);
  assert.doesNotMatch(promptOf(0), /фото уборки/i);
});

test('снимок: повторный тот же ID — duplicate, повторного распознавания нет', () => {
  const ss = makeSs();
  state.ss = ss;
  state.fetchHandler = () => geminiOk({ items: [{ name: 'Лимоны', crossed_out: false, confidence: 0.9 }], unreadable: '' });
  const rec = {
    id: 'photo-0002-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Стоп-лист', stopList: true, image: dataUrl(),
  };
  assert.equal(sandbox.submit_([rec]).results[0].status, 'saved');
  assert.equal(sandbox.submit_([rec]).results[0].status, 'duplicate');
  assert.equal(rowsOf(ss, 'Стоп-лист').length, 1);
  assert.equal(rowsOf(ss, 'Фото уборки').length, 1);
  assert.equal(state.fetchCalls.length, 1, 'второй запрос к Gemini не ушёл');
});

test('снимок: квота 429 — запись «не распознано», фото на месте, без падения', () => {
  const ss = makeSs();
  state.ss = ss;
  state.fetchHandler = () => apiResponse(429, 'quota exceeded');
  const rec = {
    id: 'photo-0003-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Стоп-лист', stopList: true, image: dataUrl(),
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'saved');
  assert.equal(r.verdict.level, 'unclear');
  assert.match(r.verdict.error, /квот/i);
  assert.equal(r.stoplist.ok, false);

  const ph = rowsOf(ss, 'Фото уборки');
  assert.equal(ph.length, 1);
  const rows = rowsOf(ss, 'Стоп-лист');
  assert.equal(rows.length, 1);
  assert.equal(rows[0][8], 'не распознано');
  assert.equal(rows[0][3], '');
  assert.match(String(rows[0][12]), /квот/i);
  assert.equal(rows[0][10], today());
});

test('снимок: модель вернула «не читается» — причина в листе, пустых позиций нет', () => {
  const ss = makeSs();
  state.ss = ss;
  state.fetchHandler = () => geminiOk({ items: [], unreadable: 'почерк не читается, смазано' });
  const rec = {
    id: 'photo-0004-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Стоп-лист', stopList: true, image: dataUrl(),
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'saved');
  assert.equal(r.stoplist.ok, false);
  assert.match(r.stoplist.reason, /почерк/);
  const rows = rowsOf(ss, 'Стоп-лист');
  assert.equal(rows.length, 1);
  assert.equal(rows[0][8], 'не распознано');
  assert.match(String(rows[0][12]), /почерк/);
});

test('снимок: Gemini упал сетью — запись «не распознано», фото сохранено', () => {
  const ss = makeSs();
  state.ss = ss;
  state.fetchHandler = () => { throw new Error('Timeout'); };
  const rec = {
    id: 'photo-0005-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Стоп-лист', stopList: true, image: dataUrl(),
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'saved');
  assert.equal(r.stoplist.ok, false);
  assert.equal(rowsOf(ss, 'Фото уборки').length, 1);
  assert.equal(rowsOf(ss, 'Стоп-лист')[0][8], 'не распознано');
});

test('снимок: без ключа GEMINI_API_KEY — «не распознано», запрос не уходит', () => {
  const ss = makeSs();
  state.ss = ss;
  state.props.delete('GEMINI_API_KEY');
  const rec = {
    id: 'photo-0006-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Стоп-лист', stopList: true, image: dataUrl(),
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'saved');
  assert.match(r.stoplist.reason, /GEMINI_API_KEY/);
  assert.equal(state.fetchCalls.length, 0);
  assert.equal(rowsOf(ss, 'Стоп-лист')[0][8], 'не распознано');
  state.props.set('GEMINI_API_KEY', 'test-key');
});

test('регрессия: обычное фото уборки по-прежнему проверяется на чистоту', () => {
  const ss = makeSs();
  state.ss = ss;
  state.fetchHandler = () => geminiOk({
    verdict: 'ok', confidence: 0.9,
    items: [{ criterion: 'Стойка', level: 'ok', comment: 'сухо' }],
  });
  const rec = {
    id: 'photo-0007-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Бар 1 этаж', image: dataUrl(),
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'saved');
  assert.equal(r.verdict.level, 'ok');
  assert.match(promptOf(0), /проверяешь фото уборки/i);
  assert.equal(rowsOf(ss, 'Стоп-лист').length, 0, 'в стоп-лист ничего не попало');
});

test('фото, у которого зона «Стоп-лист», распознаётся даже без флага stopList', () => {
  const ss = makeSs();
  state.ss = ss;
  state.fetchHandler = () => geminiOk({ items: [{ name: 'Лимоны', crossed_out: false, confidence: 0.9 }], unreadable: '' });
  const rec = {
    id: 'photo-0008-abcd', type: 'photo', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), zone: 'Стоп-лист', image: dataUrl(),
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'saved');
  assert.equal(r.verdict.level, 'stoplist');
  assert.equal(rowsOf(ss, 'Стоп-лист').length, 1);
});

// =====================================================================
//  F. РУЧНОЙ ВВОД
// =====================================================================
test('ручной ввод: позиция из справочника сохраняется и нормализуется', () => {
  const ss = makeSs();
  state.ss = ss;
  const rec = {
    id: 'manual-0001-abcd', type: 'stoplist', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), item: 'лимоны',
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'saved');
  const rows = rowsOf(ss, 'Стоп-лист');
  assert.equal(rows.length, 1);
  assert.equal(rows[0][3], 'лимоны');
  assert.equal(rows[0][4], 'Лимоны');
  assert.equal(rows[0][8], 'ручной ввод');
  assert.equal(rows[0][5], false);
  assert.equal(rows[0][6], '');     // уверенность у ручного ввода пустая
  assert.equal(rows[0][10], today());
});

test('ручной ввод: второй раз та же позиция в тот же день — duplicate', () => {
  const ss = makeSs();
  state.ss = ss;
  const base = { type: 'stoplist', name: 'Анна', pin: '1234', createdAt: new Date().toISOString(), item: 'Саке' };
  assert.equal(sandbox.submit_([{ ...base, id: 'manual-0002-abcd' }]).results[0].status, 'saved');
  assert.equal(sandbox.submit_([{ ...base, id: 'manual-0003-abcd' }]).results[0].status, 'duplicate');
  assert.equal(rowsOf(ss, 'Стоп-лист').length, 1);
});

test('ручной ввод: «уже убрали со стопа» — другой признак, отдельная строка', () => {
  const ss = makeSs();
  state.ss = ss;
  const base = { type: 'stoplist', name: 'Анна', pin: '1234', createdAt: new Date().toISOString(), item: 'Лимоны' };
  sandbox.submit_([{ ...base, id: 'manual-0004-abcd' }]);
  const r = sandbox.submit_([{ ...base, id: 'manual-0005-abcd', crossedOut: true }]).results[0];
  assert.equal(r.status, 'saved');
  const rows = rowsOf(ss, 'Стоп-лист');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][5], true);
});

test('ручной ввод: без позиции — отказ, ничего не пишется', () => {
  const ss = makeSs();
  state.ss = ss;
  const rec = {
    id: 'manual-0006-abcd', type: 'stoplist', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), item: '   ',
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'error');
  assert.match(r.error, /позиция/i);
  assert.equal(rowsOf(ss, 'Стоп-лист').length, 0);
});

test('ручной ввод: админу раздел недоступен', () => {
  const ss = makeSs();
  state.ss = ss;
  const rec = {
    id: 'manual-0007-abcd', type: 'stoplist', name: 'Борис', pin: '5678',
    createdAt: new Date().toISOString(), item: 'Лимоны',
  };
  const r = sandbox.submit_([rec]).results[0];
  assert.equal(r.status, 'error');
  assert.match(r.error, /недоступен/);
});

test('ручной ввод закрывает позицию: счёт дней обнулился', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(1), name: 'Лимоны', catalog: 'Лимоны' });
  sandbox.submit_([{
    id: 'manual-0008-abcd', type: 'stoplist', name: 'Анна', pin: '1234',
    createdAt: new Date().toISOString(), item: 'Лимоны', crossedOut: true,
  }]);
  const st = sandbox.stopListState_(ss);
  const p = st.positions.find(x => x.name === 'Лимоны');
  assert.equal(p.days, 0);
  assert.equal(p.wasCrossed, true);
  assert.equal(p.totalDays, 1);
});

// =====================================================================
//  G. CONFIG И action=stopList
// =====================================================================
test('config.stopList: текущий список с днями и недочётами, без истории', () => {
  const ss = makeSs();
  state.ss = ss;
  state.props.set('GEMINI_API_KEY', 'test-key');
  addStopRow(ss, { day: dayAgo(2), name: 'Джин Монки 47', catalog: 'Джин Монки 47' });
  addStopRow(ss, { day: dayAgo(1), name: 'Джин Монки 47', catalog: 'Джин Монки 47' });
  addStopRow(ss, { day: today(), name: 'Джин Монки 47', catalog: 'Джин Монки 47' });
  addStopRow(ss, { day: today(), name: 'Саке' });
  const cfg = sandbox.getConfig_(ss);
  assert.ok(cfg.stopList, 'config.stopList есть');
  assert.equal(cfg.stopList.ok, true);
  assert.equal(cfg.stopList.settings.longDays, 3);
  assert.equal(cfg.stopList.current[0].name, 'Джин Монки 47');
  assert.equal(cfg.stopList.current[0].days, 3);
  assert.equal(cfg.stopList.long.length, 1);
  assert.equal(cfg.stopList.missingCatalog[0].name, 'Саке');
  assert.equal(cfg.stopList.history, undefined, 'история в config не влезает');
  assert.equal(cfg.stopList.totals.inStop, 2);
  // Старые поля config не тронуты.
  assert.ok(Array.isArray(cfg.zones));
  assert.ok(Array.isArray(cfg.photoZones));
  assert.equal(typeof cfg.features.stoplist, 'boolean');
});

test('action=stopList: к текущему списку добавлена история по позициям', () => {
  const ss = makeSs();
  state.ss = ss;
  addStopRow(ss, { day: dayAgo(1), name: 'Лимоны', catalog: 'Лимоны' });
  addStopRow(ss, { day: today(), name: 'Лимоны', catalog: 'Лимоны', crossed: true });
  const full = sandbox.getStopList_();
  assert.equal(full.ok, true);
  assert.ok(full.history);
  assert.equal(full.history['Лимоны'].length, 2);
  assert.equal(full.history['Лимоны'][1].crossed, true);
});

test('ошибка в листе «Стоп-лист» не ломает config', () => {
  const ss = makeSs();
  state.ss = ss;
  // Лист есть, но шапка битая: код не должен падать, config отдаётся.
  ss.sheets.set('Стоп-лист', new FakeSheet('Стоп-лист', ['что-то'], [['мусор']]));
  const cfg = sandbox.getConfig_(ss);
  assert.equal(cfg.ok, true);
  assert.ok(Array.isArray(cfg.items));
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
