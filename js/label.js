// =====================================================================
//  ЭТИКЕТКА 30×20 ММ ДЛЯ ТЕРМОПРИНТЕРА AiYin B21
//
//  Принтер: 203 dpi = 8 точек/мм, поэтому 30 × 20 мм — это ровно
//  240 × 160 точек. Приложение производителя (Label Expert / AiYin)
//  печатает ИМПОРТИРОВАННУЮ КАРТИНКУ, а не наш шаблон; поэтому весь
//  макет рисуем здесь, на canvas, и отдаём готовый PNG:
//    • «Поделиться» — системное меню телефона → Label Expert;
//    • «Печать»    — window.print() страницы 30×20 мм (обычный принтер);
//    • «Сохранить картинку» — скачивание PNG (если share-меню не помогло).
//
//  Требования к картинке (docs/labels/ИССЛЕДОВАНИЕ.md):
//    • ровно 240 × 160, без масштабирования;
//    • чисто чёрно-белая, без полутонов — термопринтер их «выедает»;
//    • безопасная зона 2 мм (16 точек) от края;
//    • на этикетке только: название (до 2 строк), дата производства,
//      «годен до». Ни QR, ни сотрудника, ни логотипа.
//
//  Прямой печати по Bluetooth здесь нет: протокол B21 физически не
//  проверен. Место под вторую кнопку «Печать по Bluetooth» (Android,
//  Web Bluetooth) — см. комментарий BLE_HOOK ниже; iOS её не получит
//  никогда (в Safari нет Web Bluetooth).
// =====================================================================

/** Геометрия этикетки в точках (203 dpi). */
export const LABEL = {
  width: 240,
  height: 160,
  safe: 16,          // 2 мм — безопасная зона
};

/** Шрифт: системный sans-serif, кириллица есть в любом из стека. */
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const TITLE_ONE_LINE_SIZES = [40, 36, 32, 28];   // одна строка названия
const TITLE_TWO_LINE_SIZES = [30, 28, 26, 24, 22]; // две строки названия
const TITLE_MIN = 22;      // ниже — уже не читается на термо (≈2,75 мм)
const DATE_SIZES = [24, 22, 20, 18];
const DATE_MIN = 18;
const GAP = 6;             // зазор между названием и датами, точек

const titleFont = size => `800 ${size}px ${FONT}`;
const dateFont = size => `600 ${size}px ${FONT}`; // 600, а не 700: «годен до 22.11 17:45» влезает в 208 точек кеглем 22

/** «21.11 17:45» — формат этикетки: день.месяц часы:минуты. */
export function formatLabelDate(date) {
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
  return s.replace(/[\s\-–—]+$/, '') + '…';
}

/**
 * Две строки названия: перенос по словам, самое «ровное» место.
 * Одно сверхдлинное слово (> 13 символов) режем по символам с дефисом —
 * иначе оно не влезет ни при каком кегле.
 */
function bestTwoLines(ctx, text, size) {
  ctx.font = titleFont(size);
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    const w = words[0] || '';
    if (w.length > 13) {
      const cut = Math.ceil(w.length / 2);
      return [w.slice(0, cut) + '-', w.slice(cut)];
    }
    return [w, ''];
  }
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const m = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
    if (!best || m < best.m) best = { lines: [a, b], m };
  }
  return best.lines;
}

/**
 * Подбор кегля названия: сначала пробуем одну строку (40→28), потом две
 * (30→22). Шрифт уменьшаем до минимального читаемого и только потом
 * обрезаем — «обрывок» названия на этикетке хуже мелкого кегля.
 */
