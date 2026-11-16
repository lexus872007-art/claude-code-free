// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Алексей Гаврилов (Aleksei Gavrilov)
// Тесты маршрутизатора против мока провайдеров. Запуск: node --test tests/router.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let MOCK_PORT = 0;
let mock;
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const TOKEN = 'testtoken';

before(async () => {
  MOCK_PORT = await freePort();
  mock = spawn(process.execPath, [path.join(here, 'mock-provider.mjs'), String(MOCK_PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${MOCK_PORT}/_log`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
after(() => mock.kill());

async function startRouter(order, { ftt = 3, extra = {}, keyFor = (n) => 'good-' + n, port, catalogEdit } = {}) {
  port ||= await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-'));
  const conf = path.join(dir, 'conf'), state = path.join(dir, 'state');
  fs.mkdirSync(conf); fs.mkdirSync(state);
  const catalog = { providers: {}, models: [] };
  const keys = { providers: {} }; const overrides = {};
  for (const n of order) {
    catalog.providers[n] = { name: n, base: 'http://unused.invalid/v1' };
    catalog.models.push({ provider: n, id: 'm-' + n, ctx: 100000, max_out: 4096, tools: true });
    keys.providers[n] = { key: keyFor(n) };
    overrides[n] = `http://127.0.0.1:${MOCK_PORT}/${n}/v1`;
  }
  catalogEdit?.(catalog);
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(conf, 'keys.json'), JSON.stringify(keys));
  fs.writeFileSync(path.join(conf, 'config.json'), JSON.stringify({ port, first_token_timeout_s: ftt, stall_timeout_s: 3, provider_overrides: overrides, ...extra }));
  const p = spawn(process.execPath, [path.join(here, '..', 'router', 'server.mjs')], {
    env: { ...process.env, FREE_AGENT_CONF: conf, FREE_AGENT_STATE: state, FREE_AGENT_CATALOG: path.join(dir, 'catalog.json'), FREE_AGENT_TOKEN: TOKEN },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(url + '/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const stats = () => fs.readFileSync(path.join(state, 'stats.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { url, stop: () => p.kill(), stats, dir, port };
}
const call = (r, body, stream = false) => fetch(r.url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': TOKEN }, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'привет' }], ...body, stream }) });
const mockLog = async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/_log`)).json();
const reset = () => fetch(`http://127.0.0.1:${MOCK_PORT}/_reset`);
async function events(res) {
  const t = await res.text(); const out = [];
  for (const blk of t.split('\n\n')) { const e = blk.match(/event: (.*)/)?.[1]; const d = blk.match(/data: (.*)/)?.[1]; if (e) out.push({ e, d: JSON.parse(d) }); }
  return out;
}

test('без токена 401, health без токена открыт', async () => {
  const r = await startRouter(['ok']);
  try {
    assert.equal((await fetch(r.url + '/v1/messages', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(r.url + '/health')).status, 200);
  } finally { r.stop(); }
});

test('429 -> следующий провайдер; повторный запрос не бьёт в провайдера на паузе', async () => {
  await reset(); const r = await startRouter(['r429', 'ok']);
  try {
    const res = await call(r, {}); const j = await res.json();
    assert.equal(res.status, 200); assert.match(j.content[0].text, /из ok/);
    assert.match(res.headers.get('x-routed-via'), /^ok\//);
    await call(r, {});
    const log = (await mockLog()).filter((x) => x.path === '/chat/completions');
    assert.equal(log.filter((x) => x.name === 'r429').length, 1, 'после 429 провайдер на паузе');
    const st = r.stats(); assert.equal(st.filter((x) => x.outcome === '429').length, 1);
  } finally { r.stop(); }
});

test('5xx (500 и 503) -> следующий', async () => {
  await reset(); const r = await startRouter(['e500', 'e503', 'ok']);
  try {
    const j = await (await call(r, {})).json(); assert.match(j.content[0].text, /из ok/);
    assert.deepEqual(r.stats().map((x) => x.outcome), ['5xx', '5xx', 'ok']);
  } finally { r.stop(); }
});

test('долгий ответ без байтов -> по таймауту следующий', async () => {
  await reset(); const r = await startRouter(['slow', 'ok'], { ftt: 2 });
  try {
    const t = Date.now(); const j = await (await call(r, {})).json(); const dt = Date.now() - t;
    assert.match(j.content[0].text, /из ok/); assert.ok(dt >= 1900 && dt < 5000, 'время ' + dt);
    assert.equal(r.stats()[0].outcome, 'timeout');
  } finally { r.stop(); }
});

test('заголовки пришли, но токенов нет (stallfirst) -> таймаут и следующий; потоковый режим', async () => {
  await reset(); const r = await startRouter(['stallfirst', 'ok'], { ftt: 2 });
  try {
    const ev = await events(await call(r, {}, true));
    assert.equal(ev[0].e, 'message_start');
    assert.equal(ev.filter((x) => x.e === 'content_block_delta').map((x) => x.d.delta.text).join(''), 'Привет из ok');
    assert.equal(ev.at(-1).e, 'message_stop');
    assert.equal(r.stats()[0].outcome, 'timeout');
  } finally { r.stop(); }
});

test('медленный, но живой (первый токен через 2 с при пороге 4) - остаёмся на нём', async () => {
  await reset(); const r = await startRouter(['slowtok', 'ok'], { ftt: 4 });
  try {
    const j = await (await call(r, {})).json(); assert.match(j.content[0].text, /из slowtok/);
  } finally { r.stop(); }
});

test('обрыв посреди потока: в потоке - событие error; без потока - перебор дальше', async () => {
  await reset(); let r = await startRouter(['midcut', 'ok']);
  try {
    const ev = await events(await call(r, {}, true));
    assert.ok(ev.some((x) => x.e === 'error'), 'есть error'); assert.ok(ev.some((x) => x.e === 'content_block_delta'));
  } finally { r.stop(); }
  r = await startRouter(['midcut', 'ok']);
  try {
    const j = await (await call(r, {}, false)).json(); assert.match(j.content[0].text, /из ok/);
  } finally { r.stop(); }
});

test('вызов инструмента: поток и не поток, и перевод запроса', async () => {
  await reset(); const r = await startRouter(['tool']);
  const body = {
    system: [{ type: 'text', text: 'Ты помощник' }],
    tools: [{ name: 'Bash', description: 'shell', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: 'покажи файлы' },
      { role: 'assistant', content: [{ type: 'text', text: 'ок' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '/work' }] }, { type: 'text', text: 'дальше' }] },
    ],
  };
  try {
    const ev = await events(await call(r, body, true));
    const start = ev.find((x) => x.e === 'content_block_start').d.content_block;
    assert.equal(start.type, 'tool_use'); assert.equal(start.name, 'Bash');
    const args = ev.filter((x) => x.d.delta?.type === 'input_json_delta').map((x) => x.d.delta.partial_json).join('');
    assert.deepEqual(JSON.parse(args), { command: 'ls' });
    assert.equal(ev.find((x) => x.e === 'message_delta').d.delta.stop_reason, 'tool_use');
    const j = await (await call(r, body, false)).json();
    assert.equal(j.stop_reason, 'tool_use'); assert.deepEqual(j.content[0].input, { command: 'ls' });
    const sent = (await mockLog()).filter((x) => x.path === '/chat/completions')[0].body;
    assert.equal(sent.messages[0].role, 'system'); assert.equal(sent.messages[0].content, 'Ты помощник');
    assert.equal(sent.tools[0].function.name, 'Bash'); assert.equal(sent.tool_choice, 'auto');
    assert.deepEqual(sent.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
    assert.equal(sent.messages[3].tool_call_id, 'toolu_1'); assert.equal(sent.messages[3].content, '/work');
    assert.equal(sent.messages[2].tool_calls[0].function.arguments, '{"command":"pwd"}');
    assert.equal(sent.max_tokens, 100); assert.equal(sent.stream, true);
  } finally { r.stop(); }
});

test('401 и «нет модели» пропускаются; ответ не потоком (json) принимается', async () => {
  await reset(); const r = await startRouter(['auth401', 'nomodel', 'json'], { keyFor: (n) => (n === 'auth401' ? 'bad' : 'good-' + n) });
  try {
    const res = await call(r, {}); const j = await res.json();
    assert.equal(j.content[0].text, 'json-ответ');
    assert.deepEqual(r.stats().map((x) => x.outcome), ['auth', 'model', 'ok']);
  } finally { r.stop(); }
});

test('все отказали: понятная ошибка, а не зависание', async () => {
  await reset(); const r = await startRouter(['r429', 'e500']);
  try {
    const res = await call(r, {}); const j = await res.json();
    assert.ok([429, 529].includes(res.status)); assert.match(j.error.message, /недоступны/);
    assert.ok(res.headers.get('retry-after'));
  } finally { r.stop(); }
});

test('суточный 429 ставит на паузу провайдера целиком', async () => {
  await reset(); const r = await startRouter(['r429daily', 'ok']);
  try {
    await call(r, {}); await reset(); await call(r, {});
    const log = (await mockLog()).filter((x) => x.path === '/chat/completions');
    assert.equal(log.filter((x) => x.name === 'r429daily').length, 0);
  } finally { r.stop(); }
});

test('count_tokens и /v1/models', async () => {
  const r = await startRouter(['ok']);
  try {
    const c = await fetch(r.url + '/v1/messages/count_tokens', { method: 'POST', headers: { 'x-api-key': TOKEN }, body: JSON.stringify({ messages: [{ role: 'user', content: 'abc' }] }) });
    assert.ok((await c.json()).input_tokens > 0);
    const m = await (await fetch(r.url + '/v1/models', { headers: { authorization: 'Bearer ' + TOKEN } })).json();
    assert.equal(m.data.length, 1);
  } finally { r.stop(); }
});

test('слушает только 127.0.0.1: на внешний адрес контейнера соединение отказано', async () => {
  const r = await startRouter(['ok']);
  try {
    const ext = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal);
    if (!ext) return; // нет внешнего адреса - нечего проверять
    const code = await new Promise((resolve) => { const s = net.connect(r.port, ext.address); s.on('connect', () => { s.destroy(); resolve('connected'); }); s.on('error', (e) => resolve(e.code)); });
    assert.equal(code, 'ECONNREFUSED');
  } finally { r.stop(); }
});

test('C5: Claude Code просит max_tokens 128000 - модели на 128к не отсеиваются, max_tokens сжимается до предела модели', async () => {
  await reset(); const r = await startRouter(['ok'], { catalogEdit: (c) => { c.models[0].ctx = 131000; c.models[0].max_out = 8192; } });
  try {
    const res = await call(r, { max_tokens: 128000 }); assert.equal(res.status, 200);
    const sent = (await mockLog()).find((x) => x.path === '/chat/completions').body;
    assert.equal(sent.max_tokens, 8192);
  } finally { r.stop(); }
});

test('картинка base64 на 300 КБ не раздувает оценку и не вызывает «слишком большой запрос»', async () => {
  await reset(); const r = await startRouter(['ok'], { catalogEdit: (c) => { c.models[0].ctx = 100000; c.models[0].vision = true; } });
  try {
    const img = 'A'.repeat(300_000);
    const res = await call(r, { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } }, { type: 'text', text: 'что на картинке' }] }] });
    assert.equal(res.status, 200);
    const c = await fetch(r.url + '/v1/messages/count_tokens', { method: 'POST', headers: { 'x-api-key': TOKEN }, body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } }] }] }) });
    assert.ok((await c.json()).input_tokens < 5000);
  } finally { r.stop(); }
});

