/**
 * Datasets for data-driven tests: CSV (first row is the header) or a JSON
 * array of objects. Each row becomes one iteration of the test, with its
 * columns available as {{variables}}.
 */
export const MAX_ROWS = 100;
const NAME = /^[A-Za-z_][\w.-]*$/;

/** RFC 4180-style CSV: quoted fields, escaped quotes (""), commas/newlines inside quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('Unterminated quoted field in CSV');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Parse dataset text into { columns, rows }. Throws with a user-facing message. */
export function parseDataset(content) {
  const text = String(content ?? '').trim();
  if (!text) return { columns: [], rows: [] };

  let columns;
  let rows;
  if (text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`Dataset JSON is invalid: ${err.message}`);
    }
    if (!Array.isArray(parsed) || !parsed.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
      throw new Error('A JSON dataset must be an array of objects');
    }
    columns = [...new Set(parsed.flatMap((r) => Object.keys(r)))];
    rows = parsed.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] == null ? '' : typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c])])));
  } else {
    const table = parseCsv(text);
    if (table.length < 2) throw new Error('CSV needs a header row and at least one data row');
    columns = table[0].map((h) => h.trim());
    const dupes = columns.filter((c, i) => columns.indexOf(c) !== i);
    if (dupes.length) throw new Error(`Duplicate column: ${dupes[0]}`);
    rows = table.slice(1).map((cells, i) => {
      if (cells.length > columns.length) throw new Error(`Row ${i + 1} has ${cells.length} values but there are ${columns.length} columns`);
      return Object.fromEntries(columns.map((c, j) => [c, (cells[j] ?? '').trim()]));
    });
  }

  const bad = columns.find((c) => !NAME.test(c));
  if (bad !== undefined) throw new Error(`Column "${bad}" is not a valid variable name (letters, digits, _ . -; must not start with a digit)`);
  if (rows.length > MAX_ROWS) throw new Error(`Datasets are limited to ${MAX_ROWS} rows (got ${rows.length})`);
  return { columns, rows };
}

/** Short human label for an iteration, e.g. `username=bob, password=…`. */
export function describeRow(data, max = 60) {
  const text = Object.entries(data ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
