#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Алексей Гаврилов (Aleksei Gavrilov)
// agent-stats [часы=24] - запросы и отказы по провайдерам за период
import fs from 'node:fs';
import { PATHS } from '../router/common.mjs';

const hours = Number(process.argv[2]) || 24;
const since = Date.now() - hours * 3600_000;
const by = {};
let lines = [];
try { lines = fs.readFileSync(PATHS.stats, 'utf8').split('\n').filter(Boolean); } catch (e) {
  if (e.code === 'EACCES') { console.error('Нет доступа к статистике. Запустите: sudo agent-stats'); process.exit(1); }
}
for (const l of lines) {
  let r; try { r = JSON.parse(l); } catch { continue; }
  if (r.ts < since) continue;
  const p = (by[r.provider] ||= { n: 0, ok: 0, r429: 0, e5: 0, to: 0, other: 0, ttft: [], out: 0 });
  p.n++;
  if (r.outcome === 'ok') { p.ok++; if (r.ttft) p.ttft.push(r.ttft); p.out += r.out || 0; }
  else if (r.outcome === '429') p.r429++;
  else if (r.outcome === '5xx') p.e5++;
  else if (r.outcome === 'timeout') p.to++;
  else p.other++;
}
const rows = Object.entries(by).sort((a, b) => b[1].n - a[1].n);
console.log(`\nСтатистика за последние ${hours} ч (попытки к провайдерам; один запрос Claude Code может дать несколько попыток)\n`);
if (!rows.length) { console.log('Пока нет данных.\n'); process.exit(0); }
const pad = (s, n) => String(s).padStart(n);
console.log('провайдер     попыток   удачно   429   5xx   долго  прочее  ср.до 1 токена');
let T = { n: 0, ok: 0, r429: 0, e5: 0, to: 0, other: 0 };
for (const [name, p] of rows) {
  const avg = p.ttft.length ? (p.ttft.reduce((a, b) => a + b, 0) / p.ttft.length / 1000).toFixed(1) + ' с' : '-';
  console.log(`${name.padEnd(12)} ${pad(p.n, 8)} ${pad(p.ok, 8)} ${pad(p.r429, 5)} ${pad(p.e5, 5)} ${pad(p.to, 6)} ${pad(p.other, 7)}  ${pad(avg, 12)}`);
  for (const k of Object.keys(T)) T[k] += p[k];
}
console.log(`${'всего'.padEnd(12)} ${pad(T.n, 8)} ${pad(T.ok, 8)} ${pad(T.r429, 5)} ${pad(T.e5, 5)} ${pad(T.to, 6)} ${pad(T.other, 7)}`);
console.log('\n429 - лимит провайдера, 5xx - сбой у провайдера, «долго» - нет первого токена за отведённое время.\n');