function fitTitle(ctx, text, maxWidth, maxHeight) {
  for (const size of TITLE_ONE_LINE_SIZES) {
    ctx.font = titleFont(size);
    if (ctx.measureText(text).width <= maxWidth) {
      const lineH = Math.round(size * 1.12);
      if (lineH <= maxHeight) return { lines: [text], size, truncated: false };
    }
  }
  for (const size of TITLE_TWO_LINE_SIZES) {
    const lines = bestTwoLines(ctx, text, size);
    ctx.font = titleFont(size);
    if (!lines[0] || !lines[1]) continue;
    const ok = ctx.measureText(lines[0]).width <= maxWidth && ctx.measureText(lines[1]).width <= maxWidth;
    const lineH = Math.round(size * 1.12);
    if (ok && lineH * 2 <= maxHeight) return { lines, size, truncated: false };
  }

  // Не влезает даже двумя строками по 22: режем вторую строку с «…».
  ctx.font = titleFont(TITLE_MIN);
  let lines = bestTwoLines(ctx, text, TITLE_MIN);
  if (!lines[1]) lines = [ellipsize(ctx, lines[0] || text, maxWidth), ''];
  else lines[1] = ellipsize(ctx, lines[1], maxWidth);
  if (ctx.measureText(lines[0]).width > maxWidth) lines[0] = ellipsize(ctx, lines[0], maxWidth);
  return { lines, size: TITLE_MIN, truncated: true };
}

/** Подбор кегля дат: обе строки должны влезть при одном размере. */
function fitDates(ctx, lines, maxWidth) {
  for (const size of DATE_SIZES) {
    ctx.font = dateFont(size);
    if (lines.every(l => ctx.measureText(l).width <= maxWidth)) return size;
  }
  return DATE_MIN;
}

/**
 * Превращает canvas в честную 1-битную картинку: порог по яркости.
 * Антиалиасинг текста даёт серые пиксели, а термопринтер печатает
 * только «точка / не точка», поэтому серое на бумаге превращается
 * в грязь. После порога в картинке остаются ровно 0 и 255.
 */
function toBlackAndWhite(ctx, width, height) {
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    const c = v < 128 ? 0 : 255;
    d[i] = c; d[i + 1] = c; d[i + 2] = c; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Рисует этикетку.
 * @param {{name?:string, madeAt?:Date, hours?:number}} opts
 *   name  — название заготовки (то, что печатаем);
 *   madeAt — дата производства;
 *   hours — срок хранения в часах (из справочника «Сроки хранения»).
 * @returns {{canvas:HTMLCanvasElement, truncated:boolean, titleSize:number,
 *            dateSize:number, lines:string[], madeAt:Date, until:Date, hours:number}}
 */
export function buildLabel(opts = {}) {
  const name = String(opts.name || '').trim();
  const madeAt = opts.madeAt instanceof Date && !isNaN(opts.madeAt) ? opts.madeAt : new Date();
  const hours = Number(opts.hours) > 0 ? Number(opts.hours) : 24;
  const until = new Date(madeAt.getTime() + hours * 3600e3);

  const { width: W, height: H, safe } = LABEL;
  const maxW = W - safe * 2;        // 208 точек
  const maxH = H - safe * 2;        // 128 точек

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  // Белый фон: без него PNG придёт прозрачным и принтер «зальёт» всё чёрным
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000000';

  // Даты: показываем и производство, и посчитанный «годен до»
  const dateLines = [
    'изг. ' + formatLabelDate(madeAt),
    'годен до ' + formatLabelDate(until),
  ];
  const dateSize = fitDates(ctx, dateLines, maxW);
  const dateLineH = Math.round(dateSize * 1.2);
  const datesH = dateLineH * dateLines.length;

  // Название — сверху, над датами
  const titleMaxH = maxH - datesH - GAP;
  const titleText = name || '— без названия —';
  const title = fitTitle(ctx, titleText, maxW, Math.max(titleMaxH, TITLE_MIN));

  // Рисуем название сверху безопасной зоны
  ctx.font = titleFont(title.size);
  const titleLineH = Math.round(title.size * 1.12);
  let y = safe;
  title.lines.forEach(line => {
    if (line) ctx.fillText(line, safe, y);
    y += titleLineH;
  });

  // Даты — по нижней границе безопасной зоны
  ctx.font = dateFont(dateSize);
  let dy = H - safe - datesH;
  dateLines.forEach(line => {
    ctx.fillText(line, safe, dy);
    dy += dateLineH;
  });

  // Полутонов не остаётся: только чёрное и белое
  toBlackAndWhite(ctx, W, H);

  return {
    canvas,
    truncated: title.truncated,
    titleSize: title.size,
    dateSize,
    lines: title.lines.filter(Boolean),
    madeAt,
    until,
    hours,
  };
}

/** PNG как data:URL — для превью и печати. */
export function labelDataUrl(canvas) {
  return canvas.toDataURL('image/png');
}

/** Имя файла: etiketka-30x20-21.11.png (без пробелов и двоеточий). */
export function labelFileName(info) {
  const d = info && info.madeAt instanceof Date ? info.madeAt : new Date();
  const p = n => String(n).padStart(2, '0');
  return `etiketka-30x20-${p(d.getDate())}.${p(d.getMonth() + 1)}.png`;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    if (canvas.toBlob) canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Нет PNG'))), 'image/png');
    else reject(new Error('Браузер не умеет toBlob'));
  });
}

