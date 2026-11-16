#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Алексей Гаврилов (Aleksei Gavrilov)
// Мастер ключей: agent-setup [add <провайдер> | list | remove <провайдер>]
import fs from 'node:fs';
import readline from 'node:readline';
import { PATHS, loadConfig, loadCatalog, readJson, saveKeys, baseUrlFor, isFreeModel } from '../router/common.mjs';

const catalog = loadCatalog();
const config = loadConfig();
const c = process.stdout.isTTY ? { b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', x: '\x1b[0m' } : { b: '', g: '', y: '', r: '', d: '', x: '' };
const say = (s = '') => console.log(s);

if (process.getuid && process.getuid() !== 0 && !process.env.FREE_AGENT_CONF) {
  console.error('Запустите от root: sudo agent-setup'); process.exit(1);
}

const keys = readJson(PATHS.keys, { providers: {} });
keys.providers ||= {};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const lines = []; let waiting = null; let ended = false;
rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l); });
rl.on('close', () => { ended = true; if (waiting) { const w = waiting; waiting = null; w(null); } });
const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
// ключ на экране - только маской: sk-or-v1-abc…wxyz
function maskKey(k) { k = String(k || ''); return k.length >= 20 ? k.slice(0, 12) + '…' + k.slice(-4) : k.slice(0, 3) + '…'; }
// Ключ вводится обычной видимой строкой: скрытый ввод (stty -echo) в веб-консолях хостинга
// не принимал Enter. Сразу после Enter строка с ключом стирается с экрана и заменяется маской.
function ask(q, { secret = false } = {}) {
  process.stdout.write(secret && tty ? q + '\n> ' : q);
  return new Promise((resolve) => {
    const done = (l) => {
      const v = l == null ? '' : l.trim();
      if (secret && tty && v) {
        const cols = process.stdout.columns || 80;
        const rows = Math.max(1, Math.ceil((2 + String(l).length) / cols));
        process.stdout.write('\x1b[1A\x1b[2K'.repeat(rows) + '\r> ' + maskKey(v) + '\n');
      }
      resolve(v);
    };
    if (lines.length) return done(lines.shift());
    if (ended) return done(null);
    waiting = done;
  });
}

async function http(url, opts = {}, ms = 25000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal }); return { status: r.status, text: await r.text() }; }
  catch (e) { return { status: 0, text: String(e?.cause?.code || e?.message || e) }; }
  finally { clearTimeout(t); }
}

