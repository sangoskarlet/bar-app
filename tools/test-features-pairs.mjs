// =====================================================================
//  ЛОКАЛЬНЫЕ ТЕСТЫ: флаги разделов и пары позиций (мята)
//
//  Загружает apps-script/Код.gs в песочницу Node, подменяет сервисы
//  Apps Script таблицей-заглушкой и проверяет:
//    * лист «Настройки» → config.features (нет листа/ключа = включено);
//    * лист «Пары позиций» → состав пары без долей, миграция старых колонок;
//    * запись акта с парой: общий вес, листья + ветки = общий вес, «взвешено»,
//      расчёт выхода, отказ при неверной сумме;
//    * закрытие акта с парой и сохранение старых значений долей;
//    * выключенный раздел не мешает записи (очередь как раньше).
//
//  Запуск: node tools/test-features-pairs.mjs
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
// Лог пишем в память, а не в лист.
sandbox.log_ = (event, details) => state.log.push(event + ': ' + details);
// const/let в vm не становятся полями контекста — забираем константы явно,
// чтобы тесты не держали у себя числа «9 разделов» вручную.
sandbox.FEATURE_KEYS = vm.runInContext('FEATURE_KEYS', sandbox);
sandbox.STOP_SETTINGS = vm.runInContext('STOP_SETTINGS', sandbox);

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
};

const TPL_ROWS = [
  ['Мята — очистка', 'простой', 'Сырьё', 'Мята', 'г', 0, true, true, '', ''],
  ['Мята — очистка', 'простой', 'Результат', 'Мята (листья)', 'г', 0, '', true, '', ''],
  ['Лимонный фреш', 'простой', 'Сырьё', 'Лимоны', 'г', 0, true, true, '', ''],
  ['Лимонный фреш', 'простой', 'Результат', 'Лимонный сок ПФ', 'г', 0, '', true, '', ''],
  ['Заготовка Морса', 'по рецепту', 'Сырьё', 'Клюква с/м', 'г', 800, true, true, '', ''],
  ['Заготовка Морса', 'по рецепту', 'Сырьё', 'Сахар песок', 'г', 400, '', true, '', ''],
  ['Заготовка Морса', 'по рецепту', 'Результат', 'Заготовка Морса', 'г', 0, '', true, '', ''],
];

