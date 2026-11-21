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
//    Викторина   — 10 вопросов, таймер, разбор ответа, обжалование вопроса
//    Дуэль       — комната по коду, 10 HP, 30 секунд на раунд, опрос состояния
//    Очередь     — что ещё не отправлено, что отклонено, история
// =====================================================================

import { SYNC_INTERVAL_MS, PHOTO_MAX_SIDE, PHOTO_QUALITY } from '../config.js';
import { db } from './db.js';
import { apiGet, apiPost, ApiError, NetworkError } from './api.js';
import {
  enqueue, startAutoSync, onSyncChange, getStatus, syncNow,
  listQueue, listSent, removeFromQueue, retryRejected,
} from './sync.js';
import { voiceSupported, listenOnce, voiceErrorText, parseInventoryPhrase, confident, parseCustomPhrase } from './voice.js';
import { icon } from './icons.js';
import {
  buildLabel, labelDataUrl, labelFileName, canShareFiles, shareLabel, saveLabel, printLabel,
} from './label.js';

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
// Уборка за экраном: таймеры и опросы должны останавливаться при уходе.
// Экраны регистрируют здесь функции очистки (clearInterval, stop-функции).
let screenCleanups = [];
function registerCleanup(fn) { if (typeof fn === 'function') screenCleanups.push(fn); }
function runScreenCleanups() {
  while (screenCleanups.length) {
    const fn = screenCleanups.pop();
    try { fn(); } catch (e) { console.warn('cleanup', e); }
  }
}
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
  runScreenCleanups();
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
// ---------------------------------------------------------------------
//  Оформление: обычное (чёрное ESSE) или зимнее (бордо + золото).
//  Берём из таблицы («Списки», F2: обычное / зимнее / авто).
//  «авто» или пусто: зимнее с 1 декабря по 15 января.
// ---------------------------------------------------------------------
function applyTheme() {
  const t = String((config && config.theme) || 'авто').toLowerCase();
  const now = new Date(), m = now.getMonth(), d = now.getDate();
  const winterSeason = m === 11 || (m === 0 && d <= 15);
  const winter = t.startsWith('зим') || (!t.startsWith('обыч') && winterSeason);
  document.documentElement.dataset.theme = winter ? 'winter' : '';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = winter ? '#3d0712' : '#0b0b0c';
}