test('несколько вызовов инструментов без index и с одинаковым index не склеиваются', async () => {
  for (const name of ['multitool', 'multitool0']) {
    await reset(); const r = await startRouter([name]);
    try {
      const j = await (await call(r, { tools: [{ name: 'Read', input_schema: { type: 'object' } }] })).json();
      const tools = j.content.filter((b) => b.type === 'tool_use');
      assert.equal(tools.length, 2, name); assert.deepEqual(tools.map((t) => t.input.path), ['a', 'b'], name);
    } finally { r.stop(); }
  }
});

test('инструмент без аргументов: {} приходит до закрытия блока', async () => {
  await reset(); const r = await startRouter(['notoolargs']);
  try {
    const ev = await events(await call(r, { tools: [{ name: 'Status', input_schema: { type: 'object' } }] }, true));
    const i = ev.findIndex((x) => x.d.delta?.partial_json === '{}'); const j = ev.findIndex((x) => x.e === 'content_block_stop');
    assert.ok(i > 0 && i < j, 'пустой JSON до block_stop');
  } finally { r.stop(); }
});

test('ответ только из «мыслей» - отказ и переход к следующему, а не пустой ответ', async () => {
  await reset(); const r = await startRouter(['thinkonly', 'ok']);
  try {
    const j = await (await call(r, {}, false)).json(); assert.match(j.content[0].text, /из ok/);
    const ev = await events(await call(r, {}, true)); assert.ok(ev.some((x) => x.d.delta?.text?.includes('из ok')));
    assert.equal(r.stats()[0].outcome, '5xx');
  } finally { r.stop(); }
});

