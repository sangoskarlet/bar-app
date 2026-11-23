// =====================================================================
//  ИНТЕГРАЦИОННЫЕ ТЕСТЫ: ветки 16 (6 зон, этажи, эталоны) + 17 (флаги, пары)
//
//  Проверяют то, чего не было ни в одной ветке по отдельности:
//    * config отдаёт ОДНОВРЕМЕННО features (лист «Настройки»), зоны с этажами
//      (лист «Эталоны уборки» + «Списки») и пары позиций (мята) — без потерь
//      ни одного из наборов;
//    * выключенные разделы «фото» и «акты» не ломают запись из очереди:
//      обработчики записи вообще не читают флаги (проверка шпионом);
//    * акт с мятой при выключенном разделе «акты» пишется целиком, Q–V на месте.
//
//  Таблица-заглушка и песочница — те же, что в test-features-pairs.mjs,
//  чтобы тесты не расходились в поведении.
//
//  Запуск: node tools/test-integration-16-17.mjs
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
const state = { log: [], ss: null };

const sandbox = {
  console,
  Logger: { log: (m) => state.log.push(String(m)) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
  Utilities: {
    formatDate: (d, tz, fmt) => {
      const p = n => String(n).padStart(2, '0');
      return fmt === 'yyyy-MM-dd'
        ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
        : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },
    base64Encode: b => Buffer.from(b).toString('base64'),
    base64Decode: s => Uint8Array.from(Buffer.from(String(s), 'base64')),
    newBlob: (bytes, mime, name) => ({ getBytes: () => bytes, getContentType: () => mime, getName: () => name }),
  },
  SpreadsheetApp: {
    openById: () => state.ss,
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
        setText(t) { this.text = t; return this; },
        setLinkUrl() { return this; },
        build() { return { text: this.text }; },
      };
      return obj;
    },
  },
  ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {} },
  ContentService: { createTextOutput: s => ({ setMimeType: () => s }), MimeType: { JSON: 'json' } },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
  DriveApp: { getFileById: () => { throw new Error('Drive в этих тестах не нужен'); } },
  UrlFetchApp: { fetch: () => { throw new Error('сеть в этих тестах не нужна'); } },
};

vm.createContext(sandbox);
vm.runInContext(CODE, sandbox, { filename: 'Код.gs' });
sandbox.log_ = (event, details) => state.log.push(event + ': ' + details);

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
  refs: ['этаж', 'зона', 'критерии', 'эталонное_фото'],
};

// Финальный список владельца: 6 зон, три на первом этаже и три на втором.
const ZONES = ['Бар', 'Терраса', 'Зал', 'Кухня', 'Туалет', 'Склад'];
const REF_ROWS = [
  ['1', 'Бар', 'Полы вымыты; стойка протёрта', ''],
  ['1', 'Терраса', 'Полы вымыты; столы протёрты', ''],
  ['1', 'Зал', 'Полы вымыты; подоконники', ''],
  ['2', 'Кухня', 'Полы вымыты; плита', ''],
  ['2', 'Туалет', 'Полы вымыты; зеркало', ''],
  ['2', 'Склад', 'Полы вымыты; стеллажи', ''],
];
const TPL_ROWS = [
  ['Мята — очистка', 'простой', 'Сырьё', 'Мята', 'г', 0, true, true, '', ''],
  ['Мята — очистка', 'простой', 'Результат', 'Мята (листья)', 'г', 0, '', true, '', ''],
  ['Лимонный фреш', 'простой', 'Сырьё', 'Лимоны', 'г', 0, true, true, '', ''],
  ['Лимонный фреш', 'простой', 'Результат', 'Лимонный сок ПФ', 'г', 0, '', true, '', ''],
];

function makeSs() {
  return new FakeSpreadsheet([
    ['Сотрудники', HEADERS.staff, [['Анна', '1234', 'бармен', true]]],
    ['Справочник', HEADERS.items, [['Мята', 'г', 'Зелень', true], ['Мята (ветки)', 'г', 'Зелень', true]]],
    ['Списки', HEADERS.lists, ZONES.map(z => ['Бой', z, '', 'Склад', 'Кабинет', 'обычное'])],
    ['ТТК', HEADERS.ttk, []],
    ['Шаблоны переработки', HEADERS.tpl, TPL_ROWS],
    ['Опись', HEADERS.invList, []],
    ['Акты переработки', HEADERS.acts, []],
    ['Лог', ['Время', 'Событие', 'Детали'], []],
    ['Сроки хранения', ['заготовка', 'короткое_имя', 'срок_часов', 'примечание', 'активен'], []],
    ['Чек-листы', ['список', 'порядок', 'пункт', 'подсказка', 'фото_обязательно', 'активен'], []],
    ['Факты', ['id', 'текст', 'источник', 'активен', 'дата_показа'], []],
    ['Эталоны уборки', HEADERS.refs, REF_ROWS],
    ['Фото уборки', ['Дата', 'Сотрудник', 'Зона', 'Фото', 'Комментарий', 'Получено', 'ID',
      'Проверка ИИ', 'Что не так', 'Замечание менеджера', 'Фото удалено', 'ID файла'], []],
  ]);
}