function makeSs(extra = {}) {
  const ss = new FakeSpreadsheet([
    ['Сотрудники', HEADERS.staff, [['Анна', '1234', 'бармен', true]]],
    ['Справочник', HEADERS.items, [['Мята', 'г', 'Зелень', true]]],
    ['Списки', HEADERS.lists, [['Бой', 'Бар 1 этаж', '', 'Склад', 'Кабинет', 'обычное']]],
    ['ТТК', HEADERS.ttk, []],
    ['Шаблоны переработки', HEADERS.tpl, TPL_ROWS],
    ['Опись', HEADERS.invList, []],
    ['Акты переработки', HEADERS.acts, []],
    ['Лог', ['Время', 'Событие', 'Детали'], []],
    ['Сроки хранения', ['заготовка', 'короткое_имя', 'срок_часов', 'примечание', 'активен'], []],
    ['Чек-листы', ['список', 'порядок', 'пункт', 'подсказка', 'фото_обязательно', 'активен'], []],
    ['Факты', ['id', 'текст', 'источник', 'активен', 'дата_показа'], []],
  ]);
  for (const [name, spec] of Object.entries(extra || {})) {
    ss.sheets.set(name, new FakeSheet(name, spec[0], spec[1] || []));
  }
  return ss;
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
const values = (ss, name, col) => rowsOf(ss, name).map(r => r[col]);

// =====================================================================
//  A. ФЛАГИ РАЗДЕЛОВ
// =====================================================================

test('нет листа «Настройки» — все разделы включены, лист создаётся с ключами разделов', () => {
  const ss = makeSs();
  state.ss = ss;
  const f = sandbox.features_(ss);
  assert.deepEqual(Object.keys(f), ['quiz', 'duel', 'checklists', 'acts', 'photo', 'stoplist', 'inventory', 'ttk', 'transfer', 'writeoff']);
  Object.values(f).forEach(v => assert.equal(v, true));
  const sh = ss.getSheetByName('Настройки');
  assert.ok(sh, 'лист «Настройки» создан');
  assert.deepEqual(sh.cells[0], ['ключ', 'значение', 'комментарий']);
  // Разделы + настройки стоп-листа (числа и флаги проверок) — все строки на месте.
  assert.equal(sh.cells.length - 1, sandbox.FEATURE_KEYS.length + sandbox.STOP_SETTINGS.length);
  assert.equal(values(ss, 'Настройки', 0).length, sandbox.FEATURE_KEYS.length + sandbox.STOP_SETTINGS.length);
  assert.ok(values(ss, 'Настройки', 0).includes('стоплист_долго_дней'), 'настройка стоп-листа есть');
  assert.ok(values(ss, 'Настройки', 0).includes('раздел_стоплист'), 'флаг раздела стоп-листа есть');
});

test('«выкл» в разных видах выключает, пусто и «вкл» — включает', () => {
  const ss = makeSs();
  state.ss = ss;
  sandbox.features_(ss); // создаёт лист с ключами разделов
  const sh = ss.getSheetByName('Настройки');
  const set = (key, value) => {
    for (let r = 2; r <= sh.cells.length; r++) {
      if (String(sh.get(r, 1)) === key) sh.set(r, 2, value);
    }
  };
  set('раздел_викторина', 'ВЫКЛ');
  set('раздел_дуэль', 'выкл.');
  set('раздел_чеклисты', '');
  set('раздел_акты', 'нет');
  set('раздел_фото', 'off');
  set('раздел_инвентаризация', '0');
  set('раздел_ттк', 'да');
  set('раздел_перенос', 'вкл');
  set('раздел_списание', 'False');
  const f = sandbox.features_(ss);
  assert.equal(f.quiz, false);
  assert.equal(f.duel, false);
  assert.equal(f.checklists, true);
  assert.equal(f.acts, false);
  assert.equal(f.photo, false);
  assert.equal(f.inventory, false);
  assert.equal(f.ttk, true);
  assert.equal(f.transfer, true);
  assert.equal(f.writeoff, false);
});

test('нет ключа в листе — раздел включён', () => {
  const ss = makeSs();
  state.ss = ss;
  sandbox.features_(ss);
  const sh = ss.getSheetByName('Настройки');
  // удаляем строку «раздел_акты» целиком
  const idx = sh.cells.findIndex((r, i) => i > 0 && String(r[0]) === 'раздел_акты');
  assert.ok(idx > 0);
  sh.cells.splice(idx, 1);
  assert.equal(sandbox.features_(ss).acts, true);
});

test('непонятное значение не выключает раздел и пишет в «Лог»', () => {
  const ss = makeSs();
  state.ss = ss;
  sandbox.features_(ss);
  const sh = ss.getSheetByName('Настройки');
  for (let r = 2; r <= sh.cells.length; r++) {
    if (String(sh.get(r, 1)) === 'раздел_викторина') sh.set(r, 2, 'может быть');
  }
  assert.equal(sandbox.features_(ss).quiz, true);
  assert.ok(state.log.some(x => x.includes('непонятное значение') && x.includes('раздел_викторина')));
});

test('config.features — объект со всеми булевыми полями; config.pairs — состав пар без долей', () => {
  const ss = makeSs();
  state.ss = ss;
  const cfg = sandbox.getConfig_(ss);
  assert.equal(cfg.ok, true);
  assert.equal(typeof cfg.features, 'object');
  assert.equal(Object.keys(cfg.features).length, sandbox.FEATURE_KEYS.length);
  Object.values(cfg.features).forEach(v => assert.equal(typeof v, 'boolean'));
  assert.ok(Array.isArray(cfg.pairs));
  assert.equal(cfg.pairs.length, 1);
  assert.equal(cfg.pairs[0].a, 'Мята (листья)');
  assert.equal(cfg.pairs[0].b, 'Мята (ветки)');
  assert.ok(!('shareA' in cfg.pairs[0]), 'доли больше не отдаются клиенту');
  assert.ok(!('shareB' in cfg.pairs[0]));
});

// =====================================================================
//  Б. ПАРЫ ПОЗИЦИЙ
// =====================================================================

test('лист «Пары позиций» создаётся с мятой; доли не заполняются', () => {
  const ss = makeSs();
  state.ss = ss;
  const pairs = sandbox.pairs_(ss);
  assert.equal(pairs.length, 1);
  assert.deepEqual(Object.keys(pairs[0]).sort(), ['a', 'b', 'comment']);
  const sh = ss.getSheetByName('Пары позиций');
  assert.ok(sh);
  assert.deepEqual(sh.cells[0], ['позиция_A', 'позиция_B', 'доля_A (не используется)',
    'доля_B (не используется)', 'активен', 'комментарий']);
  assert.deepEqual(sh.cells[1].slice(0, 5), ['Мята (листья)', 'Мята (ветки)', '', '', true]);
});

test('старый лист с долями: колонки помечены «не используется», 0.6/0.4 сохранены', () => {
  const ss = makeSs({
    'Пары позиций': [
      ['позиция_A', 'позиция_B', 'доля_A', 'доля_B', 'активен', 'комментарий'],
      [['Мята (листья)', 'Мята (ветки)', 0.6, 0.4, true, 'стартовое значение 0.6 / 0.4 — поправьте']],
    ],
  });
  state.ss = ss;
  const pairs = sandbox.pairs_(ss);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].a, 'Мята (листья)');
  assert.ok(!('shareA' in pairs[0]), 'доли не отдаются клиенту');
  const sh = ss.getSheetByName('Пары позиций');
  assert.deepEqual(sh.cells[0], ['позиция_A', 'позиция_B', 'доля_A (не используется)',
    'доля_B (не используется)', 'активен', 'комментарий']);
  assert.equal(sh.get(2, 3), 0.6, 'старое значение доли_A не стёрто');
  assert.equal(sh.get(2, 4), 0.4, 'старое значение доли_B не стёрто');
  assert.match(String(sh.get(2, 6)), /доли не используются/, 'в комментарий добавлена пометка');
  assert.match(String(sh.get(2, 6)), /стартовое значение 0\.6 \/ 0\.4/, 'прежний комментарий сохранён');
  assert.ok(state.log.some(x => x.includes('не используется')));
});

