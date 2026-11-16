// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Алексей Гаврилов (Aleksei Gavrilov)
// Один заход к провайдеру: ждём ПЕРВЫЙ токен не дольше N секунд. Пока токена нет, клиенту ничего не отдано,
// поэтому перейти к следующему провайдеру безопасно (повтор ничего не дублирует).
import { sseJson, normalizeChunk } from './convert.mjs';
import { scrubSecrets } from './common.mjs';

export class UpstreamError extends Error {
  constructor(kind, message, { status, retryAfterMs } = {}) {
    super(scrubSecrets(message)); this.kind = kind; this.status = status; this.retryAfterMs = retryAfterMs;
  }
}
// kind: 'rate' (429) | 'server' (5xx/сеть) | 'timeout' | 'auth' (401/403) | 'model' (нет модели) | 'bad' (400 и прочее)

function parseRetryAfter(h) {
  if (!h) return null;
  const n = Number(h);
  if (!Number.isNaN(n)) return Math.min(n * 1000, 3600_000);
  const d = Date.parse(h);
  return Number.isNaN(d) ? null : Math.min(Math.max(d - Date.now(), 0), 3600_000);
}

function classifyHttp(status, body, headers, key) {
  const msg = `HTTP ${status}: ${scrubSecrets(String(body), [key]).slice(0, 300).replace(/\s+/g, ' ')}`;
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'));
  if (status === 429) {
    const daily = /per day|daily|quota|exhausted|billing/i.test(body);
    return new UpstreamError('rate', msg, { status, retryAfterMs: retryAfterMs ?? (daily ? 3600_000 : 60_000) });
  }
  if (status === 401 || status === 403) return new UpstreamError('auth', msg, { status });
  if (status === 404 || (status === 400 && /model/i.test(body) && /(not found|does not exist|unknown|invalid model|not supported|decommission)/i.test(body))) {
    return new UpstreamError('model', msg, { status });
  }
  if (status >= 500 || status === 408 || status === 425) return new UpstreamError('server', msg, { status });
  return new UpstreamError('bad', msg, { status });
}

/**
 * Возвращает { first: [события до и включая первый токен], rest: async-генератор остальных событий, t0, ttft }.
 * Бросает UpstreamError при 429/5xx/таймауте/сети.
 */
