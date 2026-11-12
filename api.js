// =====================================================================
//  СВЯЗЬ С APPS SCRIPT
//
//  Две ошибки различаем принципиально:
//    NetworkError — до сервера не достучались (нет сети, таймаут).
//                   Запись остаётся в очереди и уйдёт позже.
//    ApiError     — сервер ответил, но отказал (неверный PIN и т.п.).
// =====================================================================

import { API_URL } from '../config.js';

export class NetworkError extends Error {}
export class ApiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function request(url, options, timeoutMs) {
  if (!/^https?:\/\//.test(API_URL)) throw new ApiError('В config.js не указан адрес Apps Script');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...options, signal: ctrl.signal, redirect: 'follow', cache: 'no-store' });
  } catch (e) {
    throw new NetworkError('Нет связи с сервером');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new NetworkError('Сервер ответил ' + res.status);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    // Google иногда отдаёт HTML-страницу вместо JSON (например, при сбое) — считаем это сетевой проблемой
    throw new NetworkError('Сервер вернул не JSON');
  }
  if (!data.ok) throw new ApiError(data.error || 'Ошибка сервера', data.code);
  return data;
}

/** GET: чтение (справочник, ТТК, фото ТТК). */
export function apiGet(params, timeoutMs = 20000) {
  const qs = new URLSearchParams(params).toString();
  return request(API_URL + '?' + qs, { method: 'GET' }, timeoutMs);
}

/**
 * POST: запись.
 * Content-Type text/plain — специально: так браузер не делает лишний
 * предварительный запрос (CORS preflight), который Apps Script не поддерживает.
 */
export function apiPost(body, timeoutMs = 30000) {
  return request(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  }, timeoutMs);
}
