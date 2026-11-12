// =====================================================================
//  ИНТЕРФЕЙС ПРИЛОЖЕНИЯ
//
//  Экраны:
//    Вход        — выбор имени и PIN (нужен интернет только в первый раз)
//    Главная     — 4 плитки + полоска статуса отправки
//    Переносы    — направление, позиции из справочника, количество
//    Списания    — причина, позиции, количество
//    Фото уборки — зона, фото с камеры (сжимаются на телефоне)
//    ТТК         — список коктейлей с поиском, карточка с фото (работает офлайн)
//    Инвентаризация — место → категория → вид → позиция → полные + остаток
//    Переработка — акты: простые (было/стало) и по рецепту (ключевое → пересчёт)
//    Очередь     — что ещё не отправлено, что отклонено, история
// =====================================================================

import { SYNC_INTERVAL_MS, PHOTO_MAX_SIDE, PHOTO_QUALITY } from '../config.js';
import { db } from './db.js';
import { apiGet, apiPost, ApiError } from './api.js';
import {
  enqueue, startAutoSync, onSyncChange, getStatus, syncNow,
  listQueue, listSent, removeFromQueue, retryRejected,
} from './sync.js';
import { voiceSupported, listenOnce, voiceErrorText, parseInventoryPhrase, confident, parseCustomPhrase } from './voice.js';

const app = document.getElementById('app');
const statusEl = document.getElementById('status');

let config = null;   // справочник, списки, ТТК — с сервера (и копия на телефоне)
let session = null;  // { name, pin, role } — кто сейчас работает

// ---------------------------------------------------------------------
//  Маленький помощник для создания HTML-элементов.
//  h('button', { class: 'big', onclick: fn }, 'Текст')
//  Текст всегда вставляется как текст (не HTML) — так безопаснее.
// ---------------------------------------------------------------------
// Встроенные append/replaceChildren превращают null в текст «null».
// Убираем пустые элементы, чтобы можно было писать: условие ? кнопка : null
for (const m of ['append', 'replaceChildren']) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...kids) {
    return orig.apply(this, kids.filter(k => k !== null && k !== undefined && k !== false));
  };
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(text, kind = 'ok') {
  document.querySelectorAll('.toast').forEach(old => old.remove()); // не копим сообщения
  const t = h('div', { class: 'toast ' + kind }, text);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** «1,5» → 1.5; пустое или неправильное → NaN */
function parseQty(s) {
  const clean = String(s || '').replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(clean)) return NaN;
  return Number(clean);
}

// ---------------------------------------------------------------------
//  Навигация: стек экранов + поддержка кнопки «Назад» на Android
// ---------------------------------------------------------------------
const stack = [];
function go(screen, ...args) {
  stack.push([screen, args]);
  history.pushState({ depth: stack.length }, '');
  render();
}
function back() {
  if (stack.length > 1) history.back();
}
window.addEventListener('popstate', () => {
  if (stack.length > 1) { stack.pop(); render(); }
});
function resetTo(screen, ...args) {
  stack.length = 0;
  stack.push([screen, args]);
  render();
}
function render() {
  const [screen, args] = stack[stack.length - 1];
  app.replaceChildren(screen(...args));
  window.scrollTo(0, 0);
}

function header(title, { showBack = true } = {}) {
  return h('header', { class: 'top' },
    showBack ? h('button', { class: 'back', onclick: back, 'aria-label': 'Назад' }, '‹') : h('span'),
    h('h1', {}, title),
    h('span'),
  );
}

// ---------------------------------------------------------------------
//  Загрузка справочника и ТТК
// ---------------------------------------------------------------------
async function loadConfig() {
  const cached = await db.get('kv', 'config');
  if (cached) config = cached;
  try {
    const fresh = await apiGet({ action: 'config' });
    config = fresh;
    await db.put('kv', fresh, 'config');
    prefetchTtkPhotos(); // в фоне докачиваем фото ТТК для офлайна
  } catch (e) {
    console.warn('Справочник не обновлён:', e.message);
  }
  return config;
}

let prefetching = false;
async function prefetchTtkPhotos() {
  if (prefetching || !config) return;
  prefetching = true;
  try {
    const have = new Set(await db.keys('ttkPhotos'));
    for (const t of config.ttk) {
      if (!t.photoId || have.has(t.photoId)) continue;
      try { await fetchTtkPhoto(t.photoId); } catch (e) { /* попробуем в другой раз */ }
    }
  } finally {
    prefetching = false;
  }
}

async function fetchTtkPhoto(id) {
  const res = await apiGet({ action: 'ttkPhoto', id }, 60000);
  const dataUrl = `data:${res.mime};base64,${res.data}`;
  await db.put('ttkPhotos', dataUrl, id);
  return dataUrl;
}

// ---------------------------------------------------------------------
//  Полоска статуса внизу экрана
// ---------------------------------------------------------------------
function renderStatus(s) {
  let text, kind;
  if (s.rejected > 0) { text = `⚠ Отклонено: ${s.rejected}. Нажмите, чтобы посмотреть`; kind = 'bad'; }
  else if (s.syncing && s.pending > 0) { text = `Отправка… осталось ${s.pending}`; kind = 'wait'; }
  else if (s.pending > 0 && !s.online) { text = `Нет сети · ждут отправки: ${s.pending}`; kind = 'wait'; }
  else if (s.pending > 0) { text = `Ждут отправки: ${s.pending}. Нажмите, чтобы отправить`; kind = 'wait'; }
  else { text = s.online ? '✓ Всё отправлено' : 'Нет сети · очередь пуста'; kind = 'ok'; }
  statusEl.className = 'status ' + kind;
  statusEl.textContent = text;
  statusEl.hidden = !session;
}
statusEl.addEventListener('click', () => {
  if (!session) return;
  syncNow();
  go(screenQueue);
});