export async function openUpstream({ url, apiKey, payload, ttftMs, stallMs, thinkMs = 120_000, clientSignal, extraHeaders = {} }) {
  const ac = new AbortController();
  const onClient = () => ac.abort(clientSignal.reason instanceof UpstreamError ? clientSignal.reason : new UpstreamError('client', 'клиент отключился'));
  if (clientSignal) { if (clientSignal.aborted) onClient(); else clientSignal.addEventListener('abort', onClient, { once: true }); }
  const t0 = Date.now();
  let timer = setTimeout(() => ac.abort(new UpstreamError('timeout', `нет первого токена за ${Math.round(ttftMs / 1000)} с`)), ttftMs);
  const fail = (err) => {
    clearTimeout(timer);
    clientSignal?.removeEventListener('abort', onClient);
    ac.abort();
    if (err instanceof UpstreamError) throw err;
    const reason = ac.signal.reason;
    if (reason instanceof UpstreamError) throw reason;
    throw new UpstreamError('server', 'сеть: ' + scrubSecrets(err?.cause?.code || err?.message || err, [apiKey]));
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${apiKey}`, ...extraHeaders },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (!res.ok) { const body = await res.text(); throw classifyHttp(res.status, body, res.headers, apiKey); }
  } catch (e) { fail(e); }

  const reader = res.body.getReader();
  const ct = res.headers.get('content-type') || '';
  let read = () => reader.read();
  let guard = () => {};
  // Ограничение на ожидание следующего куска: сначала до первого токена, потом по паузе в потоке.
  const readWithin = (ms) => new Promise((resolve, reject) => {
    const id = setTimeout(() => { const e = new UpstreamError('timeout', 'поток остановился'); ac.abort(e); reject(e); }, ms);
    read().then((v) => { clearTimeout(id); resolve(v); }, (e) => { clearTimeout(id); reject(e); });
  });

  // Не-потоковый ответ (бывает у слабых шлюзов): один JSON.
  let jsonMode = false;
  if (ct.includes('application/json')) {
    jsonMode = true;
    let text = '';
    try {
      const dec = new TextDecoder();
      for (;;) { const { done, value } = await read(); if (done) break; text += dec.decode(value, { stream: true }); }
    } catch (e) { fail(e); }
    clearTimeout(timer);
    let j; try { j = JSON.parse(text); } catch { fail(new UpstreamError('server', 'провайдер вернул не JSON')); }
    if (j.error) fail(new UpstreamError('server', 'ошибка провайдера: ' + scrubSecrets(j.error.message || JSON.stringify(j.error), [apiKey]).slice(0, 200)));
    const m = j.choices?.[0]?.message || {};
    const evs = [];
    if (m.content) evs.push({ k: 'text', t: m.content });
    (m.tool_calls || []).forEach((tc, i) => evs.push({ k: 'tool', index: i, id: tc.id, name: tc.function?.name, args: tc.function?.arguments || '' }));
    evs.push({ k: 'finish', reason: j.choices?.[0]?.finish_reason || 'stop' });
    if (j.usage) evs.push({ k: 'usage', in: j.usage.prompt_tokens || 0, out: j.usage.completion_tokens || 0 });
    clientSignal?.removeEventListener('abort', onClient);
    if (!evs.some((e) => e.k === 'text' || e.k === 'tool')) throw new UpstreamError('server', 'пустой ответ');
    return { first: evs, rest: (async function* () {})(), t0, ttft: Date.now() - t0 };
  }

  const gen = sseJson(() => (stage === 'first' ? read() : readWithin(stallMs)));
  let stage = 'first';
  const first = [];
  let ttft = null; let sawFinish = false;
  const truncatedErr = () => new UpstreamError('server', 'поток оборван без завершения');
  const it = gen[Symbol.asyncIterator]();
  try {
    for (;;) {
      const { value, done } = await it.next();
      if (done) { if (value?.truncated && !first.some((e) => e.k === 'finish')) throw truncatedErr(); break; }
      const evs = normalizeChunk(value);
      first.push(...evs);
      if (evs.some((e) => e.k === 'think') && ttft == null) { // модель жива и рассуждает: дальше ждём по паузе в потоке, а не по порогу первого токена,
        // но не бесконечно: общий предел на «мысли» без текста
        ttft = Date.now() - t0; clearTimeout(timer); stage = 'rest';
        timer = setTimeout(() => ac.abort(new UpstreamError('timeout', `одни рассуждения дольше ${Math.round(thinkMs / 1000)} с`)), thinkMs);
      }
      if (evs.some((e) => e.k === 'text' || e.k === 'tool')) { if (ttft == null) ttft = Date.now() - t0; break; }
      if (evs.some((e) => e.k === 'finish')) break;
    }
  } catch (e) {
    if (e.isChunkError) fail(classifyHttp(Number(e.upstreamStatus) || 500, e.message, new Headers(), apiKey));
    if (e.isCorrupt) fail(new UpstreamError('server', e.message));
    fail(e);
  }
  clearTimeout(timer);
  sawFinish = first.some((e) => e.k === 'finish');
  // поток кончился, а текста или вызова инструмента так и не было (в том числе одни «мысли»): это отказ, клиенту ничего не отдано
  if (!first.some((e) => e.k === 'text' || e.k === 'tool')) fail(new UpstreamError('server', 'пустой ответ (нет текста и вызовов инструментов)'));
  if (ttft == null) ttft = Date.now() - t0;
  stage = 'rest';
  const rest = (async function* () {
    try {
      for (;;) {
        const { value, done } = await it.next();
        if (done) { if (value?.truncated && !sawFinish) throw truncatedErr(); return; }
        const evs = normalizeChunk(value);
        if (evs.some((e) => e.k === 'finish')) sawFinish = true;
        yield* evs;
      }
    } catch (e) {
      if (ac.signal.reason instanceof UpstreamError) throw ac.signal.reason;
      throw e instanceof UpstreamError ? e : new UpstreamError('server', 'обрыв потока: ' + (e?.message || e));
    } finally { clientSignal?.removeEventListener('abort', onClient); try { ac.abort(); } catch {} }
  })();
  return { first, rest, t0, ttft };
}
