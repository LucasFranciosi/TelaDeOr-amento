const schema = {
  sql: 'CREATE TABLE IF NOT EXISTS budget_versions (version INTEGER PRIMARY KEY, write_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)',
};
const maxBytes = 512 * 1024;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isMoney = value => Number.isSafeInteger(value) && value >= 0;
function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
const isMonth = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const isKey = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const isOccurrence = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}:\d{1,3}:\d{1,3}$/.test(value);
const limitedText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

function isBudget(state) {
  if (!isRecord(state) || !Number.isSafeInteger(state.opening) ||
      !Array.isArray(state.periods) || state.periods.length === 0 || !Array.isArray(state.entries) ||
      !Array.isArray(state.allocations) || !isRecord(state.actuals)) return false;

  return state.periods.every(p => isRecord(p) && isKey(p.id) && limitedText(p.name, 100) &&
      isDate(p.start) && isDate(p.end) && p.start <= p.end &&
      (p.limit === null || isMoney(p.limit)) && typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) &&
    state.entries.every(e => isRecord(e) && isKey(e.id) && limitedText(e.title, 100) &&
      ['income', 'expense'].includes(e.type) && isMoney(e.amount) &&
      (e.date === '' || isDate(e.date)) && ['once', 'monthly'].includes(e.recurrence) &&
      (e.recurrence !== 'monthly' || isDate(e.date)) &&
      (e.until === undefined || isMonth(e.until)) &&
      (e.actualTotal == null || isMoney(e.actualTotal)) &&
      (e.installments === undefined || Number.isInteger(e.installments) && e.installments >= 1 && e.installments <= 120) &&
      (e.method === undefined || ['cash', 'credit'].includes(e.method)) &&
      (e.firstBill === undefined || isMonth(e.firstBill)) &&
      (e.dueDay === undefined || Number.isInteger(e.dueDay) && e.dueDay >= 1 && e.dueDay <= 31)) &&
    Object.entries(state.actuals).every(([key, value]) => isOccurrence(key) && isMoney(value)) &&
    state.allocations.every(a => isRecord(a) && isKey(a.id) && isOccurrence(a.sourceKey) &&
      isOccurrence(a.targetKey) && isMoney(a.amount) && isDate(a.date));
}

function reply(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

async function execute(statements) {
  const database = process.env.TURSO_DATABASE_URL.replace(/^(libsql|turso):\/\//, 'https://');
  const response = await fetch(new URL('/v2/pipeline', database), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.TURSO_AUTH_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [...statements.map(stmt => ({ type: 'execute', stmt })), { type: 'close' }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Database HTTP ' + response.status);
  const { results } = await response.json();
  if (!Array.isArray(results) || results.length !== statements.length + 1 ||
      results.some(item => item.type !== 'ok')) throw new Error('SQLite pipeline failed');
  return results.slice(0, statements.length).map(item => item.response.result);
}

let schemaReady;
function prepareDatabase() {
  schemaReady ??= execute([schema]).catch(error => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
}

const text = value => ({ type: 'text', value });
const integer = value => ({ type: 'integer', value: String(value) });

export default async function budget(request) {
  if (!['GET', 'PUT'].includes(request.method)) {
    return reply({ error: 'Método inválido.' }, 405, { Allow: 'GET, PUT' });
  }
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    return reply({ error: 'Banco compartilhado ainda não configurado.' }, 503);
  }

  try {
    if (request.method === 'GET') {
      await prepareDatabase();
      const [result] = await execute([{ sql: 'SELECT version, state FROM budget_versions ORDER BY version DESC LIMIT 1' }]);
      const row = result.rows[0];
      return reply(row ? { version: Number(row[0].value), state: JSON.parse(row[1].value) } : { version: 0, state: null });
    }

    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
      return reply({ error: 'Envie os dados em JSON.' }, 415);
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > maxBytes) return reply({ error: 'A planilha excede o tamanho aceito.' }, 413);

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return reply({ error: 'Arquivo JSON inválido.' }, 400);
    }
    if (!isRecord(payload) || !Number.isSafeInteger(payload.version) || payload.version < 0 ||
        !isKey(payload.writeId) || !isBudget(payload.state)) {
      return reply({ error: 'Dados da planilha inválidos.' }, 400);
    }

    const { version, writeId, state } = payload;
    const document = JSON.stringify(state);
    await prepareDatabase();
    const [, lookup] = await execute([
      {
        sql: 'INSERT INTO budget_versions (version, write_id, state) SELECT ?, ?, ? WHERE (SELECT COALESCE(MAX(version), 0) FROM budget_versions) = ? ON CONFLICT DO NOTHING',
        args: [integer(version + 1), text(writeId), text(document), integer(version)],
      },
      { sql: 'SELECT version, state FROM budget_versions WHERE write_id = ?', args: [text(writeId)] },
    ]);
    const saved = lookup.rows[0];
    if (!saved || Number(saved[0].value) !== version + 1 || saved[1].value !== document) {
      return reply({ error: 'Outra pessoa já alterou a planilha.' }, 409);
    }
    return reply({ version: version + 1 });
  } catch (error) {
    console.error('Falha de acesso à planilha compartilhada.', error.name);
    return reply({ error: 'Não foi possível acessar o banco compartilhado.' }, 503);
  }
}
