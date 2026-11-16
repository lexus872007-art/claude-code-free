#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Алексей Гаврилов (Aleksei Gavrilov)
// Маршрутизатор «Бесплатного агента»: принимает запросы Claude Code (Anthropic Messages)
// и отдаёт их бесплатным провайдерам (OpenAI-формат), перебирая провайдеров при отказе.
// Слушает ТОЛЬКО 127.0.0.1. Без внешних зависимостей. Наружу ходит только к провайдерам, чьи ключи введены.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PATHS, loadConfig, loadCatalog, loadKeys, baseUrlFor, isFreeModel, scrubSecrets } from './common.mjs';
import { anthropicToOpenAI, estimateTokens, MessageBuilder } from './convert.mjs';
import { openUpstream, UpstreamError } from './upstream.mjs';

const startConfig = loadConfig();
const HOST = '127.0.0.1';
const knownKeys = () => Object.values(loadKeys().providers || {}).map((k) => k?.key).filter(Boolean);
const clean = (t) => scrubSecrets(t, knownKeys());
const log = (...a) => console.log(new Date().toISOString(), ...a.map((x) => (typeof x === 'string' ? clean(x) : x)));

let TOKEN = process.env.FREE_AGENT_TOKEN || '';
try { if (!TOKEN) TOKEN = fs.readFileSync(PATHS.token, 'utf8').trim(); } catch {}
if (!TOKEN) { console.error('Нет токена: ' + PATHS.token + '. Запустите установку заново.'); process.exit(1); }

// ---------- статистика (по строке JSON на попытку) ----------
function stat(rec) {
  try {
    fs.mkdirSync(PATHS.state, { recursive: true });
    fs.appendFileSync(PATHS.stats, JSON.stringify({ ts: Date.now(), ...rec }) + '\n');
  } catch (e) { log('stats write failed:', e.message); }
}
function pruneStats() {
  try {
    const cut = Date.now() - 7 * 86400_000;
    const lines = fs.readFileSync(PATHS.stats, 'utf8').split('\n').filter(Boolean);
    const keep = lines.filter((l) => { try { return JSON.parse(l).ts >= cut; } catch { return false; } });
    if (keep.length !== lines.length) fs.writeFileSync(PATHS.stats, keep.join('\n') + (keep.length ? '\n' : ''));
  } catch {}
}
pruneStats(); setInterval(pruneStats, 6 * 3600_000).unref();

// ---------- паузы провайдеров ----------
const authKey = new Map(); // провайдер -> отпечаток ключа, на котором получили 401
const keyHash = (p) => crypto.createHash('sha256').update(String(loadKeys().providers?.[p]?.key || '')).digest('hex');
const cool = new Map(); // ключ -> время окончания паузы
const rate429 = new Map(); // провайдер -> времена последних 429
const coolUntil = (k) => {
  if (authKey.has(k) && authKey.get(k) !== keyHash(k)) { cool.delete(k); authKey.delete(k); } // ключ заменили - пауза снята
  return cool.get(k) || 0;
};
function setCool(k, ms) { cool.set(k, Math.max(coolUntil(k), Date.now() + ms)); }
function penalize(entry, err) {
  const pk = entry.provider, mk = `${entry.provider}|${entry.id}`;
  switch (err.kind) {
    case 'rate': {
      const ms = err.retryAfterMs ?? 60_000;
      setCool(mk, ms);
      const arr = (rate429.get(pk) || []).filter((t) => Date.now() - t < 60_000); arr.push(Date.now()); rate429.set(pk, arr);
      if (arr.length >= 3 || ms >= 3600_000) setCool(pk, Math.min(ms, 3600_000)); // лимит ключа целиком
      break;
    }
    case 'auth': setCool(pk, 3600_000); authKey.set(pk, keyHash(entry.provider)); break;
    case 'model': setCool(mk, 3600_000); break;
    case 'timeout': setCool(mk, 45_000); break;
    case 'server': setCool(mk, 30_000); break;
    case 'bad': setCool(mk, 20_000); break;
  }
}

