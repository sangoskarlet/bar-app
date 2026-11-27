// =====================================================================
//  ИСТОРИЯ ФОТО: ПОРЯДОК ПО ДАТАМ, ГРУППИРОВКА ПО ДНЯМ
//
//  Поднимает настоящий Chrome в headless-режиме, открывает демо-сервер
//  (tools/demo-server.mjs) в окне 375×812 и проверяет:
//    1) история идёт по дате снимка, новые сверху; критичный вчерашний
//       снимок стоит НИЖЕ сегодняшнего с «чисто»;
//    2) заголовки дней «Сегодня» / «Вчера» / «24 ноября»;
//    3) внутри прохода кадры идут в порядке съёмки;
//    4) лимит обрезает ПОСЛЕ сортировки по дате (старые критичные не
//       всплывают наверх и не попадают в показ);
//    5) пустое состояние.
//
//  Скриншоты кладутся в docs/photo-history/.
//  Запуск: node tools/screenshot-photo-history.mjs
//  Требует уже запущенный demo-server на 127.0.0.1:8799.
// =====================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'photo-history');
const DEMO = 'http://127.0.0.1:8799';
const PORT = 9334;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VIEW = { width: 375, height: 812 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error('ПРОВЕРКА НЕ ПРОЙДЕНА: ' + msg); };

// ---------- кадры для живого прохода (реальные фото) ----------
const IMGS = [
  path.join(ROOT, 'docs', 'photo-check', 'test', 'ref1-bar-tallin.jpg'),
  path.join(ROOT, 'docs', 'photo-check', 'test', 'ref2-bar-royaloak.jpg'),
  path.join(ROOT, 'docs', 'photo-check', 'test', 'shift-dirty-dishes.jpg'),
];
const TMP_IMGS = IMGS.map((src, i) => {
  const dst = path.join(os.tmpdir(), 'photo-history-shot' + (i + 1) + path.extname(src));
  fs.copyFileSync(src, dst);
  return dst;
});

