// =====================================================================
//  ЭТИКЕТКА 30×20 ММ ДЛЯ ТЕРМОПРИНТЕРА AiYin B21
//
//  Принтер: 203 dpi = 8 точек/мм, поэтому 30 × 20 мм — это ровно
//  240 × 160 точек. Приложение производителя (Label Expert / AiYin)
//  печатает ИМПОРТИРОВАННУЮ КАРТИНКУ, а не наш шаблон; поэтому весь
//  макет рисуем здесь, на canvas, и отдаём готовый файл:
//    • «Поделиться» — системное меню телефона: Label Expert, а если его нет —
//      «Сохранить изображение» (файл уходит в «Фото»/«Галерею»);
//    • «Сохранить PNG» / «Сохранить JPG» — файлы в «Загрузки» (латиница, DPI);
//    • «PDF (30 × 20 мм)» — спрятан в «Ещё»: window.print() для офисного
//      принтера/PDF. Системный диалог AirPrint/Mopria НЕ видит B21.
//
//  Требования к картинке (docs/labels/ИССЛЕДОВАНИЕ.md):
//    • ровно 240 × 160, без масштабирования;
//    • чисто чёрно-белая, без полутонов — термопринтер их «выедает»;
//    • 8-битный полутоновой PNG без альфа-канала (color type 0);
//    • pHYs: 8000 точек/м = 8 точек/мм (203 dpi) — иначе телефон считает
//      картинку 72–96 dpi, и приложение видит «63 × 42 мм» вместо «30 × 20»;
//    • безопасная зона 2 мм (16 точек) от края;
//    • на этикетке только: название (до трёх строк), дата производства,
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

/**
 * Сколько точек на метр у принтера: 8 точек/мм = 8000. Именно это число
 * пишется в pHYs (и в JFIF у JPG): 240 точек при 8000/м = ровно 30,00 мм,
 * 160 — ровно 20,00 мм. Номинал «203 dpi» — это те же 8 точек/мм,
 * округлённые производителем (203,2).
 */
export const PIXELS_PER_METER = 8000;

/** Номинал для JFIF-заголовка JPG: в нём DPI — целое число. */
export const LABEL_DPI = 203;

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

/** PNG как data:URL — только для превью на экране и печати. */
export function labelDataUrl(canvas) {
  return canvas.toDataURL('image/png');
}

// ---------------------------------------------------------------------
//  PNG ДЛЯ ПРИЛОЖЕНИЯ: 8-битный полутоновой, без альфа-канала, с DPI
//
//  canvas.toBlob('image/png') отдаёт RGBA (color type 6) и НЕ пишет pHYs.
//  Телефон из такого файла видит «240 × 160 при 72–96 dpi», то есть
//  63 × 42 мм вместо 30 × 20, и приложение этикеток либо масштабирует
//  картинку, либо считает её «не той». Поэтому PNG собираем сами:
//  пиксели берём с canvas (они уже прошли порог — только 0 и 255),
//  сжимаем встроенным CompressionStream('deflate') и пишем чанки
//  IHDR + pHYs + IDAT + IEND. Библиотека для этого не нужна.
//
//  Старые браузеры без CompressionStream получают запасной путь:
//  обычный canvas-PNG, в который дописывается только pHYs.
// ---------------------------------------------------------------------
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** Таблица CRC32 (полином PNG) — считается один раз. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Один чанк PNG: длина (4) + тип (4) + данные + CRC (4). */
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** pHYs: разрешение в точках на метр (8000 = 8 точек/мм = 30 мм на 240 px). */
function physChunk() {
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, PIXELS_PER_METER);
  view.setUint32(4, PIXELS_PER_METER);
  data[8] = 1; // единица измерения — метр
  return pngChunk('pHYs', data);
}

/** Собирает PNG 8 бит/пиксель, полутоновой (color type 0), без альфы. */
function buildGrayPng(width, height, idat) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;   // бит на канал
  ihdr[9] = 0;   // color type 0 — grayscale, без альфа-канала
  ihdr[10] = 0;  // сжатие deflate
  ihdr[11] = 0;  // фильтрация
  ihdr[12] = 0;  // без интерлейса
  return concatBytes([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    physChunk(),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

function readU32(bytes, off) {
  return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}

/** Запасной путь: дописать pHYs в готовый canvas-PNG (перед первым IDAT). */
function insertPngDpi(input) {
  // canvasBytes отдаёт ArrayBuffer, а разбирать чанки удобнее по байтам.
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 33 || bytes[0] !== PNG_SIGNATURE[0] || bytes[1] !== PNG_SIGNATURE[1]) return bytes;
  let off = 8;
  let insertAt = -1;
  while (off + 12 <= bytes.length) {
    const len = readU32(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (type === 'pHYs') return bytes;            // DPI уже есть
    if (type === 'IDAT') { insertAt = off; break; }
    off += 12 + len;
  }
  if (insertAt < 0) return bytes;
  return concatBytes([bytes.subarray(0, insertAt), physChunk(), bytes.subarray(insertAt)]);
}

/** zlib-deflate средствами браузера; null — если браузер не умеет. */
async function zlibDeflate(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    return null;
  }
}

function canvasBytes(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (!canvas.toBlob) return reject(new Error('Браузер не умеет toBlob'));
    canvas.toBlob(blob => {
      if (!blob) return reject(new Error('Браузер не собрал файл'));
      blob.arrayBuffer().then(resolve, reject);
    }, type, quality);
  });
}