test('модель думает дольше порога первого токена, но жива - не бросаем', async () => {
  await reset(); const r = await startRouter(['thinkthen', 'ok'], { ftt: 1 });
  try { const j = await (await call(r, {})).json(); assert.match(j.content[0].text, /после раздумий/); } finally { r.stop(); }
});

test('схемы инструментов очищаются, серверный web_search не передаётся провайдеру', async () => {
  await reset(); const r = await startRouter(['ok']);
  try {
    await call(r, { tools: [
      { name: 'Edit', description: 'e', input_schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, properties: { n: { type: 'number', exclusiveMinimum: 0 } } } },
      { type: 'web_search_20250305', name: 'web_search' }] });
    const sent = (await mockLog()).find((x) => x.path === '/chat/completions').body;
    assert.equal(sent.tools.length, 1);
    assert.ok(!JSON.stringify(sent.tools).match(/\$schema|additionalProperties|exclusiveMinimum/));
  } finally { r.stop(); }
});

test('401 выключает провайдера, но замена ключа в файле возвращает его без перезапуска', async () => {
  await reset(); let r = await startRouter(['ok2', 'ok'], { keyFor: (n) => (n === 'ok2' ? 'bad' : 'good-' + n) });
  try {
    let j = await (await call(r, {})).json(); assert.match(j.content[0].text, /из ok$/);
    const kf = path.join(r.dir, 'conf', 'keys.json'); const k = JSON.parse(fs.readFileSync(kf)); k.providers.ok2.key = 'good-ok2';
    await new Promise((x) => setTimeout(x, 20)); fs.writeFileSync(kf, JSON.stringify(k));
    j = await (await call(r, {})).json(); assert.match(j.content[0].text, /из ok2/);
  } finally { r.stop(); }
});

