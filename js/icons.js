// =====================================================================
//  Тонкие линейные иконки (стиль «Афиша»). 24×24, цвет = цвет текста.
//  Чтобы поменять иконку — замените содержимое <path> в нужной строке.
// =====================================================================
const P = {
  transfer: '<path d="M4 8h13M13 4l4 4-4 4"/><path d="M20 16H7M11 12l-4 4 4 4"/>',
  writeoff: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/><path d="M10 11v5M14 11v5"/>',
  photo: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7l1.5-3h4l1.5 3"/><circle cx="12" cy="13.5" r="3.5"/>',
  ttk: '<path d="M4 4h16l-8 9z"/><path d="M12 13v7M8 20h8"/><path d="M15.5 4l2.5-2.5"/>',
  inv: '<path d="M10 2.5h4v3l1.5 2.5V21h-7V8L10 5.5z"/><path d="M8.5 12h7M8.5 16h7"/>',
  acts: '<path d="M12 3v17M7 20h10M5 6h14"/><path d="M5 6l-3 7a3 3 0 006 0zM19 6l-3 7a3 3 0 006 0z"/>',
  gift: '<rect x="3.5" y="9" width="17" height="11.5" rx="1"/><path d="M2.5 9h19M12 9v11.5"/><path d="M12 9C10 4 6 4.5 7 7.5 7.6 9 12 9 12 9zM12 9c2-5 6-4.5 5-1.5C16.4 9 12 9 12 9z"/>',
  quiz: '<circle cx="12" cy="12" r="9"/><path d="M9.3 9.4a2.8 2.8 0 015.2 1.5c0 1.6-2.7 1.9-2.7 3.6"/><path d="M12 17.4h.01"/>',
};

/** Возвращает SVG-иконку как DOM-элемент. */
export function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  return t.content.firstChild;
}