// ---------- выбор кандидатов ----------
function candidates(req) {
  const catalog = loadCatalog(), keys = loadKeys().providers || {};
  const want = (req.model || '').toLowerCase();
  const tools = !!req.tools?.length;
  let list = [];
  for (const m of catalog.models) {
    const k = keys[m.provider];
    if (!k?.key) continue;
    if (k.models_available?.length && !k.models_available.includes(m.id)) continue; // модели нет у этого провайдера
    if (m.provider === 'openrouter' && !isFreeModel('openrouter', m.id) && !(k.free_models || []).includes(m.id)) continue; // платные модели OpenRouter не используем
    list.push({ ...m });
  }
  for (const [pid, k] of Object.entries(keys)) { // модели, добавленные мастером вручную
    for (const id of k.extra_models || []) if (k.key && (isFreeModel(pid, id) || (k.free_models || []).includes(id)) && !list.some((m) => m.provider === pid && m.id === id)) list.push({ provider: pid, id, ctx: 32000, max_out: 8192, tools: true, extra: true });
  }
  // конкретная модель из каталога, заданная пользователем (ANTHROPIC_MODEL=...)
  const pinned = list.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === want || m.id.toLowerCase() === want);
  if (pinned.length) list = [...pinned, ...list.filter((m) => !pinned.includes(m))];
  else if (/haiku/.test(want)) list = [...list.filter((m) => m.fast), ...list.filter((m) => !m.fast)]; // мелкие фоновые задачи Claude Code
  const est = estimateTokens(req);
  // место под ответ - не больше, чем модель реально выдаёт (Claude Code просит max_tokens 128000)
  list = list.filter((m) => (!tools || m.tools !== false) && (m.ctx || 32000) >= est + Math.min(req.max_tokens || 4096, m.max_out || 8192));
  return list;
}

const now = () => Date.now();
const errBody = (status, type, message) => ({ type: 'error', error: { type, message } });

function send(res, status, obj, headers = {}) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), ...headers });
  res.end(b);
}

