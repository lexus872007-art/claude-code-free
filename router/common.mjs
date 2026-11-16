// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Алексей Гаврилов (Aleksei Gavrilov)
// Общие пути и загрузка настроек. Без внешних зависимостей (только Node 22).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const PATHS = {
  app: path.resolve(here, '..'),
  conf: process.env.FREE_AGENT_CONF || '/etc/free-agent',
  state: process.env.FREE_AGENT_STATE || '/var/lib/free-agent',
};
PATHS.keys = path.join(PATHS.conf, 'keys.json');
PATHS.token = path.join(PATHS.conf, 'token');
PATHS.config = path.join(PATHS.conf, 'config.json');
PATHS.stats = path.join(PATHS.state, 'stats.jsonl');
PATHS.catalog = process.env.FREE_AGENT_CATALOG || path.join(PATHS.app, 'catalog', 'models.json');

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export const DEFAULTS = {
  port: 8787,
  first_token_timeout_s: 30, // нет первого токена за N секунд - следующий провайдер
  think_timeout_s: 120,      // одни «мысли» без текста дольше N секунд - следующий провайдер
  stall_timeout_s: 60,       // после первого токена: пауза в потоке дольше N секунд - обрыв
  max_attempts: 12,
  total_deadline_s: 240,
  provider_overrides: {},    // {"openrouter": "http://127.0.0.1:9000/v1"} - для тестов и своих шлюзов
};

export function loadConfig() {
  return { ...DEFAULTS, ...readJson(PATHS.config, {}) };
}

export function loadCatalog() {
  return readJson(PATHS.catalog, { providers: {}, models: [] });
}

// Файл ключей перечитывается по mtime: мастер может добавить ключ без перезапуска службы.
let keysCache = { mtime: 0, data: { providers: {} } };
export function loadKeys() {
  try {
    const st = fs.statSync(PATHS.keys);
    if (st.mtimeMs !== keysCache.mtime) {
      const d = readJson(PATHS.keys, null);
      if (d) keysCache = { mtime: st.mtimeMs, data: d }; // файл ещё пишется или битый - оставляем прежнее, не запоминаем пустое
    }
  } catch { keysCache = { mtime: 0, data: { providers: {} } }; }
  return keysCache.data;
}

// Владелец файла ключей - служебная учётка freeagent (ищем в /etc/passwd).
function serviceOwner() {
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('freeagent:'));
    if (!line) return null;
    const f = line.split(':'); return { uid: Number(f[2]), gid: Number(f[3]) };
  } catch { return null; }
}

// Записываем во временный файл, выставляем права и владельца, и только потом подменяем: роутер не увидит чужого владельца или пустого файла.
export function saveKeys(data) {
  fs.mkdirSync(PATHS.conf, { recursive: true });
  const tmp = PATHS.keys + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  const o = serviceOwner();
  if (o && process.getuid?.() === 0) fs.chownSync(tmp, o.uid, o.gid);
  fs.renameSync(tmp, PATHS.keys);
}

export function baseUrlFor(providerId, catalog, config) {
  return (config.provider_overrides?.[providerId] || catalog.providers[providerId]?.base || '').replace(/\/$/, '');
}

// Бесплатная ли модель. У OpenRouter платные и бесплатные модели лежат в одном списке: бесплатная - суффикс :free
// или цена prompt и completion равна нулю в /models. Остальные провайдеры дают бесплатный тариф по самому ключу.
const isZero = (v) => v != null && v !== '' && Number(v) === 0 && !Number.isNaN(Number(v));
export function isFreeModel(pid, id, pricing) {
  if (pid !== 'openrouter') return true;
  if (/:free$/i.test(String(id))) return true;
  return !!pricing && isZero(pricing.prompt) && isZero(pricing.completion);
}

// Вырезает ключи и токены из текста перед выводом в журнал или клиенту.
export function scrubSecrets(text, known = []) {
  let s = String(text ?? '');
  for (const k of known) if (k && String(k).length >= 6) s = s.split(String(k)).join('[ключ скрыт]');
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [ключ скрыт]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|nvapi-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{16,}|csk-[A-Za-z0-9]{8,}|xai-[A-Za-z0-9]{8,})/g, '[ключ скрыт]');
}