async function loadConfig() {
  const cached = await db.get('kv', 'config');
  if (cached) config = cached;
  try {
    const fresh = await apiGet({ action: 'config' });
    config = fresh;
    applyTheme();
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
  const wrap = h('main', { class: 'screen' },
    h('div', { class: 'logo login-logo', role: 'img', 'aria-label': 'ESSE Jazz Club' }),
    h('p', { class: 'hint' }, 'Журнал бара'));

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
      handleDuelEntry(); // если приложение открыли по ссылке ?duel=КОД
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
// =====================================================================
//  РОЛИ (лист «Сотрудники», столбец «Роль»)
//  бармен   — всё, кроме инвентаризации Gift-shop
//  админ    — только перенос, списание и инвентаризация Gift-shop (Кабинет / Витрина)
//  менеджер — всё, включая Gift-shop
//  Места Gift-shop задаются в таблице: «Списки», столбец E.
// =====================================================================
const GIFT = 'Gift-shop';
const roleOf = () => String((session && session.role) || 'бармен').toLowerCase();
const isAdmin = () => roleOf().startsWith('админ');
const isManager = () => roleOf().startsWith('менедж');

const giftLocs = () => (config.inventory && config.inventory.giftLocations) || ['Кабинет', 'Витрина'];

/** Что показывать в инвентаризации этому сотруднику: позиции и места. */
function invScope() {
  const inv = config.inventory || { locations: [], items: [] };
  const gift = giftLocs();
  if (isAdmin()) return { items: inv.items.filter(it => it.category === GIFT), locations: gift };
  if (isManager()) return { items: inv.items, locations: [...inv.locations, ...gift] };
  return { items: inv.items.filter(it => it.category !== GIFT), locations: inv.locations };
}

function screenHome() {
  // Плитка в стиле «Афиша»: тонкая иконка, название заглавными, короткая подпись
  const tile = (ico, title, sub, onclick) =>
    h('button', { class: 'tile', onclick }, icon(ico), h('span', { class: 't-name' }, title), h('span', { class: 't-sub' }, sub));

  return h('main', { class: 'screen' },
    h('header', { class: 'top' }, h('span'), h('div', { class: 'logo', role: 'img', 'aria-label': 'ESSE Jazz Club' }), h('span')),
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
    h('div', { class: 'tiles' }, isAdmin()
      ? [ // Админ: только эти плитки
        tile('transfer', 'Перенос', 'между точками', () => go(screenItemsForm, 'transfer')),
        tile('writeoff', 'Списание', 'бой, порча, брак', () => go(screenItemsForm, 'writeoff')),
        tile('gift', 'Gift-shop', 'инвентаризация', () => go(screenInventory)),
        tile('quiz', 'Викторина', 'вопросы смены', () => go(screenQuizStart)),
        tile('duel', 'Дуэль', 'два игрока', openDuel),
      ]
      : [
        tile('transfer', 'Перенос', 'кухня ⇄ бар', () => go(screenItemsForm, 'transfer')),
        tile('writeoff', 'Списание', 'бой, порча, проливы', () => go(screenItemsForm, 'writeoff')),
        tile('photo', 'Фото уборки', 'зоны после смены', () => go(screenPhoto)),
        tile('ttk', 'ТТК', 'рецептуры', () => go(screenTtkList)),
        tile('inv', 'Инвентаризация', 'подсчёт остатков', () => go(screenInventory)),
        tile('quiz', 'Викторина', 'вопросы смены', () => go(screenQuizStart)),
        tile('duel', 'Дуэль', 'два игрока', openDuel),
        actsTile(),
      ]),
  );
}

/** Плитка «Переработка» со значком «⏳ N в работе» (число подтягивается в фоне). */
function actsTile() {
  const badge = h('span', { class: 'badge hidden' });
  const btn = h('button', { class: 'tile', onclick: () => go(screenActs) },
    icon('acts'), h('span', { class: 't-name' }, 'Переработка'), h('span', { class: 't-sub' }, 'заготовки и выход'), badge);
  const show = list => {
    const n = list.length;
    badge.textContent = n ? `⏳ ${n} в работе` : '';
    badge.classList.toggle('hidden', !n);
    badge.classList.toggle('late', list.some(isLate));
  };
  getOpenActs(false).then(show);
  getOpenActs(true).then(show).catch(() => {});
  return btn;
}

// =====================================================================
//  АКТЫ «В РАБОТЕ»: выход запишем позже
//  Список берём с сервера (его видят все бармены) + свои ещё не отправленные.
// =====================================================================
const LATE_HOURS = 24; // через сколько часов незакрытый акт подсвечивается красным
const isLate = a => a.date && (Date.now() - new Date(a.date).getTime()) > LATE_HOURS * 3600e3;

async function getOpenActs(fresh) {
  let server = (await db.get('kv', 'openActs')) || [];
  if (fresh) {
    try {
      server = (await apiGet({ action: 'openActs' })).acts || [];
      await db.put('kv', server, 'openActs');
    } catch (e) { /* нет связи — показываем то, что было */ }
  }
  const queue = await listQueue();
  const closing = new Set(queue.filter(r => r.type === 'processingClose').map(r => r.actId));
  // свои акты «в работе», которые ещё в очереди (нет связи) — тоже показываем
  const local = queue.filter(r => r.type === 'processing' && r.pending && !server.some(a => a.id === r.id))
    .map(r => {
      const out = (r.lines || []).find(l => l.role === 'Результат') || {};
      return { id: r.id, act: r.act, name: r.name, date: r.createdAt, item: out.item, unit: out.unit,
        inputs: (r.lines || []).filter(l => l.role === 'Сырьё' && l.qty > 0), expected: r.expected || null,
        basis: r.expected ? 'по рецепту' : '', local: true };
    });
  return [...server, ...local].filter(a => !closing.has(a.id))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// =====================================================================
//  ЭТИКЕТКА 30×20 КАК ИЗ АКТА ПЕРЕРАБОТКИ
//
//  Блок появляется, когда акт готов: вписан выход (или акт закрыли).
//  Картинку рисует js/label.js — ровно 240×160 точек (30×20 мм при
//  203 dpi), чёрно-белая, безопасная зона 2 мм.
//
//  Срок хранения берём из справочника «Сроки хранения» (config.shelfLife).
//  Позиции нет в справочнике — подставляем 24 часа и пишем об этом
//  мелким текстом под превью; на самой этикетке только срок.
//
//  Название пустое (акт без рецепта/позиций) — спрашиваем тут же,
//  обычным полем ввода; срок по умолчанию 24 ч, его можно поменять.
//
//  «Поделиться» показываем только если navigator.canShare({files}) умеет
//  файлы — иначе кнопки нет вовсе. «Печать» — window.print() страницы
//  30×20 мм (не Bluetooth: протокол B21 ещё не проверен физически).
// =====================================================================
const LABEL_DEFAULT_HOURS = 24;

/** Ключ сравнения названий: регистр, «ё», лишние пробелы. */
function nameKey(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/** Строка справочника «Сроки хранения» для названия (или null). */
function shelfLifeFor(name) {
  const key = nameKey(name);
  if (!key) return null;
  const list = (config && config.shelfLife) || [];
  return list.find(x => nameKey(x.name) === key) || null;
}

function shelfLifeHours(name) {
  const hit = shelfLifeFor(name);
  return hit && Number(hit.hours) > 0 ? Number(hit.hours) : LABEL_DEFAULT_HOURS;
}

/**
 * Блок этикетки: превью 2×, название (если его надо спрашивать),
 * срок хранения и кнопки «Печать» / «Поделиться» / «Сохранить картинку».
 * @returns {{el:HTMLElement, madeAt:Date, refresh:Function}}
 */
function createLabelBox(opts = {}) {
  const state = {
    name: String(opts.name || ''),
    madeAt: opts.madeAt instanceof Date && !isNaN(opts.madeAt) ? opts.madeAt : new Date(),
    hoursTouched: false,
  };
  const shareOk = canShareFiles();
  let info = null;

  const preview = h('img', { class: 'label-preview', alt: 'Превью этикетки 30×20 мм' });
  const note = h('p', { class: 'label-note' });
  const nameInput = opts.nameEditable
    ? h('input', { type: 'text', class: 'label-name', placeholder: 'Например: Имбирная заготовка', value: state.name })
    : null;
  const hoursInput = h('input', {
    type: 'text', inputmode: 'decimal', class: 'label-hours',
    value: String(shelfLifeHours(state.name)).replace('.', ','),
  });

  /** Перерисовать превью и подписи. Возвращает актуальную этикетку. */
  function refresh() {
    const name = state.name.trim();
    const hours = parseQty(hoursInput.value);
    const hoursOk = hours > 0;
    const hit = shelfLifeFor(name);
    info = buildLabel({ name, madeAt: state.madeAt, hours: hoursOk ? hours : LABEL_DEFAULT_HOURS });
    preview.src = labelDataUrl(info.canvas);
    const parts = [];
    if (!name) parts.push('Название не заполнено — картинка не напечатается');
    if (!hoursOk) parts.push('Срок хранения: впишите число часов');
    else if (hit && hit.hours === hours) parts.push(`Срок ${fmtNum(hours)} ч — из справочника «Сроки хранения»`);
    else if (hit) parts.push(`Срок ${fmtNum(hours)} ч (в справочнике ${fmtNum(hit.hours)} ч) — поправлено вручную`);
    else parts.push(`Срок ${fmtNum(hours)} ч: позиции нет в справочнике «Сроки хранения», проверьте`);
    if (info.truncated) parts.push('название не помещается целиком — сократите его');
    note.textContent = parts.join(' · ');
    note.classList.toggle('bad', !name || !hoursOk || info.truncated);
    return info;
  }

  let timer = 0;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 120); };

  if (nameInput) {
    nameInput.addEventListener('input', () => {
      state.name = nameInput.value;
      if (!state.hoursTouched) hoursInput.value = String(shelfLifeHours(state.name)).replace('.', ',');
      schedule();
    });
  }
  hoursInput.addEventListener('input', () => { state.hoursTouched = true; schedule(); });

  /** Перед действием: проверки и гарантированно свежая картинка. */
  function prepare() {
    const cur = refresh();
    if (!state.name.trim()) {
      if (nameInput) nameInput.focus();
      toast('Впишите название заготовки', 'bad');
      return null;
    }
    if (!(parseQty(hoursInput.value) > 0)) {
      hoursInput.focus();
      toast('Срок хранения: нужно число часов больше нуля', 'bad');
      return null;
    }
    return cur;
  }

  async function onPrint() {
    const cur = prepare();
    if (cur) await printLabel(cur.canvas);
  }

  async function onShare() {
    const cur = prepare();
    if (!cur) return;
    const res = await shareLabel(cur.canvas, labelFileName(cur));
    if (!res.ok && res.error !== 'Отменено') toast(res.error, 'bad');
  }

  async function onSave() {
    const cur = prepare();
    if (!cur) return;
    try {
      await saveLabel(cur.canvas, labelFileName(cur));
      toast('Картинка сохраняется в загрузки');
    } catch (e) {
      toast('Не удалось сохранить картинку', 'bad');
    }
  }

  const buttons = h('div', { class: 'label-btns' + (shareOk ? '' : ' single') },
    shareOk ? h('button', { class: 'secondary', onclick: onShare }, 'Поделиться') : null,
    h('button', { class: 'primary', onclick: onPrint }, 'Печать'),
  );

  const el = h('div', { class: 'label-box' },
    h('p', { class: 'group' }, 'Этикетка 30×20'),
    h('div', { class: 'label-frame' }, preview),
    note,
    nameInput ? h('div', {}, h('p', { class: 'label' }, 'Название'), nameInput) : null,
    h('div', { class: 'label-hours-row' }, h('span', { class: 'label' }, 'Срок хранения'), hoursInput, h('span', { class: 'unit' }, 'ч')),
    buttons,
    h('button', { class: 'link label-save', onclick: onSave }, 'Сохранить картинку (PNG)'),
  );

  refresh();
  return { el, madeAt: state.madeAt, refresh };
}

/** Экран «Акт сохранён / закрыт»: сразу с этикеткой, печать в один тап. */
function screenActDone(opts = {}) {
  const name = String(opts.name || '');
  const root = h('main', { class: 'screen' }, header(opts.title || 'Акт сохранён'));
  const box = createLabelBox({ name, madeAt: opts.madeAt, nameEditable: !name });
  root.append(
    name ? h('p', { class: 'total' }, name) : h('p', { class: 'label' }, 'Название заготовки'),
    opts.note ? h('p', { class: 'hint left' }, opts.note) : null,
    box.el,
    h('button', { class: 'secondary', onclick: () => resetTo(screenActs) }, 'Готово'),
  );
  return root;
}

/** Пустая заготовка: акта нет, название вводится руками. */
function screenLabel() {
  const root = h('main', { class: 'screen' }, header('Этикетка 30×20'));
  const box = createLabelBox({ name: '', madeAt: new Date(), nameEditable: true });
  root.append(
    h('p', { class: 'hint left' }, 'Пустая заготовка: впишите название и срок хранения — этикетка напечатается так же, как из акта.'),
    box.el,
  );
  setTimeout(() => box.el.querySelector('input.label-name')?.focus(), 80);
  return root;
}

/** Закрыть акт: вписать, сколько получилось. Может любой бармен. */
function screenCloseAct(a) {
  const root = h('main', { class: 'screen' }, header('Закрыть акт'));
  const qty = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0', class: 'qty big' });
  const info = h('p', { class: 'total' });
  const comment = h('textarea', { rows: '2', placeholder: 'Комментарий (необязательно)' });
  const saveBtn = h('button', { class: 'primary' }, '✅ Закрыть акт');
  const dev = v => (a.expected > 0 ? (v - a.expected) / a.expected * 100 : 0);

  // Этикетка: акт закрыт = выход есть. Дата производства — начало акта:
  // времени закрытия в таблице нет, а заготовка сделана, когда акт начали.
  const startedAt = a.date ? new Date(a.date) : new Date();
  const labelSlot = h('div', {});
  let labelBox = null;
  const syncLabel = () => {
    if (!(parseQty(qty.value) > 0)) {
      if (labelBox) { labelSlot.replaceChildren(); labelBox = null; }
      return;
    }
    if (labelBox) return;
    const name = a.item || '';
    labelBox = createLabelBox({ name, madeAt: startedAt, nameEditable: !name });
    labelSlot.replaceChildren(labelBox.el);
  };

  qty.addEventListener('input', () => {
    const v = parseQty(qty.value);
    if (!(v > 0) || !(a.expected > 0)) { info.textContent = ''; return; }
    const d = dev(v);
    info.textContent = Math.abs(d) < 1 ? 'Точно как ожидалось' : `${d > 0 ? '+' : ''}${fmtNum(d)}% от ожидаемого`;
    info.classList.toggle('warn', Math.abs(d) >= 15);
  });
  qty.addEventListener('input', syncLabel);
  saveBtn.addEventListener('click', async () => {
    const v = parseQty(qty.value);
    if (!(v > 0)) return toast('Введите, сколько получилось', 'bad');
    // Выход сильно отличается от ожидаемого — переспрашиваем и просим комментарий
    if (a.expected > 0 && Math.abs(dev(v)) >= 15) {
      if (!confirm(`Выход ${fmtNum(v)} ${a.unit}, а ожидалось ≈ ${fmtNum(a.expected)} ${a.unit}. Всё верно?`)) return;
      if (!comment.value.trim()) { comment.focus(); return toast('Напишите в комментарии, почему выход другой', 'bad'); }
    }
    saveBtn.disabled = true;
    const madeAt = labelBox ? labelBox.madeAt : startedAt;
    await enqueue({ type: 'processingClose', name: session.name, pin: session.pin, actId: a.id, act: a.act,
      qty: v, unit: a.unit, comment: comment.value.trim() });
    toast('Акт закрыт');
    stack.pop(); // экран закрытия в истории заменяем на «Акт закрыт» + этикетка
    go(screenActDone, {
      title: 'Акт закрыт',
      name: a.item || '',
      madeAt,
      note: 'Дата производства — время начала акта: время закрытия в таблице не хранится.',
    });
  });
  root.append(
    h('p', { class: 'label' }, a.act),
    h('p', { class: 'muted' }, `Начат ${fmtDateTime(a.date)} · ${a.name}${a.local ? ' · ещё не отправлен' : ''}`),
    h('div', { class: 'act-summary' }, ...(a.inputs || []).map(i =>
      h('div', { class: 'act-line' }, h('span', {}, i.item), h('span', {}, `${fmtNum(i.qty)} ${i.unit}` +
        (i.clean ? ` (чистый ${fmtNum(i.clean)})` : ''))))),
    a.comment ? h('p', { class: 'muted' }, '💬 ' + a.comment) : null,
    h('p', { class: 'label' }, `Получилось: ${a.item}, ${a.unit}`),
    a.expected > 0 ? h('p', { class: 'hint left' }, `Ожидается ≈ ${fmtNum(a.expected)} ${a.unit} · ${a.basis}`) : null,
    qty, info, labelSlot, comment, saveBtn);
  setTimeout(() => qty.focus(), 50);
  return root;
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
    h('div', { class: 'card' },
      field('Категория', t.category),
      field('Бокал', t.glass),
      field('Метод', t.method),
      t.ingredients.length ? h('div', { class: 'field' }, h('p', { class: 'label' }, 'Ингредиенты'),
        h('ul', { class: 'ingredients' }, t.ingredients.map(i => h('li', {}, i)))) : null,
      field('Гарнир', t.garnish),
      field('Подача и заметки', t.notes),
    ),
    t.photoId ? photo : null, // фото — после рецепта (если фото нет, блок не показываем)
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
  const scope = invScope();
  // Если место одно — не спрашиваем, выбираем сразу
  if (scope.locations.length > 1) root.append(h('p', { class: 'label' }, 'Где считаете?'), locBox);
  root.append(body);

  async function draw() {
    let loc = await db.get('kv', 'invLocation');
    if (scope.locations.length === 1 && loc !== scope.locations[0]) {
      loc = scope.locations[0];
      await db.put('kv', loc, 'invLocation');
    }
    locBox.replaceChildren(...scope.locations.map(l => h('button', {
      class: 'chip' + (l === loc ? ' on' : ''),
      onclick: async () => { await db.put('kv', l, 'invLocation'); draw(); },
    }, l)));
    if (!loc || !scope.locations.includes(loc)) { body.replaceChildren(h('p', { class: 'hint' }, 'Выберите место')); return; }

    const counts = await myCounts(loc);
    // В Кабинете и на Витрине считаем только Gift-shop, на барах и складах — всё остальное
    const isGiftPlace = giftLocs().includes(loc);
    const here = scope.items.filter(it => isGiftPlace === (it.category === GIFT));
    const voice = voiceButton(() => voiceInventory(here));
    const cats = {};
    here.forEach(it => {
      const c = (cats[it.category] = cats[it.category] || { total: 0, done: 0 });
      c.total++;
      if (counts.has(it.category + '|' + it.name)) c.done++;
    });
    const customBtn = h('button', { class: 'secondary', onclick: () => go(screenInvCustom, {}) }, '+ Нет в описи');
    const catNames = Object.keys(cats);
    if (catNames.length === 1) {
      // Одна категория (Gift-shop у админа) — сразу показываем её разделы: CD, Книги, Сувениры…
      const cat = catNames[0];
      const kinds = {};
      here.forEach(it => {
        const k = (kinds[it.kind || ''] = kinds[it.kind || ''] || { total: 0, done: 0 });
        k.total++;
        if (counts.has(it.category + '|' + it.name)) k.done++;
      });
      body.replaceChildren(voice, h('p', { class: 'label' }, cat),
        ...Object.entries(kinds).map(([kind, k]) => h('button', { class: 'row', onclick: () => go(screenInvItems, cat, kind || null) },
          h('span', {}, kind || 'Без раздела'), h('span', { class: k.done === k.total ? 'ok-text' : 'muted' }, `${k.done} / ${k.total}`))),
        customBtn);
      return;
    }
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
/** Кнопка сохранения: «Сохранить акт» или «⏳ Сохранить, выход позже», если выход пустой. */
function setSaveLabel(btn, outInput) {
  btn.textContent = outInput.value.trim() === '' ? '⏳ Сохранить, выход позже' : 'Сохранить акт';
}

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
  // Сверху — акты «в работе»: их может закрыть любой бармен
  const openBox = h('div', {});
  const drawOpen = arr => openBox.replaceChildren(...(arr.length ? [
    h('p', { class: 'group' }, `⏳ В работе — впишите выход (${arr.length})`),
    ...arr.map(a => h('button', { class: 'row open-act' + (isLate(a) ? ' late' : ''), onclick: () => go(screenCloseAct, a) },
      h('span', {}, a.act), h('span', { class: 'muted' }, `${fmtDateTime(a.date)} · ${a.name}`))),
  ] : []));
  getOpenActs(false).then(drawOpen);
  getOpenActs(true).then(drawOpen);
  // Пустая заготовка: акта нет, но этикетку печатаем теми же кнопками
  const blank = h('button', { class: 'row', onclick: () => go(screenLabel) },
    h('span', {}, '🏷 Этикетка пустой заготовки'), h('span', { class: 'muted' }, 'название вручную'));
  root.append(openBox, blank, search, list);
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
  let expectedOut = null;

  // Этикетка появляется, как только вписан выход: акт готов.
  // Пока выхода нет — блока нет вообще (печатать нечего).
  const labelSlot = h('div', {});
  let labelBox = null;
  const syncLabel = () => {
    if (!(parseQty(outInput.value) > 0)) {
      if (labelBox) { labelSlot.replaceChildren(); labelBox = null; }
      return;
    }
    if (labelBox) return;
    const labelName = (act.output && act.output.item) || '';
    labelBox = createLabelBox({ name: labelName, madeAt: new Date(), nameEditable: !labelName });
    labelSlot.replaceChildren(labelBox.el);
  };
  outInput.addEventListener('input', syncLabel);

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
    outInput.placeholder = 'пусто = впишу позже';
    outInput.addEventListener('input', () => setSaveLabel(saveBtn, outInput));
    saveBtn.addEventListener('click', async () => {
      const k = parseQty(keyInput.value);
      const later = outInput.value.trim() === '';
      const o = later ? 0 : parseQty(outInput.value);
      if (!(k > 0)) return toast('Введите, сколько было', 'bad');
      if (!later && !(o > 0)) return toast('Проверьте, сколько стало', 'bad');
      saveBtn.disabled = true;
      const madeAt = labelBox ? labelBox.madeAt : new Date();
      await enqueue({ type: 'processing', name: session.name, pin: session.pin, act: act.name, comment: comment.value.trim(),
        pending: later,
        lines: [{ role: 'Сырьё', item: key.item, unit: key.unit, qty: k },
                { role: 'Результат', item: act.output.item, unit: act.output.unit, qty: o }] });
      toast(later ? 'Сохранено. Выход впишете позже в «⏳ В работе»' : 'Акт сохранён');
      if (later) return back();
      // Акт готов — сразу этикетка, чтобы не искать её потом
      stack.pop();
      go(screenActDone, { name: act.output.item || '', madeAt });
    });
    setSaveLabel(saveBtn, outInput);
    root.append(
      h('p', { class: 'label' }, `Было: ${key.item}, ${key.unit}`), keyInput,
      h('p', { class: 'label' }, `Стало: ${act.output.item}, ${act.output.unit}`), outInput,
      h('p', { class: 'muted' }, 'Ещё не готово? Оставьте «стало» пустым — допишете потом.'),
      info, labelSlot, comment, saveBtn);
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
      // Выход не подставляем — только подсказка: его вписывают, когда заготовка готова
      if (act.output.qty > 0) { expectedOut = smartRound(act.output.qty * f); outInput.placeholder = `≈ ${String(expectedOut).replace('.', ',')} по рецепту, или пусто — позже`; }
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
    const later = outInput.value.trim() === '';
    const o = later ? 0 : parseQty(outInput.value);
    if (!later && !(o > 0)) return toast('Проверьте, сколько получилось', 'bad');
    lines.push({ role: 'Результат', item: act.output.item, unit: act.output.unit, qty: o });
    saveBtn.disabled = true;
    const madeAt = labelBox ? labelBox.madeAt : new Date();
    await enqueue({ type: 'processing', name: session.name, pin: session.pin, act: act.name, lines, comment: comment.value.trim(),
      pending: later, expected: later ? expectedOut : null });
    toast(later ? 'Сохранено. Выход впишете позже в «⏳ В работе»' : 'Акт сохранён');
    if (later) return back();
    stack.pop();
    go(screenActDone, { name: act.output.item || '', madeAt });
  });
  outInput.addEventListener('input', () => setSaveLabel(saveBtn, outInput));
  setSaveLabel(saveBtn, outInput);

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
    h('p', { class: 'muted' }, 'Ещё варится? Оставьте пустым — выход впишете потом.'),
    info, labelSlot, comment, saveBtn);
  recalc();
  setTimeout(() => (keyRow.raw || keyRow.amount).focus(), 50);
  return root;
}

