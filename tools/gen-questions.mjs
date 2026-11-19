// =====================================================================
//  ГЕНЕРАТОР БАНКА ВОПРОСОВ ДЛЯ БЭКЕНДА
//
//  Читает content/вопросы.tsv (60 вопросов, 10 колонок) и пишет
//  apps-script/Вопросы.gs — константу QUIZ_QUESTIONS для Apps Script.
//  Так импорт в таблицу воспроизводим: правится только TSV,
//  а файл для clasp пересобирается этой командой:
//
//      node tools/gen-questions.mjs
// =====================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const TSV = join(root, 'content', 'вопросы.tsv');
const OUT = join(root, 'apps-script', 'Вопросы.gs');

// Колонки TSV и поля вопроса в листе (порядок важен)
const COLUMNS = [
  ['id', 'id'],
  ['категория', 'категория'],
  ['вопрос', 'вопрос'],
  ['вариант_A', 'A'],
  ['вариант_B', 'B'],
  ['вариант_C', 'C'],
  ['вариант_D', 'D'],
  ['правильный', 'правильный'],
  ['пояснение', 'пояснение'],
  ['источник', 'источник'],
];

// BOM в начале файла, \r\n после правки в Excel и «умные» кавычки-ёлочки не ломаем:
// они лежат в тексте как есть, TSV их не экранирует.
const raw = readFileSync(TSV, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/).filter(line => line.trim() !== '');
if (lines.length < 2) throw new Error('В TSV нет данных');

const header = lines[0].split('\t').map(h => h.trim());
if (header.length !== COLUMNS.length || header.some((h, i) => h !== COLUMNS[i][0])) {
  throw new Error('Неожиданная шапка TSV: ' + JSON.stringify(header));
}

const questions = lines.slice(1).map((line, idx) => {
  const cells = line.split('\t');
  if (cells.length !== COLUMNS.length) {
    throw new Error(`Строка ${idx + 2}: колонок ${cells.length}, ожидается ${COLUMNS.length}`);
  }
  const q = {};
  COLUMNS.forEach(([, field], i) => { q[field] = cells[i].trim(); });
  return q;
});

// --- Проверки целостности: битый вопрос лучше не пускать в таблицу ---
const problems = [];
const seen = new Set();
questions.forEach((q, i) => {
  const where = `Строка ${i + 2} (${q.id || 'без id'})`;
  for (const [, field] of COLUMNS) {
    if (!q[field]) problems.push(`${where}: пустое поле «${field}»`);
  }
  if (q.id && seen.has(q.id)) problems.push(`${where}: повторяющийся id`);
  seen.add(q.id);
  if (q['правильный'] && !/^[ABCD]$/.test(q['правильный'])) {
    problems.push(`${where}: правильный = «${q['правильный']}», ожидается A/B/C/D`);
  }
});
if (problems.length) throw new Error('Проблемы в банке вопросов:\n' + problems.join('\n'));

// --- Сборка файла ---
const banner = `/**
 * =====================================================================
 *  БАНК ВОПРОСОВ ДЛЯ ВИКТОРИНЫ — данные листа «Вопросы»
 * =====================================================================
 *
 *  ФАЙЛ СГЕНЕРИРОВАН: не правьте его руками.
 *  Источник: content/вопросы.tsv
 *  Пересобрать: node tools/gen-questions.mjs
 *
 *  Вопросов: ${questions.length}. Поля: id, категория, вопрос, A–D,
 *  правильный (буква), пояснение, источник (название документа).
 *
 *  setupQuiz() в «Код.gs» заливает эти вопросы в лист «Вопросы»,
 *  если он пуст. Повторный запуск дублей не создаёт.
 * =====================================================================
 */

const QUIZ_QUESTIONS = `;

writeFileSync(OUT, banner + JSON.stringify(questions, null, 2) + ';\n', 'utf8');

const byCat = {};
questions.forEach(q => { byCat[q['категория']] = (byCat[q['категория']] || 0) + 1; });
const distinctSources = new Set(questions.map(q => q['источник'])).size;
console.log(`Готово: ${OUT}`);
console.log(`Вопросов: ${questions.length}, категорий: ${Object.keys(byCat).length}, уникальных источников: ${distinctSources}`);
console.log(Object.entries(byCat).map(([c, n]) => `  ${c}: ${n}`).join('\n'));
