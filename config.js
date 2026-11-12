// =====================================================================
//  НАСТРОЙКИ ПРИЛОЖЕНИЯ — единственный файл, который нужно поменять
// =====================================================================

// Адрес веб-приложения Apps Script. Его выдаёт Google после
// «Начать развёртывание → Веб-приложение». Заканчивается на /exec
export const API_URL = 'https://script.google.com/macros/s/AKfycbzRXm4P2dC_xEmSrw4RjAXWk6J-Hav54iHrXK8xddGH9o5NcsdchIKkaZArwGqvAJN7-w/exec';

// Как часто приложение пытается отправить очередь, пока открыто (мс)
export const SYNC_INTERVAL_MS = 30_000;

// Фото уборки сжимаются на телефоне до этого размера по длинной стороне
export const PHOTO_MAX_SIDE = 1600;
export const PHOTO_QUALITY = 0.72;