/**
 * PNG-файл этикетки: 240 × 160, 8-битный чёрно-белый, без альфа-канала,
 * с pHYs = 8000 точек/м (203 dpi). Основной формат для Label Expert.
 * @returns {Promise<Blob>} тип image/png
 */
export async function labelPngBlob(canvas) {
  const { width, height } = canvas;
  let bytes = null;
  try {
    const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    // Строка PNG = байт фильтра (0 = None) + по байту на пиксель.
    const raw = new Uint8Array(height * (width + 1));
    for (let y = 0; y < height; y++) {
      const row = y * (width + 1);
      raw[row] = 0;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const gray = (pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000;
        raw[row + 1 + x] = gray < 128 ? 0 : 255;
      }
    }
    const idat = await zlibDeflate(raw);
    if (idat) bytes = buildGrayPng(width, height, idat);
  } catch (e) {
    bytes = null;
  }
  if (!bytes) bytes = insertPngDpi(await canvasBytes(canvas, 'image/png'));
  return new Blob([bytes], { type: 'image/png' });
}

/**
 * JPG-файл этикетки: качество 100 %, белая подложка (JPG не умеет
 * прозрачность — без подложки она станет чёрной), DPI 203 в JFIF.
 * Нужен приложениям, которые принимают только JPG.
 * @returns {Promise<Blob>} тип image/jpeg
 */
export async function labelJpegBlob(canvas) {
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const ctx = flat.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  const bytes = await canvasBytes(flat, 'image/jpeg', 1);
  return new Blob([withJpegDpi(bytes)], { type: 'image/jpeg' });
}

/** Правит JFIF-заголовок JPG: единицы — dpi, плотность 203 × 203. */
function withJpegDpi(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 20 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes;
  let off = 2;
  while (off + 4 < bytes.length && bytes[off] === 0xFF) {
    const marker = bytes[off + 1];
    if (marker === 0xDA) break; // SOS — дальше сжатые данные
    const len = (bytes[off + 2] << 8) | bytes[off + 3];
    if (len < 2) break;
    const isJfif = marker === 0xE0 && len >= 16 &&
      bytes[off + 4] === 0x4A && bytes[off + 5] === 0x46 &&
      bytes[off + 6] === 0x49 && bytes[off + 7] === 0x46; // «JFIF»
    if (isJfif) {
      bytes[off + 11] = 1;                  // единица измерения — dpi
      bytes[off + 12] = LABEL_DPI >> 8;
      bytes[off + 13] = LABEL_DPI & 0xFF;
      bytes[off + 14] = LABEL_DPI >> 8;
      bytes[off + 15] = LABEL_DPI & 0xFF;
      return bytes;
    }
    off += 2 + len;
  }
  return bytes;
}

/** Имя файла: etiketka-30x20-21.11.png (латиница, без пробелов и двоеточий). */
export function labelFileName(info, ext) {
  const d = info && info.madeAt instanceof Date ? info.madeAt : new Date();
  const p = n => String(n).padStart(2, '0');
  const e = String(ext || 'png').toLowerCase();
  return `etiketka-30x20-${p(d.getDate())}.${p(d.getMonth() + 1)}.${e === 'jpg' || e === 'jpeg' ? 'jpg' : 'png'}`;
}

/** Готовый файл для navigator.share({files}) и скачивания. */
export async function labelFile(canvas, fileName, format) {
  const jpg = format === 'jpg' || format === 'jpeg';
  const blob = jpg ? await labelJpegBlob(canvas) : await labelPngBlob(canvas);
  return new File([blob], fileName || (jpg ? 'etiketka-30x20.jpg' : 'etiketka-30x20.png'), { type: blob.type });
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

/** Поделиться картинкой: системное меню → «Сохранить изображение» / Label Expert. */
export async function shareLabel(canvas, fileName, format) {
  if (!canShareFiles()) return { ok: false, error: 'Устройство не умеет «Поделиться» картинкой' };
  const file = await labelFile(canvas, fileName, format);
  try {
    await navigator.share({ files: [file], title: 'Этикетка 30×20' });
    return { ok: true };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, error: 'Отменено' };
    return { ok: false, error: (e && e.message) || 'Не удалось поделиться' };
  }
}

/** Скачать файл (PNG по умолчанию, JPG — по запросу). */
export async function saveLabel(canvas, fileName, format) {
  const file = await labelFile(canvas, fileName, format);
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
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