test('выключенная пара (снятая галочка) не попадает в config', () => {
  const ss = makeSs();
  state.ss = ss;
  sandbox.pairs_(ss);
  ss.getSheetByName('Пары позиций').set(2, 5, false);
  assert.equal(sandbox.pairs_(ss).length, 0);
});

test('вторая пара добавляется строкой в лист, без долей, и её можно выключить', () => {
  const ss = makeSs();
  state.ss = ss;
  sandbox.pairs_(ss);
  const sh = ss.getSheetByName('Пары позиций');
  sh.cells.push(['Апельсин (цедра)', 'Апельсин (мякоть)', '', '', true, 'тестовая пара']);
  let pairs = sandbox.pairs_(ss);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[1].a, 'Апельсин (цедра)');
  assert.ok(!('shareA' in pairs[1]), 'доли не нужны и не отдаются');
  // «выключаем» вторую строку
  sh.set(3, 5, false);
  pairs = sandbox.pairs_(ss);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].a, 'Мята (листья)');
});

test('одинаковые позиции пропускаются; пустые доли больше не мешают', () => {
  const ss = makeSs();
  state.ss = ss;
  sandbox.pairs_(ss);
  const sh = ss.getSheetByName('Пары позиций');
  sh.set(2, 2, 'Мята (листья)');
  assert.equal(sandbox.pairs_(ss).length, 0);
  assert.ok(state.log.some(x => x.includes('одинаковыми позициями')));
  sh.set(2, 2, 'Мята (ветки)');
  sh.set(2, 3, '');
  sh.set(2, 4, '');
  assert.equal(sandbox.pairs_(ss).length, 1, 'пара без долей работает');
});

