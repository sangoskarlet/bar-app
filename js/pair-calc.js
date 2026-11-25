// =====================================================================
//  ПАРЫ: ВЫЧИТАНИЕ ИЗ ОБЩЕГО ВЕСА (мята: листья и ветки)
//
//  Мяту взвешивают целиком (общий вес), а потом разбирают на две части:
//  листья и ветки. Бармен вводит общий вес и любую одну часть; вторая
//  часть = общий вес − введённая. Никаких долей и коэффициентов.
//
//  Дробные граммы: в интерфейсе показываем целые, но считаем и сохраняем
//  точное значение, чтобы листья + ветки = общий вес без «прыжков» на 1 г.
//
//  Файл намеренно без DOM: те же правила проверяются в Node
//  (tools/test-mint-subtract.mjs) и используются в js/app.js.
// =====================================================================

/**
 * Вторая часть пары.
 *
 * @param {number} total   общий вес, г
 * @param {number} entered введённая часть, г
 * @returns {{ok:boolean, other?:number, reason?:string, warning?:string}}
 *   reason = 'no-total'  — общий вес пуст или 0, пересчитывать нечего;
 *   reason = 'bad-value' — часть не число или отрицательная;
 *   warning = 'over'     — введённая часть больше общего веса: вторая = 0,
 *                          значение введённой не обрезаем.
 */
export function splitPair(total, entered) {
  if (typeof total !== 'number' || !isFinite(total) || total <= 0) {
    return { ok: false, reason: 'no-total' };
  }
  if (typeof entered !== 'number' || !isFinite(entered) || entered < 0) {
    return { ok: false, reason: 'bad-value' };
  }
  const other = total - entered;
  if (other < 0) return { ok: true, other: 0, warning: 'over' };
  return { ok: true, other, warning: '' };
}

/** Целые граммы для показа; пустая строка, если числа нет. */
export function displayGrams(v) {
  if (v === null || v === undefined) return '';
  return isFinite(v) ? String(Math.round(v)) : '';
}

/**
 * Сходится ли сумма частей с общим весом.
 * Допуск 0.01 г — только на погрешность чисел с плавающей точкой;
 * сохранённые значения точные, поэтому сумма не «прыгает».
 */
export function pairSumOk(total, a, b, eps = 0.01) {
  if (!Number.isFinite(total) || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs((a + b) - total) <= eps;
}