// =====================================================================
//  ВИКТОРИНА
//
//  Вопросы приходят с сервера (?action=questions) и ложатся в кэш на
//  телефоне (kv «quiz:questions» вместе с version): без сети играем из
//  кэша. Правильный ответ и пояснение уже есть в самом вопросе, поэтому
//  по ходу партии сеть не нужна.
//
//  «Обжаловать» → POST {action:'dispute'}: вопрос уходит в карантин,
//  жалоба — в лист «Обжалования». Без сети жалоба копится в
//  kv «quiz:disputes» и досылается при следующем запуске и появлении сети.
// =====================================================================
const QUIZ_SIZE = 10;      // вопросов в одной партии
const QUIZ_SECONDS = 30;   // секунд на один вопрос
const QUIZ_CACHE_KEY = 'quiz:questions';
const QUIZ_DISPUTES_KEY = 'quiz:disputes'; // очередь: и обжалования, и результаты
const QUIZ_STATS_KEY = 'quiz:stats';
const QUIZ_LETTERS = ['A', 'B', 'C', 'D'];

/** Короткий уникальный id попытки: он же защищает от двойной записи при обрыве сети. */
function newQuizAttemptId() {
  try {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch (e) { /* старый браузер */ }
  return 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** Перемешивание: каждую партию вопросы идут в новом порядке. */
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** «1 вопрос», «2 вопроса», «5 вопросов» — чтобы на экране не было «10 вопрос». */
function questionsWord(n) {
  const d = n % 10, dd = n % 100;
  if (d === 1 && dd !== 11) return 'вопрос';
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'вопроса';
  return 'вопросов';
}

/**
 * Вопросы: сначала пробуем сервер, при отсутствии сети — кэш на телефоне.
 * Если сервер вернул новую version — обновляем кэш.
 */
async function loadQuizQuestions() {
  const cache = await db.get('kv', QUIZ_CACHE_KEY);
  try {
    const res = await apiGet({ action: 'questions' }, 20000);
    const fresh = Array.isArray(res.questions) ? res.questions : [];
    if (!cache || cache.version !== res.version) {
      await db.put('kv', { version: res.version, questions: fresh, savedAt: new Date().toISOString() }, QUIZ_CACHE_KEY);
    }
    return { questions: fresh, cached: false, version: res.version };
  } catch (e) {
    if (cache && Array.isArray(cache.questions) && cache.questions.length) {
      return { questions: cache.questions, cached: true, version: cache.version };
    }
    throw e;
  }
}

// ---------- Отправка и локальная очередь (обжалования + результаты) ----------

/** Отправить одну жалобу. queued:true — сеть недоступна, повторять позже. */
async function sendQuizDispute(rec) {
  try {
    await apiPost({ action: 'dispute', id: rec.id, employee: rec.employee, answer: rec.answer, comment: rec.comment }, 20000);
    return { ok: true };
  } catch (e) {
    if (e instanceof NetworkError) return { ok: false, queued: true, error: '' };
    // Сервер ответил и отказал (например, нет листов викторины) — повторять бессмысленно
    return { ok: false, queued: false, error: e.message || 'Сервер отклонил обжалование' };
  }
}

/** Отправить результат попытки. Повторный attemptId сервер не задваивает. */
async function sendQuizResult(rec) {
  try {
    const data = await apiPost({
      action: 'quizResult', attemptId: rec.attemptId, employee: rec.employee,
      correct: rec.correct, total: rec.total, seconds: rec.seconds,
      bankVersion: rec.bankVersion || '',
    }, 20000);
    return Object.assign({ ok: true }, data);
  } catch (e) {
    if (e instanceof NetworkError) return { ok: false, queued: true, error: '' };
    return { ok: false, queued: false, error: e.message || 'Сервер отклонил результат' };
  }
}

function sameQuizRecord(a, b) {
  if (a.kind === 'result' || b.kind === 'result') {
    return a.kind === 'result' && b.kind === 'result' && a.attemptId === b.attemptId;
  }
  return a.id === b.id && a.employee === b.employee;
}

async function queueQuizRecord(rec) {
  const list = (await db.get('kv', QUIZ_DISPUTES_KEY)) || [];
  if (list.some(x => sameQuizRecord(x, rec))) return;
  list.push(rec);
  await db.put('kv', list, QUIZ_DISPUTES_KEY);
}

async function removeQuizRecord(rec) {
  const list = (await db.get('kv', QUIZ_DISPUTES_KEY)) || [];
  const left = list.filter(x => !sameQuizRecord(x, rec));
  if (left.length) await db.put('kv', left, QUIZ_DISPUTES_KEY);
  else await db.del('kv', QUIZ_DISPUTES_KEY);
}

function quizStatsFromResponse(employee, res) {
  return {
    employee,
    attempts: Number(res.attempts) || 0,
    best: Number(res.best) || 0,
    bestCorrect: Number(res.bestCorrect) || 0,
    bestTotal: Number(res.bestTotal) || 0,
    average: Number(res.average) || 0,
    lastAt: res.lastAt || '',
  };
}

/** Локальная (оптимистичная) статистика, пока результат ждёт сети. */
function mergeLocalQuizStats(prev, rec) {
  const pct = rec.total > 0 ? rec.correct / rec.total * 100 : 0;
  const attempts = (prev ? prev.attempts : 0) + 1;
  const oldBest = prev ? Number(prev.best) || 0 : -1;
  const better = !prev || pct > oldBest || (pct === oldBest && rec.correct > (prev.bestCorrect || 0));
  return {
    employee: rec.employee,
    attempts,
    best: better ? pct : (prev.best || 0),
    bestCorrect: better ? rec.correct : (prev.bestCorrect || 0),
    bestTotal: better ? rec.total : (prev.bestTotal || 0),
    average: prev && prev.average
      ? Math.round(((prev.average * (attempts - 1)) + pct) / attempts * 10) / 10
      : Math.round(pct * 10) / 10,
    lastAt: new Date().toISOString(),
  };
}

function quizStatsLine(stats) {
  if (!stats || !(stats.attempts > 0)) return '';
  let best = '';
  if (stats.bestTotal) best = `${stats.bestCorrect} из ${stats.bestTotal}`;
  else if (stats.best) best = `${fmtNum(stats.best)}%`;
  return best
    ? `Лучший результат: ${best} · попыток: ${stats.attempts}`
    : `Попыток: ${stats.attempts}`;
}

/** Дослать отложенные жалобы и результаты. Вызывается при старте и появлении сети. */
async function flushQuizDisputes() {
  const list = (await db.get('kv', QUIZ_DISPUTES_KEY)) || [];
  if (!list.length) return;
  const left = [];
  let offline = false;
  for (const rec of list) {
    if (offline) { left.push(rec); continue; }
    const isResult = rec.kind === 'result';
    const res = isResult ? await sendQuizResult(rec) : await sendQuizDispute(rec);
    if (res.ok) {
      if (isResult && session && rec.employee === session.name) {
        await db.put('kv', quizStatsFromResponse(rec.employee, res), QUIZ_STATS_KEY);
      }
      continue;
    }
    if (res.queued) { offline = true; left.push(rec); }       // нет сети — оставляем до следующего раза
    else console.warn(isResult ? 'Результат викторины отклонён:' : 'Обжалование отклонено:', res.error);
  }
  if (left.length) await db.put('kv', left, QUIZ_DISPUTES_KEY);
  else await db.del('kv', QUIZ_DISPUTES_KEY);
}

/** Жалоба на вопрос: сразу на сервер, при отсутствии сети — в очередь на телефоне. */
async function submitQuizDispute(q, letter, comment) {
  const rec = {
    kind: 'dispute',
    id: q.id,
    employee: session ? session.name : '',
    answer: letter ? `${letter}. ${q[letter]}` : 'нет ответа (время вышло)',
    comment: comment || '',
    createdAt: new Date().toISOString(),
  };
  const res = await sendQuizDispute(rec);
  if (res.ok) return { ok: true, queued: false };
  if (res.queued) { await queueQuizRecord(rec); return { ok: true, queued: true }; }
  return res;
}

/**
 * Результат попытки: сначала кладём в IndexedDB (attemptId уже сохранён),
 * потом сразу пытаемся отправить. Нет сети — запись останется до следующего раза.
 */
async function submitQuizAttempt(game) {
  if (game.resultSubmitted) return null;
  game.resultSubmitted = true;
  if (!game.attemptId) game.attemptId = newQuizAttemptId();
  const rec = {
    kind: 'result',
    attemptId: game.attemptId,
    employee: session ? session.name : '',
    correct: game.score,
    total: game.list.length,
    seconds: game.seconds,
    bankVersion: game.bankVersion || '',
    createdAt: new Date().toISOString(),
  };
  if (!rec.employee || !(rec.total > 0)) return { ok: false, error: 'Некого сохранять' };

  await queueQuizRecord(rec);
  const res = await sendQuizResult(rec);
  if (res.ok) {
    await removeQuizRecord(rec);
    const stats = quizStatsFromResponse(rec.employee, res);
    await db.put('kv', stats, QUIZ_STATS_KEY);
    return { ok: true, queued: false, stats };
  }
  if (res.queued) {
    const cached = await db.get('kv', QUIZ_STATS_KEY);
    const prev = cached && cached.employee === rec.employee ? cached : null;
    const stats = mergeLocalQuizStats(prev, rec);
    await db.put('kv', stats, QUIZ_STATS_KEY);
    return { ok: true, queued: true, stats };
  }
  await removeQuizRecord(rec);
  return res;
}

// ---------- Экран 1: старт ----------

function screenQuizStart() {
  const root = h('main', { class: 'screen' }, header('Викторина'));
  const statsEl = h('p', { class: 'quiz-stats hidden' });
  const body = h('div', {}, h('p', { class: 'hint' }, 'Загрузка вопросов…'));
  root.append(statsEl, body);

  // Свой рекорд показываем сразу из кэша, не дожидаясь сети.
  db.get('kv', QUIZ_STATS_KEY).then(stats => {
    if (!stats || stats.employee !== session.name) return;
    const line = quizStatsLine(stats);
    if (!line) return;
    statsEl.textContent = line;
    statsEl.classList.remove('hidden');
  });

  function draw(state) {
    if (!state.questions.length) {
      body.replaceChildren(
        h('p', { class: 'hint' }, 'Вопросов пока нет.'),
        h('p', { class: 'hint left' }, 'Банк вопросов лежит на сервере, в листе «Вопросы». Если викторину только что включили, владельцу нужно один раз запустить setupQuiz() в редакторе Apps Script.'),
        h('button', { class: 'secondary', onclick: retry }, 'Обновить'),
      );
      return;
    }
    const n = Math.min(QUIZ_SIZE, state.questions.length);
    body.replaceChildren(
      h('p', { class: 'quiz-score' }, `${n} ${questionsWord(n)}`),
      h('p', { class: 'muted' }, `Короткая партия: ${QUIZ_SECONDS} секунд на вопрос, один ответ без возврата. После каждого ответа — пояснение и источник, в конце — разбор ошибок.`),
      state.cached ? h('p', { class: 'hint left' }, 'Нет сети — вопросы взяты из кэша на телефоне. Обжалования уйдут, когда появится связь.') : null,
      h('button', {
        class: 'primary',
        onclick: () => {
          const game = {
            list: shuffled(state.questions).slice(0, n), i: 0, score: 0, wrong: [], answered: false,
            startedAt: Date.now(), bankVersion: state.version || '',
            attemptId: '', resultSubmitted: false, seconds: null,
          };
          resetTo(screenQuizQuestion, game);
        },
      }, 'Начать'),
    );
  }

  function retry() {
    body.replaceChildren(h('p', { class: 'hint' }, 'Загрузка вопросов…'));
    loadQuizQuestions().then(draw).catch(showError);
  }

  function showError(e) {
    const oldServer = e instanceof ApiError && /Неизвестное действие/i.test(e.message);
    body.replaceChildren(
      h('p', { class: 'hint' }, oldServer ? 'Сервер пока не умеет отдавать вопросы.' : 'Не удалось загрузить вопросы.'),
      h('p', { class: 'hint left' }, oldServer
        ? 'Похоже, новая версия сервера ещё не развёрнута. Владельцу: выложить проект (clasp push) и обновить развёртывание, затем запустить setupQuiz().'
        : e.message || 'Нет сети, и кэша на телефоне тоже нет.'),
      h('button', { class: 'secondary', onclick: retry }, 'Повторить'),
    );
  }

  loadQuizQuestions().then(draw).catch(showError);
  flushQuizDisputes();
  return root;
}

// ---------- Экран 2: вопрос и таймер ----------

function screenQuizQuestion(game) {
  const root = h('main', { class: 'screen' });
  const q = game.list[game.i];
  const totalMs = QUIZ_SECONDS * 1000;
  let endsAt = Date.now() + totalMs;
  let tick = null;

  const stopTimer = () => { if (tick) { clearInterval(tick); tick = null; } };

  const timeLabel = h('span', { class: 'quiz-time' });
  const bar = h('div', { class: 'quiz-bar' });
  const head = h('div', { class: 'quiz-head' },
    h('span', {}, `Счёт: ${game.score}`),
    timeLabel,
    h('button', {
      class: 'link',
      onclick: () => { if (confirm('Выйти из викторины? Результат этой партии не сохранится.')) { stopTimer(); resetTo(screenHome); } },
    }, 'Выйти'));
  const body = h('div', {});
  root.append(header(`Вопрос ${game.i + 1} из ${game.list.length}`, { showBack: false }), head,
    h('div', { class: 'quiz-timer' }, bar), body);

  const answers = h('div', { class: 'quiz-answers' });
  const buttons = {};
  QUIZ_LETTERS.forEach(L => {
    const b = h('button', { class: 'answer' }, h('span', { class: 'letter' }, L), h('span', {}, q[L]));
    b.addEventListener('click', () => choose(L));
    buttons[L] = b;
    answers.append(b);
  });
  const verdictBox = h('div', {});
  body.append(h('p', { class: 'quiz-q' }, q['вопрос']), answers, verdictBox);

  function paintTimer() {
    const left = Math.max(0, endsAt - Date.now());
    timeLabel.textContent = `${Math.ceil(left / 1000)} с`;
    bar.style.width = `${(left / totalMs) * 100}%`;
    bar.classList.toggle('low', left <= 5000);
  }

  function choose(letter) {
    if (game.answered) return; // ответить дважды нельзя
    game.answered = true;
    stopTimer();
    const correct = q['правильный'];
    const isRight = letter === correct;
    QUIZ_LETTERS.forEach(L => {
      buttons[L].disabled = true;
      if (L === correct) buttons[L].classList.add('correct');
      else if (L === letter) buttons[L].classList.add('wrong');
    });
    if (isRight) game.score++;
    else game.wrong.push({ q, answer: letter });

    const verdict = letter === null ? '⏱ Время вышло' : (isRight ? '✅ Верно' : '❌ Неверно');
    verdictBox.replaceChildren(
      h('p', { class: 'quiz-verdict ' + (isRight ? 'ok' : 'bad') }, verdict),
      h('div', { class: 'quiz-explain' },
        letter !== null && !isRight
          ? h('p', {}, `Правильный ответ: ${correct}. ${q[correct]}`) : null,
        h('p', {}, q['пояснение']),
        h('p', { class: 'quiz-source' }, 'Источник: ' + q['источник'])),
      h('button', { class: 'primary', onclick: next },
        game.i + 1 < game.list.length ? 'Дальше' : 'Показать результат'),
    );
  }

  function next() {
    game.i++;
    game.answered = false;
    if (game.i >= game.list.length) return resetTo(screenQuizResult, game);
    render(); // тот же экран заново: новый вопрос, новый отсчёт
  }

  paintTimer();
  tick = setInterval(() => {
    if (!document.body.contains(root)) { stopTimer(); return; } // экран закрыли — таймер не нужен
    paintTimer();
    if (Date.now() >= endsAt) { stopTimer(); choose(null); }
  }, 100);

  return root;
}

// ---------- Экран 3: результат и обжалования ----------

function screenQuizResult(game) {
  const total = game.list.length;
  if (game.seconds === null || game.seconds === undefined) {
    game.seconds = Math.max(0, Math.min(3600, Math.round((Date.now() - (game.startedAt || Date.now())) / 1000)));
  }
  const root = h('main', { class: 'screen' }, header('Результат', { showBack: false }));
  const wrong = game.wrong;
  const statsBox = h('div', { class: 'quiz-personal hidden' });

  function paintQuizStats(stats, note) {
    const line = quizStatsLine(stats);
    if (!line) return;
    statsBox.replaceChildren(h('p', { class: 'quiz-personal-line' }, line));
    if (note) statsBox.append(h('p', { class: 'quiz-personal-note' }, note));
    statsBox.classList.remove('hidden');
  }

  root.append(
    h('p', { class: 'quiz-score' }, `Правильно ${game.score} из ${total}`),
    statsBox,
  );

  // Сохраняем попытку один раз на игру: attemptId переживает обрыв сети,
  // а сервер отбрасывает повтор с тем же id.
  (async () => {
    try {
      const cached = await db.get('kv', QUIZ_STATS_KEY);
      if (cached && session && cached.employee === session.name) paintQuizStats(cached, '');
      const res = await submitQuizAttempt(game);
      if (!res) return;
      if (res.ok) {
        paintQuizStats(res.stats, res.queued
          ? 'Результат сохранён на телефоне — уйдёт, когда появится сеть.'
          : 'Результат сохранён.');
      } else {
        statsBox.replaceChildren(h('p', { class: 'quiz-personal-note bad' },
          'Не удалось сохранить результат: ' + (res.error || 'ошибка')));
        statsBox.classList.remove('hidden');
      }
    } catch (e) {
      statsBox.replaceChildren(h('p', { class: 'quiz-personal-note bad' },
        'Не удалось сохранить результат: ' + (e.message || 'ошибка')));
      statsBox.classList.remove('hidden');
    }
  })();

  if (!wrong.length) {
    root.append(h('p', { class: 'hint' }, 'Ни одной ошибки — отличное знание меню и стандартов.'));
  } else {
    root.append(
      h('p', { class: 'label' }, `Ошибки: ${wrong.length}`),
      h('p', { class: 'muted' }, 'Считаете вопрос неверным или устаревшим — нажмите «Обжаловать». Вопрос уйдёт на проверку и больше не попадётся игрокам.'),
      h('div', {}, ...wrong.map(wrongCard)),
    );
  }

  root.append(h('button', { class: 'primary', onclick: () => resetTo(screenHome) }, 'На главную'));

  function wrongCard(w) {
    const q = w.q;
    const answerText = w.answer ? `${w.answer}. ${q[w.answer]}` : 'не ответил(а), время вышло';
    const calc = h('div', { class: 'quiz-dispute' });
    const sent = h('p', { class: 'quiz-sent hidden' }, 'Отправлено на проверку');
    const row = h('div', { class: 'quiz-dispute-row hidden' });
    const openBtn = h('button', {
      class: 'secondary',
      onclick: () => {
        openBtn.classList.add('hidden');
        const comment = h('input', { type: 'text', placeholder: 'Комментарий (необязательно)', maxlength: '500' });
        const sendBtn = h('button', { class: 'primary' }, 'Отправить');
        sendBtn.addEventListener('click', async () => {
          sendBtn.disabled = true;
          const res = await submitQuizDispute(q, w.answer, comment.value.trim());
          if (!res.ok) {
            sendBtn.disabled = false;
            return toast(res.error || 'Не удалось отправить обжалование', 'bad');
          }
          row.classList.add('hidden');
          sent.textContent = res.queued ? 'Отправлено на проверку. Уйдёт, когда появится сеть.' : 'Отправлено на проверку';
          sent.classList.remove('hidden');
        });
        comment.addEventListener('keydown', e => { if (e.key === 'Enter') sendBtn.click(); });
        row.replaceChildren(comment, sendBtn);
        row.classList.remove('hidden');
        setTimeout(() => comment.focus(), 50);
      },
    }, 'Обжаловать');

    calc.append(
      h('p', { class: 'quiz-source' }, `Ваш ответ: ${answerText} · Правильный: ${q['правильный']}`),
      h('p', { class: 'quiz-source' }, 'Источник: ' + q['источник']),
      openBtn, row, sent,
    );
    return h('div', { class: 'quiz-wrong' },
      h('p', { class: 'quiz-wrong-q' }, q['вопрос']),
      h('p', { class: 'muted' }, q['пояснение']),
      calc);
  }

  return root;
}


// =====================================================================
//  ДУЭЛЬ
//
//  Два сотрудника, комната по коду. Живого соединения нет: пока открыт
//  экран боя, приложение опрашивает ?action=duelState раз в 3 секунды.
//  Всё, что влияет на исход (время ответа, порядок, урон, HP, Elo),
//  считает сервер. Правильный ответ приходит только после закрытия раунда.
//
//  Таймеры и опрос регистрируются в screenCleanups: render() останавливает
//  их при любом переходе, поэтому утечек нет.
// =====================================================================
const DUEL_POLL_MS = 3000;
const DUEL_POLL_OFFLINE_MS = 5000;
const DUEL_ROUND_MS = 30000;
const DUEL_HP = 10;
const DUEL_LETTERS = ['A', 'B', 'C', 'D'];
const DUEL_ACTIVE_KEY = 'duelActive';

let pendingDuelCode = '';

function duelCodeFromUrl() {
  try {
    const code = (new URL(location.href).searchParams.get('duel') || '').trim().toUpperCase();
    return /^[A-Z0-9]{4,10}$/.test(code) ? code : '';
  } catch (e) {
    return '';
  }
}

/** Ссылка на дуэль: ?duel=КОД — её можно отправить сопернику. */
function duelLink(code) {
  const u = new URL(location.href);
  u.search = '?duel=' + encodeURIComponent(code);
  u.hash = '';
  return u.toString();
}

function duelErrorText(e) {
  if (e instanceof NetworkError) return 'Для дуэли нужен интернет — проверьте связь';
  return e && e.message ? e.message : 'Не удалось связаться с сервером';
}

async function saveDuelActive(duelId, code, role) {
  await db.put('kv', { duelId, code, role, savedAt: new Date().toISOString() }, DUEL_ACTIVE_KEY);
}
async function clearDuelActive() {
  await db.del('kv', DUEL_ACTIVE_KEY);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // Старые браузеры: копируем через скрытое поле
    try {
      const ta = h('textarea', { class: 'hidden' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

/**
 * Опрос состояния. Возвращает { pollNow, stop }.
 * Нет сети — не чаще раза в 5 секунд; появилась сеть — сразу.
 */
function startDuelPoll(duelId, onState, onError) {
  let stopped = false, busy = false, again = false, timer = null;

  const schedule = (ms) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };

  async function run() {
    if (stopped) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const st = await apiGet({ action: 'duelState', duelId, employee: session.name }, 15000);
      busy = false;
      if (stopped) return;
      onState(st);
      schedule(DUEL_POLL_MS);
    } catch (e) {
      busy = false;
      if (stopped) return;
      onError(e);
      schedule(e instanceof NetworkError ? DUEL_POLL_OFFLINE_MS : DUEL_POLL_MS);
    } finally {
      if (again && !stopped) { again = false; schedule(0); }
    }
  }

  const onOnline = () => { if (!stopped) { if (busy) again = true; else schedule(0); } };
  window.addEventListener('online', onOnline);
  run();

  return {
    pollNow: () => { if (!stopped) { if (busy) again = true; else schedule(0); } },
    stop: () => { stopped = true; clearTimeout(timer); window.removeEventListener('online', onOnline); },
  };
}

/** Плитка «Дуэль»: если матч уже идёт — сразу возвращаемся в него. */
async function openDuel() {
  const saved = await db.get('kv', DUEL_ACTIVE_KEY);
  if (saved && saved.duelId) {
    try {
      const st = await apiGet({ action: 'duelState', duelId: saved.duelId, employee: session.name }, 15000);
      if (st.status === 'playing') return go(screenDuelBattle, { duelId: st.duelId, initialState: st });
      if (st.status === 'waiting') return go(screenDuelWait, { duelId: st.duelId, code: st.code, now: st.now, expiresAt: st.deadline });
      if (st.status === 'finished') return go(screenDuelResult, { duelId: st.duelId, initialState: st });
    } catch (e) {
      if (e instanceof ApiError) await clearDuelActive();
      else return toast(duelErrorText(e), 'bad');
    }
  }
  go(screenDuelStart);
}

/** Восстановление после закрытия приложения: матч живёт на сервере. */
let duelRestoring = false;
async function restoreDuelIfAny() {
  if (duelRestoring || !session) return;
  const saved = await db.get('kv', DUEL_ACTIVE_KEY);
  if (!saved || !saved.duelId) return;
  duelRestoring = true;
  try {
    const st = await apiGet({ action: 'duelState', duelId: saved.duelId, employee: session.name }, 15000);
    if (st.status === 'playing') go(screenDuelBattle, { duelId: st.duelId, initialState: st });
    else if (st.status === 'waiting') go(screenDuelWait, { duelId: st.duelId, code: st.code, now: st.now, expiresAt: st.deadline });
    else if (st.status === 'finished') go(screenDuelResult, { duelId: st.duelId, initialState: st });
  } catch (e) {
    if (e instanceof ApiError) await clearDuelActive();
  } finally {
    duelRestoring = false;
  }
}

/** Deep-link ?duel=КОД или возврат в незакрытый матч. */
async function handleDuelEntry() {
  if (!session) return;
  if (pendingDuelCode) {
    const code = pendingDuelCode;
    pendingDuelCode = '';
    return joinDuelByCode(code);
  }
  return restoreDuelIfAny();
}

async function joinDuelByCode(code) {
  try {
    const res = await apiPost({ action: 'duelJoin', employee: session.name, code }, 20000);
    await saveDuelActive(res.duelId, res.code, res.role);
    if (res.status === 'playing') return go(screenDuelBattle, { duelId: res.duelId });
    if (res.status === 'finished') return go(screenDuelResult, { duelId: res.duelId });
    return go(screenDuelWait, { duelId: res.duelId, code: res.code, now: res.now, expiresAt: res.now + 2 * 60 * 1000 });
  } catch (e) {
    toast(duelErrorText(e), 'bad');
    go(screenDuelStart, { code });
  }
}

async function loadDuelRatingCard(box) {
  try {
    const r = await apiGet({ action: 'duelRating', employee: session.name }, 15000);
    box.replaceChildren(
      h('div', { class: 'duel-rating-line' },
        h('span', { class: 'duel-rating-num' }, String(r.rating)),
        h('span', { class: 'duel-rating-label' }, 'рейтинг')),
      h('p', { class: 'muted' }, r.matches
        ? `${r.matches} ${r.matches === 1 ? 'матч' : (r.matches < 5 ? 'матча' : 'матчей')} · место ${r.place} из ${r.players}`
        : 'Матчей ещё нет — стартовый рейтинг 1000'),
    );
  } catch (e) {
    box.replaceChildren(h('p', { class: 'muted' }, e instanceof NetworkError
      ? 'Рейтинг: нет связи'
      : 'Рейтинг пока недоступен'));
  }
}

// ---------- Экран 1: создание и вход по коду ----------

function screenDuelStart(prefill = {}) {
  const root = h('main', { class: 'screen' }, header('Дуэль'));
  const ratingBox = h('div', { class: 'duel-rating-card' }, h('p', { class: 'muted' }, 'Рейтинг загружается…'));
  const codeInput = h('input', {
    type: 'text', class: 'duel-code-input', maxlength: '10', placeholder: 'КОД',
    autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
    value: prefill.code || '',
  });
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  });
  const createBtn = h('button', { class: 'primary' }, 'Создать дуэль');
  const joinBtn = h('button', { class: 'secondary' }, 'Присоединиться');

  createBtn.addEventListener('click', async () => {
    if (createBtn.disabled) return;
    createBtn.disabled = true;
    try {
      const res = await apiPost({ action: 'duelCreate', employee: session.name }, 20000);
      await saveDuelActive(res.duelId, res.code, res.role);
      go(screenDuelWait, { duelId: res.duelId, code: res.code, now: res.now, expiresAt: res.expiresAt });
    } catch (e) {
      createBtn.disabled = false;
      toast(duelErrorText(e), 'bad');
    }
  });

  joinBtn.addEventListener('click', async () => {
    const code = codeInput.value.trim().toUpperCase();
    if (!code) { codeInput.focus(); return toast('Введите код комнаты', 'bad'); }
    if (joinBtn.disabled) return;
    joinBtn.disabled = true;
    try {
      const res = await apiPost({ action: 'duelJoin', employee: session.name, code }, 20000);
      await saveDuelActive(res.duelId, res.code, res.role);
      if (res.status === 'playing') go(screenDuelBattle, { duelId: res.duelId });
      else if (res.status === 'finished') go(screenDuelResult, { duelId: res.duelId });
      else go(screenDuelWait, { duelId: res.duelId, code: res.code, now: res.now, expiresAt: res.now + 2 * 60 * 1000 });
    } catch (e) {
      joinBtn.disabled = false;
      toast(duelErrorText(e), 'bad');
    }
  });

  root.append(
    h('p', { class: 'hint left' }, 'Дуэль двух сотрудников: по 10 HP, 30 секунд на вопрос, правильный ответ отнимает 1 HP. Второй успел ответить правильно за 7 секунд — блок. Матч до 0 HP или 15 раундов. Нужен интернет.'),
    ratingBox,
    createBtn,
    h('p', { class: 'label' }, 'Присоединиться по коду'),
    codeInput,
    joinBtn,
    h('p', { class: 'muted' }, 'Код действует 2 минуты после создания. Ссылку с кодом можно отправить сопернику.'),
  );
  loadDuelRatingCard(ratingBox);
  return root;
}

// ---------- Экран 2: ожидание соперника ----------

function screenDuelWait({ duelId, code, now, expiresAt }) {
  const root = h('main', { class: 'screen' }, header('Ожидание соперника'));
  let offset = (now || Date.now()) - Date.now();
  let deadline = expiresAt || (Date.now() + 2 * 60 * 1000);

  const codeEl = h('p', { class: 'duel-big-code' }, code);
  const timerEl = h('p', { class: 'duel-wait-timer' }, '2:00');
  const bar = h('div', { class: 'duel-timer-bar' });
  const linkHint = h('p', { class: 'muted duel-link-text' }, duelLink(code));
  const copyBtn = h('button', { class: 'primary' }, 'Скопировать ссылку');
  const cancelBtn = h('button', { class: 'danger' }, 'Отменить');
  const netEl = h('p', { class: 'duel-net hidden' });

  copyBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(duelLink(code));
    toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать — отправьте код вручную', ok ? 'ok' : 'bad');
  });

  cancelBtn.addEventListener('click', async () => {
    if (cancelBtn.disabled) return;
    cancelBtn.disabled = true;
    try {
      await apiGet({ action: 'duelCancel', duelId, employee: session.name }, 15000);
      await clearDuelActive();
      toast('Ожидание отменено');
      resetTo(screenHome);
    } catch (e) {
      cancelBtn.disabled = false;
      toast(duelErrorText(e), 'bad');
    }
  });

  let expiredShown = false;
  const tick = setInterval(() => {
    const left = Math.max(0, deadline - (Date.now() + offset));
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    bar.style.width = `${Math.min(100, (left / (2 * 60 * 1000)) * 100)}%`;
    bar.classList.toggle('low', left <= 15000);
    if (left <= 0 && !expiredShown) {
      expiredShown = true;
      timerEl.textContent = '0:00';
      netEl.textContent = 'Время ожидания истекло. Создайте новую комнату.';
      netEl.classList.remove('hidden');
    }
  }, 250);
  registerCleanup(() => clearInterval(tick));

  let poll = null;
  poll = startDuelPoll(duelId, (st) => {
    netEl.classList.add('hidden');
    offset = st.now - Date.now();
    deadline = st.deadline || deadline;
    if (st.status === 'playing') {
      if (poll) poll.stop();
      saveDuelActive(duelId, code, 1);
      go(screenDuelBattle, { duelId });
    } else if (st.status === 'finished') {
      if (poll) poll.stop();
      go(screenDuelResult, { duelId });
    }
  }, (e) => {
    if (e instanceof ApiError) {
      if (e.code === 'expired' || e.code === 'notfound' || e.code === 'auth') {
        clearDuelActive();
        if (poll) poll.stop();
      }
      netEl.textContent = e.message;
      netEl.classList.remove('hidden');
    } else {
      netEl.textContent = 'Нет связи — ждём сервер…';
      netEl.classList.remove('hidden');
    }
  });
  registerCleanup(() => { if (poll) poll.stop(); });

  root.append(
    h('p', { class: 'label' }, 'Код комнаты'),
    codeEl,
    linkHint,
    copyBtn,
    h('p', { class: 'label' }, 'Соперник подключится'),
    timerEl,
    h('div', { class: 'duel-timer' }, bar),
    h('p', { class: 'muted' }, 'Пока ждём — отправьте сопернику код или ссылку. Через 2 минуты комната закроется.'),
    netEl,
    cancelBtn,
  );
  return root;
}

