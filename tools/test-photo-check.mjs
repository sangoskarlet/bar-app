// =====================================================================
//  ЛОКАЛЬНЫЕ ТЕСТЫ ПРОВЕРКИ ФОТО (без сети и без Google)
//
//  Загружает apps-script/Код.gs в песочницу Node, подменяет сервисы
//  Apps Script заглушками и проверяет чистые функции: промпт, разбор
//  ответа модели, правила вердикта, запись колонок M–R и чтение истории.
//
//  Запуск: node tools/test-photo-check.mjs
// =====================================================================

import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const CODE = fs.readFileSync(new URL('../apps-script/Код.gs', import.meta.url), 'utf8');

// ---------- заглушки Google Apps Script ----------
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
  setRichTextValue(v) { this.sheet.set(this.row, this.col, v && v.text !== undefined ? v.text : String(v)); return this; }
  setNumberFormat() { return this; }
}

class FakeSheet {
  constructor(headers, rows = []) {
    this.cells = [headers.slice(), ...rows.map(r => r.slice())];
    this.cols = Math.max(...this.cells.map(r => r.length), headers.length);
    this.cells.forEach(r => { while (r.length < this.cols) r.push(''); });
  }
  getLastRow() {
    let last = 0;
    this.cells.forEach((r, i) => { if (r.some(v => v !== '' && v !== null && v !== undefined)) last = i + 1; });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.cells.forEach(r => r.forEach((v, i) => { if (v !== '' && v !== null && v !== undefined) last = Math.max(last, i + 1); }));
    return last;
  }
  getMaxRows() { return Math.max(this.cells.length, 10); }
  getMaxColumns() { return Math.max(this.cols, 20); }
  getRange(row, col, numRows = 1, numCols = 1) { return new FakeRange(this, row, col, numRows, numCols); }
  get(row, col) {
    const r = this.cells[row - 1];
    return r && r[col - 1] !== undefined ? r[col - 1] : '';
  }
  set(row, col, v) {
    while (this.cells.length < row) this.cells.push([]);
    const r = this.cells[row - 1];
    while (r.length < col) r.push('');
    r[col - 1] = v;
  }
}

const PHOTO_HEADERS = ['Дата', 'Сотрудник', 'Зона', 'Фото', 'Комментарий', 'Получено', 'ID записи',
  'Проверка ИИ', 'Что не так', 'Замечание менеджера', 'Фото удалено', 'ID файла'];
const PHOTO_FULL_HEADERS = PHOTO_HEADERS.concat(['вердикт', 'уверенность', 'замечания', 'модель', 'проверено_в', 'эталон']);

const props = new Map([
  ['GEMINI_API_KEY', 'test-key'],
]);
const state = {
  fetchCalls: [],
  fetchHandler: null,
  driveFiles: new Map(),
  photoSheet: null,
  refsSheet: null,
  log: [],
};