// =====================================================================
//  ЭКРАН: ВХОД
// =====================================================================
function screenLogin() {
  const wrap = h('main', { class: 'screen' }, h('header', { class: 'top' }, h('span'), h('h1', {}, 'Бар · вход'), h('span')));

  if (!config) {
    wrap.append(
      h('p', { class: 'hint' }, 'Для первого запуска нужен интернет: приложение скачает справочник и список сотрудников.'),
      h('button', { class: 'primary', onclick: async () => { await loadConfig(); resetTo(screenLogin); } }, 'Повторить'),
    );
    return wrap;
  }

  let chosen = null;
  const pinInput = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '6', placeholder: 'PIN', class: 'pin' });
  const loginBtn = h('button', { class: 'primary', disabled: true }, 'Войти');
  const names = h('div', { class: 'chips' }, config.employees.map(name =>
    h('button', {
      class: 'chip',
      onclick: (e) => {
        chosen = name;
        names.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
        e.currentTarget.classList.add('on');
        loginBtn.disabled = false;
        pinInput.focus();
      },
    }, name)));

  async function doLogin() {
    if (!chosen || !pinInput.value) return toast('Выберите имя и введите PIN', 'bad');
    loginBtn.disabled = true;
    try {
      const res = await apiPost({ action: 'login', name: chosen, pin: pinInput.value });
      session = { name: res.name, pin: pinInput.value, role: res.role };
      await db.put('kv', session, 'session');
      renderStatus(await getStatus());
      resetTo(screenHome);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Нет связи. Для входа нужен интернет.', 'bad');
      loginBtn.disabled = false;
    }
  }
  loginBtn.addEventListener('click', doLogin);
  pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  wrap.append(h('p', { class: 'label' }, 'Кто вы?'), names, pinInput, loginBtn);
  return wrap;
}

// =====================================================================
//  ЭКРАН: ГЛАВНАЯ
// =====================================================================
function screenHome() {
  const tile = (icon, title, onclick) =>
    h('button', { class: 'tile', onclick }, h('span', { class: 'icon' }, icon), h('span', {}, title));

  return h('main', { class: 'screen' },
    h('header', { class: 'top' }, h('span'), h('h1', {}, 'Бар'), h('span')),
    h('div', { class: 'who' },
      h('span', {}, 'Смена: ', h('b', {}, session.name)),
      h('button', {
        class: 'link',
        onclick: async () => {
          const s = await getStatus();
          if (s.pending > 0 && !confirm('В очереди есть неотправленные записи. Они всё равно отправятся. Сменить пользователя?')) return;
          session = null;
          await db.del('kv', 'session');
          renderStatus(s);
          resetTo(screenLogin);
        },
      }, 'Сменить'),
    ),
    h('div', { class: 'tiles' },
      tile('📦', 'Перенос', () => go(screenItemsForm, 'transfer')),
      tile('🗑', 'Списание', () => go(screenItemsForm, 'writeoff')),
      tile('📸', 'Фото уборки', () => go(screenPhoto)),
      tile('📖', 'ТТК', () => go(screenTtkList)),
      tile('📋', 'Инвентаризация', () => go(screenInventory)),
      tile('⚖️', 'Переработка', () => go(screenActs)),
    ),
  );
}

// =====================================================================
//  ЭКРАН: ПЕРЕНОС / СПИСАНИЕ (одна форма на оба случая)
// =====================================================================
function screenItemsForm(type) {
  const isTransfer = type === 'transfer';
  const form = { direction: '', reason: '', comment: '', lines: [{ item: null, qty: '' }] };

  const root = h('main', { class: 'screen' }, header(isTransfer ? 'Перенос' : 'Списание'));

  // --- Направление или причина: выбор кнопками ---
  const choices = isTransfer ? config.directions : config.reasons;
  const choiceBox = h('div', { class: 'chips' }, choices.map(c =>
    h('button', {
      class: 'chip',
      onclick: (e) => {
        if (isTransfer) form.direction = c; else form.reason = c;
        choiceBox.querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
        e.currentTarget.classList.add('on');
      },
    }, c)));

  // --- Строки с позициями ---
  const linesBox = h('div', { class: 'lines' });
  function drawLines() {
    linesBox.replaceChildren(...form.lines.map((line, i) => {
      const qty = h('input', {
        type: 'text', inputmode: 'decimal', placeholder: '0', class: 'qty', value: line.qty,
        oninput: (e) => { line.qty = e.target.value; },
      });
      return h('div', { class: 'line' },
        h('button', {
          class: 'pick' + (line.item ? '' : ' empty'),
          onclick: () => openItemPicker(item => { line.item = item; drawLines(); qtyFocus(i); }),
        }, line.item ? line.item.name : 'Выбрать позицию'),
        qty,
        h('span', { class: 'unit' }, line.item ? line.item.unit : ''),
        form.lines.length > 1
          ? h('button', { class: 'x', 'aria-label': 'Удалить строку', onclick: () => { form.lines.splice(i, 1); drawLines(); } }, '✕')
          : h('span', { class: 'x-space' }),
      );
    }));
  }
  function qtyFocus(i) { setTimeout(() => linesBox.querySelectorAll('.qty')[i]?.focus(), 50); }
  drawLines();

  const comment = h('textarea', { rows: '2', placeholder: 'Комментарий (необязательно)', oninput: e => { form.comment = e.target.value; } });
  const saveBtn = h('button', { class: 'primary' }, 'Сохранить');

  saveBtn.addEventListener('click', async () => {
    // Проверки до сохранения — чтобы в таблицу не попадал мусор
    if (isTransfer && !form.direction) return toast('Выберите направление', 'bad');
    if (!isTransfer && !form.reason) return toast('Выберите причину', 'bad');
    const filled = form.lines.filter(l => l.item || l.qty);
    if (filled.length === 0) return toast('Добавьте хотя бы одну позицию', 'bad');
    for (const l of filled) {
      if (!l.item) return toast('В одной из строк не выбрана позиция', 'bad');
      const q = parseQty(l.qty);
      if (!(q > 0)) return toast(`Проверьте количество: ${l.item.name}`, 'bad');
    }

    saveBtn.disabled = true; // защита от двойного нажатия
    for (const l of filled) {
      await enqueue({
        type,
        name: session.name,
        pin: session.pin,
        item: l.item.name,
        unit: l.item.unit,
        qty: parseQty(l.qty),
        direction: isTransfer ? form.direction : undefined,
        reason: isTransfer ? undefined : form.reason,
        comment: form.comment.trim(),
      });
    }
    toast(`Сохранено: ${filled.length} поз.`);
    resetTo(screenHome);
  });

  root.append(
    h('p', { class: 'label' }, isTransfer ? 'Направление' : 'Причина'), choiceBox,
    h('p', { class: 'label' }, 'Позиции'), linesBox,
    h('button', { class: 'secondary', onclick: () => { form.lines.push({ item: null, qty: '' }); drawLines(); } }, '+ Ещё позиция'),
    comment, saveBtn,
  );
  return root;
}