const results = [];
function test(name, fn) {
  state.log = [];
  try { fn(); results.push(['OK', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + (e && e.message || e)]); }
}
const rowsOf = (ss, name) => {
  const sh = ss.getSheetByName(name);
  if (!sh) return [];
  return sh.cells.slice(1).filter(r => r.some(v => v !== '' && v !== null && v !== undefined));
};
const setSetting = (ss, key, value) => {
  const sh = ss.getSheetByName('Настройки');
  for (let r = 2; r <= sh.cells.length; r++) {
    if (String(sh.get(r, 1)) === key) sh.set(r, 2, value);
  }
};

// =====================================================================
//  A. ОДИН config — ТРИ НАБОРА ДАННЫХ
// =====================================================================

test('config отдаёт одновременно features, 6 зон с этажами и пару мяты', () => {
  const ss = makeSs();
  state.ss = ss;
  const cfg = sandbox.getConfig_(ss);
  assert.equal(cfg.ok, true);

  // 1) Флаги разделов (ветка 17): все девять полей.
  assert.equal(typeof cfg.features, 'object');
  assert.equal(Object.keys(cfg.features).length, 9);
  Object.values(cfg.features).forEach(v => assert.equal(typeof v, 'boolean'));

  // 2) Зоны с этажами (ветка 16): старое поле zones не пропало, новое — с этажами.
  assert.deepEqual(Array.from(cfg.zones), ZONES);
  assert.equal(cfg.photoZones.length, 6);
  assert.deepEqual(Array.from(cfg.photoZones, z => z.zone), ZONES);
  assert.deepEqual(Array.from(cfg.photoZones, z => z.floor), ['1', '1', '1', '2', '2', '2']);
  assert.equal(cfg.photoRefLimit, 3);

  // 3) Пары позиций (ветка 17): мята 0.6 / 0.4.
  assert.ok(Array.isArray(cfg.pairs));
  assert.equal(cfg.pairs.length, 1);
  assert.equal(cfg.pairs[0].a, 'Мята (листья)');
  assert.equal(cfg.pairs[0].b, 'Мята (ветки)');
  assert.equal(cfg.pairs[0].shareA, 0.6);
  assert.equal(cfg.pairs[0].shareB, 0.4);

  // 4) Листы обоих наборов реально созданы и не затёрли друг друга.
  const settings = ss.getSheetByName('Настройки');
  assert.ok(settings, 'лист «Настройки» создан');
  assert.deepEqual(Array.from(settings.cells[0]), ['ключ', 'значение', 'комментарий']);
  assert.equal(rowsOf(ss, 'Настройки').length, 9);
  assert.ok(ss.getSheetByName('Пары позиций'), 'лист «Пары позиций» создан');
  assert.ok(ss.getSheetByName('Эталоны — фото'), 'лист «Эталоны — фото» создан');
  // «Эталоны уборки» остались в новой схеме и не получили вторую «этаж».
  const refs = ss.getSheetByName('Эталоны уборки');
  assert.deepEqual(Array.from(refs.cells[0]), ['этаж', 'зона', 'критерии', 'эталонное_фото']);
  assert.equal(rowsOf(ss, 'Эталоны уборки').length, 6);
});

test('выключенные «фото» и «акты» не отнимают зоны, эталоны и пары из config', () => {
  const ss = makeSs();
  state.ss = ss;
  sandbox.getConfig_(ss); // создаёт «Настройки» с 9 ключами
  setSetting(ss, 'раздел_фото', 'выкл');
  setSetting(ss, 'раздел_акты', 'выкл');
  const cfg = sandbox.getConfig_(ss);
  assert.equal(cfg.features.photo, false);
  assert.equal(cfg.features.acts, false);
  assert.equal(cfg.features.quiz, true);
  // данные обоих наборов никуда не делись
  assert.equal(cfg.photoZones.length, 6);
  assert.equal(cfg.pairs.length, 1);
  assert.equal(cfg.zones.length, 6);
});

