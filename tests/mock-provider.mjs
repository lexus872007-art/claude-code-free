// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Алексей Гаврилов (Aleksei Gavrilov)
// Мок провайдеров: один сервер, у каждого «провайдера» свой префикс /<имя>/v1 и своё поведение.
// Поведение = имя: ok, r429, e500, e503, slow (молчит), stallfirst (пустой кусок и молчит),
// midcut (пара токенов и обрыв), tool (вызов инструмента), auth401, nomodel, json (ответ не потоком), r429daily.
import http from 'node:http';
const port = Number(process.argv[2] || 9100);
const log = [];
const sse = (res, objs) => { for (const o of objs) res.write('data: ' + (typeof o === 'string' ? o : JSON.stringify(o)) + '\n\n'); };
const delta = (d, fin) => ({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: fin || null }] });

http.createServer(async (req, res) => {
  const m = req.url.match(/^\/([^/]+)\/v1(\/.*)$/);
  if (req.url === '/_log') { res.end(JSON.stringify(log)); return; }
  if (req.url === '/_reset') { log.length = 0; res.end('ok'); return; }
  if (!m) { res.writeHead(404); res.end(); return; }
  const [, name, path] = m;
  let body = ''; for await (const c of req) body += c;
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  log.push({ name, path, auth, body: body ? JSON.parse(body) : null, t: Date.now() });
  if (auth !== 'good-' + name) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Invalid API Key"}}'); return; }
  if (name === 'ormix' && path === '/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'a/paid', pricing: { prompt: '0.001', completion: '0.002' } }, { id: 'coder-paid-qwen', pricing: { prompt: '0.1', completion: '0.1' } }, { id: 'qwen/zero-priced', pricing: { prompt: '0', completion: '0' } }, { id: 'c/x:free' }, { id: 'd/nopricing' }] })); return; }
  if (name === 'ormix404' && path === '/models') { res.writeHead(404); res.end('no'); return; }
  if (path === '/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: ['m-' + name, 'moonshotai/kimi-k2.6', 'qwen-3-coder-480b', 'cohere/north-mini-code:free', 'openai/gpt-oss-120b', 'codestral-latest', 'gemini-2.5-flash'].map((id) => ({ id })) })); return; }
  if (name === 'leak') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"bad Authorization: Bearer sk-or-v1-SECRETSECRET123 key good-leak nvapi-ABCDEFGH12345 gsk_ABCDEFGH12345 AIzaSyABCDEFGHIJKLMNOPQRS"}'); return; }
  if (name === 'r429') { res.writeHead(429, { 'retry-after': '2', 'content-type': 'application/json' }); res.end('{"error":"rate limit"}'); return; }
  if (name === 'r429daily') { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"daily quota exhausted"}'); return; }
  if (name === 'e500') { res.writeHead(500); res.end('boom'); return; }
  if (name === 'e503') { res.writeHead(503); res.end('unavailable'); return; }
  if (name === 'nomodel') { res.writeHead(404); res.end('{"error":"model not found"}'); return; }
  if (name === 'json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'json-ответ' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } })); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (name === 'slow') { return; } // ни байта - клиент должен уйти по таймауту
  if (name === 'stallfirst') { sse(res, [delta({ role: 'assistant', content: '' })]); return; }
  if (name === 'midcut') { sse(res, [delta({ content: 'Нач' }), delta({ content: 'ало' })]); setTimeout(() => res.destroy(), 100); return; }
  if (name === 'tool') {
    sse(res, [delta({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'Bash', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, null),
      delta({}, 'tool_calls'), { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }, '[DONE]']);
    res.end(); return;
  }
  if (name === 'multitool') { // два вызова подряд без index
    sse(res, [delta({ tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } }] }),
      delta({ tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{"path":"b"}' } }] }), delta({}, 'tool_calls'), '[DONE]']);
    res.end(); return;
  }
  if (name === 'multitool0') { // два вызова, у обоих index 0, id разные
    sse(res, [delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"path":"a"}' } }] }),
      delta({ tool_calls: [{ index: 0, id: 'call_2', function: { name: 'Read', arguments: '{"path":"b"}' } }] }), delta({}, 'tool_calls'), '[DONE]']);
    res.end(); return;
  }
  if (name === 'notoolargs') { // вызов без аргументов
    sse(res, [delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Status', arguments: '' } }] }), delta({}, 'tool_calls'), '[DONE]']);
    res.end(); return;
  }
  if (name === 'truncpre') { sse(res, [delta({ reasoning_content: 'думаю' })]); res.end(); return; }
  if (name === 'corruptpre') { sse(res, ['{bad json']); res.end(); return; }
  if (name === 'trunc') { // текст, начало аргументов инструмента и конец потока без finish и [DONE]
    sse(res, [delta({ content: 'Нач' }), delta({ tool_calls: [{ index: 0, id: 'c9', function: { name: 'Bash', arguments: '{"command":"rm ' } }] })]); res.end(); return;
  }
  if (name === 'corrupt') { sse(res, [delta({ content: 'Нач' }), '{bad json', delta({ content: 'ало' }), '[DONE]']); res.end(); return; }
  if (name === 'thinkforever') { const t = setInterval(() => sse(res, [delta({ reasoning_content: 'думаю' })]), 300); res.on('close', () => clearInterval(t)); return; }
  if (name === 'textforever') { const t = setInterval(() => sse(res, [delta({ content: 'слово ' })]), 300); res.on('close', () => clearInterval(t)); return; }
  if (name === 'thinkonly') { sse(res, [delta({ reasoning_content: 'думаю' }), delta({}, 'stop'), '[DONE]']); res.end(); return; }
  if (name === 'thinkthen') { // думает 1.5 с, потом отвечает; порог первого токена в тесте 1 с
    sse(res, [delta({ reasoning_content: 'думаю' })]); await new Promise((r) => setTimeout(r, 1500));
    sse(res, [delta({ content: 'после раздумий' }), delta({}, 'stop'), '[DONE]']); res.end(); return;
  }
  if (name === 'slowtok') { // первый токен через 2 с (меньше таймаута)
    await new Promise((r) => setTimeout(r, 2000));
  }
  sse(res, [delta({ role: 'assistant', content: '' }), delta({ content: 'Привет' }), delta({ content: ' из ' + name }), delta({}, 'stop'), { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } }, '[DONE]']);
  res.end();
}).listen(port, '0.0.0.0', () => console.log('mock on', port));