// ---------- Экран 3: бой ----------

function duelRoundVerdict(lr) {
  if (!lr) return { text: 'Раунд закрыт', cls: '' };
  if (lr.blocked) return { text: '🛡 Блок — урона нет', cls: 'ok' };
  if (lr.damage === 'me') return { text: 'Урон вам: −1 HP', cls: 'bad' };
  if (lr.damage === 'opponent') return { text: 'Вы нанесли урон: −1 HP сопернику', cls: 'ok' };
  if (lr.timeout) return { text: '⏱ Никто не ответил — урона нет', cls: '' };
  return { text: 'Урона нет', cls: '' };
}

function screenDuelBattle({ duelId, initialState }) {
  // Кнопка «Назад» остаётся: матч живёт на сервере, вернуться можно с главной.
  const root = h('main', { class: 'screen duel-screen' }, header('Дуэль'));

  const oppName = h('div', { class: 'duel-name' });
  const oppMeta = h('div', { class: 'duel-meta' });
  const oppHpText = h('span', { class: 'duel-hp-text' });
  const oppBar = h('div', { class: 'duel-hp-bar' });
  const myName = h('div', { class: 'duel-name' });
  const myMeta = h('div', { class: 'duel-meta' });
  const myHpText = h('span', { class: 'duel-hp-text' });
  const myBar = h('div', { class: 'duel-hp-bar' });
  const roundLabel = h('span', { class: 'duel-round-label' }, 'Раунд');
  const timeLabel = h('span', { class: 'duel-time' }, '—');
  const timerBar = h('div', { class: 'duel-timer-bar' });
  const oppStatus = h('div', { class: 'duel-opp-status' });
  const questionEl = h('div', { class: 'duel-question' });
  const answersEl = h('div', { class: 'duel-answers' });
  const resultEl = h('div', { class: 'duel-round-result hidden' });
  const netEl = h('p', { class: 'duel-net hidden' });

  const buttons = {};
  DUEL_LETTERS.forEach(L => {
    const text = h('span', { class: 'duel-answer-text' });
    const b = h('button', { class: 'answer' }, h('span', { class: 'letter' }, L), text);
    b.addEventListener('click', () => sendAnswer(L));
    buttons[L] = b;
    answersEl.append(b);
  });

  let state = initialState && initialState.status === 'playing' ? initialState : null;
  let offset = state ? state.now - Date.now() : 0;
  let deadline = state && state.question ? state.deadline : 0;
  let shownRound = 0;
  let sending = false;
  let navigating = false;
  let poll = null;

  function setButtonsDisabled(disabled) {
    DUEL_LETTERS.forEach(L => { buttons[L].disabled = disabled; });
  }

  function paintTimer() {
    if (!state) return;
    if (!state.question) {
      timeLabel.textContent = 'Разбор';
      timerBar.style.width = '100%';
      timerBar.classList.remove('low');
      return;
    }
    const left = Math.max(0, deadline - (Date.now() + offset));
    timeLabel.textContent = `${Math.ceil(left / 1000)} с`;
    timerBar.style.width = `${Math.max(0, Math.min(100, (left / DUEL_ROUND_MS) * 100))}%`;
    timerBar.classList.toggle('low', left <= 5000);
  }
  const timer = setInterval(paintTimer, 200);
  registerCleanup(() => clearInterval(timer));

  function setHp(bar, text, hp) {
    const v = Math.max(0, Number(hp) || 0);
    bar.style.width = `${(v / DUEL_HP) * 100}%`;
    bar.classList.toggle('low', v <= 3);
    text.textContent = `${v} / ${DUEL_HP}`;
  }

  function paintQuestion(st) {
    const q = st.question;
    questionEl.replaceChildren(
      h('p', { class: 'duel-cat' }, q['категория'] || ''),
      h('p', { class: 'quiz-q duel-q' }, q['вопрос']),
    );
    DUEL_LETTERS.forEach(L => {
      buttons[L].querySelector('.duel-answer-text').textContent = q[L] || '';
      buttons[L].classList.remove('correct', 'wrong', 'picked');
      buttons[L].disabled = false;
    });
    if (st.myAnswer) {
      buttons[st.myAnswer].classList.add('picked');
      setButtonsDisabled(true);
    }
  }

  function paintResult(lr) {
    if (!lr) {
      resultEl.replaceChildren(h('p', { class: 'muted' }, 'Раунд закрыт'));
      return;
    }
    const v = duelRoundVerdict(lr);
    const mine = lr.myChoice ? `${lr.myChoice}` : '—';
    const theirs = lr.oppChoice ? `${lr.oppChoice}` : (lr.oppAnswered ? '—' : 'не ответил');
    resultEl.replaceChildren(
      h('p', { class: 'duel-verdict ' + v.cls }, v.text),
      h('p', { class: 'duel-correct' }, `Правильный ответ: ${lr.correct}. ${lr.correctText}`),
      h('p', { class: 'muted' }, `Вы: ${mine} · Соперник: ${theirs}`),
      lr.explanation ? h('p', { class: 'duel-explain' }, lr.explanation) : null,
    );
  }

  function applyState(st) {
    if (navigating) return;
    netEl.classList.add('hidden');
    offset = st.now - Date.now();

    if (st.status === 'finished') {
      navigating = true;
      clearDuelActive();
      if (poll) poll.stop();
      return go(screenDuelResult, { duelId: st.duelId, initialState: st });
    }
    if (st.status === 'waiting') {
      navigating = true;
      if (poll) poll.stop();
      return go(screenDuelWait, { duelId: st.duelId, code: st.code, now: st.now, expiresAt: st.deadline });
    }

    state = st;

    oppName.textContent = st.opponent || 'Соперник';
    oppMeta.textContent = st.oppRating ? `рейтинг ${st.oppRating}` : '';
    myName.textContent = st.myName;
    myMeta.textContent = st.myRating ? `рейтинг ${st.myRating}` : '';
    setHp(oppBar, oppHpText, st.oppHp);
    setHp(myBar, myHpText, st.myHp);
    roundLabel.textContent = `Раунд ${st.round} из ${st.maxRounds}`;

    if (st.question) {
      deadline = st.deadline;
      questionEl.classList.remove('hidden');
      answersEl.classList.remove('hidden');
      resultEl.classList.add('hidden');
      if (shownRound !== st.round) { shownRound = st.round; paintQuestion(st); }
      if (st.myAnswer) {
        buttons[st.myAnswer].classList.add('picked');
        setButtonsDisabled(true);
      } else if (!sending) {
        setButtonsDisabled(false);
      }
      oppStatus.textContent = st.oppAnswered ? 'Соперник ответил' : 'Соперник думает…';
      oppStatus.classList.toggle('done', !!st.oppAnswered);
    } else {
      questionEl.classList.add('hidden');
      answersEl.classList.add('hidden');
      resultEl.classList.remove('hidden');
      oppStatus.textContent = '';
      oppStatus.classList.remove('done');
      paintResult(st.lastRound);
    }
    paintTimer();
  }

  async function sendAnswer(choice) {
    if (sending || navigating || !state || !state.question || state.myAnswer) return;
    const round = state.round;
    sending = true;
    setButtonsDisabled(true);
    buttons[choice].classList.add('picked');
    netEl.textContent = 'Ответ отправлен…';
    netEl.classList.remove('hidden');
    try {
      await apiPost({ action: 'duelAnswer', duelId, employee: session.name, round, choice }, 15000);
      netEl.textContent = 'Ответ принят — ждём соперника';
    } catch (e) {
      if (e instanceof ApiError) {
        netEl.textContent = e.message;
        toast(e.message, 'bad');
      } else {
        netEl.textContent = 'Нет связи — проверяем, дошёл ли ответ…';
        toast('Нет связи — проверяем ответ', 'bad');
      }
    } finally {
      sending = false;
      if (poll) poll.pollNow();
    }
  }

  const oppSide = h('div', { class: 'duel-side opp' },
    h('div', { class: 'duel-side-head' }, h('div', {}, oppName, oppMeta), oppHpText),
    h('div', { class: 'duel-hp' }, oppBar));
  const mySide = h('div', { class: 'duel-side me' },
    h('div', { class: 'duel-side-head' }, h('div', {}, myName, myMeta), myHpText),
    h('div', { class: 'duel-hp' }, myBar));

  root.append(
    oppSide,
    h('div', { class: 'duel-roundline' }, roundLabel, timeLabel),
    h('div', { class: 'duel-timer' }, timerBar),
    oppStatus,
    questionEl,
    answersEl,
    resultEl,
    netEl,
    mySide,
  );

  const stop = startDuelPoll(duelId, applyState, (e) => {
    if (e instanceof ApiError) {
      if (e.code === 'notfound' || e.code === 'expired' || e.code === 'auth') {
        navigating = true;
        clearDuelActive();
        toast(e.message, 'bad');
        resetTo(screenHome);
        return;
      }
      netEl.textContent = e.message;
    } else {
      netEl.textContent = 'Нет связи — ждём сервер…';
    }
    netEl.classList.remove('hidden');
  });
  poll = stop;
  registerCleanup(() => stop.stop());

  if (state) applyState(state);
  else {
    questionEl.replaceChildren(h('p', { class: 'hint' }, 'Загрузка матча…'));
    netEl.textContent = 'Соединяемся с сервером…';
    netEl.classList.remove('hidden');
  }
  return root;
}

