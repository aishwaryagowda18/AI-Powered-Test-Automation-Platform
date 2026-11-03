/**
 * Minimal 5-field cron parser (minute hour day-of-month month day-of-week),
 * evaluated in the server's local time. Supports `*`, numbers, ranges `1-5`,
 * lists `1,15,30`, steps `*\/15` and `10-50/10`. Day-of-week 0 and 7 are Sunday.
 * As in classic cron, when both day fields are restricted a day matches if
 * either one does.
 */
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

function parseField(text, { name, min, max }) {
  const values = new Set();
  for (const part of text.split(',')) {
    const [rangeText, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step "${stepText}" in ${name}`);
    let lo;
    let hi;
    if (rangeText === '*') {
      lo = min;
      hi = max;
    } else if (rangeText.includes('-')) {
      [lo, hi] = rangeText.split('-').map(Number);
    } else {
      lo = Number(rangeText);
      hi = stepText === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Invalid ${name} "${part}" (allowed ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expression) {
  const parts = String(expression ?? '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Cron expression must have 5 fields: minute hour day month weekday');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function dayMatches(c, d) {
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

/** Next fire time strictly after `from`, or null if none within ~4 years. */
export function nextRun(expression, from = new Date()) {
  const c = parseCron(expression);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 4 * 366 * 24 * 3600 * 1000;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (c.minute.has(d.getMinutes())) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** Plain-English description for common shapes; falls back to the raw expression. */
export function describeCron(expression) {
  const p = String(expression).trim().split(/\s+/);
  if (p.length !== 5) return expression;
  const [m, h, dom, mon, dow] = p;
  const pad = (n) => String(n).padStart(2, '0');
  const at = /^\d+$/.test(m) && /^\d+$/.test(h) ? `at ${pad(h)}:${pad(m)}` : null;
  if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${m.slice(2)} minutes`;
  if (m === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute';
  if (/^\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Hourly at :${pad(m)}`;
  if (/^\d+$/.test(m) && /^\*\/\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return `Every ${h.slice(2)} hours at :${pad(m)}`;
  if (at && dom === '*' && mon === '*' && dow === '*') return `Daily ${at}`;
  if (at && dom === '*' && mon === '*' && dow === '1-5') return `Weekdays ${at}`;
  if (at && dom === '*' && mon === '*' && /^[0-7]$/.test(dow)) {
    return `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][Number(dow)]} ${at}`;
  }
  return `Cron: ${expression}`;
}
