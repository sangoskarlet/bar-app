// =====================================================================
//  МОК-СЕРВЕР ТОЛЬКО ДЛЯ ЛОКАЛЬНОЙ ПРОВЕРКИ И СКРИНШОТОВ
//
//  Зачем: показать приложение с выключенными разделами и с парой мяты
//  без изменения боевой таблицы. Не часть приложения, на GitHub Pages
//  не попадает (лежит в tools/), на боевой бэкенд не влияет.
//
//  Запуск: node tools/demo-server.mjs  (порт 8799)
//  Управление флагами: GET /__state?quiz=off&duel=off&pairs=off&stoplist=off
//  Журнал POST-запросов: GET /__log
// =====================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8799);

const state = {
  features: {
    quiz: true, duel: true, checklists: true, acts: true, photo: true,
    stoplist: true, inventory: true, ttk: true, transfer: true, writeoff: true,
  },
  pairsOn: true,
  posts: [],
  photoRuns: {},      // runId → сколько кадров уже «проверено» (демо)
  photoUndef: false,  // второй кадр прохода — «зона не определена» (для скриншота)
};

const DEMO_ZONES = { '1': ['Бар', 'Холодильники', 'За баром'], '2': ['Окно', 'Дверь', 'Склад'] };
const DEMO_NOTES = {
  ok: '',
  warn: 'warn: пустая бутылка у правого края стойки',
  crit: 'crit: грязная посуда на стойке слева',
  unclear: 'зона не определена',
};

/** Вердикт демо-проверки: зона из списка этажа + уровень по номеру кадра. */
function demoPhotoVerdict(r, idx) {
  const floor = String(r.floor || '1');
  const zones = DEMO_ZONES[floor] || DEMO_ZONES['1'];
  const manual = !!r.zone && r.zone !== 'стоп-лист';
  const undefinedZone = !manual && state.photoUndef && idx === 1;
  const zone = manual ? r.zone : (undefinedZone ? 'зона не определена' : zones[idx % zones.length]);
  const levels = ['ok', 'warn', 'crit'];
  const level = zone === 'зона не определена' ? 'unclear' : levels[idx % levels.length];
  const zoneConfidence = zone === 'зона не определена' ? 0.42 : 0.86;
  return {
    level, verdict: level, confidence: zone === 'зона не определена' ? null : 0.84,
    notes: DEMO_NOTES[level] || '',
    issues: DEMO_NOTES[level] || '',
    items: level === 'ok' ? [{ criterion: 'Стойка', level: 'ok', comment: 'сухо и пусто' }] : [],
    model: 'gemini-flash-lite-latest',
    checkedAt: new Date().toISOString(),
    reference: '', references: [], error: '',
    zone, zoneAuto: !manual, zoneConfidence, floor, runId: String(r.runId || ''),
  };
}

/** Демо-история: одна смена с тремя кадрами и один старый одиночный снимок. */
function demoPhotos() {
  const at = n => new Date(Date.now() - n * 60000).toISOString();
  return [
    { id: 'demo-run-1-a', at: at(8), zone: 'Бар', level: 'ok', verdict: 'ok', notes: '',
      floor: '1', runId: 'demo-run-1', zoneAuto: true, zoneConfidence: 0.91, model: 'gemini-flash-lite-latest' },
    { id: 'demo-run-1-b', at: at(7), zone: 'Холодильники', level: 'warn', verdict: 'warn',
      notes: 'warn: липкий след на полке', floor: '1', runId: 'demo-run-1', zoneAuto: true, zoneConfidence: 0.82,
      model: 'gemini-flash-lite-latest' },
    { id: 'demo-run-1-c', at: at(6), zone: 'За баром', level: 'crit', verdict: 'crit',
      notes: 'crit: коробка и тряпка на полу', floor: '1', runId: 'demo-run-1', zoneAuto: true, zoneConfidence: 0.79,
      model: 'gemini-flash-lite-latest' },
    { id: 'demo-run-1-stop', at: at(5), zone: 'Стоп-лист', level: 'stoplist', verdict: 'стоп-лист',
      notes: 'в стопе: 5, из них по остатку 0: 1, остатки: 4, кухня отсечена: 3', floor: '1',
      runId: 'demo-run-1', zoneAuto: false, zoneConfidence: null, model: 'gemini-flash-lite-latest' },
    { id: 'demo-old-1', at: at(1500), zone: 'Окно', level: 'ok', verdict: 'ok', notes: '',
      floor: '2', runId: '', zoneAuto: false, zoneConfidence: null, model: 'gemini-flash-lite-latest' },
  ];
}