// ---------- Экран 4: результат ----------

function screenDuelResult({ duelId, initialState }) {
  const root = h('main', { class: 'screen' }, header('Результат', { showBack: false }));
  const body = h('div', { class: 'duel-result' }, h('p', { class: 'hint' }, 'Загрузка результата…'));
  root.append(body);

  function draw(st) {
    clearDuelActive();
    const r = st.result || { winner: 'draw', myHp: st.myHp, oppHp: st.oppHp, rounds: st.round };
    const title = r.winner === 'me' ? 'Победа' : r.winner === 'opponent' ? 'Поражение' : 'Ничья';
    const cls = r.winner === 'me' ? 'ok' : r.winner === 'opponent' ? 'bad' : '';
    const rating = st.rating;
    const delta = rating ? rating.delta : null;
    const ratingLine = rating
      ? h('p', { class: 'duel-rating-change ' + (delta > 0 ? 'ok' : delta < 0 ? 'bad' : '') },
        `Рейтинг: ${rating.before} → ${rating.after}`,
        h('span', { class: 'duel-delta' }, `${delta >= 0 ? '+' : ''}${delta}`))
      : h('p', { class: 'muted' }, 'Рейтинг не изменился');

    body.replaceChildren(
      h('p', { class: 'duel-result-title ' + cls }, title),
      h('p', { class: 'duel-score-big' }, `${r.myHp} : ${r.oppHp}`),
      h('p', { class: 'muted' }, `${st.myName} · ${st.opponent}`),
      h('p', { class: 'muted' }, `Раундов: ${r.rounds}`),
      h('div', { class: 'duel-rating-card' },
        h('p', { class: 'label' }, 'Ваш рейтинг'), ratingLine,
        st.oppRatingChange !== null && st.oppRatingChange !== undefined
          ? h('p', { class: 'muted' }, `Соперник: ${st.oppRatingChange >= 0 ? '+' : ''}${st.oppRatingChange}`) : null),
      h('button', { class: 'primary', onclick: () => go(screenDuelStart) }, 'Ещё раз'),
      h('button', { class: 'secondary', onclick: () => resetTo(screenHome) }, 'На главную'),
    );
  }

  if (initialState && initialState.status === 'finished') {
    draw(initialState);
  } else {
    apiGet({ action: 'duelState', duelId, employee: session.name }, 15000)
      .then(st => {
        if (st.status !== 'finished') {
          body.replaceChildren(
            h('p', { class: 'hint' }, 'Матч ещё не закончен.'),
            h('button', { class: 'primary', onclick: () => go(screenDuelBattle, { duelId }) }, 'Вернуться в бой'),
            h('button', { class: 'secondary', onclick: () => resetTo(screenHome) }, 'На главную'),
          );
          return;
        }
        draw(st);
      })
      .catch(e => {
        body.replaceChildren(
          h('p', { class: 'hint' }, e instanceof NetworkError
            ? 'Нет связи — результат подтянется, когда появится интернет.'
            : 'Не удалось загрузить результат: ' + e.message),
          h('button', { class: 'secondary', onclick: () => render() }, 'Повторить'),
          h('button', { class: 'secondary', onclick: () => resetTo(screenHome) }, 'На главную'),
        );
      });
  }
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
    return `Переработка · ${r.act} · ${first ? first.qty + ' ' + first.unit : ''} → ${r.pending ? '⏳ выход позже' : res ? res.qty + ' ' + res.unit : ''}`;
  }
  if (r.type === 'processingClose') return `Закрытие акта · ${r.act} · выход ${r.qty} ${r.unit}`;
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
  // Ссылка вида …?duel=КОД: запоминаем код и убираем его из адреса,
  // чтобы обновление страницы не начинало вход заново.
  pendingDuelCode = duelCodeFromUrl();
  if (pendingDuelCode) {
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* не критично */ }
  }

  // Просим браузер не удалять наши данные при нехватке места (особенно важно на iPhone)
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // Service Worker — сохраняет само приложение на телефоне, чтобы оно открывалось без сети
  if ('serviceWorker' in navigator) {
    // Когда пришла новая версия приложения — один раз перезагружаемся, чтобы сразу её показать
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('./sw.js')
      .then(reg => reg.update())       // проверяем обновление при каждом открытии
      .catch(e => console.warn(e));
  }

  session = (await db.get('kv', 'session')) || null;
  onSyncChange(renderStatus);

  config = (await db.get('kv', 'config')) || null;
  applyTheme();
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
  // Обжалования викторины, скопившиеся без сети, — досылаем при запуске и появлении сети
  window.addEventListener('online', () => { flushQuizDisputes(); });
  flushQuizDisputes();
  renderStatus(await getStatus());
  // Вернулись в приложение — восстанавливаем незакрытую дуэль (или переходим по ссылке)
  handleDuelEntry();
}

start();