/** Выбор позиции: поиск + список по категориям + «нет в списке». */
function openItemPicker(onPick) {
  const overlay = h('div', { class: 'overlay' });
  const close = () => overlay.remove();
  const search = h('input', { type: 'search', placeholder: 'Поиск позиции…', class: 'search' });
  const list = h('div', { class: 'picker-list' });

  function draw() {
    const q = search.value.trim().toLowerCase();
    const items = config.items.filter(it => !q || it.name.toLowerCase().includes(q));
    const groups = {};
    items.forEach(it => { (groups[it.category] = groups[it.category] || []).push(it); });
    list.replaceChildren(
      ...Object.entries(groups).map(([cat, arr]) => h('div', {},
        h('p', { class: 'group' }, cat),
        ...arr.map(it => h('button', { class: 'row', onclick: () => { close(); onPick(it); } },
          h('span', {}, it.name), h('span', { class: 'muted' }, it.unit))),
      )),
      customItemBlock(),
    );
  }

  // Позиции нет в справочнике — можно ввести вручную (менеджер потом добавит её в справочник)
  function customItemBlock() {
    const name = h('input', { type: 'text', placeholder: 'Название', value: search.value.trim() });
    const unit = h('select', {}, config.units.map(u => h('option', { value: u }, u)));
    return h('div', { class: 'custom' },
      h('p', { class: 'group' }, 'Нет в списке?'),
      h('div', { class: 'custom-row' }, name, unit,
        h('button', {
          class: 'secondary',
          onclick: () => {
            const n = name.value.trim();
            if (!n) return toast('Введите название', 'bad');
            close();
            onPick({ name: n, unit: unit.value, category: 'Вручную' });
          },
        }, 'OK')));
  }

  search.addEventListener('input', draw);
  overlay.append(h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, search, h('button', { class: 'x', onclick: close, 'aria-label': 'Закрыть' }, '✕')),
    list));
  document.body.append(overlay);
  draw();
  setTimeout(() => search.focus(), 50);
}

// =====================================================================
//  ЭКРАН: ФОТО УБОРКИ
// =====================================================================
function screenPhoto() {
  const form = { zone: '', comment: '', photos: [] }; // photos: [dataURL]
  const root = h('main', { class: 'screen' }, header('Фото уборки'));

  const zones = h('div', { class: 'chips' }, config.zones.map(z =>
    h('button', {
      class: 'chip',
      onclick: (e) => {
        form.zone = z;
        zones.querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
        e.currentTarget.classList.add('on');
      },
    }, z)));

  const previews = h('div', { class: 'previews' });
  function drawPreviews() {
    previews.replaceChildren(...form.photos.map((src, i) =>
      h('div', { class: 'preview' }, h('img', { src, alt: '' }),
        h('button', { class: 'x', onclick: () => { form.photos.splice(i, 1); drawPreviews(); } }, '✕'))));
  }

  // Два поля выбора файла: с камерой и из галереи
  const camInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const galInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  async function onFiles(e) {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      try {
        form.photos.push(await compressImage(f));
      } catch (err) {
        toast('Не удалось обработать фото', 'bad');
      }
    }
    drawPreviews();
  }
  camInput.addEventListener('change', onFiles);
  galInput.addEventListener('change', onFiles);

  const comment = h('textarea', { rows: '2', placeholder: 'Комментарий (необязательно)', oninput: e => { form.comment = e.target.value; } });
  const saveBtn = h('button', { class: 'primary' }, 'Сохранить');
  saveBtn.addEventListener('click', async () => {
    if (!form.zone) return toast('Выберите зону', 'bad');
    if (form.photos.length === 0) return toast('Добавьте фото', 'bad');
    saveBtn.disabled = true;
    for (const image of form.photos) {
      await enqueue({ type: 'photo', name: session.name, pin: session.pin, zone: form.zone, image, comment: form.comment.trim() });
    }
    toast(`Сохранено фото: ${form.photos.length}`);
    resetTo(screenHome);
  });

  root.append(
    h('p', { class: 'label' }, 'Зона'), zones,
    h('p', { class: 'label' }, 'Фото'),
    h('div', { class: 'two' },
      h('button', { class: 'secondary', onclick: () => camInput.click() }, '📷 Камера'),
      h('button', { class: 'secondary', onclick: () => galInput.click() }, '🖼 Галерея')),
    camInput, galInput, previews, comment, saveBtn,
  );
  return root;
}

/**
 * Сжатие фото на телефоне: длинная сторона до 1600 px, JPEG ~72%.
 * Было 3–5 МБ, становится ~200–400 КБ. Отправка быстрее, Диск не забивается.
 */
async function compressImage(file) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  const w0 = source.width, h0 = source.height;
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w0 * scale);
  canvas.height = Math.round(h0 * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
}

// =====================================================================
//  ЭКРАН: ТТК — список и карточка
// =====================================================================
function screenTtkList() {
  const root = h('main', { class: 'screen' }, header('ТТК'));
  const search = h('input', { type: 'search', placeholder: 'Поиск по названию или ингредиенту…', class: 'search' });
  const list = h('div', {});

  function draw() {
    const q = search.value.trim().toLowerCase();
    const items = config.ttk.filter(t => !q ||
      t.name.toLowerCase().includes(q) || t.ingredients.some(i => i.toLowerCase().includes(q)));
    if (items.length === 0) { list.replaceChildren(h('p', { class: 'hint' }, 'Ничего не найдено')); return; }
    const groups = {};
    items.forEach(t => { (groups[t.category] = groups[t.category] || []).push(t); });
    list.replaceChildren(...Object.entries(groups).map(([cat, arr]) => h('div', {},
      h('p', { class: 'group' }, cat),
      ...arr.map(t => h('button', { class: 'row', onclick: () => go(screenTtkCard, t) },
        h('span', {}, t.name), h('span', { class: 'muted' }, t.glass || ''))))));
  }
  search.addEventListener('input', draw);
  draw();
  root.append(search, list);
  return root;
}

function screenTtkCard(t) {
  const photo = h('div', { class: 'ttk-photo' }, t.photoId ? 'Загрузка фото…' : 'Нет фото');
  if (t.photoId) {
    (async () => {
      let src = await db.get('ttkPhotos', t.photoId);
      if (!src) {
        try { src = await fetchTtkPhoto(t.photoId); } catch (e) { /* нет сети */ }
      }
      photo.replaceChildren(src ? h('img', { src, alt: t.name }) : 'Фото загрузится, когда появится интернет');
    })();
  }

  const field = (label, value) => value ? h('div', { class: 'field' }, h('p', { class: 'label' }, label), h('p', {}, value)) : null;
  return h('main', { class: 'screen' },
    header(t.name),
    photo,
    h('div', { class: 'card' },
      field('Категория', t.category),
      field('Бокал', t.glass),
      field('Метод', t.method),
      t.ingredients.length ? h('div', { class: 'field' }, h('p', { class: 'label' }, 'Ингредиенты'),
        h('ul', { class: 'ingredients' }, t.ingredients.map(i => h('li', {}, i)))) : null,
      field('Гарнир', t.garnish),
      field('Подача и заметки', t.notes),
    ),
  );
}