test('файл ключей, который в этот момент пишется (битый JSON), не обнуляет список ключей', async () => {
  await reset(); const r = await startRouter(['ok']);
  try {
    assert.equal((await call(r, {})).status, 200);
    const kf = path.join(r.dir, 'conf', 'keys.json'); const good = fs.readFileSync(kf, 'utf8');
    fs.writeFileSync(kf, '{"provid'); assert.equal((await call(r, {})).status, 200);
    fs.writeFileSync(kf, good);
  } finally { r.stop(); }
});

// ---------- доработки перед выпуском ----------
const runSetup = (conf, catalogFile, args, input) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(here, '..', 'cli', 'setup.mjs'), ...args], { env: { ...process.env, FREE_AGENT_CONF: conf, FREE_AGENT_CATALOG: catalogFile } });
  let out = ''; p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => out += d);
  p.on('close', () => resolve(out)); p.stdin.end(input);
});
function setupDir(models, listing) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-setup-'));
  const conf = path.join(dir, 'conf'); fs.mkdirSync(conf);
  const catalog = { providers: { openrouter: { name: 'OpenRouter', base: 'http://unused.invalid/v1', signup: 'x', keypage: 'x', needs: 'x', limits: 'x' } }, models: models.map((id) => ({ provider: 'openrouter', id })) };
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(conf, 'config.json'), JSON.stringify({ provider_overrides: { openrouter: `http://127.0.0.1:${MOCK_PORT}/${listing}/v1` } }));
  return { conf, cat: path.join(dir, 'catalog.json') };
}
const chatModels = async () => (await mockLog()).filter((x) => x.path === '/chat/completions').map((x) => x.body.model);