/** Дни назад в формате «2026-11-24» (для демо-стоп-листа). */
function dayAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Позиция демо-стоп-листа: дни, отрезки, теги. */
function demoStopItem(o) {
  const days = o.days || 0;
  const streaks = o.streaks || (days ? [{ from: o.since, to: dayAgo(0), days: days, gaps: o.gaps || 0 }] : []);
  return {
    name: o.name, canonical: o.canonical === undefined ? o.name : o.canonical,
    inCatalog: o.canonical === undefined ? true : !!o.canonical,
    fromStock: !!o.fromStock,
    days: days, since: o.since || '', span: o.span || days, gaps: o.gaps || 0,
    long: !!o.long, streaks: streaks,
    wasCrossed: !!o.wasCrossed, removedAt: o.removedAt || '',
    premature: o.premature || null, returned: !!o.returned,
    lastReturnAt: o.lastReturnAt || '', totalDays: o.totalDays || days,
    lastSeen: o.lastSeen || dayAgo(0), records: o.records || days,
  };
}

/**
 * Демо-стоп-лист: два этажа, долгожитель, возврат после «убрали»,
 * позиция не из справочника, одна позиция пришла из нулевого остатка.
 */
function demoStopList(withHistory) {
  const f1current = [
    demoStopItem({
      name: '0,3 Курпфайц нефильтрованное', days: 4, since: dayAgo(3), long: true,
      totalDays: 4, records: 4,
    }),
    demoStopItem({
      name: 'Вишневка 40мл', days: 2, since: dayAgo(1), totalDays: 2, records: 2,
    }),
    demoStopItem({
      name: 'Просекко', days: 1, since: dayAgo(0), totalDays: 3, records: 4,
      wasCrossed: true, removedAt: dayAgo(1), returned: true, lastReturnAt: dayAgo(0),
      premature: { removedAt: dayAgo(1), returnedAt: dayAgo(0), gapDays: 1, beforeDays: 2 },
      streaks: [{ from: dayAgo(3), to: dayAgo(2), days: 2, gaps: 0 }, { from: dayAgo(0), to: dayAgo(0), days: 1, gaps: 0 }],
    }),
    demoStopItem({ name: 'Саке', canonical: '', days: 1, since: dayAgo(0), totalDays: 1, records: 1 }),
    demoStopItem({
      name: 'бут.Сидр Эйбрахолс яблочный сух.', fromStock: true,
      days: 1, since: dayAgo(0), totalDays: 1, records: 1,
    }),
  ];
  const f2current = [
    demoStopItem({ name: 'бут. Лондон Прайд', days: 3, since: dayAgo(2), totalDays: 3, records: 3 }),
    demoStopItem({ name: 'Торт Три Шоколада', days: 1, since: dayAgo(0), totalDays: 1, records: 1 }),
  ];

  const makeFloor = (floor, current) => ({
    floor: floor,
    label: floor === '1' ? '1 этаж' : '2 этаж',
    current: current,
    long: current.filter(p => p.long),
    premature: current.filter(p => p.premature),
    missingCatalog: current.filter(p => !p.inCatalog),
    returned: current.filter(p => p.returned),
    noData: floor === '2' ? [{ day: dayAgo(1), time: '23:40', reason: 'квота Gemini (429)', employee: 'Анна' }] : [],
    issuesCount: current.filter(p => p.long).length + current.filter(p => p.premature).length +
      current.filter(p => !p.inCatalog).length + (floor === '2' ? 1 : 0),
    totals: {
      positions: current.length, inStop: current.length, daysWithData: 4,
      photos: 6, photoShots: 4, manual: 1, unreadable: floor === '2' ? 1 : 0, lastDay: dayAgo(0),
    },
  });

  const floors = [makeFloor('1', f1current), makeFloor('2', f2current)];
  const out = {
    ok: true,
    today: dayAgo(0),
    updatedAt: new Date().toISOString(),
    settings: {
      longDays: 3, prematureDays: 2, historyDays: 30, gapBreaks: false,
      checks: { long: true, premature: true, catalog: true, data: true },
    },
    floors: floors,
    summary: floors.map(f => ({ floor: f.floor, label: f.label, inStop: f.current.length, long: f.long.length, issues: f.issuesCount })),
    totals: { floors: 2, positions: 7, inStop: 7, photos: 12, manual: 1, unreadable: 1 },
  };
  if (withHistory) {
    out.history = {
      '1': {
        '0,3 Курпфайц нефильтрованное': [0, 1, 2, 3].map(n => ({ day: dayAgo(n), crossed: false, source: 'фото', name: '0,3 Курпфайц нефильтрованное' })),
        'Вишневка 40мл': [0, 1].map(n => ({ day: dayAgo(n), crossed: false, source: 'фото', name: 'Вишневка 40мл' })),
        'Просекко': [
          { day: dayAgo(3), crossed: false, source: 'фото', name: 'Просекко' },
          { day: dayAgo(2), crossed: false, source: 'фото', name: 'Просекко' },
          { day: dayAgo(1), crossed: true, source: 'фото', name: 'Просекко' },
          { day: dayAgo(0), crossed: false, source: 'фото', name: 'Просекко' },
        ],
        'Саке': [{ day: dayAgo(0), crossed: false, source: 'ручной ввод', name: 'Саке' }],
        'бут.Сидр Эйбрахолс яблочный сух.': [{ day: dayAgo(0), crossed: false, source: 'фото', name: 'бут.Сидр Эйбрахолс яблочный сух.' }],
        'Апероль': [
          { day: dayAgo(6), crossed: false, source: 'фото', name: 'Апероль' },
          { day: dayAgo(7), crossed: false, source: 'фото', name: 'Апероль' },
        ],
      },
      '2': {
        'бут. Лондон Прайд': [0, 1, 2].map(n => ({ day: dayAgo(n), crossed: false, source: 'фото', name: 'бут. Лондон Прайд' })),
        'Торт Три Шоколада': [{ day: dayAgo(0), crossed: false, source: 'фото', name: 'Торт Три Шоколада' }],
      },
    };
  }
  return out;
}


