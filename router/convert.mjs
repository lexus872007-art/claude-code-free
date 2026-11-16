// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Алексей Гаврилов (Aleksei Gavrilov)
// Перевод между Anthropic Messages (его говорит Claude Code) и OpenAI chat/completions (его говорят провайдеры).
import crypto from 'node:crypto';

const textOf = (c) => {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[изображение]' : '')).filter(Boolean).join('\n');
};

// У Mistral id вызова инструмента - ровно 9 символов a-zA-Z0-9.
function shortId(id) {
  return crypto.createHash('sha1').update(String(id)).digest('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 9).padEnd(9, 'x');
}

// Оценка токенов: картинки считаем фиксированно (base64 не должен раздувать счёт).
export function estimateTokens(req) {
  let n = 0, images = 0;
  const add = (v) => {
    n += typeof v === 'string' ? v.length : JSON.stringify(v ?? '', (k, val) => {
      if (val && typeof val === 'object' && val.type === 'base64' && typeof val.data === 'string') { images++; return { type: 'base64' }; }
      return val;
    }).length;
  };
  add(req.system); add(req.tools); add(req.messages);
  return Math.ceil(n / 3.5) + images * 1500;
}

// Схемы инструментов: убираем ключевые слова, на которых строгие провайдеры отвечают 400.
const DROP_KEYS = new Set(['$schema', '$id', 'additionalProperties', 'exclusiveMinimum', 'exclusiveMaximum', 'propertyNames', 'patternProperties', 'unevaluatedProperties']);
export function cleanSchema(s) {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (s && typeof s === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(s)) if (!DROP_KEYS.has(k)) o[k] = cleanSchema(v);
    return o;
  }
  return s;
}

export function anthropicToOpenAI(req, entry, prov) {
  const idOf = prov.shortToolIds ? shortId : (x) => x;
  const messages = [];
  const sys = textOf(req.system);
  if (sys) messages.push({ role: 'system', content: sys });

  for (const m of req.messages || []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: idOf(b.id), type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      if (!text && !calls.length) continue; // были только «мысли» - их провайдерам не отдаём
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      messages.push(msg);
    } else {
      const parts = [];
      for (const b of blocks.filter((x) => x.type === 'tool_result')) {
        let body = textOf(b.content);
        // картинки внутри результата инструмента: в OpenAI tool-сообщение только текстовое, поэтому
        // для модели с vision картинка уходит следующим сообщением пользователя, иначе - пометка
        const imgs = Array.isArray(b.content) ? b.content.filter((x) => x?.type === 'image' && x.source?.type === 'base64') : [];
        if (imgs.length && entry.vision) {
          body = (body ? body + '\n' : '') + '[картинка из результата инструмента приложена ниже]';
          parts.push({ type: 'text', text: 'Картинка из результата инструмента:' });
          for (const im of imgs) parts.push({ type: 'image_url', image_url: { url: `data:${im.source.media_type};base64,${im.source.data}` } });
        }
        messages.push({ role: 'tool', tool_call_id: idOf(b.tool_use_id), content: (b.is_error ? 'Ошибка: ' : '') + (body || '(пусто)') });
      }
      for (const b of blocks) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') {
          if (entry.vision && b.source?.type === 'base64') {
            parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
          } else parts.push({ type: 'text', text: '[изображение пропущено: эта модель не видит картинки]' });
        }
      }
      if (parts.length) {
        const onlyText = parts.every((p) => p.type === 'text');
        messages.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('\n') : parts });
      }
    }
  }

  const out = {
    model: entry.id,
    messages,
    stream: true,
    max_tokens: Math.min(req.max_tokens || 4096, entry.max_out || 8192),
  };
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.tools?.length) {
    // серверные инструменты Anthropic (web_search и т.п.) у провайдеров не работают - не передаём
    const usable = req.tools.filter((t) => t.input_schema && (!t.type || t.type === 'custom'));
    if (usable.length) out.tools = usable.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: cleanSchema(t.input_schema) },
    }));
    if (!out.tools) delete out.tool_choice;
    const tc = out.tools ? req.tool_choice : null;
    if (!out.tools) { /* без инструментов */ }
    else if (tc?.type === 'any') out.tool_choice = 'required';
    else if (tc?.type === 'tool') out.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc?.type === 'none') out.tool_choice = 'none';
    else if (out.tools) out.tool_choice = 'auto';
  }
  return out;
}

// Разбор SSE-потока провайдера в JSON-куски. Выдаёт объекты; '[DONE]' - чистый конец.
// Конец потока без '[DONE]' возвращается как { truncated: true } (вызывающий решает, был ли finish_reason).
// Битое JSON-событие - ошибка (isCorrupt), а не молчаливый пропуск.
export async function* sseJson(readChunk) {
  const dec = new TextDecoder();
  let buf = '';
  const parse = (raw) => {
    const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) return undefined;
    if (data === '[DONE]') return { done: true };
    try { return { value: JSON.parse(data) }; } catch { const e = new Error('битое событие в потоке провайдера'); e.isCorrupt = true; throw e; }
  };
  for (;;) {
    const { done, value } = await readChunk();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const r = parse(raw);
      if (!r) continue;
      if (r.done) return { truncated: false };
      yield r.value;
    }
  }
  if (buf.trim()) { const r = parse(buf); if (r?.done) return { truncated: false }; if (r) yield r.value; }
  return { truncated: true };
}