test('п.1 мастер: тестовый запрос OpenRouter идёт только на бесплатные модели (цена 0 или :free)', async () => {
  await reset(); const d = setupDir(['a/paid', 'coder-paid-qwen', 'c/x:free'], 'ormix');
  const out = await runSetup(d.conf, d.cat, ['add', 'openrouter'], 'good-ormix\n');
  assert.match(out, /Ключ работает/);
  const used = await chatModels();
  assert.ok(used.length >= 1);
  for (const m of used) assert.ok(['c/x:free', 'qwen/zero-priced', 'd/nopricing'].includes(m) && m !== 'd/nopricing', 'платная модель в тестовом запросе: ' + m);
  assert.deepEqual(used, ['c/x:free']);
  const keys = JSON.parse(fs.readFileSync(path.join(d.conf, 'keys.json'), 'utf8')).providers.openrouter;
  assert.ok(keys.free_models.includes('c/x:free') && keys.free_models.includes('qwen/zero-priced'));
  assert.ok(!keys.free_models.includes('a/paid') && !keys.free_models.includes('d/nopricing'));
});

test('п.1 мастер: если из каталога бесплатных нет, запасные берутся только бесплатные по цене', async () => {
  await reset(); const d = setupDir(['a/paid'], 'ormix');
  await runSetup(d.conf, d.cat, ['add', 'openrouter'], 'good-ormix\n');
  const used = await chatModels();
  assert.ok(used.length >= 1);
  assert.ok(used.every((m) => m === 'qwen/zero-priced'), 'пробовали: ' + used);
});

test('п.1 мастер: список моделей недоступен - пробуем только модели с :free, платные не трогаем', async () => {
  await reset(); const d = setupDir(['a/paid', 'coder-paid-qwen', 'c/x:free'], 'ormix404');
  const out = await runSetup(d.conf, d.cat, ['add', 'openrouter'], 'good-ormix404\n');
  assert.deepEqual(await chatModels(), ['c/x:free'], out);
});

test('п.1 маршрутизатор: платные модели OpenRouter не получают запросы, бесплатные получают', async () => {
  await reset();
  const r = await startRouter(['ok'], { keyFor: () => 'good-ok', extra: { provider_overrides: { openrouter: `http://127.0.0.1:${MOCK_PORT}/ok/v1` } },
    catalogEdit: (c) => { c.providers.openrouter = { name: 'or', base: 'x' }; c.models = [{ provider: 'openrouter', id: 'paid/model', ctx: 100000, max_out: 4096, tools: true }, { provider: 'openrouter', id: 'free/model:free', ctx: 100000, max_out: 4096, tools: true }]; delete c.providers.ok; } });
  try {
    fs.writeFileSync(path.join(r.dir, 'conf', 'keys.json'), JSON.stringify({ providers: { openrouter: { key: 'good-ok' } } }));
    assert.equal((await call(r, {})).status, 200);
    assert.deepEqual((await mockLog()).map((x) => x.body?.model), ['free/model:free']);
  } finally { r.stop(); }
  await reset();
  const r2 = await startRouter(['ok'], { keyFor: () => 'good-ok', extra: { provider_overrides: { openrouter: `http://127.0.0.1:${MOCK_PORT}/ok/v1` } },
    catalogEdit: (c) => { c.providers.openrouter = { name: 'or', base: 'x' }; c.models = [{ provider: 'openrouter', id: 'paid/model', ctx: 100000, max_out: 4096, tools: true }]; } });
  try {
    fs.writeFileSync(path.join(r2.dir, 'conf', 'keys.json'), JSON.stringify({ providers: { openrouter: { key: 'good-ok' } } }));
    assert.equal((await call(r2, {})).status, 400);
    assert.equal((await mockLog()).length, 0, 'платной модели ничего не отправлено');
  } finally { r2.stop(); }
});

test('п.2 ключи и токены из тела ошибки провайдера вырезаются (клиент и журнал)', async () => {
  await reset(); const r = await startRouter(['leak'], { ftt: 3 });
  try {
    const res = await call(r, {}); const t = await res.text();
    assert.equal(res.status, 529);
    for (const secret of ['SECRETSECRET123', 'good-leak', 'nvapi-ABCDEFGH12345', 'gsk_ABCDEFGH12345', 'AIzaSyABCDEFGHIJKLMNOPQRS']) assert.ok(!t.includes(secret), 'утекло: ' + secret);
    assert.match(t, /ключ скрыт/);
  } finally { r.stop(); }
});