async function verify(pid, key) {
  const p = catalog.providers[pid]; const base = baseUrlFor(pid, catalog, config);
  const auth = { authorization: `Bearer ${key}` };
  let available = null; let listed = null;
  const l = await http(base + '/models', { headers: auth });
  if (l.status === 401 || l.status === 403) return { ok: false, why: 'провайдер не принял ключ (ошибка ' + l.status + '). Проверьте, что скопировали ключ целиком.' };
  if (l.status === 200) {
    try { listed = (JSON.parse(l.text).data || []).map((m) => ({ id: String(m.id).replace(/^models\//, ''), pricing: m.pricing })); available = listed.map((m) => m.id); } catch {}
  }
  const freeIds = new Set((listed || []).filter((m) => isFreeModel(pid, m.id, m.pricing)).map((m) => m.id));
  // платные модели не пробуем и не сохраняем: тестовый запрос не должен списывать деньги
  const mine = catalog.models.filter((m) => m.provider === pid && (!available || available.includes(m.id)) && (available ? freeIds.has(m.id) : isFreeModel(pid, m.id)));
  let extra = [];
  if (available && !mine.length) {
    extra = available.filter((id) => freeIds.has(id)).filter((id) => /coder|code|gpt-oss|qwen|deepseek|kimi|glm|llama-3\.3|mistral-large|gemini|nemotron/i.test(id) && !/embed|guard|safety|vision|vl\b|tts|whisper|rerank/i.test(id)).slice(0, 4);
  }
  const probe = [...mine.map((m) => m.id), ...extra].slice(0, 3);
  if (!probe.length) return { ok: l.status === 200, free: [...freeIds], why: l.status === 200 ? '' : `список моделей не получен (код ${l.status}: ${l.text.slice(0, 120)})`, available, extra, note: 'ключ принят, но подходящих моделей в списке провайдера нет' };
  let last = '';
  for (const id of probe) {
    const r = await http(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...auth, ...(p.headers || {}) }, body: JSON.stringify({ model: id, max_tokens: 16, messages: [{ role: 'user', content: 'Ответь одним словом: ок' }] }) }, 40000);
    if (r.status === 200) return { ok: true, model: id, available, extra, free: [...freeIds] };
    if (r.status === 429) return { ok: true, model: id, available, extra, free: [...freeIds], note: 'ключ верный, но сейчас лимит - это нормально, агент будет переключаться' };
    if (r.status === 401 || r.status === 403) return { ok: false, why: `провайдер ответил ${r.status}: ключ не подходит или аккаунт не подтверждён (телефон/регион)` };
    last = `${id}: код ${r.status} ${r.text.slice(0, 120).replace(/\s+/g, ' ')}`;
  }
  return { ok: false, why: 'ключ принят, но тестовый запрос не прошёл. ' + last, available, extra };
}

function chown() { /* владелец выставляется в saveKeys до подмены файла */ }

async function addProvider(pid, { skippable = true, step = null } = {}) {
  const p = catalog.providers[pid];
  say(`\n${c.b}${step ? 'Шаг ' + step + ': ' : ''}${p.name}${c.x}`);
  say('  1) Откройте ссылку и зарегистрируйтесь:  ' + p.signup);
  say('     Что потребуется: ' + p.needs);
  say('  2) Создайте ключ на странице:            ' + p.keypage);
  say('  3) Скопируйте ключ и вставьте сюда.');
  say('     Лимиты бесплатного тарифа: ' + p.limits);
  if (p.trains) say(`${c.y}Внимание: на бесплатном тарифе этого провайдера запросы могут использоваться для обучения моделей.${c.x}`);
  say(`${c.d}Одна учётка на провайдера. Не раздавайте доступ другим и не заводите несколько учёток ради лимитов - это нарушает правила и ведёт к блокировке.${c.x}`);
  say(`${c.d}Личные данные, пароли и чужие документы в запросы не отправляйте.${c.x}`);
  if (keys.providers[pid]?.key) say(`${c.g}Ключ уже сохранён.${c.x} Введите новый, чтобы заменить, или Enter, чтобы оставить.`);
  for (;;) {
    const k = await ask(`Вставьте ключ ${p.key_hint ? '(' + p.key_hint + ') ' : ''}и нажмите Enter${skippable ? ' (пустой Enter - пропустить)' : ''}. Пока вставляете, ключ виден, после Enter он скроется:`, { secret: true });
    if (!k) { say('Пропущено. Вернуться позже: ' + c.b + 'agent-setup add ' + pid + c.x); return false; }
    if (/[^\x21-\x7e]/.test(k)) { say(c.r + 'В ключе есть пробелы, русские буквы или лишние символы - вставилось не то. Ключ состоит только из латинских букв, цифр и знаков. Попробуйте ещё раз.' + c.x); continue; }
    say(`Ключ получен (${k.length} символов: ${maskKey(k)}), проверяю тестовым запросом...`);
    const v = await verify(pid, k);
    if (v.ok) {
      keys.providers[pid] = { key: k, added: new Date().toISOString(), models_available: v.available || undefined, free_models: pid === 'openrouter' ? v.free : undefined, extra_models: v.extra?.length ? v.extra : undefined };
      saveKeys(keys); chown();
      say(`${c.g}Ключ работает${v.model ? ' (модель ' + v.model + ')' : ''}.${c.x}${v.note ? ' ' + v.note + '.' : ''}`);
      return true;
    }
    say(`${c.r}Не получилось:${c.x} ${v.why}`);
    const again = await ask('Ввести ключ ещё раз? (да/нет, по умолчанию нет): ');
    if (!/^(д|y)/i.test(again)) return false;
  }
}

function list() {
  say('\nПровайдеры:');
  for (const [pid, p] of Object.entries(catalog.providers)) {
    const k = keys.providers[pid];
    say(`  ${k?.key ? c.g + '[ключ есть]' + c.x : c.d + '[нет ключа]' + c.x}  ${pid.padEnd(11)} ${p.name}`);
  }
  say('');
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'list' || cmd === 'status') list();
else if (cmd === 'remove') {
  if (!catalog.providers[arg]) say('Укажите провайдера: ' + Object.keys(catalog.providers).join(', '));
  else { delete keys.providers[arg]; saveKeys(keys); chown(); say('Ключ ' + arg + ' удалён.'); }
} else if (cmd === 'add') {
  if (!catalog.providers[arg]) say('Укажите провайдера: ' + Object.keys(catalog.providers).join(', '));
  else await addProvider(arg, { skippable: true });
} else {
  say(`\n${c.b}Мастер ключей «Бесплатного агента»${c.x}`);
  say('Агент берёт бесплатные лимиты у нескольких провайдеров и переключается между ними. Чем больше ключей, тем дольше он работает без пауз.');
  say(`${c.y}Важно:${c.x} это НЕ модели Claude. Запросы (ваш код и тексты) уходят провайдерам. Личное и секретное не отправляйте.`);
  say('Начните с NVIDIA и OpenRouter: они сильные для кода. Любого провайдера можно пропустить (Enter) и вернуться позже.');
  const order = ['nvidia', 'openrouter', 'cerebras', 'groq', 'mistral', 'google'].filter((p) => catalog.providers[p]);
  let n = 0;
  for (const [i, pid] of order.entries()) { if (await addProvider(pid, { step: `${i + 1} из ${order.length}` })) n++; }
  list();
  say(n || Object.values(keys.providers).some((k) => k.key) ? `${c.g}Готово.${c.x} Запуск: ${c.b}agent${c.x}` : `${c.y}Ни одного ключа не введено.${c.x} Запустите agent-setup ещё раз, когда получите ключ.`);
}
rl.close();