// =====================================================================
//  ИНВЕНТАРИЗАЦИЯ
//  Экран 1: место + категории.  Экран 2: виды / позиции.  Экран 3: ввод.
// =====================================================================

/** Подсчёт итога — та же формула, что на сервере (сервер всё равно пересчитает сам). */
function invTotal(item, full, openMl, weight) {
  if (item.unit === 'шт') return full;
  let open = 0;
  if (openMl !== null) open = openMl;
  else if (weight !== null) {
    const density = item.unit === 'г' ? 1 : item.density;
    open = item.tare && density ? Math.max(0, (weight - item.tare) / density) : 0;
  }
  return Math.round((full * (item.volume || 0) + open) * 10) / 10;
}
function invSummary(r) {
  if (r.category === 'Нет в описи') return `нет в описи, ${r.unit === 'шт' ? r.full : r.openMl} ${r.unit}`;
  const parts = [`полных ${r.full || 0}`];
  if (r.openMl !== null && r.openMl !== undefined) parts.push(`открытая ${r.openMl} мл`);
  if (r.weight !== null && r.weight !== undefined) parts.push(`вес ${r.weight} г`);
  return parts.join(', ');
}
const fmtNum = n => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 1 });

/** Что Я уже посчитал в этой инвентаризации на этом месте (из очереди и истории). */
async function myCounts(location) {
  const inv = config.inventory;
  const all = [...await listSent(), ...await listQueue()]
    .filter(r => r.type === 'inventory' && r.session === inv.active && r.location === location && r.name === session.name)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const map = new Map();
  for (const r of all) {
    const item = inv.items.find(it => it.category === r.category && it.name === r.item);
    if (item) map.set(r.category + '|' + r.item, invTotal(item, r.full || 0, r.openMl ?? null, r.weight ?? null));
  }
  return map;
}

// ---------------------------------------------------------------------
//  Голос в инвентаризации: «Бомбей, две полных, открытая триста пятьдесят»
// ---------------------------------------------------------------------
function voiceButton(onclick, text = '🎤 Сказать позицию и количество') {
  if (!voiceSupported()) {
    // Браузер не умеет распознавать речь (Firefox, Яндекс Браузер, Opera, некоторые встроенные браузеры)
    return h('p', { class: 'hint left' }, '🎤 Голосовой ввод в этом браузере не работает. ' +
      'Откройте приложение в Chrome, Safari или Edge — или пользуйтесь микрофоном на клавиатуре телефона.');
  }
  return h('button', { class: 'secondary voice-btn', onclick }, text);
}

/** Показывает «Слушаю…», ждёт фразу. Возвращает варианты распознавания или null. */
async function listenWithUi() {
  if (!voiceSupported()) {
    toast('Голос здесь не поддерживается — нажмите микрофон на клавиатуре', 'bad');
    return null;
  }
  const overlay = h('div', { class: 'overlay center' },
    h('div', { class: 'listen' }, h('div', { class: 'mic-pulse' }, '🎤'), h('p', {}, 'Слушаю…'),
      h('p', { class: 'muted' }, 'Например: «Бомбей, две полных, открытая триста»')));
  document.body.append(overlay);
  try {
    return await listenOnce();
  } catch (e) {
    toast(voiceErrorText(e), 'bad');
    return null;
  } finally {
    overlay.remove();
  }
}

/** Голосовой поиск позиции среди scopeItems и переход к вводу с подставленными цифрами. */
async function voiceInventory(scopeItems) {
  const alts = await listenWithUi();
  if (!alts) return;
  // Берём вариант распознавания, где позиция нашлась увереннее всего
  let best = null;
  for (const text of alts) {
    const r = parseInventoryPhrase(text, { items: scopeItems });
    if (r.candidates.length && (!best || r.candidates[0].score > best.r.candidates[0].score)) best = { text, r };
  }
  const heard = alts[0];
  if (!best) {
    // Ничего похожего в Описи — предлагаем записать как новую позицию
    return offerCustom(heard, scopeItems);
  }
  const open = (item) => {
    const q = parseInventoryPhrase(best.text, { item });
    go(screenInvCount, item, { full: q.full, open: q.open, weight: q.weight, heard: best.text });
  };
  if (confident(best.r.candidates)) return open(best.r.candidates[0].item);

  // Не уверены — даём выбрать из похожих
  const overlay = h('div', { class: 'overlay' });
  const close = () => overlay.remove();
  overlay.append(h('div', { class: 'sheet short' },
    h('div', { class: 'sheet-head' }, h('p', { class: 'label' }, `Услышал: «${best.text}». Что именно?`),
      h('button', { class: 'x', onclick: close }, '✕')),
    h('div', { class: 'picker-list' },
      ...best.r.candidates.map(c => h('button', { class: 'row', onclick: () => { close(); open(c.item); } },
        h('span', {}, c.item.name), h('span', { class: 'muted' }, c.item.kind || c.item.category))),
      h('button', { class: 'secondary', onclick: () => {
        close();
        go(screenInvCustom, { ...parseCustomPhrase(best.text), heard: best.text });
      } }, '+ Нет в списке — новая позиция'),
      h('button', { class: 'secondary', onclick: () => { close(); voiceInventory(scopeItems); } }, '🎤 Сказать ещё раз'))));
  document.body.append(overlay);
}

/** Позиция не нашлась голосом: добавить как новую или сказать ещё раз. */
function offerCustom(heard, scopeItems) {
  const overlay = h('div', { class: 'overlay' });
  const close = () => overlay.remove();
  overlay.append(h('div', { class: 'sheet short' },
    h('div', { class: 'sheet-head' }, h('p', { class: 'label' }, `Услышал: «${heard}». В описи такого нет.`),
      h('button', { class: 'x', onclick: close }, '✕')),
    h('div', { class: 'picker-list' },
      h('button', { class: 'primary', onclick: () => {
        close();
        go(screenInvCustom, { ...parseCustomPhrase(heard), heard });
      } }, '+ Добавить как новую позицию'),
      h('button', { class: 'secondary', onclick: () => { close(); voiceInventory(scopeItems); } }, '🎤 Сказать ещё раз'))));
  document.body.append(overlay);
}

/**
 * Позиция, которой нет в Описи (новая или забыли добавить).
 * Бармен пишет название, выбирает единицу и вводит ОБЩЕЕ количество.
 * В таблице такие строки собираются на листе «Нет в описи» — менеджер добавит их в Опись.
 */