const sandbox = {
  console,
  Logger: { log: (m) => state.log.push(String(m)) },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => props.set(k, String(v)),
      deleteProperty: (k) => props.delete(k),
    }),
  },
  Utilities: {
    base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
    base64Decode: (s) => Uint8Array.from(Buffer.from(String(s), 'base64')),
    newBlob: (bytes, mime, name) => ({
      bytes: Uint8Array.from(bytes), mime, name,
      getBytes() { return this.bytes; },
      getContentType() { return this.mime; },
    }),
    formatDate: () => '2026-11-22_23-40',
  },
  UrlFetchApp: {
    fetch: (url, options) => {
      state.fetchCalls.push({ url, options });
      if (!state.fetchHandler) throw new Error('нет мока fetch');
      return state.fetchHandler(url, options, state.fetchCalls.length);
    },
  },
  DriveApp: {
    getFileById: (id) => {
      const f = state.driveFiles.get(id);
      if (!f) throw new Error('нет файла ' + id);
      return {
        getId: () => id,
        getUrl: () => 'https://drive.google.com/file/d/' + id + '/view',
        getBlob: () => ({
          getContentType: () => f.mime || 'image/jpeg',
          getBytes: () => Uint8Array.from(f.bytes || [1, 2, 3]),
        }),
        getThumbnail: () => (f.thumb
          ? { getContentType: () => f.thumbMime || 'image/jpeg', getBytes: () => Uint8Array.from(f.thumb) }
          : null),
      };
    },
  },
  SpreadsheetApp: {
    openById: () => ({
      getSheetByName: (name) => {
        if (name === 'Фото уборки') return state.photoSheet;
        if (name === 'Эталоны уборки') return state.refsSheet;
        if (name === 'Лог') return null;
        return null;
      },
    }),
    newRichTextValue: () => {
      const obj = {
        text: '',
        url: '',
        setText(t) { this.text = t; return this; },
        setLinkUrl(u) { this.url = u; return this; },
        build() { return { text: this.text, url: this.url }; },
      };
      return obj;
    },
  },
  ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {} },
  ContentService: { createTextOutput: (s) => ({ setMimeType: () => s }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
};

vm.createContext(sandbox);
vm.runInContext(CODE, sandbox, { filename: 'Код.gs' });
// Лог в тестах не должен ходить в таблицу.
sandbox.log_ = (event, details) => state.log.push(event + ': ' + details);

const results = [];
function test(name, fn) {
  try { fn(); results.push(['OK', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]); }
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

// ---------- 1. Критерии и промпт ----------
test('критерии зоны режутся на предложения', () => {
  const what = 'Стойка пустая и сухая, без стаканов, бутылок и тряпок. Инструмент вымыт и лежит на местах. Коврики чистые. Не должно быть чёрных контейнеров с посудой (ни на стойке, ни под ней, ни рядом — это замечание).';
  const list = sandbox.splitPhotoCriteria_(what);
  assert.equal(list.length, 4);
  assert.match(list[0], /Стойка пустая/);
  assert.match(list[3], /чёрных контейнеров/);
});

test('промпт: зона, критерии, только JSON, запрет людей, unclear', () => {
  const p = sandbox.buildPhotoPrompt_('Бар 1 этаж', ['Стойка сухая', 'Нет посуды'], false);
  assert.match(p, /Бар 1 этаж/);
  assert.match(p, /1\) Стойка сухая/);
  assert.match(p, /ТОЛЬКО JSON/);
  assert.match(p, /Не описывай и не оценивай людей/);
  assert.match(p, /"unclear"/);
  assert.doesNotMatch(p, /изображении 1/);
});

test('промпт с эталоном просит сравнить состав, а не пиксели', () => {
  const p = sandbox.buildPhotoPrompt_('Бар 1 этаж', ['Стойка сухая'], true);
  assert.match(p, /изображении 1 — эталон/);
  assert.match(p, /попиксельного/);
  assert.match(p, /состав и захламлённость/);
});

// ---------- 2. Разбор ответа ----------
test('валидный JSON принимается', () => {
  const v = sandbox.validatePhotoAnswer_(JSON.stringify({
    verdict: 'warn', confidence: 0.82,
    items: [{ criterion: 'Стойка', level: 'ok', comment: 'сухо' },
      { criterion: 'Тара', level: 'warn', comment: 'бутылка слева' }],
  }), ['Стойка', 'Тара']);
  assert.equal(v.ok, true);
  assert.equal(v.confidence, 0.82);
  assert.equal(v.items.length, 2);
});

test('markdown-обёртка снимается', () => {
  const v = sandbox.validatePhotoAnswer_('```json\n{"verdict":"ok","confidence":0.9,"items":[{"criterion":"a","level":"ok","comment":""}]}\n```', ['a']);
  assert.equal(v.ok, true);
});

test('не JSON → понятная ошибка, без исключения', () => {
  const v = sandbox.validatePhotoAnswer_('Извините, я не могу оценить это фото', ['a']);
  assert.equal(v.ok, false);
  assert.match(v.reason, /не JSON/);
});

test('confidence вне 0…1 → ошибка', () => {
  assert.equal(sandbox.validatePhotoAnswer_('{"verdict":"ok","confidence":1.4,"items":[{"criterion":"a","level":"ok","comment":""}]}', []).ok, false);
  assert.equal(sandbox.validatePhotoAnswer_('{"verdict":"ok","items":[{"criterion":"a","level":"ok","comment":""}]}', []).ok, false);
});

test('пустой items → ошибка', () => {
  const v = sandbox.validatePhotoAnswer_('{"verdict":"ok","confidence":0.9,"items":[]}', []);
  assert.equal(v.ok, false);
  assert.match(v.reason, /items/);
});

test('уровни нормализуются, неизвестный → unclear', () => {
  assert.equal(sandbox.normalizePhotoLevel_('чисто'), 'ok');
  assert.equal(sandbox.normalizePhotoLevel_('Критично'), 'crit');
  assert.equal(sandbox.normalizePhotoLevel_('замечание'), 'warn');
  assert.equal(sandbox.normalizePhotoLevel_('не видно'), 'unclear');
  assert.equal(sandbox.normalizePhotoLevel_('что-то'), 'unclear');
});

// ---------- 3. Правила вердикта ----------
test('crit побеждает warn и ok', () => {
  assert.equal(sandbox.photoVerdictLevel_([{ level: 'ok' }, { level: 'warn' }, { level: 'crit' }], 0.95), 'crit');
});
test('warn побеждает ok', () => {
  assert.equal(sandbox.photoVerdictLevel_([{ level: 'ok' }, { level: 'warn' }], 0.8), 'warn');
});
test('всё ok → ok', () => {
  assert.equal(sandbox.photoVerdictLevel_([{ level: 'ok' }, { level: 'ok' }], 0.7), 'ok');
});
test('confidence < 0.5 → unclear даже при crit', () => {
  assert.equal(sandbox.photoVerdictLevel_([{ level: 'crit' }], 0.49), 'unclear');
});
test('все пункты не видны → unclear', () => {
  assert.equal(sandbox.photoVerdictLevel_([{ level: 'unclear' }, { level: 'na' }], 0.9), 'unclear');
});
test('замечания: уровни и комментарии через ;', () => {
  const notes = sandbox.photoNotes_([
    { level: 'crit', criterion: 'Стойка', comment: 'грязная посуда слева' },
    { level: 'warn', criterion: 'Тара', comment: 'пустая бутылка у края' },
    { level: 'ok', criterion: 'Коврик', comment: '' },
  ]);
  assert.equal(notes, 'crit: грязная посуда слева; warn: пустая бутылка у края');
});

test('невалидный ответ модели → unclear, без падения', () => {
  const v = sandbox.photoFromGeminiResult_({ invalid: true, reason: 'ответ не JSON', model: 'm' }, null);
  assert.equal(v.level, 'unclear');
  assert.match(v.notes, /ответ модели не разобран/);
});

test('unclear: в замечания попадает, чего не видно', () => {
  const v = sandbox.photoFromGeminiResult_({
    items: [{ criterion: 'Стойка', level: 'unclear', comment: 'стойка не в кадре' }],
    confidence: 0.7,
    model: 'm',
  }, null);
  assert.equal(v.level, 'unclear');
  assert.equal(v.notes, 'unclear: стойка не в кадре');
});

test('не проверено → телефон получает unclear + причину', () => {
  const v = sandbox.photoUnchecked_('Gemini HTTP 503', null);
  const pub = sandbox.photoPublic_(v);
  assert.equal(pub.level, 'unclear');
  assert.equal(pub.verdict, 'не проверено');
  assert.match(pub.error, /503/);
  assert.match(pub.notes, /причина/);
});

// ---------- 4. Запрос к Gemini (мок) ----------
const BLOB = sandbox.Utilities.newBlob([1, 2, 3, 4], 'image/jpeg', 'x.jpg');

test('запрос: одна картинка, схема ответа, рабочая модель', () => {
  state.fetchCalls = [];
  state.fetchHandler = () => geminiOk({
    verdict: 'ok', confidence: 0.9,
    items: [{ criterion: 'Стойка', level: 'ok', comment: 'сухо' }],
  });
  props.delete('GEMINI_MODEL');
  const res = sandbox.geminiPhotoCheck_('k', 'Бар 1 этаж', null, BLOB, null);
  assert.equal(res.model, 'gemini-flash-lite-latest');
  assert.equal(res.items[0].level, 'ok');
  const call = state.fetchCalls[0];
  assert.match(call.url, /gemini-flash-lite-latest:generateContent$/);
  const payload = JSON.parse(call.options.payload);
  const parts = payload.contents[0].parts;
  assert.equal(parts.length, 2); // текст + фото
  assert.equal(parts[1].inline_data.mime_type, 'image/jpeg');
  assert.equal(payload.generationConfig.responseSchema.properties.items.type, 'ARRAY');
  assert.equal(payload.generationConfig.temperature, 0);
});

test('запрос с эталоном: две картинки, эталон первым', () => {
  state.fetchCalls = [];
  state.driveFiles.set('ref1', { bytes: [9, 9], mime: 'image/png' });
  state.fetchHandler = () => geminiOk({
    verdict: 'ok', confidence: 0.9,
    items: [{ criterion: 'Стойка', level: 'ok', comment: 'сухо' }],
  });
  const ref = { what: 'Стойка сухая', fileId: 'ref1', url: 'https://drive.google.com/file/d/ref1/view' };
  const res = sandbox.geminiPhotoCheck_('k', 'Бар 1 этаж', ref, BLOB, null);
  assert.equal(res.model, 'gemini-flash-lite-latest');
  const parts = JSON.parse(state.fetchCalls[0].options.payload).contents[0].parts;
  assert.equal(parts.length, 3); // текст + эталон + фото
  assert.equal(parts[1].inline_data.mime_type, 'image/png');
  assert.match(parts[0].text, /изображении 1 — эталон/);
});

test('503 → следующая модель; найденная сохраняется в GEMINI_MODEL', () => {
  state.fetchCalls = [];
  state.fetchHandler = (url, opt, n) => (n === 1 ? apiResponse(503, 'high demand') : geminiOk({
    verdict: 'ok', confidence: 0.8,
    items: [{ criterion: 'Стойка', level: 'ok', comment: 'сухо' }],
  }));
  props.delete('GEMINI_MODEL');
  const res = sandbox.geminiPhotoCheck_('k', 'Бар 1 этаж', null, BLOB, null);
  assert.equal(res.model, 'gemini-3.8-flash');
  assert.equal(props.get('GEMINI_MODEL'), 'gemini-3.8-flash');
});

test('429 → ошибка квоты, без перебора', () => {
  state.fetchCalls = [];
  state.fetchHandler = () => apiResponse(429, 'quota');
  props.delete('GEMINI_MODEL');
  assert.throws(() => sandbox.geminiPhotoCheck_('k', 'Бар 1 этаж', null, BLOB, null), /429/);
  assert.equal(state.fetchCalls.length, 1);
});

test('все модели 404 → ошибка', () => {
  state.fetchCalls = [];
  state.fetchHandler = () => apiResponse(404, 'not found');
  props.delete('GEMINI_MODEL');
  assert.throws(() => sandbox.geminiPhotoCheck_('k', 'Бар 1 этаж', null, BLOB, null), /404/);
});

test('сеть упала → повтор с превью 512px и успех', () => {
  state.fetchCalls = [];
  state.driveFiles.set('photo1', { bytes: [1, 2, 3], thumb: [7, 7, 7], mime: 'image/jpeg' });
  state.fetchHandler = (url, opt, n) => {
    if (n === 1) throw new Error('Timeout');
    return geminiOk({
      verdict: 'ok', confidence: 0.85,
      items: [{ criterion: 'Стойка', level: 'ok', comment: 'сухо' }],
    });
  };
  props.delete('GEMINI_MODEL');
  const res = sandbox.geminiPhotoCheck_('k', 'Бар 1 этаж', null, BLOB, 'photo1');
  assert.equal(res.model, 'gemini-flash-lite-latest');
  const smaller = JSON.parse(state.fetchCalls[1].options.payload).contents[0].parts;
  assert.equal(Buffer.from(smaller[smaller.length - 1].inline_data.data, 'base64').toString('hex'), '070707');
});

test('невалидный JSON от Gemini → invalid, а не исключение', () => {
  state.fetchCalls = [];
  state.fetchHandler = () => apiResponse(200, { candidates: [{ content: { parts: [{ text: 'я не понял фото' }] } }] });
  props.delete('GEMINI_MODEL');
  const res = sandbox.geminiPhotoCheck_('k', 'Бар 1 этаж', null, BLOB, null);
  assert.equal(res.invalid, true);
  assert.match(res.reason, /не JSON/);
});

// ---------- 5. Лист: колонки, запись, чтение ----------
test('колонки M–R создаются один раз и не дублируются', () => {
  const sheet = new FakeSheet(PHOTO_HEADERS);
  const cols = sandbox.ensurePhotoColumns_(sheet);
  assert.deepEqual(
    [cols.verdict, cols.confidence, cols.notes, cols.model, cols.checkedAt, cols.reference],
    [13, 14, 15, 16, 17, 18],
  );
  assert.equal(sheet.get(1, 13), 'вердикт');
  assert.equal(sheet.get(1, 18), 'эталон');
  const again = sandbox.ensurePhotoColumns_(sheet);
  assert.equal(again.verdict, 13);
  assert.equal(sheet.getLastColumn(), 18);
});

test('вердикт пишется в H/I и M–R', () => {
  const sheet = new FakeSheet(PHOTO_HEADERS, [[
    new Date('2026-11-22T20:40:00Z'), 'Тест', 'Бар 1 этаж', 'Открыть фото', '', new Date(), "'id-1",
    '', '', '', '', 'file-1',
  ]]);
  const v = {
    level: 'warn', confidence: 0.82,
    notes: 'warn: пустая бутылка слева',
    model: 'gemini-flash-lite-latest',
    checkedAt: new Date('2026-11-22T20:41:00Z'),
    reference: 'нет', error: '', items: [],
  };
  sandbox.writePhotoVerdict_(sheet, 2, v);
  assert.equal(sheet.get(2, 8), '⚠ Замечания');
  assert.equal(String(sheet.get(2, 9)).replace(/^'/, ''), 'warn: пустая бутылка слева');
  assert.equal(sheet.get(2, 13), 'warn');
  assert.equal(sheet.get(2, 14), 0.82);
  assert.equal(String(sheet.get(2, 15)).replace(/^'/, ''), 'warn: пустая бутылка слева');
  assert.equal(sheet.get(2, 16), 'gemini-flash-lite-latest');
  assert.equal(typeof sheet.get(2, 17).getTime, 'function');
  assert.equal(sheet.get(2, 18), 'нет');
});

test('не проверено пишется в колонку вердикта и в причину', () => {
  const sheet = new FakeSheet(PHOTO_HEADERS, [[new Date(), 'Тест', 'Бар 1 этаж', '', '', new Date(), "'id-2", '', '', '', '', 'file-2']]);
  sandbox.writePhotoVerdict_(sheet, 2, sandbox.photoUnchecked_('Gemini HTTP 503', null));
  assert.equal(sheet.get(2, 8), '❓ Не проверено');
  assert.equal(sheet.get(2, 13), 'не проверено');
  assert.match(String(sheet.get(2, 15)), /503/);
});

test('история: последние сверху, без имени сотрудника', () => {
  state.photoSheet = new FakeSheet(PHOTO_FULL_HEADERS, [
    [new Date('2026-11-22T20:00:00Z'), 'Иван', 'Бар 1 этаж', '', '', new Date(), 'id-1', '✅ Чисто', '', '', '', 'f1', 'ok', 0.9, '', 'm', new Date('2026-11-22T20:01:00Z'), 'нет'],
    [new Date('2026-11-22T21:00:00Z'), 'Пётр', 'Кофемашина', '', '', new Date(), 'id-2', '⛔ Критично', '', '', '', 'f2', 'crit', 0.8, 'crit: грязно', 'm', new Date('2026-11-22T21:01:00Z'), 'нет'],
  ]);
  state.refsSheet = null;
  const res = sandbox.getPhotoHistory_(10);
  assert.equal(res.ok, true);
  assert.equal(res.photos.length, 2);
  assert.equal(res.photos[0].id, 'id-2');
  assert.equal(res.photos[0].zone, 'Кофемашина');
  assert.equal(res.photos[0].level, 'crit');
  assert.equal(res.photos[0].notes, 'crit: грязно');
  assert.equal(res.photos[0].employee, undefined);
});

test('вердикт по ID находится; чужой ID → ошибка', () => {
  state.photoSheet = new FakeSheet(PHOTO_FULL_HEADERS, [
    [new Date('2026-11-22T20:00:00Z'), 'Иван', 'Бар 1 этаж', '', '', new Date(), 'id-1', '✅ Чисто', '', '', '', 'f1', 'ok', 0.9, '', 'm', new Date(), 'нет'],
  ]);
  const res = sandbox.getPhotoVerdict_('id-1');
  assert.equal(res.ok, true);
  assert.equal(res.photo.level, 'ok');
  assert.equal(res.photo.zone, 'Бар 1 этаж');
  assert.equal(sandbox.getPhotoVerdict_('nope').ok, false);
});

test('эталоны читаются по зоне; ссылка сохраняется', () => {
  state.refsSheet = new FakeSheet(
    ['Зона (как в «Списки», столбец B)', 'Что проверять (ИИ читает это описание)', 'Эталонное фото (ссылка на Google Диск)'],
    [['Бар 1 этаж', 'Стойка сухая. Коврики чистые.', 'https://drive.google.com/file/d/ABC123456789012345678/view']],
  );
  const refs = sandbox.photoRefs_({ getSheetByName: (n) => (n === 'Эталоны уборки' ? state.refsSheet : null) });
  const ref = sandbox.photoRefFor_(refs, 'бар 1 ЭТАЖ');
  assert.ok(ref);
  assert.equal(ref.what, 'Стойка сухая. Коврики чистые.');
  assert.equal(ref.fileId, 'ABC123456789012345678');
  assert.match(ref.url, /ABC123456789012345678/);
});

// ---------- итог ----------
let failed = 0;
for (const [status, name] of results) {
  if (status === 'OK') console.log('✓ ' + name);
  else { failed++; console.error('✗ ' + name); }
}
console.log(`\n${results.length - failed} из ${results.length} тестов прошли`);
if (failed) process.exit(1);