test('старые колонки Q–V: доли помечены, часть_A/часть_B добавлены', () => {
  const ss = makeSs();
  state.ss = ss;
  const sh = actSheet(ss);
  sh.cells[0].push('пара_позиция', 'пара_кол-во', 'доля_A', 'доля_B', 'взвешено', 'всего, г');
  const cols = sandbox.ensureActPairColumns_(sh);
  assert.equal(sh.cells[0][18], 'доля_A (не используется)');
  assert.equal(sh.cells[0][19], 'доля_B (не используется)');
  assert.ok(cols['часть_A, г'] > 0, 'часть_A добавлена');
  assert.ok(cols['часть_B, г'] > 0, 'часть_B добавлена');
  assert.ok(state.log.some(x => x.includes('обновлены')));
});

// =====================================================================
//  В. АКТЫ: запись, сохранение общего веса и обеих частей, выход
// =====================================================================

const AUTH = { name: 'Анна', role: 'бармен' };

function actSheet(ss) { return ss.getSheetByName('Акты переработки'); }
function lastPairCols(ss) {
  const sh = actSheet(ss);
  const head = sh.cells[0].map(String);
  const at = name => {
    const exact = head.indexOf(name);
    if (exact >= 0) return exact + 1;
    if (name.indexOf('доля_') === 0) return head.indexOf(name + ' (не используется)') + 1;
    return 0;
  };
  const row = sh.getLastRow();
  const val = name => (at(name) ? sh.get(row, at(name)) : '');
  return {
    pairItem: val('пара_позиция'),
    pairQty: val('пара_кол-во'),
    shareA: val('доля_A'),
    shareB: val('доля_B'),
    weighed: val('взвешено'),
    total: val('всего, г'),
    partA: val('часть_A, г'),
    partB: val('часть_B, г'),
  };
}
function saveMint(ss, outQty, pair) {
  return sandbox.saveProcessing_(ss, actSheet(ss), AUTH, {
    act: 'Мята — очистка',
    pending: outQty === 0,
    lines: [
      { role: 'Сырьё', item: 'Мята', unit: 'г', qty: 200 },
      { role: 'Результат', item: 'Мята (листья)', unit: 'г', qty: outQty, pair },
    ],
  }, 'test-mint-0001', new Date(), new Date(), '');
}

test('акт с парой: листья 120 + ветки 80 = общий 200, взвешены листья', () => {
  const ss = makeSs();
  state.ss = ss;
  const res = saveMint(ss, 120, { item: 'Мята (ветки)', qty: 80, total: 200, source: 'own' });
  assert.equal(res.status, 'saved');
  const cols = lastPairCols(ss);
  assert.equal(cols.pairItem, 'Мята (ветки)');
  assert.equal(cols.pairQty, 80);
  assert.equal(cols.shareA, '', 'старые доли не заполняются');
  assert.equal(cols.shareB, '', 'старые доли не заполняются');
  assert.equal(cols.weighed, 'Мята (листья)');
  assert.equal(cols.total, 200);
  assert.equal(cols.partA, 120);
  assert.equal(cols.partB, 80);
  const sh = actSheet(ss);
  const row = sh.getLastRow();
  assert.equal(sh.get(row, 6), 120);
  assert.equal(sh.get(row, 8), 60);
  assert.equal(cols.partA + cols.partB, cols.total, 'сумма частей = общий вес');
  assert.equal(sh.get(row, 6) + cols.pairQty, cols.total, 'F + R = V');
});