function screenInvCustom(prefill = {}) {
  const inv = config.inventory;
  const root = h('main', { class: 'screen' }, header('Нет в описи'));
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  const nameInput = h('input', { type: 'text', placeholder: 'Название, например: Джин Монки 47 0,5', value: cap(prefill.name || '') });
  let unit = prefill.unit || 'мл';
  const unitBox = h('div', { class: 'chips' });
  const qtyLabel = h('p', { class: 'label' });
  const qty = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0', class: 'qty big',
    value: prefill.amount !== null && prefill.amount !== undefined ? String(prefill.amount).replace('.', ',') : '' });
  function drawUnits() {
    unitBox.replaceChildren(...['мл', 'г', 'шт'].map(u => h('button', {
      class: 'chip' + (u === unit ? ' on' : ''), onclick: () => { unit = u; drawUnits(); },
    }, u)));
    qtyLabel.textContent = unit === 'шт' ? 'Сколько штук всего' : `Сколько всего, ${unit} (все бутылки вместе)`;
  }
  drawUnits();
  const comment = h('textarea', { rows: '2', placeholder: 'Комментарий: объём бутылки, где стоит, сколько полных…' });
  const saveBtn = h('button', { class: 'primary' }, 'Сохранить');
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const q = parseQty(qty.value);
    if (!name) return toast('Введите название', 'bad');
    if (!(q >= 0)) return toast('Введите количество (можно 0)', 'bad');
    if (unit === 'шт' && !Number.isInteger(q)) return toast('Штуки — целое число', 'bad');
    const loc = await db.get('kv', 'invLocation');
    saveBtn.disabled = true;
    await enqueue({
      type: 'inventory', name: session.name, pin: session.pin,
      session: inv.active, location: loc, category: 'Нет в описи', kind: '', item: name, unit,
      full: unit === 'шт' ? q : 0, openMl: unit === 'шт' ? null : q, weight: null,
      comment: comment.value.trim(),
    });
    toast('Записано. Менеджер добавит позицию в опись');
    back();
  });
  root.append(
    prefill.heard ? h('p', { class: 'heard' }, `🎤 «${prefill.heard}» — проверьте название и цифры`) : null,
    h('p', { class: 'hint left' }, 'Позиции нет в описи? Запишите её здесь — цифра не потеряется, а менеджер потом добавит позицию в опись.'),
    h('p', { class: 'label' }, 'Название'), nameInput,
    h('p', { class: 'label' }, 'Единица'), unitBox,
    qtyLabel, qty, comment, saveBtn);
  if (!prefill.name) setTimeout(() => nameInput.focus(), 50);
  return root;
}

function screenInventory() {
  const inv = config.inventory || { active: '', locations: [], items: [] };
  const root = h('main', { class: 'screen' }, header('Инвентаризация'));
  if (!inv.active) {
    root.append(h('p', { class: 'hint' }, 'Сейчас нет активной инвентаризации. Менеджер включает её в таблице: лист «Списки», ячейка C2.'),
      h('button', { class: 'secondary', onclick: async () => { await loadConfig(); resetTo(screenHome); go(screenInventory); } }, 'Обновить'));
    return root;
  }
  root.append(h('p', { class: 'who' }, h('span', {}, 'Идёт: ', h('b', {}, inv.active))));

  const body = h('div', {});
  const locBox = h('div', { class: 'chips' });
  root.append(h('p', { class: 'label' }, 'Где считаете?'), locBox, body);

  async function draw() {
    const loc = await db.get('kv', 'invLocation');
    locBox.replaceChildren(...inv.locations.map(l => h('button', {
      class: 'chip' + (l === loc ? ' on' : ''),
      onclick: async () => { await db.put('kv', l, 'invLocation'); draw(); },
    }, l)));
    if (!loc || !inv.locations.includes(loc)) { body.replaceChildren(h('p', { class: 'hint' }, 'Выберите место')); return; }

    const counts = await myCounts(loc);
    const voice = voiceButton(() => voiceInventory(inv.items));
    const cats = {};
    inv.items.forEach(it => {
      const c = (cats[it.category] = cats[it.category] || { total: 0, done: 0 });
      c.total++;
      if (counts.has(it.category + '|' + it.name)) c.done++;
    });
    const customBtn = h('button', { class: 'secondary', onclick: () => go(screenInvCustom, {}) }, '+ Нет в описи');
    body.replaceChildren(voice, h('p', { class: 'label' }, 'Категория'),
      ...Object.entries(cats).map(([cat, c]) => h('button', { class: 'row', onclick: () => go(screenInvItems, cat, null) },
        h('span', {}, cat), h('span', { class: c.done === c.total ? 'ok-text' : 'muted' }, `${c.done} / ${c.total}`))),
      customBtn);
  }
  draw();
  return root;
}

/** Список видов внутри категории (если они есть) или сразу позиции. */
function screenInvItems(category, kind) {
  const inv = config.inventory;
  const inCat = inv.items.filter(it => it.category === category);
  const kinds = [...new Set(inCat.map(it => it.kind).filter(Boolean))];
  const title = kind ? `${category} · ${kind}` : category;
  const root = h('main', { class: 'screen' }, header(title));
  const body = h('div', {});
  const search = h('input', { type: 'search', placeholder: 'Поиск…', class: 'search' });
  const scope = inCat.filter(it => !kind || it.kind === kind);
  root.append(voiceButton(() => voiceInventory(scope)), search, body);

  async function draw() {
    const loc = await db.get('kv', 'invLocation');
    const counts = await myCounts(loc);
    const q = search.value.trim().toLowerCase();

    // Если в категории есть виды и вид ещё не выбран (и нет поиска) — показываем виды
    if (!kind && kinds.length > 1 && !q) {
      body.replaceChildren(...kinds.map(k => {
        const list = inCat.filter(it => it.kind === k);
        const done = list.filter(it => counts.has(it.category + '|' + it.name)).length;
        return h('button', { class: 'row', onclick: () => go(screenInvItems, category, k) },
          h('span', {}, k), h('span', { class: done === list.length ? 'ok-text' : 'muted' }, `${done} / ${list.length}`));
      }), ...inCat.filter(it => !it.kind).map(itemRow));
      return;
    }
    const list = inCat.filter(it => (!kind || it.kind === kind) && (!q || it.name.toLowerCase().includes(q)));
    body.replaceChildren(...(list.length ? list.map(itemRow) : [h('p', { class: 'hint' }, 'Ничего не найдено')]),
      h('button', { class: 'secondary', onclick: () => go(screenInvCustom, { name: search.value.trim() }) }, '+ Нет в описи'));

    function itemRow(it) {
      const key = it.category + '|' + it.name;
      return h('button', { class: 'row', onclick: () => go(screenInvCount, it) },
        h('span', {}, it.name),
        counts.has(key) ? h('span', { class: 'ok-text' }, `✓ ${fmtNum(counts.get(key))} ${it.unit}`) : h('span', { class: 'muted' }, '—'));
    }
  }
  search.addEventListener('input', draw);
  draw();
  return root;
}

