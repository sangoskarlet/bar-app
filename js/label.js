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

// Кегли названия по числу строк: одна строка (40→28), две (30→22),
// три (24→22). Три строки влезают только мелким кеглем — зато длинное
// название печатается целиком, а не обрывком с «…».
const TITLE_PLANS = [
  { lines: 1, sizes: [40, 36, 32, 28] },
  { lines: 2, sizes: [30, 28, 26, 24, 22] },
  { lines: 3, sizes: [24, 22] },
];
const TITLE_MIN = 22;      // ниже — уже не читается на термо (≈2,75 мм)
// Даты: 24→18. Если название занимает три строки, даты уходят на 18 —
// это единственный кегль, при котором всё влезает в 128 точек безопасной зоны.
const DATE_SIZES = [24, 22, 20, 18];
const DATE_THREE_LINE = 18;
const DATE_MIN = 18;
const GAP = 8;             // зазор между названием и датами, точек

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
 * Разбивка названия на куски, между которыми можно переносить строку:
 * слова и, внутри слова, части после дефиса/тире. «Лимонграсс–Бузина–Лаванда»
 * рвётся по тире — так длинное двойное название влезает без обрезки.
 */
function titleTokens(text) {
  const tokens = [];
  text.trim().split(/\s+/).filter(Boolean).forEach((word, wi) => {
    const parts = word.split(/(?<=[-–—])/).filter(Boolean);
    parts.forEach((part, pi) => tokens.push({ text: part, space: wi > 0 && pi === 0 }));
  });
  return tokens;
}

function joinTokens(tokens) {
  return tokens.map((t, i) => (t.space && i > 0 ? ' ' : '') + t.text).join('');
}

/** Куски, которые сами шире строки, режем по символам с дефисом. */
function splitLongTokens(ctx, tokens, maxWidth) {
  const out = [];
  tokens.forEach(t => {
    if (ctx.measureText(t.text).width <= maxWidth) { out.push(t); return; }
    let rest = t.text;
    let first = true;
    while (rest.length > 1) {
      let cut = rest.length;
      for (let i = rest.length; i > 0; i--) {
        if (ctx.measureText(rest.slice(0, i) + '-').width <= maxWidth) { cut = i; break; }
        cut = 1;
      }
      out.push({ text: rest.slice(0, cut) + '-', space: first ? t.space : false });
      rest = rest.slice(cut);
      first = false;
    }
    if (rest) out.push({ text: rest, space: false });
  });
  return out;
}

/**
 * Раскладка названия в n строк: перебираем места переноса и берём
 * самый «ровный» вариант (минимальная максимальная ширина строки).
 * allowSplit=false — переносить только по словам и тире; резать слово
 * по буквам разрешаем лишь когда иначе не влезает совсем.
 */
function bestLines(ctx, text, n, size, maxWidth, allowSplit) {
  ctx.font = titleFont(size);
  let tokens = titleTokens(text);
  if (allowSplit) {
    tokens = splitLongTokens(ctx, tokens, maxWidth);
  } else if (tokens.some(t => ctx.measureText(t.text).width > maxWidth)) {
    return null;
  }
  if (tokens.length < n) return null;
  if (n === 1) return [joinTokens(tokens)];

  let best = null;
  const measure = s => ctx.measureText(s).width;
  if (n === 2) {
    for (let i = 1; i < tokens.length; i++) {
      const a = joinTokens(tokens.slice(0, i));
      const b = joinTokens(tokens.slice(i));
      const w = Math.max(measure(a), measure(b));
      if (!best || w < best.w) best = { lines: [a, b], w };
    }
  } else {
    for (let i = 1; i < tokens.length - 1; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        const a = joinTokens(tokens.slice(0, i));
        const b = joinTokens(tokens.slice(i, j));
        const c = joinTokens(tokens.slice(j));
        const w = Math.max(measure(a), measure(b), measure(c));
        if (!best || w < best.w) best = { lines: [a, b, c], w };
      }
    }
  }
  return best ? best.lines : null;
}

/**
 * Подбор раскладки названия и кегля дат.
 * Порядок: одна строка с обычными датами → две строки → три строки с датами 18.
 * Слово по буквам не рвём, пока есть хоть один кегль и раскладка, где оно
 * остаётся целым: сначала перебираем все варианты без разрыва слов, и только
 * если совсем не влезает — разрешаем резать слово.
 * Обрезка с «…» — последнее средство, когда не влезают и три строки по 22.
 */
function layoutTitle(ctx, text, maxWidth, dateSizeMax) {
  const attempt = (allowSplit) => {
    for (const plan of TITLE_PLANS) {
      const dateSizes = plan.lines === 3
        ? [Math.min(dateSizeMax, DATE_THREE_LINE)]
        : [dateSizeMax];
      for (const dateSize of dateSizes) {
        const availH = (LABEL.height - LABEL.safe * 2) - 2 * Math.round(dateSize * 1.2) - GAP;
        for (const size of plan.sizes) {
          const lines = bestLines(ctx, text, plan.lines, size, maxWidth, allowSplit);
          if (!lines) continue;
          const lineH = Math.round(size * 1.12);
          ctx.font = titleFont(size);
          const fits = lines.every(l => ctx.measureText(l).width <= maxWidth);
          if (fits && lineH * lines.length <= availH) {
            return { lines, size, dateSize, truncated: false };
          }
        }
      }
    }
    return null;
  };

  const whole = attempt(false);
  if (whole) return whole;
  const split = attempt(true);
  if (split) return split;

  // Не влезает и в три строки по 22: режем строки с «…» (с конца).
  const dateSize = Math.min(dateSizeMax, DATE_THREE_LINE);
  ctx.font = titleFont(TITLE_MIN);
  let lines = bestLines(ctx, text, 3, TITLE_MIN, maxWidth, true) || [ellipsize(ctx, text, maxWidth), '', ''];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ctx.measureText(lines[i]).width > maxWidth) lines[i] = ellipsize(ctx, lines[i], maxWidth);
  }
  return { lines: lines.filter(Boolean), size: TITLE_MIN, dateSize, truncated: true };
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
  const dateSizeMax = fitDates(ctx, dateLines, maxW);
  const titleText = name || '— без названия —';

  // Название: до трёх строк; если три — даты мельче (18), чтобы всё влезло
  const title = layoutTitle(ctx, titleText, maxW, dateSizeMax);
  const dateSize = title.dateSize;
  const dateLineH = Math.round(dateSize * 1.2);
  const datesH = dateLineH * dateLines.length;

  // Одна сетка: даты всегда заканчиваются у нижней границы безопасной зоны,
  // между названием и датами — один и тот же зазор GAP. Остаток высоты
  // (у коротких названий) делится пополам: немного отступа сверху,
  // остальное — в зазор, иначе посреди этикетки получается дырка.
  const datesTop = H - safe - datesH;
  const titleH = title.lines.length * Math.round(title.size * 1.12);
  const availH = datesTop - GAP - safe;
  const titleTop = safe + Math.max(0, Math.round((availH - titleH) / 2));

  ctx.font = titleFont(title.size);
  const titleLineH = Math.round(title.size * 1.12);
  let y = titleTop;
  title.lines.forEach(line => {
    if (line) ctx.fillText(line, safe, y);
    y += titleLineH;
  });

  // Даты — по нижней границе безопасной зоны
  ctx.font = dateFont(dateSize);
  let dy = datesTop;
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
