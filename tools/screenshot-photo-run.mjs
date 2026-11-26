// =====================================================================
//  СКРИНШОТЫ ПОТОКА «ТРИ КАДРА ЗА ПРОХОД» (локально, без сети и Google)
//
//  Поднимает настоящий Chrome в headless-режиме, открывает демо-сервер
//  (tools/demo-server.mjs) в окне 375×812, проходит поток как бармен и
//  сохраняет PNG в docs/photo-run/.
//
//  Запуск: node tools/screenshot-photo-run.mjs
//  Требует уже запущенный demo-server на 127.0.0.1:8799.
// =====================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'photo-run');
const DEMO = 'http://127.0.0.1:8799';
const PORT = 9333;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VIEW = { width: 375, height: 812 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- картинки для кадров (реальные фото, не синтетика) ----------
const IMGS = [
  path.join(ROOT, 'docs', 'photo-check', 'test', 'ref1-bar-tallin.jpg'),
  path.join(ROOT, 'docs', 'photo-check', 'test', 'ref2-bar-royaloak.jpg'),
  path.join(ROOT, 'docs', 'photo-check', 'test', 'shift-dirty-dishes.jpg'),
];
const TMP_IMGS = IMGS.map((src, i) => {
  const dst = path.join(os.tmpdir(), 'photo-run-shot' + (i + 1) + path.extname(src));
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-run-chrome-'));
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
  const clickText = async (text, tag = 'button') => {    const ok = await evaluate(`(() => {
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
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('✓ ' + path.relative(ROOT, file));
  };
  const setFile = async (file) => {
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

  // ---------- 0. Приложение и вход ----------
  try {
  await fetch(DEMO + '/__state?resetphotos&photoundef=0');
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

  // ---------- 1. Экран: этаж → съёмка трёх кадров ----------
  await clickText('Фото уборки');
  await waitFor('[...document.querySelectorAll(".floor-btn")].length > 0', 15000, 'этажи');
  await clickText('1 этаж', '.floor-name');
  // Кнопка «1 этаж» — это span внутри кнопки; клик по span всплывёт до кнопки.
  await waitFor('document.querySelector(".photo-shutter")', 15000, 'экран съёмки');

  await setFile(TMP_IMGS[0]);
  await waitFor('document.querySelectorAll(".photo-shot-slot").length === 1', 15000, 'первый кадр');
  await setFile(TMP_IMGS[1]);
  await waitFor('document.querySelectorAll(".photo-shot-slot").length === 2', 15000, 'второй кадр');
  await waitFor('document.querySelector(".photo-shot-counter").textContent.trim() === "2 из 3"', 5000, 'счётчик 2 из 3');
  await shot('01-shoot-three-375.png');

  // ---------- 2. Сводка: три вердикта ----------
  await setFile(TMP_IMGS[2]);
  await waitFor('document.querySelectorAll(".photo-shot-slot").length === 3', 15000, 'третий кадр');
  await clickText('Отправить');
  await waitFor('document.querySelector(".photo-run-list") && document.querySelectorAll(".photo-run-row").length === 3', 40000, 'сводка');
  await waitFor('[...document.querySelectorAll(".photo-run-badge")].filter(b => /критично|замечания|чисто/.test(b.textContent)).length === 3', 20000, 'три вердикта');
  await shot('02-summary-three-375.png');

  // ---------- 3. История: группировка по проходу ----------
  await clickText('История снимков');
  await waitFor('[...document.querySelectorAll(".photo-hist-row")].some(r => r.textContent.includes("Смена"))', 20000, 'история с проходом');
  await sleep(400);
  await shot('03-history-run-375.png');

  // ---------- 4. «Зона не определена» + выбор зоны вручную ----------
  await fetch(DEMO + '/__state?resetphotos&photoundef=1');
  // Домой: перезагрузка приложения чище, чем длинная навигация назад.
  await goto(DEMO + '/');
  await waitFor('[...document.querySelectorAll(".tile")].some(b => b.textContent.includes("Фото уборки"))', 20000, 'главная');
  await clickText('Фото уборки');
  await waitFor('[...document.querySelectorAll(".floor-btn")].length > 0', 15000, 'этажи');
  await clickText('1 этаж', '.floor-name');
  await waitFor('document.querySelector(".photo-shutter")', 15000, 'экран съёмки');
  for (const img of TMP_IMGS) {
    const n = await evaluate('document.querySelectorAll(".photo-shot-slot").length');
    await setFile(img);
    await waitFor('document.querySelectorAll(".photo-shot-slot").length === ' + (n + 1), 15000, 'кадр ' + (n + 1));
  }
  await clickText('Отправить');
  await waitFor('document.querySelector(".photo-run-list") && document.querySelectorAll(".photo-run-row").length === 3', 40000, 'сводка');
  await waitFor('[...document.querySelectorAll(".photo-zone-change")].some(b => b.textContent.includes("выбрать зону"))', 20000, 'строка «зона не определена»');
  await clickText('выбрать зону');
  await waitFor('document.querySelector(".photo-run-picker")', 10000, 'список зон');
  await sleep(300);
  await shot('04-zone-undefined-picker-375.png');

  // ---------- 5. Зона выбрана вручную → снимок перепроверен ----------
  await clickText('Бар', '.chip');
  await waitFor('[...document.querySelectorAll(".photo-run-auto")].some(e => e.textContent.includes("вручную"))', 20000, 'перепроверка после смены зоны');
  await sleep(400);
  await shot('05-zone-changed-375.png');

  // ---------- итог ----------
  ws.close();
  proc.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* профиль временный */ }
  console.log('Готово: ' + path.relative(ROOT, OUT));
  } catch (e) {
    // Диагностика: что было на экране, когда шаг не сложился.
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