/** Ввод: полные + остаток (мл или вес). Итог считается сразу на экране. */
function screenInvCount(item, prefill = null) {
  const inv = config.inventory;
  const canWeigh = item.unit !== 'шт' && item.tare > 0 && (item.unit === 'г' || item.density > 0);
  // Нет объёма тары (фрукты, ПФ, разливное) — «полных бутылок» не бывает, вводим общее количество
  const byBottle = item.unit !== 'шт' && item.volume > 0;
  const state = { full: '', open: '', mode: 'ml' }; // mode: 'ml' | 'weight'
  const fmtIn = v => (v === null || v === undefined ? '' : String(v).replace('.', ','));
  function applyVoice(p) {
    if (!p) return;
    if (p.full !== null && p.full !== undefined) state.full = fmtIn(p.full);
    if (p.weight !== null && p.weight !== undefined && canWeigh) { state.mode = 'weight'; state.open = fmtIn(p.weight); }
    else if (p.open !== null && p.open !== undefined) { state.mode = 'ml'; state.open = fmtIn(p.open); }
  }
  applyVoice(prefill);
  const root = h('main', { class: 'screen' }, header(item.name));

  const totalEl = h('p', { class: 'total' });
  function update() {
    const full = state.full === '' ? 0 : parseQty(state.full);
    const open = state.open === '' ? null : parseQty(state.open);
    if (!(full >= 0) || (open !== null && !(open >= 0))) { totalEl.textContent = 'Проверьте цифры'; return; }
    const t = invTotal(item, full, state.mode === 'ml' ? open : null, state.mode === 'weight' ? open : null);
    totalEl.textContent = `Итого: ${fmtNum(t)} ${item.unit}`;
  }

  const fullInput = h('input', { type: 'text', inputmode: 'numeric', placeholder: '0', class: 'qty big', value: state.full, oninput: e => { state.full = e.target.value; update(); } });
  const stepper = h('div', { class: 'stepper' },
    h('button', { class: 'secondary', onclick: () => { const n = Math.max(0, (parseQty(state.full) || 0) - 1); state.full = String(n); fullInput.value = n; update(); } }, '−'),
    fullInput,
    h('button', { class: 'secondary', onclick: () => { const n = (parseQty(state.full) || 0) + 1; state.full = String(n); fullInput.value = n; update(); } }, '+'));

  const openInput = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0', class: 'qty big', value: state.open, oninput: e => { state.open = e.target.value; update(); } });
  const openLabel = h('p', { class: 'label' });
  const modeBox = h('div', { class: 'chips' });
  function drawMode() {
    openLabel.textContent = state.mode === 'ml'
      ? (byBottle ? `Открытая: остаток, ${item.unit}` : `Количество, ${item.unit}`)
      : (byBottle ? 'Открытая: вес на весах вместе с бутылкой, г' : 'Вес на весах вместе с тарой, г');
    modeBox.replaceChildren(
      h('button', { class: 'chip' + (state.mode === 'ml' ? ' on' : ''), onclick: () => { state.mode = 'ml'; drawMode(); update(); } }, `В ${item.unit}`),
      canWeigh ? h('button', { class: 'chip' + (state.mode === 'weight' ? ' on' : ''), onclick: () => { state.mode = 'weight'; drawMode(); update(); } }, 'Весом') : null);
  }
  drawMode();

  const comment = h('textarea', { rows: '2', placeholder: 'Комментарий (необязательно)' });
  const saveBtn = h('button', { class: 'primary' }, 'Сохранить');
  saveBtn.addEventListener('click', async () => {
    const loc = await db.get('kv', 'invLocation');
    const full = state.full === '' ? 0 : parseQty(state.full);
    const open = state.open === '' ? null : parseQty(state.open);
    if (state.full === '' && state.open === '') return toast('Введите количество (можно 0)', 'bad');
    if (!(full >= 0) || !Number.isInteger(full)) return toast('Полных — целое число', 'bad');
    if (open !== null && !(open >= 0)) return toast('Проверьте остаток', 'bad');
    saveBtn.disabled = true;
    await enqueue({
      type: 'inventory', name: session.name, pin: session.pin,
      session: inv.active, location: loc, category: item.category, kind: item.kind, item: item.name,
      full,
      openMl: item.unit !== 'шт' && state.mode === 'ml' ? open : null,
      weight: item.unit !== 'шт' && state.mode === 'weight' ? open : null,
      comment: comment.value.trim(),
    });
    toast('Записано');
    back();
  });

  const heardBox = h('p', { class: 'heard' + (prefill && prefill.heard ? '' : ' hidden') },
    prefill && prefill.heard ? `🎤 «${prefill.heard}» — проверьте цифры` : '');
  const voiceAgain = voiceButton(async () => {
    const alts = await listenWithUi();
    if (!alts) return;
    const p = parseInventoryPhrase(alts[0], { item });
    applyVoice(p);
    fullInput.value = state.full; openInput.value = state.open;
    drawMode(); update();
    heardBox.textContent = `🎤 «${alts[0]}» — проверьте цифры`;
    heardBox.classList.remove('hidden');
  }, '🎤 Сказать цифры');
  root.append(
    h('p', { class: 'muted' }, [item.category, item.kind, item.volume ? `тара ${item.volume} ${item.unit}` : ''].filter(Boolean).join(' · ')),
    heardBox, voiceAgain,
    ...(item.unit === 'шт' || byBottle
      ? [h('p', { class: 'label' }, item.unit === 'шт' ? 'Количество, шт' : 'Полных (закрытых)'), stepper] : []),
    ...(item.unit !== 'шт' ? [modeBox, openLabel, openInput] : []),
    totalEl, comment, saveBtn,
  );
  update();
  if (!prefill) setTimeout(() => (item.unit === 'шт' || byBottle ? fullInput : openInput).focus(), 50);
  return root;
}

// =====================================================================
//  АКТЫ ПЕРЕРАБОТКИ
//  Простые: было → стало (мята без веточек, лимоны → фреш), выход в %.
//  По рецепту: вводишь ключевое сырьё — остальное пересчитывается
//  по пропорции рецепта (цифры можно поправить), «стало» — по факту.
// =====================================================================

/** Аккуратное округление для пересчитанных количеств. */
function smartRound(v) {
  if (!isFinite(v)) return '';
  if (v >= 100) return Math.round(v);
  if (v >= 10) return Math.round(v * 10) / 10;
  if (v >= 1) return Math.round(v * 100) / 100;
  return Number(v.toPrecision(2));
}