// Кусок OpenAI -> простые события.
export function normalizeChunk(ch) {
  const evs = [];
  if (ch.error) { const e = new Error(ch.error.message || JSON.stringify(ch.error)); e.upstreamStatus = ch.error.code; e.isChunkError = true; throw e; }
  const c = ch.choices?.[0];
  if (c) {
    const d = c.delta || {};
    const think = d.reasoning_content ?? d.reasoning;
    if (typeof think === 'string' && think) evs.push({ k: 'think' });
    if (typeof d.content === 'string' && d.content) evs.push({ k: 'text', t: d.content });
    for (const tc of d.tool_calls || []) {
      evs.push({ k: 'tool', index: tc.index, id: tc.id, name: tc.function?.name, args: tc.function?.arguments || '' });
    }
    if (c.finish_reason) evs.push({ k: 'finish', reason: c.finish_reason });
  }
  if (ch.usage) evs.push({ k: 'usage', in: ch.usage.prompt_tokens || 0, out: ch.usage.completion_tokens || 0 });
  return evs;
}

const STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };

// Собирает ответ Anthropic из событий. emit(event, data) - для потоковой отдачи клиенту.
export class MessageBuilder {
  constructor(model, inputTokens, emit) {
    this.model = model; this.emit = emit || (() => {});
    this.id = 'msg_' + crypto.randomBytes(12).toString('hex');
    this.blocks = []; this.cur = null; this.tools = new Map(); this.toolById = new Map(); this.lastTool = null;
    this.stop = null; this.usage = { input_tokens: inputTokens, output_tokens: 0 };
    this.outChars = 0; this.started = false; this.hadTool = false;
  }
  start() {
    if (this.started) return; this.started = true;
    this.emit('message_start', { type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: this.usage.input_tokens, output_tokens: 1 } } });
    this.emit('ping', { type: 'ping' });
  }
  _close() {
    if (!this.cur) return;
    if (this.cur.type === 'tool_use') { // инструмент без аргументов: Anthropic ждёт валидный JSON до закрытия блока
      const b = this.blocks[this.cur.index];
      if (!b._json) { b._json = '{}'; this.emit('content_block_delta', { type: 'content_block_delta', index: this.cur.index, delta: { type: 'input_json_delta', partial_json: '{}' } }); }
    }
    this.emit('content_block_stop', { type: 'content_block_stop', index: this.cur.index });
    this.cur = null;
  }
  _open(block) {
    this._close();
    const index = this.blocks.length;
    this.blocks.push(block);
    this.cur = { index, type: block.type };
    this.emit('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} } });
    return index;
  }
  push(ev) {
    this.start();
    if (ev.k === 'text' || ev.k === 'tool') this.hadContent = true;
    if (ev.k === 'text') {
      if (this.cur?.type !== 'text') this._open({ type: 'text', text: '' });
      this.blocks[this.cur.index].text += ev.t; this.outChars += ev.t.length;
      this.emit('content_block_delta', { type: 'content_block_delta', index: this.cur.index, delta: { type: 'text_delta', text: ev.t } });
    } else if (ev.k === 'tool') {
      // Вызовы различаем по id (у части провайдеров index отсутствует или у всех одинаковый), иначе по index.
      let t = ev.id ? this.toolById.get(ev.id) : (this.tools.get(ev.index ?? 0) || this.lastTool);
      if (!t) {
        if (!ev.name && !ev.id) return;
        const id = ev.id || 'toolu_' + crypto.randomBytes(8).toString('hex');
        const block = { type: 'tool_use', id, name: ev.name || '', input: {}, _json: '' };
        const bi = this._open(block);
        t = { bi, block }; this.toolById.set(id, t); this.hadTool = true;
      }
      this.tools.set(ev.index ?? 0, t); this.lastTool = t;
      if (ev.name && !t.block.name) t.block.name = ev.name;
      if (ev.args) {
        t.block._json += ev.args; this.outChars += ev.args.length;
        this.emit('content_block_delta', { type: 'content_block_delta', index: t.bi, delta: { type: 'input_json_delta', partial_json: ev.args } });
      }
    } else if (ev.k === 'finish') this.stop = STOP[ev.reason] || 'end_turn';
    else if (ev.k === 'usage') { this.usage.input_tokens = ev.in || this.usage.input_tokens; this.usage.output_tokens = ev.out || this.usage.output_tokens; }
  }
  finish() {
    this.start();
    this._close();
    if (!this.blocks.length) { this._open({ type: 'text', text: '' }); this._close(); }
    for (const b of this.blocks) if (b.type === 'tool_use') { try { b.input = JSON.parse(b._json || '{}'); } catch { b.input = {}; } delete b._json; }
    if (!this.usage.output_tokens) this.usage.output_tokens = Math.max(1, Math.ceil(this.outChars / 4));
    const stop = this.hadTool && this.stop !== 'max_tokens' ? 'tool_use' : (this.stop || 'end_turn');
    this.emit('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: this.usage.output_tokens } });
    this.emit('message_stop', { type: 'message_stop' });
    this.stopReason = stop;
  }
  message() {
    return { id: this.id, type: 'message', role: 'assistant', model: this.model, content: this.blocks, stop_reason: this.stopReason, stop_sequence: null, usage: this.usage };
  }
}
