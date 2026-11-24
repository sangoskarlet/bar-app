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
};

/** Дни назад в формате «2026-11-24» (для демо-стоп-листа). */
function dayAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Демо-стоп-лист: долгожитель, скорое возвращение, позиция не из справочника. */
function demoStopList(withHistory) {
  const current = [
    {
      name: 'Джин Монки 47', canonical: 'Джин Монки 47', inCatalog: true,
      days: 4, since: dayAgo(3), span: 4, gaps: 0, long: true, streaks: [{ from: dayAgo(3), to: dayAgo(0), days: 4, gaps: 0 }],
      wasCrossed: false, removedAt: '', premature: null, returned: false,
      lastReturnAt: '', totalDays: 4, lastSeen: dayAgo(0), records: 4,
    },
    {
      name: 'Лимоны', canonical: 'Лимоны', inCatalog: true,
      days: 2, since: dayAgo(1), span: 2, gaps: 0, long: false, streaks: [{ from: dayAgo(1), to: dayAgo(0), days: 2, gaps: 0 }],
      wasCrossed: false, removedAt: '', premature: null, returned: false,
      lastReturnAt: '', totalDays: 2, lastSeen: dayAgo(0), records: 2,
    },
    {
      name: 'Просекко', canonical: 'Просекко', inCatalog: true,
      days: 1, since: dayAgo(0), span: 1, gaps: 0, long: false, streaks: [{ from: dayAgo(3), to: dayAgo(2), days: 2, gaps: 0 }, { from: dayAgo(0), to: dayAgo(0), days: 1, gaps: 0 }],
      wasCrossed: true, removedAt: dayAgo(1),
      premature: { removedAt: dayAgo(1), returnedAt: dayAgo(0), gapDays: 1, beforeDays: 2 },
      returned: true, lastReturnAt: dayAgo(0), totalDays: 3, lastSeen: dayAgo(0), records: 4,
    },
    {
      name: 'Саке', canonical: '', inCatalog: false,
      days: 1, since: dayAgo(0), span: 1, gaps: 0, long: false, streaks: [{ from: dayAgo(0), to: dayAgo(0), days: 1, gaps: 0 }],
      wasCrossed: false, removedAt: '', premature: null, returned: false,
      lastReturnAt: '', totalDays: 1, lastSeen: dayAgo(0), records: 1,
    },
  ];
  const out = {
    ok: true,
    today: dayAgo(0),
    updatedAt: new Date().toISOString(),
    settings: {
      longDays: 3, prematureDays: 2, historyDays: 30,
      checks: { long: true, premature: true, catalog: true, data: true },
    },
    current,
    long: current.filter(p => p.long),
    premature: current.filter(p => p.premature),
    missingCatalog: current.filter(p => !p.inCatalog),
    returned: current.filter(p => p.returned),
    noData: [{ day: dayAgo(1), time: '23:40', reason: 'квота Gemini (429)', employee: 'Анна' }],
    totals: { positions: 5, inStop: 4, daysWithData: 5, photos: 8, photoShots: 5, manual: 1, unreadable: 1, lastDay: dayAgo(0) },
  };
  if (withHistory) {
    out.history = {
      'Джин Монки 47': [0, 1, 2, 3].map(n => ({ day: dayAgo(n), crossed: false, source: 'фото', name: 'Джин Монки 47' })),
      'Лимоны': [0, 1].map(n => ({ day: dayAgo(n), crossed: false, source: 'фото', name: 'Лимоны' })),
      'Просекко': [
        { day: dayAgo(3), crossed: false, source: 'фото', name: 'Просекко' },
        { day: dayAgo(2), crossed: false, source: 'фото', name: 'Просекко' },
        { day: dayAgo(1), crossed: true, source: 'фото', name: 'Просекко' },
        { day: dayAgo(0), crossed: false, source: 'фото', name: 'Просекко' },
      ],
      'Саке': [{ day: dayAgo(0), crossed: false, source: 'ручной ввод', name: 'Саке' }],
      'Апероль': [
        { day: dayAgo(6), crossed: false, source: 'фото', name: 'Апероль' },
        { day: dayAgo(7), crossed: false, source: 'фото', name: 'Апероль' },
      ],
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
      { a: 'Мята (листья)', b: 'Мята (ветки)', shareA: 0.6, shareB: 0.4, comment: 'демо' },
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
          // Снимок стоп-листа: отдаём то, что «распознала» модель, чтобы
          // экран результата было на чём проверить.
          const results = (b.records || []).map(r => {
            if (r.type === 'photo' && (r.stopList === true || r.zone === 'Стоп-лист')) {
              return {
                id: r.id, status: 'saved',
                verdict: {
                  level: 'stoplist', verdict: 'стоп-лист', confidence: 0.88,
                  notes: 'распознано позиций: 3, перечёркнуто: 1, нет в справочнике: 1',
                  items: [], model: 'gemini-flash-lite-latest',
                  checkedAt: new Date().toISOString(), reference: '', references: [], error: '',
                },
                stoplist: {
                  ok: true, reason: '', unreadable: '', model: 'gemini-flash-lite-latest',
                  confidence: 0.88, day: dayAgo(0),
                  summary: 'распознано позиций: 3, перечёркнуто: 1, нет в справочнике: 1',
                  items: [
                    { name: 'джин монки', canonical: 'Джин Монки 47', inCatalog: true, crossedOut: false, confidence: 0.94, note: '' },
                    { name: 'Просеко', canonical: 'Просекко', inCatalog: true, crossedOut: true, confidence: 0.81, note: '' },
                    { name: 'Саке', canonical: '', inCatalog: false, crossedOut: false, confidence: 0.62, note: 'нет в справочнике' },
                  ],
                },
              };
            }
            return { id: r.id, status: 'saved' };
          });
          return json(res, { ok: true, results });
        }
        return json(res, { ok: true });
      }
      const action = url.searchParams.get('action') || '';
      if (action === 'config') return json(res, config());
      if (action === 'stopList') return json(res, demoStopList(true));
      if (action === 'openActs') return json(res, { ok: true, acts: [] });
      if (action === 'photos') return json(res, { ok: true, photos: [] });
      if (action === 'questions') return json(res, { ok: true, questions: [], version: 'demo' });
      if (action === 'ping') return json(res, { ok: true });
      return json(res, { ok: true });
    });
    return;
  }

  if (url.pathname === '/__state') {
    for (const [k, v] of url.searchParams.entries()) {
      if (k === 'pairs') state.pairsOn = v !== 'off';
      else if (k in state.features) state.features[k] = v !== 'off';
    }
    return json(res, { ok: true, features: state.features, pairsOn: state.pairsOn });
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