test('ввели ветки 80 — сервер считает листья 120, присланному 999 не верит', () => {
  const ss = makeSs();
  state.ss = ss;
  saveMint(ss, 999, { item: 'Мята (ветки)', qty: 80, total: 200, source: 'other' });
  const sh = actSheet(ss);
  const row = sh.getLastRow();
  assert.equal(sh.get(row, 6), 120);
  assert.equal(sh.get(row, 8), 60);
  const cols = lastPairCols(ss);
  assert.equal(cols.pairQty, 80);
  assert.equal(cols.weighed, 'Мята (ветки)');
  assert.equal(cols.partA, 120);
  assert.equal(cols.partB, 80);
  assert.equal(cols.partA + cols.partB, cols.total);
});

test('листья больше общего веса: акт не пишется, ошибка заметная', () => {
  const ss = makeSs();
  state.ss = ss;
  const res = saveMint(ss, 250, { item: 'Мята (ветки)', qty: 0, total: 200, source: 'own' });
  assert.equal(res.status, 'error');
  assert.match(res.error, /больше общего веса/);
  assert.equal(actSheet(ss).getLastRow(), 1, 'ни одной строки акта не добавлено');
});

test('старая запись без total: общий вес берётся из «Было» (200)', () => {
  const ss = makeSs();
  state.ss = ss;
  const res = saveMint(ss, 120, { item: 'Мята (ветки)', qty: 80, source: 'own' });
  assert.equal(res.status, 'saved');
  const cols = lastPairCols(ss);
  assert.equal(cols.total, 200);
  assert.equal(cols.partA, 120);
  assert.equal(cols.partB, 80);
});

test('пара без общего веса и без fallback — invalid, акт не пишется молча', () => {
  const pair = sandbox.actPairForLine_(
    [{ a: 'Мята (листья)', b: 'Мята (ветки)' }],
    { item: 'Мята (листья)', pair: { item: 'Мята (ветки)', qty: 80, source: 'own' } },
    120,
    0,
  );
  assert.equal(pair.invalid, true);
  assert.match(pair.error, /общий вес/);
});

test('выключенная пара не показывается: акт пишется как раньше, без колонок пары', () => {
  const ss = makeSs();
  state.ss = ss;
  sandbox.pairs_(ss);
  ss.getSheetByName('Пары позиций').set(2, 5, false);
  saveMint(ss, 120, { item: 'Мята (ветки)', qty: 80, total: 200, source: 'own' });
  const sh = actSheet(ss);
  const row = sh.getLastRow();
  assert.equal(sh.get(row, 6), 120);
  assert.equal(sh.get(row, 8), 60);
  assert.equal(lastPairCols(ss).pairItem, '');
});

test('акт без пары считается как раньше (лимонный фреш 1000 → 300 = 30 %)', () => {
  const ss = makeSs();
  state.ss = ss;
  const res = sandbox.saveProcessing_(ss, actSheet(ss), AUTH, {
    act: 'Лимонный фреш',
    lines: [
      { role: 'Сырьё', item: 'Лимоны', unit: 'г', qty: 1000 },
      { role: 'Результат', item: 'Лимонный сок ПФ', unit: 'г', qty: 300 },
    ],
  }, 'test-lemon-001', new Date(), new Date(), '');
  assert.equal(res.status, 'saved');
  const sh = actSheet(ss);
  assert.equal(sh.get(sh.getLastRow(), 8), 30);
});

