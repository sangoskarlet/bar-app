// =====================================================================
//  ГОЛОСОВОЙ ВВОД
//
//  1. Распознавание речи — встроенная функция браузера (Web Speech API).
//     Звук уходит на серверы Google (Android) или Apple (iPhone),
//     поэтому нужен интернет. Без сети кнопка скажет об этом.
//  2. Разбор фразы — уже здесь, на телефоне:
//       «Бомбей, две полных, открытая триста пятьдесят»
//        → позиция: Бомбей Сапфир, полных: 2, открытая: 350
//     Позиция ищется только среди позиций Описи (нечёткое сравнение),
//     поэтому «бомбей сапфир», «бомбей» и «сапфир» найдут одно и то же.
//  3. Ничего не сохраняется само: форма заполняется, бармен проверяет и жмёт «Сохранить».
// =====================================================================

const Recognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

export function voiceSupported() { return !!Recognition; }

/**
 * Слушает одну фразу. Возвращает массив вариантов распознавания (лучший первый).
 * Ошибки: 'no-speech', 'network', 'not-allowed' (нет доступа к микрофону) и т.п.
 */
export function listenOnce({ lang = 'ru-RU', timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!Recognition) return reject(new Error('unsupported'));
    const rec = new Recognition();
    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    rec.continuous = false;
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(t); try { rec.stop(); } catch (e) {} fn(v); } };
    const t = setTimeout(() => finish(reject, new Error('timeout')), timeoutMs);
    rec.onresult = (e) => {
      const res = e.results[0];
      const alts = [];
      for (let i = 0; i < res.length; i++) alts.push(res[i].transcript);
      finish(resolve, alts);
    };
    rec.onerror = (e) => finish(reject, new Error(e.error || 'error'));
    rec.onend = () => finish(reject, new Error('no-speech'));
    try { rec.start(); } catch (e) { finish(reject, e); }
  });
}

export function voiceErrorText(err) {
  const m = (err && err.message) || '';
  if (m === 'unsupported') return 'Этот браузер не умеет распознавать речь. Используйте микрофон на клавиатуре.';
  if (m === 'not-allowed' || m === 'service-not-allowed') return 'Нет доступа к микрофону. Разрешите его в настройках браузера.';
  if (m === 'network') return 'Для голосового ввода нужен интернет.';
  if (m === 'no-speech' || m === 'timeout') return 'Ничего не услышал. Попробуйте ещё раз, ближе к телефону.';
  return 'Не получилось распознать: ' + m;
}

// ---------------------------------------------------------------------
//  Числа словами → цифры («две», «триста пятьдесят», «полторы тысячи»)
// ---------------------------------------------------------------------
const UNITS = {
  ноль: 0, один: 1, одна: 1, одну: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7,
  восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14,
  пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
};
const TENS = { двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90 };
const HUNDREDS = { сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900 };
const THOUSAND = /^тысяч/;

/** Разбивает фразу на токены; подряд идущие числовые слова склеивает в одно число. */
export function tokenize(text) {
  const words = String(text).toLowerCase().replace(/ё/g, 'е')
    .replace(/(\d),(\d)/g, '$1.$2')            // 0,5 → 0.5
    .replace(/(^|\s)(\d)\s+(\d{3})(?!\d)/g, '$1$2$3') // «1 200» → 1200, но «47 900» — два числа
    .replace(/(\d)([а-я])/g, '$1 $2')            // «350мл» → «350 мл»
    .replace(/[^a-zа-я0-9.\s]/g, ' ')
    .split(/\s+/).filter(Boolean);
  const out = [];
  let acc = null; // {value, current}
  const flush = () => { if (acc) { out.push({ num: acc.total + acc.cur }); acc = null; } };
  for (const w of words) {
    if (/^\d+(\.\d+)?$/.test(w)) { flush(); out.push({ num: Number(w) }); continue; }
    let v = null;
    if (w in UNITS) v = UNITS[w];
    else if (w in TENS) v = TENS[w];
    else if (w in HUNDREDS) v = HUNDREDS[w];
    if (w === 'полторы' || w === 'полтора') { flush(); acc = { total: 0, cur: 1.5, last: 0 }; continue; }
    if (w === 'половина' || w === 'пол' || w === 'половину') { flush(); out.push({ num: 0.5 }); continue; }
    if (v !== null) {
      // «сорок семь девятьсот» — два числа (47 и 900): сотни после десятков/единиц начинают новое число
      const mag = x => (x >= 100 ? 3 : x >= 20 ? 2 : 1);
      if (acc && acc.last && mag(v) >= mag(acc.last)) flush();
      if (!acc) acc = { total: 0, cur: 0 };
      acc.cur += v; acc.last = v;
      continue;
    }
    if (THOUSAND.test(w)) {
      if (!acc) acc = { total: 0, cur: 1 };
      acc.total += (acc.cur || 1) * 1000; acc.cur = 0; acc.last = 0;
      continue;
    }
    flush();
    out.push({ word: w });
  }
  flush();
  // «2 литра» → 2000 (мл), «полтора кило» → 1500 (г)
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].num !== undefined && out[i + 1].word && /^(литр|кило|кг)/.test(out[i + 1].word)) {
      out[i].num = Math.round(out[i].num * 1000);
      out[i + 1].word = 'мл';
    }
  }
  return out;
}