// ---------- минимальный CDP-клиент ----------
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 30000);
    });
  }
}

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-history-chrome-'));
  const args = [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--disable-extensions', '--disable-background-networking', '--disable-breakpad',
    '--force-device-scale-factor=1',
    '--window-size=' + VIEW.width + ',' + VIEW.height, 'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  proc.on('error', e => { console.error('Не удалось запустить Chrome:', e.message); process.exit(1); });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      const j = await res.json();
      return { proc, profile, wsUrl: j.webSocketDebuggerUrl };
    } catch (e) { await sleep(250); }
  }
  throw new Error('Chrome не поднялся на порту ' + PORT);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { proc, profile, wsUrl } = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });

  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.text || '') + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result ? r.result.value : undefined;
  };
  const waitFor = async (expression, timeout = 20000, label = '') => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evaluate('(() => { try { return !!(' + expression + '); } catch (e) { return false; } })()')) return true;
      await sleep(120);
    }
    throw new Error('Не дождались: ' + (label || expression));
  };
  const clickText = async (text, tag = 'button') => {
    const ok = await evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(tag)})]
        .find(b => (b.textContent || '').trim().replace(/\\s+/g, ' ').includes(${JSON.stringify(text)}));
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`);
    if (!ok) throw new Error('Не нашли кнопку «' + text + '»');
    await sleep(250);
  };
  const shot = async name => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
    console.log('✓ ' + path.relative(ROOT, path.join(OUT, name)));
  };
  // Длинный снимок всей истории: высота страницы, а не окна.
  const shotFull = async name => {
    // Полоска «Всё отправлено» приклеена к низу окна и на длинном снимке
    // закрыла бы строку истории — на время снимка её убираем.
    await evaluate(`(() => { const s = document.getElementById('status'); if (s) s.style.display = 'none'; return true; })()`);
    const m = await send('Page.getLayoutMetrics');
    const size = m.cssContentSize || m.contentSize;
    const height = Math.min(Math.ceil(size.height), 4000);
    const { data } = await send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: VIEW.width, height, scale: 1 },
    });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
    await evaluate(`(() => { const s = document.getElementById('status'); if (s) s.style.display = ''; return true; })()`);
    console.log('✓ ' + path.relative(ROOT, path.join(OUT, name)) + ' (' + VIEW.width + '×' + height + ')');
  };
  const setFile = async file => {
    const { root } = await send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await send('DOM.querySelector', {
      nodeId: root.nodeId, selector: 'input[type=file][capture]',
    });
    if (!nodeId) throw new Error('Не нашли поле камеры');
    await send('DOM.setFileInputFiles', { nodeId, files: [file] });
  };
  const goto = async url => {
    await send('Page.navigate', { url });
    await waitFor('document.readyState === "complete"', 20000, 'загрузка страницы');
    await sleep(400);
  };

  // Снимок истории в структуре: заголовок дня и строки в порядке экрана.
  const readHistory = () => evaluate(`(() => {
    const list = document.querySelector('.photo-hist-list');
    if (!list) return { seq: [], days: [], rows: [] };
    const seq = [...list.children].map(el => el.classList.contains('photo-hist-day')
      ? { day: el.textContent.trim() }
      : {
          row: el.className,
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
          frames: [...el.querySelectorAll('.photo-run-group-row')].map(r => ({
            no: (r.querySelector('.photo-run-group-no') || {}).textContent || '',
            zone: (r.querySelector('.photo-run-group-zone') || {}).textContent || '',
          })),
        });
    const rows = [];
    let day = '';
    for (const x of seq) {
      if (x.day) day = x.day;
      else if (x.row) rows.push(Object.assign({ day: day }, x));
    }
    return { seq: seq, days: seq.filter(x => x.day).map(x => x.day), rows: rows };
  })()`);
  // Минуты из строки «дд.мм чч:мм» — для проверки «внутри дня новые сверху».
  const minutesOf = text => {
    const m = /(\d{2}):(\d{2})/.exec(text || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  };

  // Открыть историю: главная → «Фото уборки» → «История снимков».
  const openHistory = async () => {
    await goto(DEMO + '/');
    await waitFor('[...document.querySelectorAll(".tile")].some(b => b.textContent.includes("Фото уборки"))', 20000, 'главная');
    await clickText('Фото уборки');
    await waitFor('[...document.querySelectorAll(".floor-btn")].length > 0', 15000, 'этажи');
    await clickText('История снимков');
    await waitFor('document.querySelector(".photo-hist-list")', 15000, 'экран истории');
  };

  try {
    // ---------- 0. Вход ----------
    await fetch(DEMO + '/__state?photodates=off&resetphotos&rememberphotos=0');
    await goto(DEMO + '/');
    await waitFor('[...document.querySelectorAll("button.chip")].some(b => b.textContent.includes("Анна"))', 20000, 'экран входа');
    await clickText('Анна');
    await evaluate(`(() => {
      const pin = document.querySelector('input.pin');
      pin.value = '1234';
      pin.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await clickText('Войти');
    await waitFor('[...document.querySelectorAll(".tile")].some(b => b.textContent.includes("Фото уборки"))', 20000, 'главная');

    // ---------- 1. История по датам + группировка по дням ----------
    await fetch(DEMO + '/__state?photodates=days&resetphotos');
    await openHistory();
    await waitFor('document.querySelectorAll(".photo-hist-day").length >= 7 && document.querySelectorAll(".photo-hist-row").length >= 8', 20000, 'история с днями');
    await sleep(300);

    let hist = await readHistory();
    let { days, rows } = hist;
    assert(days[0] === 'Сегодня', 'первый заголовок — «Сегодня», получили: ' + JSON.stringify(days));
    assert(days[1] === 'Вчера', 'второй заголовок — «Вчера», получили: ' + JSON.stringify(days));
    assert(days.length === 7, 'в истории 7 дней, получили: ' + days.length + ' (' + JSON.stringify(days) + ')');

    // Первая строка — сегодняшний чистый одиночный снимок.
    assert(rows[0] && rows[0].row.includes('ok'), 'первая строка — «чисто», получили: ' + JSON.stringify(rows[0]));
    assert(/чисто/.test(rows[0].text), 'в первой строке бейдж «чисто»: ' + rows[0].text);
    assert(rows[0].day === 'Сегодня', 'чистый снимок — под «Сегодня»');

    // Группа из трёх кадров сегодня, кадры — в порядке съёмки.
    const runIdx = rows.findIndex(x => x.frames.length === 3);
    assert(runIdx > 0, 'нашли группу из трёх кадров');
    assert(rows[runIdx].day === 'Сегодня', 'группа из трёх кадров — под «Сегодня», а не ' + rows[runIdx].day);
    assert(rows[runIdx].frames.map(f => f.zone).join(' | ') === 'Бар | Холодильники | За баром',
      'кадры в порядке съёмки: ' + JSON.stringify(rows[runIdx].frames));
    assert(rows[runIdx].frames.map(f => f.no).join('') === '123', 'номера кадров 1, 2, 3');

    // Критичный вчерашний снимок — НИЖЕ сегодняшнего чистого.
    const critIdx = rows.findIndex(x => x.row.includes('crit') && /Окно/.test(x.text));
    assert(critIdx > 0, 'критичный вчерашний снимок не первый, индекс: ' + critIdx);
    assert(rows[critIdx].day === 'Вчера', 'критичный снимок стоит под «Вчера», а не ' + rows[critIdx].day);
    assert(critIdx > runIdx, 'критичный вчерашний снимок ниже сегодняшней группы');
    assert(/критично/.test(rows[critIdx].text), 'у вчерашнего снимка виден бейдж «критично»');

    // Внутри каждого дня — тоже от новых к старым.
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].day !== rows[i - 1].day) continue;
      assert(minutesOf(rows[i - 1].text) >= minutesOf(rows[i].text),
        'внутри дня время не растёт: ' + minutesOf(rows[i - 1].text) + ' → ' + minutesOf(rows[i].text));
    }
    console.log('✓ порядок по датам: первый — сегодняшний «чисто», вчерашний «критично» ниже');

    await shotFull('01-history-days-375.png');
    await shot('02-crit-yesterday-not-first-375.png');
    // ---------- 2. Пустое состояние ----------
    await fetch(DEMO + '/__state?photodates=empty&resetphotos');
    await openHistory();
    await waitFor('document.querySelector(".photo-hist-empty")', 20000, 'пустая история');
    const emptyText = await evaluate('document.querySelector(".photo-hist-empty").textContent.trim()');
    assert(emptyText === 'Пока нет снимков', 'пустое состояние: ' + emptyText);
    console.log('✓ пустое состояние: «' + emptyText + '»');
    await shot('04-history-empty-375.png');

    // ---------- 3. Лимит: обрезка ПОСЛЕ сортировки по дате ----------
    await fetch(DEMO + '/__state?photodates=many&resetphotos');
    await openHistory();
    await waitFor('document.querySelectorAll(".photo-hist-row").length === 30', 20000, '30 строк истории');
    const many = await readHistory();
    const manyRows = many.rows;
    assert(manyRows.length === 30, 'показано 30 проходов, получили: ' + manyRows.length);
    assert(manyRows.filter(x => x.row.includes('crit')).length === 0,
      'старые критичные (вне последних 30) не всплыли наверх и не показаны');
    assert(manyRows[0].row.includes('ok') || manyRows[0].row.includes('warn'), 'первая строка — самая новая');
    console.log('✓ лимит: 30 последних по дате, старые критичные не показаны');

    // ---------- 4. Новый проход из трёх кадров на своём месте ----------
    await fetch(DEMO + '/__state?photodates=daysold&resetphotos&rememberphotos=1');
    await goto(DEMO + '/');
    await waitFor('[...document.querySelectorAll(".tile")].some(b => b.textContent.includes("Фото уборки"))', 20000, 'главная');
    await clickText('Фото уборки');
    await waitFor('[...document.querySelectorAll(".floor-btn")].length > 0', 15000, 'этажи');
    await clickText('1 этаж', '.floor-name');
    await waitFor('document.querySelector(".photo-shutter")', 15000, 'экран съёмки');
    for (const img of TMP_IMGS) {
      const n = await evaluate('document.querySelectorAll(".photo-shot-grid .photo-shot-slot").length');
      await setFile(img);
      await waitFor('document.querySelectorAll(".photo-shot-grid .photo-shot-slot").length === ' + (n + 1), 15000, 'кадр ' + (n + 1));
    }
    await clickText('Отправить');
    await waitFor('document.querySelector(".photo-run-list") && document.querySelectorAll(".photo-run-row").length === 3', 40000, 'сводка');
    await clickText('История снимков');
    await waitFor('document.querySelectorAll(".photo-hist-row").length === 7 && document.querySelectorAll(".photo-run-group-row").length === 3', 20000, 'история с новым проходом');
    await sleep(500);
    const fresh = await readHistory();
    const freshRows = fresh.rows;
    const freshRun = freshRows.findIndex(x => x.frames.length === 3);
    assert(freshRun === 0, 'новый проход — первая строка истории, а не ' + freshRun);
    assert(freshRows[freshRun].day === 'Сегодня', 'новый проход — под «Сегодня»');
    assert(freshRows[freshRun].frames.map(f => f.zone).join(' | ') === 'Бар | Холодильники | За баром',
      'кадры нового прохода по порядку: ' + JSON.stringify(freshRows[freshRun].frames));
    console.log('✓ новый проход из трёх кадров стоит первым под «Сегодня»');
    await shot('03-history-new-run-375.png');

    ws.close();
    proc.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* профиль временный */ }
    console.log('Готово: ' + path.relative(ROOT, OUT));
  } catch (e) {
    try {
      const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(OUT, '99-error.png'), Buffer.from(data, 'base64'));
      console.error('ТЕКСТ ЭКРАНА:\n' + await evaluate('document.body.innerText'));
    } catch (e2) { /* уже всё сломалось */ }
    throw e;
  }
}

main().catch(e => {
  console.error('ОШИБКА:', e.message);
  process.exit(1);
});