function screenActs() {
  const root = h('main', { class: 'screen' }, header('Переработка'));
  const acts = config.acts || [];
  const search = h('input', { type: 'search', placeholder: 'Поиск: мята, фреш, кордиал…', class: 'search' });
  const list = h('div', {});
  function draw() {
    const q = search.value.trim().toLowerCase();
    const found = acts.filter(a => !q || a.name.toLowerCase().includes(q) ||
      a.inputs.some(i => i.item.toLowerCase().includes(q)));
    if (!found.length) { list.replaceChildren(h('p', { class: 'hint' }, acts.length ? 'Ничего не найдено' : 'Шаблонов пока нет')); return; }
    const groups = [['простой', 'Простые: было → стало'], ['по рецепту', 'По рецепту']];
    list.replaceChildren(...groups.map(([type, title]) => {
      const arr = found.filter(a => (a.type === 'по рецепту' ? 'по рецепту' : 'простой') === type);
      return arr.length ? h('div', {}, h('p', { class: 'group' }, title),
        ...arr.map(a => h('button', { class: 'row', onclick: () => go(screenAct, a) },
          h('span', {}, a.name), h('span', { class: 'muted' }, a.output.unit)))) : null;
    }));
  }
  search.addEventListener('input', draw);
  draw();
  root.append(search, list);
  return root;
}

function screenAct(act) {
  const isRecipe = act.type === 'по рецепту';
  const root = h('main', { class: 'screen' }, header(act.name));
  const numInput = (big) => h('input', { type: 'text', inputmode: 'decimal', placeholder: '0', class: 'qty' + (big ? ' big' : '') });
  const info = h('p', { class: 'total' });
  const comment = h('textarea', { rows: '2', placeholder: 'Комментарий (необязательно)' });
  const saveBtn = h('button', { class: 'primary' }, 'Сохранить акт');
  const outInput = numInput(true);
  let outDirty = false;

  // ---------- Простой акт: было → стало ----------
  if (!isRecipe) {
    const key = act.inputs[0];
    const keyInput = numInput(true);
    const recalc = () => {
      const k = parseQty(keyInput.value), o = parseQty(outInput.value);
      info.textContent = k > 0 && o >= 0 ? `Выход: ${fmtNum(o / k * 100)}%` : '';
    };
    keyInput.addEventListener('input', recalc);
    outInput.addEventListener('input', recalc);
    saveBtn.addEventListener('click', async () => {
      const k = parseQty(keyInput.value), o = parseQty(outInput.value);
      if (!(k > 0)) return toast('Введите, сколько было', 'bad');
      if (!(o > 0)) return toast('Введите, сколько стало', 'bad');
      saveBtn.disabled = true;
      await enqueue({ type: 'processing', name: session.name, pin: session.pin, act: act.name, comment: comment.value.trim(),
        lines: [{ role: 'Сырьё', item: key.item, unit: key.unit, qty: k },
                { role: 'Результат', item: act.output.item, unit: act.output.unit, qty: o }] });
      toast('Акт сохранён');
      back();
    });
    root.append(
      h('p', { class: 'label' }, `Было: ${key.item}, ${key.unit}`), keyInput,
      h('p', { class: 'label' }, `Стало: ${act.output.item}, ${act.output.unit}`), outInput,
      info, comment, saveBtn);
    setTimeout(() => keyInput.focus(), 50);
    return root;
  }

  // ---------- Акт по рецепту ----------
  // Для каждого сырья: поле «в дело» (amount) и, если его надо чистить, поле «до чистки» (raw).
  // Количество в рецепте — это вес «в дело» (для чистки — чистый вес).
  const key = act.inputs.find(i => i.key) || act.inputs[0];
  const rows = act.inputs.map(i => {
    const amount = numInput(i === key);
    const raw = i.clean ? numInput(false) : null;
    amount.dataset.dirty = '';
    amount.addEventListener('input', () => { if (i !== key) amount.dataset.dirty = '1'; });
    if (i.fixed && i.qty > 0) amount.value = String(i.qty).replace('.', ',');
    return { i, amount, raw };
  });
  const keyRow = rows.find(r => r.i === key);

  function recalc() {
    const k = parseQty(keyRow.amount.value);
    if (key.qty > 0 && k > 0) {
      const f = k / key.qty;
      rows.forEach(r => {
        if (r.i === key || r.i.fixed || r.amount.dataset.dirty || !(r.i.qty > 0)) return;
        r.amount.value = String(smartRound(r.i.qty * f)).replace('.', ',');
      });
      if (!outDirty && act.output.qty > 0) outInput.value = String(smartRound(act.output.qty * f)).replace('.', ',');
      info.textContent = `Замес: ×${fmtNum(k / key.qty)} от рецепта`;
    } else info.textContent = '';
    // процент чистки
    rows.forEach(r => {
      if (!r.raw) return;
      const a = parseQty(r.amount.value), w = parseQty(r.raw.value);
      r.pct.textContent = a > 0 && w > 0 ? `чистый вес: ${fmtNum(a / w * 100)}% от грязного` : '';
    });
  }
  rows.forEach(r => {
    r.amount.addEventListener('input', recalc);
    if (r.raw) { r.raw.addEventListener('input', recalc); r.pct = h('p', { class: 'muted' }); }
  });
  outInput.addEventListener('input', () => { outDirty = true; });

  saveBtn.addEventListener('click', async () => {
    const lines = [];
    for (const r of rows) {
      const a = r.amount.value.trim() === '' ? 0 : parseQty(r.amount.value);
      if (!(a >= 0)) return toast(`Проверьте: ${r.i.item}`, 'bad');
      if (r.i === key && !(a > 0)) return toast(`Введите: ${r.i.item}`, 'bad');
      if (r.raw) {
        const w = parseQty(r.raw.value);
        if (a > 0 && !(w > 0)) return toast(`${r.i.item}: введите вес до чистки`, 'bad');
        if (a > w) return toast(`${r.i.item}: чистый вес больше, чем до чистки`, 'bad');
        lines.push({ role: 'Сырьё', item: r.i.item, unit: r.i.unit, qty: a > 0 ? w : 0, clean: a });
      } else {
        lines.push({ role: 'Сырьё', item: r.i.item, unit: r.i.unit, qty: a });
      }
    }
    const o = parseQty(outInput.value);
    if (!(o > 0)) return toast('Введите, сколько получилось', 'bad');
    lines.push({ role: 'Результат', item: act.output.item, unit: act.output.unit, qty: o });
    saveBtn.disabled = true;
    await enqueue({ type: 'processing', name: session.name, pin: session.pin, act: act.name, lines, comment: comment.value.trim() });
    toast('Акт сохранён');
    back();
  });

  const block = (r) => {
    const i = r.i;
    const tag = i === key ? ' — ключевое' : i.fixed ? ' — постоянно' : '';
    if (r.raw) {
      // Одна строка: грязный = чистый. Пропорция считается от чистого веса.
      r.raw.placeholder = 'грязный';
      r.amount.placeholder = 'чистый';
      return h('div', { class: 'clean-block' + (i === key ? ' key' : '') },
        h('p', { class: 'label' }, `${i.item}${tag}`),
        h('div', { class: 'clean-line' }, r.raw, h('span', { class: 'arrow' }, '='), r.amount, h('span', { class: 'unit' }, i.unit)),
        h('div', { class: 'clean-caps' }, h('span', {}, 'грязный'), h('span', {}), h('span', {}, 'чистый (идёт в рецепт)'), h('span', {})),
        r.pct);
    }
    if (i === key) return h('div', {}, h('p', { class: 'label' }, `${i.item}, ${i.unit}${tag}`), r.amount);
    return h('div', { class: 'act-line' }, h('span', {}, i.item + (i.fixed ? ' · пост.' : '')), r.amount, h('span', { class: 'unit' }, i.unit));
  };
  const keyFirst = [keyRow, ...rows.filter(r => r !== keyRow)];
  const restRows = keyFirst.slice(1);
  root.append(
    key.qty > 0 ? h('p', { class: 'muted' }, `Рецепт рассчитан на ${fmtNum(key.qty)} ${key.unit} «${key.item}»${key.clean ? ' (чистый вес)' : ''}`) : null,
    block(keyRow),
    restRows.length ? h('p', { class: 'label' }, 'Остальное сырьё (считается само, можно поправить)') : null,
    h('div', { class: 'lines' }, ...restRows.map(block)),
    h('p', { class: 'label' }, `Получилось: ${act.output.item}, ${act.output.unit}`), outInput,
    info, comment, saveBtn);
  recalc();
  setTimeout(() => (keyRow.raw || keyRow.amount).focus(), 50);
  return root;
}