/** PNG-файл для navigator.share({files}). */
export async function labelFile(canvas, fileName) {
  const blob = await canvasToBlob(canvas);
  return new File([blob], fileName || 'etiketka-30x20.png', { type: 'image/png' });
}

/**
 * Можно ли отдать файл в системное меню «Поделиться». Проверяем сразу,
 * а не на клике: если нельзя — кнопку не показываем вовсе.
 */
export function canShareFiles() {
  if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false;
  if (typeof File !== 'function') return false;
  try {
    const probe = new File([new Uint8Array([137, 80, 78, 71])], 'etiketka.png', { type: 'image/png' });
    return !!navigator.canShare({ files: [probe] });
  } catch (e) {
    return false;
  }
}

/** Поделиться PNG: системное меню → Label Expert / AiYin → печать. */
export async function shareLabel(canvas, fileName) {
  if (!canShareFiles()) return { ok: false, error: 'Телефон не умеет «Поделиться» картинкой' };
  const file = await labelFile(canvas, fileName);
  try {
    await navigator.share({ files: [file], title: 'Этикетка 30×20' });
    return { ok: true };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, error: 'Отменено' };
    return { ok: false, error: (e && e.message) || 'Не удалось поделиться' };
  }
}

/** Скачать PNG. Работает везде, даже если share-меню не даёт выбрать приложение. */
export async function saveLabel(canvas, fileName) {
  const blob = await canvasToBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'etiketka-30x20.png';
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { ok: true };
}

/**
 * Печать на обычном принтере: страница ровно 30 × 20 мм.
 * Правила @page и скрытие всего лишнего — в styles.css (@media print).
 * BLE_HOOK: вторая кнопка «Печать по Bluetooth» (только Android, после
 * физического теста протокола B21) будет отдельной функцией здесь;
 * общий макет картинки менять не придётся — тот же canvas 240×160.
 */
export function printLabel(canvas) {
  return new Promise(resolve => {
    const url = labelDataUrl(canvas);
    const sheet = document.createElement('div');
    sheet.className = 'print-only';
    const img = document.createElement('img');
    img.alt = 'Этикетка 30×20 мм';
    img.width = LABEL.width;
    img.height = LABEL.height;
    sheet.append(img);
    document.body.append(sheet);

    let removed = false;
    const cleanup = () => {
      if (removed) return;
      removed = true;
      sheet.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    // Страницу печати убираем после закрытия предпросмотра; если браузер
    // не присылает afterprint — через минуту.
    window.addEventListener('afterprint', cleanup);
    setTimeout(cleanup, 60000);

    img.onload = () => {
      try {
        window.print();
      } catch (e) {
        /* браузер без печати — картинку всё равно можно сохранить */
      }
      resolve({ ok: true });
    };
    img.onerror = () => { cleanup(); resolve({ ok: false }); };
    img.src = url;
  });
}