const acts = [
  {
    name: 'Мята — очистка', type: 'простой', output: { item: 'Мята (листья)', unit: 'г', qty: 0 },
    inputs: [{ item: 'Мята', unit: 'г', qty: 0, key: true, fixed: false, clean: false }],
  },
  {
    name: 'Лимонный фреш', type: 'простой', output: { item: 'Лимонный сок ПФ', unit: 'г', qty: 0 },
    inputs: [{ item: 'Лимоны', unit: 'г', qty: 0, key: true, fixed: false, clean: false }],
  },
  {
    name: 'Заготовка Морса', type: 'по рецепту', output: { item: 'Заготовка Морса', unit: 'г', qty: 0 },
    inputs: [
      { item: 'Клюква с/м', unit: 'г', qty: 800, key: true, fixed: false, clean: false },
      { item: 'Сахар песок', unit: 'г', qty: 400, key: false, fixed: false, clean: false },
      { item: 'Вода', unit: 'мл', qty: 500, key: false, fixed: false, clean: false },
    ],
  },
];

function config() {
  return {
    ok: true,
    theme: 'обычное',
    employees: ['Анна'],
    items: [
      { name: 'Мята', unit: 'г', category: 'Зелень' },
      { name: 'Лимоны', unit: 'г', category: 'Фрукты' },
      { name: 'Джин Монки 47', unit: 'мл', category: 'Крепкий алкоголь' },
      { name: 'Просекко', unit: 'мл', category: 'Игристое' },
      { name: 'Апероль', unit: 'мл', category: 'Ликёр' },
      { name: 'Саке', unit: 'мл', category: 'Крепкий алкоголь' },
      { name: 'Лайм', unit: 'шт', category: 'Фрукты' },
      { name: 'Клюква', unit: 'г', category: 'Ягоды' },
      { name: 'Сливки', unit: 'мл', category: 'Молочное' },
      { name: 'Тоник', unit: 'мл', category: 'Безалкогольное' },
    ],
    reasons: ['Бой', 'Порча', 'Пролив'],
    zones: ['Окно', 'Дверь', 'Склад', 'Бар', 'Холодильники', 'За баром'],
    // Фото уборки: 6 утверждённых зон и этажи — как отдаёт бэкенд после 16.
    photoZones: [
      { zone: 'Окно', floor: '2' },
      { zone: 'Дверь', floor: '2' },
      { zone: 'Склад', floor: '2' },
      { zone: 'Бар', floor: '1' },
      { zone: 'Холодильники', floor: '1' },
      { zone: 'За баром', floor: '1' },
    ],
    photoRefs: [
      { zone: 'Окно', floor: '2', active: 0, total: 0 },
      { zone: 'Дверь', floor: '2', active: 0, total: 0 },
      { zone: 'Склад', floor: '2', active: 0, total: 0 },
      { zone: 'Бар', floor: '1', active: 1, total: 1 },
      { zone: 'Холодильники', floor: '1', active: 0, total: 0 },
      { zone: 'За баром', floor: '1', active: 0, total: 0 },
    ],
    photoRefLimit: 3,
    ttk: [
      { name: 'Хуго', category: 'Игристое', glass: 'Винный', method: 'Билд', ingredients: ['Просекко 100', 'Бузина 20'], garnish: 'Мята', notes: '', photoId: '' },
    ],
    inventory: { active: 'Ноябрь', locations: ['Склад'], giftLocations: ['Кабинет'], items: [] },
    acts,
    shelfLife: [
      { name: 'Мята (листья)', short: '', hours: 24, note: '' },
      { name: 'Заготовка Морса', short: 'Морс', hours: 48, note: '' },
    ],
    factOfDay: { id: 'f1', text: 'В 1806 году «коктейль» впервые определили как смесь спиртного, сахара, воды и биттеров.', source: 'The Balance, 13.05.1806' },
    checklists: [
      { name: 'Открытие бара', items: [
        { text: 'Протереть витрину', hint: 'Без разводов', photo: false },
        { text: 'Проверить запас льда', hint: 'Лёдница полная', photo: false },
      ] },
      { name: 'Закрытие бара', items: [
        { text: 'Вынести мусор', hint: 'Пакеты заменены', photo: false },
      ] },
    ],
    features: { ...state.features },
    pairs: state.pairsOn ? [
      { a: 'Мята (листья)', b: 'Мята (ветки)', comment: 'демо: вычитание из общего веса' },
    ] : [],
    stopList: demoStopList(false),
    directions: ['Кухня → Бар', 'Бар → Кухня'],
    units: ['г', 'мл', 'шт', 'кг', 'л'],
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
};

function json(res, obj, code = 200) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/exec') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST') {
        let b = {};
        try { b = JSON.parse(body || '{}'); } catch (e) { b = {}; }
        state.posts.push({ at: new Date().toISOString(), action: b.action, body: b });
        console.log('[POST]', b.action, b.list || b.act || '');
        if (b.action === 'login') return json(res, { ok: true, name: b.name, role: 'бармен' });
        if (b.action === 'checklistSave') {
          return json(res, { ok: true, duplicate: false, results: [{ id: b.id, status: 'saved' }] });
        }
        if (b.action === 'submit') {
          // Снимок стоп-листа: отдаём то, что «распознала» модель (обе
          // колонки), чтобы экран результата было на чём проверить.
          const results = (b.records || []).map(r => {
            if (r.type === 'photo' && (r.stopList === true || r.zone === 'Стоп-лист')) {              const floor = String(r.floor || '1');
              return {
                id: r.id, status: 'saved',
                verdict: {
                  level: 'stoplist', verdict: 'стоп-лист', confidence: null,
                  notes: 'стоп-лист: 13, остатки: 8, недочётов: 2',
                  items: [], model: 'gemini-flash-lite-latest',
                  checkedAt: new Date().toISOString(), reference: '', references: [], error: '',
                },
                stoplist: {
                  ok: true, reason: '', unreadable: '', model: 'gemini-flash-lite-latest',
                  day: dayAgo(0), floor: floor,
                  summary: 'в стопе: 5, из них по остатку 0: 1, остатки: 4, кухня отсечена: 3',
                  stop: [
                    { name: '0,3 Курпфайц нефильтрованное', canonical: '', inCatalog: false, origin: 'stop' },
                    { name: '0,5 Курпфайц нефильтрованное', canonical: '', inCatalog: false, origin: 'stop' },
                    { name: 'бут. Бридог ИПА 0,33', canonical: '', inCatalog: false, origin: 'stop' },
                    { name: 'Вишневка 40мл', canonical: '', inCatalog: false, origin: 'stop' },
                    { name: 'бут.Сидр Эйбрахолс яблочный сух.', canonical: '', inCatalog: false, origin: 'stock' },
                  ],
                  stock: [
                    { name: '0,150 Домен Брюне Шинон', qty: 3 },
                    { name: 'бут.Сидр Эйбрахолс яблочный сух.', qty: 0 },
                    { name: 'Штрудель Яблочный', qty: 4 },
                    { name: 'Настойка черная смородина 40мл', qty: 7 },
                  ],
                  excluded: [
                    'Комментарий на бар',
                    'Равиоли с лососем',
                    'Чиз-кейк "Нью-Йорк"',
                  ],
                },
              };
            }
            if (r.type === 'photo') {
              // Новый поток: зона «определяется» по этажу, кадры идут по порядку.
              state.photoRuns[r.runId] = (state.photoRuns[r.runId] || 0) + 1;
              const idx = state.photoRuns[r.runId] - 1;
              return { id: r.id, status: 'saved', verdict: demoPhotoVerdict(r, idx) };
            }
            return { id: r.id, status: 'saved' };
          });
          return json(res, { ok: true, results });
        }
        if (b.action === 'photoRecheck') {
          // Ручная смена зоны: перепроверяем «по критериям новой зоны».
          const floor = String(b.floor || '1');
          const zones = DEMO_ZONES[floor] || DEMO_ZONES['1'];
          if (!zones.includes(b.zone)) return json(res, { ok: false, error: 'Такой зоны нет в таблице зон' });
          const level = b.zone === 'Бар' ? 'ok' : 'warn';
          return json(res, {
            ok: true,
            photo: {
              level, verdict: level, confidence: 0.8,
              notes: level === 'ok' ? '' : 'warn: ведро стоит не на месте',
              issues: level === 'ok' ? '' : 'warn: ведро стоит не на месте',
              items: [], model: 'gemini-flash-lite-latest',
              checkedAt: new Date().toISOString(), reference: '', references: [], error: '',
              zone: b.zone, zoneAuto: false, zoneConfidence: null, floor, runId: String(b.runId || ''),
            },
          });
        }
        return json(res, { ok: true });
      }
      const action = url.searchParams.get('action') || '';
      if (action === 'config') return json(res, config());
      if (action === 'stopList') return json(res, demoStopList(true));
      if (action === 'openActs') return json(res, { ok: true, acts: [] });
      if (action === 'photos') return json(res, { ok: true, photos: demoPhotos() });
      if (action === 'questions') return json(res, { ok: true, questions: [], version: 'demo' });
      if (action === 'ping') return json(res, { ok: true });
      return json(res, { ok: true });
    });
    return;
  }

  if (url.pathname === '/__state') {
    for (const [k, v] of url.searchParams.entries()) {
      if (k === 'pairs') state.pairsOn = v !== 'off';
      else if (k === 'photoundef') state.photoUndef = v !== '0';
      else if (k === 'resetphotos') { state.photoRuns = {}; state.photoUndef = false; }
      else if (k in state.features) state.features[k] = v !== 'off';
    }
    return json(res, { ok: true, features: state.features, pairsOn: state.pairsOn, photoUndef: state.photoUndef });
  }
  if (url.pathname === '/__log') return json(res, { ok: true, posts: state.posts });
  if (url.pathname === '/__clear-log') { state.posts = []; return json(res, { ok: true }); }

  if (url.pathname === '/config.js') {
    const src = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
    res.setHeader('Content-Type', MIME['.js']);
    res.setHeader('Cache-Control', 'no-store');
    res.end(src.replace(/export const API_URL = '[^']*';/, `export const API_URL = 'http://127.0.0.1:${PORT}/exec';`));
    return;
  }
  if (url.pathname === '/sw.js') {
    res.setHeader('Content-Type', MIME['.js']);
    res.setHeader('Cache-Control', 'no-store');
    res.end('/* demo: service worker отключён */');
    return;
  }

  let file = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) { res.statusCode = 403; res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`demo on http://127.0.0.1:${PORT}`));
