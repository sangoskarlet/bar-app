// =====================================================================
//  ТЕСТЫ ЧИСТОГО РАСЧЁТА МЯТЫ: ВЫЧИТАНИЕ ИЗ ОБЩЕГО ВЕСА
//
//  Проверяет js/pair-calc.js без браузера и без Google:
//  200 → листья 120 → ветки 80; 200 → ветки 80 → листья 120;
//  превышение, пустой/нулевой общий вес, мусор, отрицательные,
//  дробные граммы и допуск суммы.
//
//  Запуск: node tools/test-mint-subtract.mjs
// =====================================================================

import assert from 'node:assert/strict';
import { splitPair, displayGrams, pairSumOk } from '../js/pair-calc.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(['OK', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + (e && e.message || e)]); }
}

test('200 → ввели листья 120 → ветки 80', () => {
  const r = splitPair(200, 120);
  assert.equal(r.ok, true);
  assert.equal(r.other, 80);
  assert.equal(r.warning, '');
});

test('200 → ввели ветки 80 → листья 120', () => {
  const r = splitPair(200, 80);
  assert.equal(r.ok, true);
  assert.equal(r.other, 120);
  assert.equal(r.warning, '');
});

test('200 → листья 250 → ветки 0 и предупреждение, значение не обрезается', () => {
  const r = splitPair(200, 250);
  assert.equal(r.ok, true);
  assert.equal(r.other, 0);
  assert.equal(r.warning, 'over');
});

test('общий вес пуст, 0 или отрицательный — пересчёта нет', () => {
  [NaN, 0, -1, null, undefined].forEach(total => {
    const r = splitPair(total, 100);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-total');
  });
});

test('часть — мусор или отрицательная — пересчёта нет', () => {
  [NaN, -1, null, undefined, Infinity].forEach(entered => {
    const r = splitPair(200, entered);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad-value');
  });
});

test('введённая часть = 0 допустима: вторая = общий вес', () => {
  const r = splitPair(200, 0);
  assert.equal(r.ok, true);
  assert.equal(r.other, 200);
  assert.equal(r.warning, '');
});

test('дробные граммы считаются точно, показываются целыми', () => {
  const r = splitPair(200.5, 120.3);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.other - 80.2) < 1e-9);
  assert.equal(displayGrams(r.other), '80');
  assert.equal(displayGrams(120.3), '120');
  assert.equal(displayGrams(200.5), '201');
  assert.equal(pairSumOk(200.5, 120.3, r.other), true);
});

test('сумма сходится только при точных значениях; допуск 0.01 г', () => {
  assert.equal(pairSumOk(200, 120, 80), true);
  assert.equal(pairSumOk(200, 120, 79), false);
  assert.equal(pairSumOk(200.5, 120.3, 80.2), true);
  assert.equal(pairSumOk(200.5, 120, 80), false);
  assert.equal(pairSumOk(NaN, 120, 80), false);
});

test('displayGrams: пустое и мусор — пустая строка', () => {
  assert.equal(displayGrams(NaN), '');
  assert.equal(displayGrams(null), '');
  assert.equal(displayGrams(undefined), '');
  assert.equal(displayGrams(0), '0');
});

const failed = results.filter(r => r[0] === 'FAIL');
results.forEach(([st, name]) => console.log(st + '  ' + name));
console.log('\n' + (results.length - failed.length) + ' из ' + results.length + ' прошли');
if (failed.length) process.exit(1);