test('флаги читаются только для config: обработчики записи их не спрашивают', () => {
  // features_ вызывается ровно из getConfig_ (и объявлена один раз).
  const calls = (CODE.match(/features_\(ss\)/g) || []).length;
  assert.equal(calls, 2, 'ожидались объявление и единственный вызов из getConfig_');
  // Очередь на клиенте (js/sync.js) о флагах не знает — записи уходят всегда.
  const sync = fs.readFileSync(new URL('../js/sync.js', import.meta.url), 'utf8');
  assert.ok(!/sectionOn|features/.test(sync), 'js/sync.js не должен знать о флагах разделов');
});

// =====================================================================
//  B. ЗАПИСЬ ИЗ ОЧЕРЕДИ ПРИ ВЫКЛЮЧЕННЫХ РАЗДЕЛАХ
// =====================================================================

const AUTH = { name: 'Анна', role: 'бармен' };
const actSheet = ss => ss.getSheetByName('Акты переработки');

/** Шпион: если обработчик записи полезет за флагами — тест это увидит. */
function spyFeatures() {
  const real = sandbox.features_;
  let called = 0;
  sandbox.features_ = function (...args) { called++; return real.apply(this, args); };
  return { count: () => called, restore: () => { sandbox.features_ = real; } };
}

test('акт с мятой пишется при выключенном «акты» и не читает флаги', () => {
  const ss = makeSs();
  state.ss = ss;
  sandbox.getConfig_(ss);
  setSetting(ss, 'раздел_акты', 'выкл');
  const spy = spyFeatures();
  const res = sandbox.saveProcessing_(ss, actSheet(ss), AUTH, {
    act: 'Мята — очистка',
    lines: [
      { role: 'Сырьё', item: 'Мята', unit: 'г', qty: 200 },
      { role: 'Результат', item: 'Мята (листья)', unit: 'г', qty: 120,
        pair: { item: 'Мята (ветки)', qty: 80, source: 'own' } },
    ],
  }, 'test-int-mint-01', new Date(), new Date(), '');
  spy.restore();
  assert.equal(res.status, 'saved');
  assert.equal(spy.count(), 0, 'запись акта не должна читать флаги разделов');

  const sh = actSheet(ss);
  const head = sh.cells[0].map(String);
  const at = name => head.indexOf(name) + 1;
  const row = sh.getLastRow();
  assert.equal(sh.get(row, at('пара_позиция')), 'Мята (ветки)');
  assert.equal(sh.get(row, at('пара_кол-во')), 80);
  assert.equal(sh.get(row, at('доля_A')), 0.6);
  assert.equal(sh.get(row, at('доля_B')), 0.4);
  assert.equal(sh.get(row, at('взвешено')), 'Мята (листья)');
  assert.equal(sh.get(row, at('всего, г')), 200);
  // Выход считается по своей позиции: 120 / 200 = 60 %.
  assert.equal(sh.get(row, 6), 120);
  assert.equal(sh.get(row, 8), 60);
});

test('закрытие акта с мятой при выключенном «акты» пересчитывает оба поля', () => {
  const ss = makeSs();
  state.ss = ss;
  sandbox.getConfig_(ss);
  setSetting(ss, 'раздел_акты', 'выкл');
  // Сначала акт «в работе»: выход оставлен на потом.
  sandbox.saveProcessing_(ss, actSheet(ss), AUTH, {
    act: 'Мята — очистка',
    pending: true,
    lines: [
      { role: 'Сырьё', item: 'Мята', unit: 'г', qty: 200 },
      { role: 'Результат', item: 'Мята (листья)', unit: 'г', qty: 0 },
    ],
  }, 'test-int-mint-02', new Date(), new Date(), '');
  const sh = actSheet(ss);
  const row = sh.getLastRow();
  const spy = spyFeatures();
  const res = sandbox.closeProcessing_(ss, sh, AUTH, {
    actId: 'test-int-mint-02',
    qty: 80, // взвесили ветки: «своё» поле пересчитывается из 80 г веток
    pair: { item: 'Мята (ветки)', qty: 80, source: 'other' },
  }, 'test-int-close-01', new Date());
  spy.restore();
  assert.equal(res.status, 'saved');
  assert.equal(spy.count(), 0);
  const head = sh.cells[0].map(String);
  const at = name => head.indexOf(name) + 1;
  assert.equal(sh.get(row, 6), 120, 'листья = 80 × 0.6/0.4 = 120');
  assert.equal(sh.get(row, at('пара_позиция')), 'Мята (ветки)');
  assert.equal(sh.get(row, at('пара_кол-во')), 80);
  assert.equal(sh.get(row, at('взвешено')), 'Мята (ветки)');
});

// ---------- итог ----------
const failed = results.filter(r => r[0] === 'FAIL');
results.forEach(([st, name]) => console.log(st + '  ' + name));
console.log('\n' + (results.length - failed.length) + ' из ' + results.length + ' прошли');
if (failed.length) process.exit(1);