test('позиция не из шаблона по-прежнему отклоняется', () => {
  const ss = makeSs();
  state.ss = ss;
  const res = sandbox.saveProcessing_(ss, actSheet(ss), AUTH, {
    act: 'Мята — очистка',
    lines: [
      { role: 'Сырьё', item: 'Мята', unit: 'г', qty: 200 },
      { role: 'Результат', item: 'Мята (листья)', unit: 'г', qty: 120,
        pair: { item: 'Неизвестно', qty: 80, total: 200 } },
    ],
  }, 'test-badpair-01', new Date(), new Date(), '');
  // Вторая позиция пары неизвестна → пара игнорируется, сам акт сохраняется.
  assert.equal(res.status, 'saved');
  assert.ok(state.log.some(x => x.includes('нет активной пары')));
});

test('пары не меняют расчёт выхода у рецепта', () => {
  const ss = makeSs();
  state.ss = ss;
  const res = sandbox.saveProcessing_(ss, actSheet(ss), AUTH, {
    act: 'Заготовка Морса',
    lines: [
      { role: 'Сырьё', item: 'Клюква с/м', unit: 'г', qty: 800 },
      { role: 'Сырьё', item: 'Сахар песок', unit: 'г', qty: 400 },
      { role: 'Результат', item: 'Заготовка Морса', unit: 'г', qty: 900 },
    ],
  }, 'test-mors-0001', new Date(), new Date(), '');
  assert.equal(res.status, 'saved');
  const sh = actSheet(ss);
  assert.equal(sh.get(sh.getLastRow(), 8), '');
});

test('закрытие акта с парой: общий вес из акта, части считаются; старые доли не стёрты', () => {
  const ss = makeSs();
  state.ss = ss;
  saveMint(ss, 0, null); // pending: выход пуст
  const sh = actSheet(ss);
  const row = sh.getLastRow();
  assert.equal(sh.get(row, 13), '⏳ В работе');
  // Старый акт мог быть сохранён прежней версией: в S/T уже стоят 0.6/0.4.
  sandbox.ensureActPairColumns_(sh);
  const shareAcol = sh.cells[0].indexOf('доля_A (не используется)') + 1;
  const shareBcol = sh.cells[0].indexOf('доля_B (не используется)') + 1;
  sh.set(row, shareAcol, 0.6);
  sh.set(row, shareBcol, 0.4);
  const res = sandbox.closeProcessing_(ss, sh, AUTH, {
    actId: 'test-mint-0001', qty: 999,
    pair: { item: 'Мята (ветки)', qty: 80, total: 200, source: 'other' },
  }, 'test-close-0001', new Date());
  assert.equal(res.status, 'saved');
  assert.equal(sh.get(row, 6), 120); // листья = 200 − 80
  assert.equal(sh.get(row, 8), 60);
  const cols = lastPairCols(ss);
  assert.equal(cols.pairQty, 80);
  assert.equal(cols.total, 200);
  assert.equal(cols.partA, 120);
  assert.equal(cols.partB, 80);
  assert.equal(cols.weighed, 'Мята (ветки)');
  assert.equal(sh.get(row, shareAcol), 0.6, 'старая доля_A не стёрта');
  assert.equal(sh.get(row, shareBcol), 0.4, 'старая доля_B не стёрта');
});

test('выключенный раздел «акты» не мешает записи акта (очередь работает)', () => {
  const ss = makeSs();
  state.ss = ss;
  sandbox.features_(ss);
  const sh = ss.getSheetByName('Настройки');
  for (let r = 2; r <= sh.cells.length; r++) {
    if (String(sh.get(r, 1)) === 'раздел_акты') sh.set(r, 2, 'выкл');
  }
  assert.equal(sandbox.features_(ss).acts, false);
  const res = saveMint(ss, 120, null);
  assert.equal(res.status, 'saved');
});

// ---------- итог ----------
const failed = results.filter(r => r[0] === 'FAIL');
results.forEach(([st, name]) => console.log(st + '  ' + name));
console.log('\n' + (results.length - failed.length) + ' из ' + results.length + ' прошли');
if (failed.length) process.exit(1);