test('п.3 обрыв/порча потока до отдачи клиенту - следующий провайдер', async () => {
  for (const bad of ['truncpre', 'corruptpre']) {
    await reset(); const r = await startRouter([bad, 'ok']);
    try { const j = await (await call(r, {}, false)).json(); assert.match(j.content[0].text, /из ok/, bad); }
    finally { r.stop(); }
  }
});

test('п.3 обрыв после начала отдачи: честная ошибка, а не end_turn с обрезанными аргументами', async () => {
  for (const bad of ['trunc', 'corrupt']) {
    await reset(); const r = await startRouter([bad, 'ok']);
    try {
      const ev = await events(await call(r, {}, true));
      assert.ok(ev.some((x) => x.e === 'error'), bad + ': есть error');
      assert.ok(!ev.some((x) => x.e === 'message_stop'), bad + ': нет message_stop');
      assert.ok(!ev.some((x) => x.e === 'message_delta'), bad + ': нет stop_reason');
    } finally { r.stop(); }
  }
});

test('п.4 одни «мысли» без конца не держат бесконечно: по пределу - следующий провайдер', async () => {
  await reset(); const r = await startRouter(['thinkforever', 'ok'], { ftt: 1, extra: { think_timeout_s: 2 } });
  const t0 = Date.now();
  try {
    const j = await (await call(r, {}, false)).json();
    assert.match(j.content[0].text, /из ok/); assert.ok(Date.now() - t0 < 8000);
  } finally { r.stop(); }
});

test('п.4 общий таймер запроса: бесконечный поток текста обрывается честной ошибкой', async () => {
  await reset(); const r = await startRouter(['textforever', 'ok'], { extra: { total_deadline_s: 2 } });
  const t0 = Date.now();
  try {
    const ev = await events(await call(r, {}, true));
    assert.ok(ev.some((x) => x.e === 'error')); assert.ok(!ev.some((x) => x.e === 'message_stop'));
    assert.ok(Date.now() - t0 < 7000, 'ждали ' + (Date.now() - t0));
  } finally { r.stop(); }
});

test('п.5 кривой адрес - 400, процесс жив; исключения не роняют сервер', async () => {
  const r = await startRouter(['ok']);
  try {
    for (const raw of ['GET //[ HTTP/1.1', 'GET http://[bad HTTP/1.1', 'GET /v1/%E0%A4%A HTTP/1.1']) {
      const resp = await new Promise((resolve) => { const s = net.connect(r.port, '127.0.0.1', () => s.write(raw + '\r\nhost: x\r\nconnection: close\r\n\r\n')); let d = ''; s.on('data', (c) => d += c); s.on('close', () => resolve(d)); s.on('error', () => resolve(d)); });
      assert.match(resp, /^HTTP\/1\.1 (400|401|404)/, raw + ' -> ' + resp.slice(0, 40));
    }
    const resp = await new Promise((resolve) => { const s = net.connect(r.port, '127.0.0.1', () => s.write('GET //[ HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n')); let d = ''; s.on('data', (c) => d += c); s.on('close', () => resolve(d)); });
    assert.match(resp, /^HTTP\/1\.1 400/, 'кривой адрес должен дать 400: ' + resp.slice(0, 40));
    assert.equal((await fetch(r.url + '/health')).status, 200, 'сервер жив');
  } finally { r.stop(); }
});

test('п.6 картинка внутри tool_result: vision-модели уходит блоком, остальным - пометка', async () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const msgs = [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'скрин' }, img] }] }];
  const { anthropicToOpenAI } = await import('../router/convert.mjs');
  const v = anthropicToOpenAI({ messages: msgs }, { id: 'm', vision: true }, {}).messages;
  assert.equal(v.at(-2).role, 'tool'); assert.equal(typeof v.at(-2).content, 'string');
  assert.ok(v.at(-1).content.some((p) => p.type === 'image_url' && p.image_url.url === 'data:image/png;base64,AAAA'));
  const n = anthropicToOpenAI({ messages: msgs }, { id: 'm' }, {}).messages;
  assert.equal(n.at(-1).role, 'tool'); assert.match(n.at(-1).content, /изображение/);
});