// ---------------------------------------------------------------------
//  Поиск позиции по похожести названия
// ---------------------------------------------------------------------
const STOP = new Set(['и', 'в', 'на', 'с', 'по', 'мл', 'г', 'гр', 'грамм', 'граммов', 'грамма', 'шт', 'штук', 'штуки',
  'полных', 'полные', 'полная', 'полный', 'закрытых', 'закрытые', 'закрытая', 'целых', 'целые', 'бутылки', 'бутылок',
  'бутылка', 'бутылку', 'открытая', 'открытой', 'открытую', 'открытые', 'открытых', 'остаток', 'начатая', 'начатой',
  'вес', 'весом', 'весит', 'на', 'весах', 'миллилитров', 'литр', 'литра', 'литров', 'еще', 'ещё', 'плюс', 'и']);
// Латиница → кириллица (на слух): «V.S.O.P.» и «VSOP» сравниваются с «вэсоп»
const LAT = { a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м',
  n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'й', z: 'з' };
const norm = s => String(s).toLowerCase().replace(/ё/g, 'е')
  .replace(/\b([a-z])\.(?=[a-z]\.)/g, '$1').replace(/\b([a-z])\.(?=\s|$)/g, '$1') // V.S.O.P. → vsop
  .replace(/[a-z]/g, ch => LAT[ch] || ch)
  .replace(/[^а-я0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function bigrams(s) {
  const t = ' ' + s + ' ';
  const m = new Map();
  for (let i = 0; i < t.length - 1; i++) { const b = t.slice(i, i + 2); m.set(b, (m.get(b) || 0) + 1); }
  return m;
}
function dice(a, b) {
  if (!a || !b) return 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, na = 0, nb = 0;
  A.forEach(v => { na += v; });
  B.forEach(v => { nb += v; });
  A.forEach((v, k) => { if (B.has(k)) inter += Math.min(v, B.get(k)); });
  return (2 * inter) / (na + nb);
}

/** Похожесть двух слов: совпало — 1, общее начало — почти 1, иначе по буквам. */
function wordSim(a, b) {
  if (a === b) return 1;
  if (a.slice(0, 4) === b.slice(0, 4)) return 0.75 + 0.25 * dice(a, b);
  return dice(a, b);
}

/** Сравнивает «что сказали» с названием позиции. 0…1 */
export function nameScore(spoken, name) {
  const s = norm(spoken), n = norm(name);
  if (!s || !n) return 0;
  const sWords = s.split(' ').filter(w => w.length >= 3);
  const nWords = n.split(' ').filter(w => w.length >= 3 && !/^\d/.test(w));
  // Каждое значимое слово из названия: насколько похоже на любое сказанное слово
  let wordHits = 0;
  for (const nw of nWords) {
    let best = 0;
    for (const sw of sWords) best = Math.max(best, wordSim(sw, nw));
    if (best >= 0.6) wordHits += best;
  }
  // Доля сказанных слов, нашедших пару в названии (чтобы «джин бомбей» не выбрал просто «джин хаус»)
  let spokenHits = 0;
  for (const sw of sWords) {
    let best = 0;
    for (const nw of nWords) best = Math.max(best, wordSim(sw, nw));
    if (best >= 0.6) spokenHits += best;
  }
  const wordPart = nWords.length ? wordHits / nWords.length : 0;
  const spokenPart = sWords.length ? spokenHits / sWords.length : 0;
  return 0.45 * wordPart + 0.35 * spokenPart + 0.2 * dice(s, n);
}

/** Возвращает лучшие совпадения [{item, score}] по убыванию. */
export function matchItems(spoken, items, limit = 3) {
  return items.map(item => ({ item, score: nameScore(spoken, item.name) }))
    .filter(x => x.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------------------------------------------------------------------
//  Разбор фразы инвентаризации
// ---------------------------------------------------------------------
const KW_FULL = /^(полн|закрыт|цел|бутыл|запечат)/;
const KW_OPEN = /^(открыт|остат|начат|отпит)/;
const KW_WEIGHT = /^(вес|весах|весит|взвес)/;

/**
 * Разбирает фразу. item — если позиция уже выбрана (экран ввода), иначе ищем в items.
 * Возвращает { candidates: [{item,score}], full, open, weight, spokenName }.
 * open — остаток в единицах позиции (мл/г), weight — вес на весах в граммах.
 */
export function parseInventoryPhrase(text, { items = [], item = null } = {}) {
  const tokens = tokenize(text);
  const res = { candidates: [], full: null, open: null, weight: null, spokenName: '' };

  // 1. Назначаем числа по ключевым словам рядом (до или после числа)
  const kwAt = i => {
    const t = tokens[i];
    if (!t || !t.word) return null;
    if (KW_FULL.test(t.word)) return 'full';
    if (KW_WEIGHT.test(t.word)) return 'weight';
    if (KW_OPEN.test(t.word)) return 'open';
    return null;
  };
  const used = new Set();

  // Числа, которые входят в название позиции («Макаллан 12 лет», «Гарни 0,5»), — не количество
  if (item) {
    const nameNorm = norm(item.name);
    const nameWords = new Set(nameNorm.split(' '));
    const nameNums = new Set((String(item.name).replace(/,/g, '.').match(/\d+(\.\d+)?/g) || []).map(Number));
    tokens.forEach((t, i) => {
      if (t.num === undefined || !nameNums.has(t.num)) return;
      const near = [tokens[i - 1], tokens[i + 1]].some(n => n && n.word && nameWords.has(norm(n.word)));
      if (near) used.add(i);
    });
  }
  const prevKw = i => kwAt(i - 1) || (tokens[i - 1] && tokens[i - 1].word === 'на' ? kwAt(i - 2) : null);
  // Проход 1 — надёжные связки: «две ПОЛНЫХ», «ОТКРЫТАЯ 350», «ВЕС 900», «ПОЛНЫХ две»
  tokens.forEach((t, i) => {
    if (t.num === undefined || used.has(i)) return;
    let kind = null;
    if (kwAt(i + 1) === 'full') kind = 'full';
    else if (prevKw(i) === 'open' || prevKw(i) === 'weight') kind = prevKw(i);
    else if (prevKw(i) === 'full') kind = 'full';
    if (kind && res[kind] === null) { res[kind] = t.num; used.add(i); }
  });
  // Проход 2 — слабые связки: «350 открытая», «900 на весах»
  tokens.forEach((t, i) => {
    if (t.num === undefined || used.has(i)) return;
    const kind = kwAt(i + 1) || (tokens[i + 1] && tokens[i + 1].word === 'на' ? kwAt(i + 2) : null);
    if (kind && res[kind] === null) { res[kind] = t.num; used.add(i); }
  });

  // 2. Числа без ключевых слов: маленькое целое — бутылки, большое — остаток
  const target = item;
  tokens.forEach((t, i) => {
    if (t.num === undefined || used.has(i)) return;
    const byBottle = target ? (target.unit !== 'шт' && target.volume > 0) : true;
    if (target && target.unit === 'шт') { if (res.full === null) res.full = t.num; return; }
    if (!byBottle) { if (res.open === null) res.open = t.num; return; }
    if (Number.isInteger(t.num) && t.num <= 30 && res.full === null) res.full = t.num;
    else if (res.open === null) res.open = t.num;
    else if (res.full === null) res.full = t.num;
  });

  // 3. Название — всё, что осталось без чисел и служебных слов
  res.spokenName = tokens.filter(t => t.word && !STOP.has(t.word) && !KW_FULL.test(t.word) &&
    !KW_OPEN.test(t.word) && !KW_WEIGHT.test(t.word)).map(t => t.word).join(' ');
  if (!item && res.spokenName) res.candidates = matchItems(res.spokenName, items);
  return res;
}

/** Уверены ли мы в первом кандидате настолько, чтобы сразу открыть его. */
export function confident(candidates) {
  if (!candidates.length) return false;
  const [a, b] = candidates;
  return a.score >= 0.55 && (!b || a.score - b.score >= 0.12);
}

/**
 * Для позиции, которой нет в Описи: «джин монки 47 900 мл» → { name: 'джин монки 47', amount: 900 }.
 * Количество — число перед «мл/грамм/штук/полных…», иначе последнее число.
 * Остальные числа считаем частью названия («Монки 47», «Гарни 0,5»).
 */
export function parseCustomPhrase(text) {
  const tokens = tokenize(text);
  const isQtyWord = t => t && t.word && (/^(мл|миллилитр|г|гр|грамм|кг|шт|штук|литр)/.test(t.word) ||
    KW_FULL.test(t.word) || KW_OPEN.test(t.word) || KW_WEIGHT.test(t.word));
  let qi = -1;
  tokens.forEach((t, i) => { if (t.num !== undefined && isQtyWord(tokens[i + 1])) qi = i; });
  if (qi === -1) tokens.forEach((t, i) => { if (t.num !== undefined) qi = i; });
  const name = tokens.filter((t, i) => i !== qi && (t.num !== undefined
    ? true : !STOP.has(t.word) && !KW_FULL.test(t.word) && !KW_OPEN.test(t.word) && !KW_WEIGHT.test(t.word)))
    .map(t => (t.num !== undefined ? String(t.num).replace('.', ',') : t.word)).join(' ');
  // Единица по слову после количества: штуки/полные бутылки → шт, граммы/вес → г, иначе мл
  const nx = qi === -1 ? null : tokens[qi + 1];
  let unit = 'мл';
  if (nx && nx.word && (/^шт/.test(nx.word) || KW_FULL.test(nx.word))) unit = 'шт';
  else if (nx && nx.word && (/^(г|гр|грамм|кг)$|^грамм|^кило/.test(nx.word) || KW_WEIGHT.test(nx.word))) unit = 'г';
  return { name, amount: qi === -1 ? null : tokens[qi].num, unit };
}