// ---------- главный путь ----------
async function handleMessages(req, res, body) {
  const config = loadConfig(); // настройки перечитываются на каждый запрос
  const wantStream = !!body.stream;
  const catalog = loadCatalog(), keys = loadKeys().providers || {};
  const cands = candidates(body);
  const deadline = now() + config.total_deadline_s * 1000;
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  const tried = new Set(); const failures = [];
  let attempts = 0;
  const inTok = estimateTokens(body);

  if (!cands.length) {
    return send(res, 400, errBody(400, 'invalid_request_error', 'Нет подходящих моделей: не введено ни одного ключа провайдера (команда agent-setup) или запрос слишком большой для их моделей.'));
  }

  while (attempts < config.max_attempts && now() < deadline) {
    const entry = cands.find((m) => !tried.has(`${m.provider}|${m.id}`) && coolUntil(m.provider) <= now() && coolUntil(`${m.provider}|${m.id}`) <= now());
    if (!entry) break;
    tried.add(`${entry.provider}|${entry.id}`);
    attempts++;
    const prov = catalog.providers[entry.provider] || {};
    const url = baseUrlFor(entry.provider, catalog, config) + '/chat/completions';
    const t0 = now();
    let up;
    // общий предел на весь запрос: по его исходу текущая попытка отменяется (клиенту ещё ничего не отдано - пойдём дальше, иначе честная ошибка)
    const att = new AbortController();
    const onCl = () => att.abort(new UpstreamError('client', 'клиент отключился'));
    if (ac.signal.aborted) onCl(); else ac.signal.addEventListener('abort', onCl, { once: true });
    const dl = setTimeout(() => att.abort(new UpstreamError('timeout', `превышено общее время запроса ${config.total_deadline_s} с`)), Math.max(deadline - now(), 1));
    const endAtt = () => { clearTimeout(dl); ac.signal.removeEventListener('abort', onCl); };
    try {
      const payload = anthropicToOpenAI(body, entry, prov);
      up = await openUpstream({
        url, apiKey: keys[entry.provider].key, payload,
        ttftMs: config.first_token_timeout_s * 1000, stallMs: config.stall_timeout_s * 1000, thinkMs: config.think_timeout_s * 1000,
        clientSignal: att.signal, extraHeaders: prov.headers || {},
      });
    } catch (e) {
      endAtt();
      if (e instanceof UpstreamError && e.kind === 'client') return; // клиент ушёл
      const err = e instanceof UpstreamError ? e : new UpstreamError('server', String(e?.message || e));
      penalize(entry, err);
      const outcome = { rate: '429', server: '5xx', timeout: 'timeout', auth: 'auth', model: 'model', bad: '4xx' }[err.kind];
      stat({ provider: entry.provider, model: entry.id, outcome, status: err.status, ms: now() - t0 });
      failures.push(`${entry.provider}/${entry.id}: ${clean(err.message)}`);
      log(`пропуск ${entry.provider}/${entry.id}: ${err.message}`);
      continue;
    }

    // Первый токен получен - с этого момента отвечаем этим провайдером.
    const label = `${entry.provider}/${entry.id}`;
    const b = new MessageBuilder(label, inTok, wantStream ? (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`) : null);
    if (wantStream) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-routed-via': label });
    try {
      for (const ev of up.first) b.push(ev);
      for await (const ev of up.rest) b.push(ev);
      endAtt();
      b.finish();
      stat({ provider: entry.provider, model: entry.id, outcome: 'ok', ms: now() - t0, ttft: up.ttft, out: b.usage.output_tokens });
      if (wantStream) res.end(); else send(res, 200, b.message(), { 'x-routed-via': label });
    } catch (e) {
      endAtt();
      const err = e instanceof UpstreamError ? e : new UpstreamError('server', String(e?.message || e));
      if (err.kind === 'client') return;
      penalize(entry, err);
      stat({ provider: entry.provider, model: entry.id, outcome: err.kind === 'timeout' ? 'timeout' : '5xx', ms: now() - t0, midstream: true });
      log(`обрыв на середине ${label}: ${err.message}`);
      // Часть ответа уже у клиента - повторить нельзя. Для потока шлём ошибку, Claude Code сам повторит запрос.
      if (wantStream && !res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: clean(`Провайдер ${label} оборвал ответ: ${err.message}`) } })}\n\n`);
        res.end();
      } else if (!wantStream && !res.headersSent) {
        // не потоковый запрос: клиент ничего не получил, можно перебирать дальше
        if (attempts < config.max_attempts) { failures.push(`${label}: ${clean(err.message)}`); continue; }
        send(res, 529, errBody(529, 'overloaded_error', clean(err.message)));
      }
    }
    return;
  }

  // Все провайдеры отказали или на паузе.
  const waits = [...cool.entries()].map(([, t]) => t - now()).filter((x) => x > 0);
  const retry = waits.length ? Math.ceil(Math.min(...waits) / 1000) : 30;
  const allRate = failures.length && failures.every((f) => /HTTP 429/.test(f));
  const msg = 'Все бесплатные провайдеры сейчас недоступны или исчерпали лимит. ' + (failures.length ? 'Последние ошибки: ' + failures.slice(-4).join(' | ') : 'Провайдеры на паузе после предыдущих отказов.') + ` Повтор через ${retry} с.`;
  if (res.headersSent) return;
  send(res, allRate ? 429 : 529, errBody(0, allRate ? 'rate_limit_error' : 'overloaded_error', msg), { 'retry-after': String(retry) });
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, errBody(400, 'invalid_request_error', 'Некорректный адрес запроса')); }
    if (req.method === 'GET' && url.pathname === '/health') {
      const keys = loadKeys().providers || {};
      return send(res, 200, { ok: true, providers: Object.keys(keys).filter((k) => keys[k].key) });
    }
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if ((req.headers['x-api-key'] || bearer) !== TOKEN) return send(res, 401, errBody(401, 'authentication_error', 'Неверный токен маршрутизатора'));

    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, errBody(400, 'invalid_request_error', 'Не разобрать JSON')); }
      return await handleMessages(req, res, body);
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, errBody(400, 'invalid_request_error', 'Не разобрать JSON')); }
      return send(res, 200, { input_tokens: estimateTokens(body) });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const catalog = loadCatalog(), keys = loadKeys().providers || {};
      const data = catalog.models.filter((m) => keys[m.provider]?.key).map((m) => ({ type: 'model', id: `${m.provider}/${m.id}`, display_name: m.id, created_at: '2026-01-01T00:00:00Z' }));
      return send(res, 200, { data, has_more: false, first_id: data[0]?.id, last_id: data.at(-1)?.id });
    }
    send(res, 404, errBody(404, 'not_found_error', 'нет такого адреса'));
  } catch (e) {
    log('ошибка:', e?.stack || e);
    if (!res.headersSent) send(res, 500, errBody(500, 'api_error', 'внутренняя ошибка маршрутизатора'));
    else res.end();
  }
});
server.on('clientError', (e, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n'); } catch {} });
process.on('uncaughtException', (e) => log('необработанная ошибка:', e?.stack || e));
process.on('unhandledRejection', (e) => log('необработанный отказ:', e?.stack || e));
server.requestTimeout = 0; server.headersTimeout = 30_000; server.keepAliveTimeout = 5_000;
server.listen(startConfig.port, HOST, () => log(`маршрутизатор слушает ${HOST}:${startConfig.port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