// =====================================================================
//  ЭКРАН: ОЧЕРЕДЬ И ИСТОРИЯ
// =====================================================================
function describe(r) {
  if (r.type === 'transfer') return `Перенос · ${r.direction} · ${r.item} ${r.qty} ${r.unit}`;
  if (r.type === 'writeoff') return `Списание · ${r.item} ${r.qty} ${r.unit} · ${r.reason}`;
  if (r.type === 'photo') return `Фото уборки · ${r.zone}`;
  if (r.type === 'processing') {
    const res = (r.lines || []).find(l => l.role === 'Результат');
    const first = (r.lines || []).find(l => l.role === 'Сырьё' && l.qty > 0);
    return `Переработка · ${r.act} · ${first ? first.qty + ' ' + first.unit : ''} → ${res ? res.qty + ' ' + res.unit : ''}`;
  }
  if (r.type === 'inventory') return `Инвентаризация · ${r.location} · ${r.item} · ${invSummary(r)}`;
  return r.type;
}

function screenQueue() {
  const root = h('main', { class: 'screen' }, header('Отправка'));
  const body = h('div', {});
  root.append(
    h('button', { class: 'primary', onclick: async () => { await syncNow(); draw(); } }, 'Отправить сейчас'),
    body,
  );

  async function draw() {
    const queue = await listQueue();
    const sent = (await listSent()).slice(0, 30);
    const pending = queue.filter(r => r.status !== 'rejected');
    const rejected = queue.filter(r => r.status === 'rejected');

    body.replaceChildren(
      rejected.length ? h('div', {},
        h('p', { class: 'group bad' }, `Отклонено сервером: ${rejected.length}`),
        ...rejected.map(r => h('div', { class: 'qrow bad' },
          h('div', {}, h('b', {}, describe(r)), h('p', { class: 'muted' }, `${fmtTime(r.createdAt)} · ${r.name}`),
            h('p', { class: 'err' }, r.error),
            r.code === 'auth' ? h('p', { class: 'muted' }, 'Если PIN поменяли: на главной «Сменить», войдите с новым PIN, вернитесь сюда и нажмите «Повторить».') : null),
          h('div', { class: 'qbtns' },
            h('button', {
              class: 'secondary',
              onclick: async () => {
                // Если PIN поменяли, а запись была от текущего сотрудника, — подставим новый PIN
                const patch = r.name === session.name ? { pin: session.pin } : {};
                await retryRejected(r.id, patch);
                setTimeout(draw, 500);
              },
            }, 'Повторить'),
            h('button', {
              class: 'danger',
              onclick: async () => {
                if (!confirm('Удалить эту запись? Она НЕ попадёт в таблицу.')) return;
                await removeFromQueue(r.id);
                draw();
              },
            }, 'Удалить'))))) : null,

      h('p', { class: 'group' }, `Ждут отправки: ${pending.length}`),
      ...(pending.length ? pending.map(r => h('div', { class: 'qrow' },
        h('div', {}, h('b', {}, describe(r)), h('p', { class: 'muted' }, `${fmtTime(r.createdAt)} · ${r.name}`),
          r.error ? h('p', { class: 'muted' }, 'Последняя попытка: ' + r.error) : null))) :
        [h('p', { class: 'hint' }, 'Всё отправлено')]),

      h('p', { class: 'group' }, 'Отправлено недавно'),
      ...(sent.length ? sent.map(r => h('div', { class: 'qrow done' },
        h('div', {}, h('b', {}, describe(r)), h('p', { class: 'muted' }, `${fmtTime(r.createdAt)} · ${r.name}`)))) :
        [h('p', { class: 'hint' }, 'Пока пусто')]),
    );
  }
  draw();
  const off = onSyncChange(() => { if (document.body.contains(root)) draw(); else off(); });
  return root;
}

// =====================================================================
//  СТАРТ
// =====================================================================
async function start() {
  // Просим браузер не удалять наши данные при нехватке места (особенно важно на iPhone)
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // Service Worker — сохраняет само приложение на телефоне, чтобы оно открывалось без сети
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(e => console.warn(e));

  session = (await db.get('kv', 'session')) || null;
  onSyncChange(renderStatus);

  config = (await db.get('kv', 'config')) || null;
  if (session && config) {
    resetTo(screenHome);
    loadConfig(); // обновим справочник в фоне
  } else {
    app.replaceChildren(h('main', { class: 'screen' }, h('p', { class: 'hint' }, 'Загрузка…')));
    await loadConfig();
    resetTo(session && config ? screenHome : screenLogin);
  }
  history.replaceState({ depth: 1 }, '');
  startAutoSync(SYNC_INTERVAL_MS);
  renderStatus(await getStatus());
}

start();
