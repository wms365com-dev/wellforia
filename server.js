const http = require('http');
const fs = require('fs');
const path = require('path');

let Pool = null;
try {
  ({ Pool } = require('pg'));
} catch (error) {
  Pool = null;
}

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DEFAULT_STATE_ID = process.env.APP_STATE_ID || 'default';
const DATABASE_URL = process.env.DATABASE_URL || '';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const pool = DATABASE_URL && Pool ? new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }
}) : null;

let dbReadyPromise = null;

function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload), 'application/json; charset=utf-8');
}

function safePath(urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const normalized = decoded === '/' ? '/index.html' : decoded;
  const absolute = path.normalize(path.join(ROOT, normalized));
  return absolute.startsWith(ROOT) ? absolute : null;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeStatePayload(payload) {
  const safePayload = normalizeObject(payload);
  return {
    settings: normalizeObject(safePayload.settings),
    rows: normalizeArray(safePayload.rows),
    itemMaster: normalizeArray(safePayload.itemMaster),
    stockRows: normalizeArray(safePayload.stockRows),
    selectedIndex: Number.isFinite(Number(safePayload.selectedIndex)) ? Math.max(0, Number(safePayload.selectedIndex)) : 0
  };
}

async function ensureDb() {
  if (!pool) return false;
  if (!dbReadyPromise) {
    dbReadyPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id TEXT PRIMARY KEY,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        rows JSONB NOT NULL DEFAULT '[]'::jsonb,
        item_master JSONB NOT NULL DEFAULT '[]'::jsonb,
        stock_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
        selected_index INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
  await dbReadyPromise;
  return true;
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('Payload too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('Request body must be valid JSON.'));
      }
    });

    req.on('error', reject);
  });
}

async function handleHealth(res) {
  let dbReady = false;
  try {
    dbReady = await ensureDb();
  } catch (error) {
    dbReady = false;
  }
  sendJson(res, 200, {
    ok: true,
    dbEnabled: Boolean(pool),
    dbReady
  });
}

async function handleGetState(res) {
  if (!await ensureDb()) {
    sendJson(res, 200, { ok: true, enabled: false, found: false });
    return;
  }

  const result = await pool.query(`
    SELECT
      settings,
      rows,
      item_master AS "itemMaster",
      stock_rows AS "stockRows",
      selected_index AS "selectedIndex",
      updated_at AS "updatedAt"
    FROM app_state
    WHERE id = $1
    LIMIT 1
  `, [DEFAULT_STATE_ID]);

  if (!result.rows.length) {
    sendJson(res, 200, { ok: true, enabled: true, found: false });
    return;
  }

  const row = result.rows[0];
  sendJson(res, 200, {
    ok: true,
    enabled: true,
    found: true,
    updatedAt: row.updatedAt,
    state: {
      settings: normalizeObject(row.settings),
      rows: normalizeArray(row.rows),
      itemMaster: normalizeArray(row.itemMaster),
      stockRows: normalizeArray(row.stockRows),
      selectedIndex: Number.isFinite(Number(row.selectedIndex)) ? Number(row.selectedIndex) : 0
    }
  });
}

async function handleSaveState(req, res) {
  if (!await ensureDb()) {
    sendJson(res, 503, { ok: false, enabled: false, message: 'DATABASE_URL is not configured for Railway database storage.' });
    return;
  }

  const payload = normalizeStatePayload(await readJsonBody(req));
  const result = await pool.query(`
    INSERT INTO app_state (
      id,
      settings,
      rows,
      item_master,
      stock_rows,
      selected_index,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (id) DO UPDATE SET
      settings = EXCLUDED.settings,
      rows = EXCLUDED.rows,
      item_master = EXCLUDED.item_master,
      stock_rows = EXCLUDED.stock_rows,
      selected_index = EXCLUDED.selected_index,
      updated_at = NOW()
    RETURNING updated_at AS "updatedAt"
  `, [
    DEFAULT_STATE_ID,
    payload.settings,
    payload.rows,
    payload.itemMaster,
    payload.stockRows,
    payload.selectedIndex
  ]);

  sendJson(res, 200, {
    ok: true,
    enabled: true,
    updatedAt: result.rows[0].updatedAt
  });
}

async function handleApi(req, res) {
  const pathname = (req.url || '').split('?')[0];

  if (pathname === '/health') {
    await handleHealth(res);
    return;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    await handleGetState(res);
    return;
  }

  if (pathname === '/api/state' && req.method === 'POST') {
    await handleSaveState(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, message: 'Not found' });
}

function handleStatic(req, res) {
  const filePath = safePath(req.url);
  if (!filePath) {
    send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const stream = fs.createReadStream(filePath);

    res.writeHead(200, { 'Content-Type': contentType });
    stream.pipe(res);
    stream.on('error', () => send(res, 500, 'Server Error', 'text/plain; charset=utf-8'));
  });
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '').split('?')[0];
  const isApi = pathname === '/health' || pathname.startsWith('/api/');

  if (isApi) {
    handleApi(req, res).catch((error) => {
      console.error('API error:', error);
      sendJson(res, 500, { ok: false, message: error && error.message ? error.message : 'Server error' });
    });
    return;
  }

  handleStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Wellforia app listening on port ${PORT}`);
  if (pool) {
    console.log('Railway database mode enabled.');
  } else {
    console.log('Railway database mode disabled. Set DATABASE_URL to enable shared saving.');
  }
});
