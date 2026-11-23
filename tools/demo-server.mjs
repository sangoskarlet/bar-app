// =====================================================================
//  МОК-СЕРВЕР ТОЛЬКО ДЛЯ ЛОКАЛЬНОЙ ПРОВЕРКИ И СКРИНШОТОВ
//
//  Зачем: показать приложение с выключенными разделами и с парой мяты
//  без изменения боевой таблицы. Не часть приложения, на GitHub Pages
//  не попадает (лежит в tools/), на боевой бэкенд не влияет.
//
//  Запуск: node tools/demo-server.mjs  (порт 8799)
//  Управление флагами: GET /__state?quiz=off&duel=off&pairs=off
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
    inventory: true, ttk: true, transfer: true, writeoff: true,
  },
  pairsOn: true,
  posts: [],
};

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
    ],
    reasons: ['Бой', 'Порча', 'Пролив'],
    zones: ['Бар 1 этаж', 'Раковины'],
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
          return json(res, { ok: true, results: (b.records || []).map(r => ({ id: r.id, status: 'saved' })) });
        }
        return json(res, { ok: true });
      }
      const action = url.searchParams.get('action') || '';
      if (action === 'config') return json(res, config());
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
