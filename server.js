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
const DB_SCHEMA = 'public';
const TABLES = {
  config: `${DB_SCHEMA}.app_config`,
  itemMaster: `${DB_SCHEMA}.item_master_rows`,
  stock: `${DB_SCHEMA}.stock_rows`,
  calculator: `${DB_SCHEMA}.calculator_rows`,
  legacy: `${DB_SCHEMA}.app_state`
};

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

function isUndefinedTableError(error) {
  return error && error.code === '42P01';
}

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

function normalizeString(value) {
  return String(value ?? '').trim();
}

function normalizeSku(value) {
  return normalizeString(value).toUpperCase();
}

function toNum(value) {
  const number = parseFloat(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? number : 0;
}

function itemRowsFromCalculatorRows(rows) {
  const seen = new Set();
  return normalizeArray(rows)
    .map((row) => ({
      product: normalizeString(row.product),
      sku: normalizeString(row.sku),
      lcm: toNum(row.lcm),
      wcm: toNum(row.wcm),
      hcm: toNum(row.hcm),
      notes: normalizeString(row.notes)
    }))
    .filter((row) => row.product || row.sku || row.lcm || row.wcm || row.hcm)
    .filter((row) => {
      const key = normalizeSku(row.sku);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function stockRowsFromCalculatorRows(rows) {
  return normalizeArray(rows)
    .map((row) => ({
      sku: normalizeString(row.sku),
      product: normalizeString(row.product),
      boxes: toNum(row.boxes),
      notes: normalizeString(row.notes)
    }))
    .filter((row) => row.sku || row.product || row.boxes);
}

function mergeItemMasterWithCalculatorRows(calculatorRows, existingItemMaster) {
  const existingBySku = new Map();
  const extraRows = [];

  normalizeItemMasterRows(existingItemMaster).forEach((row) => {
    const key = normalizeSku(row.sku);
    if (key) existingBySku.set(key, row);
    else extraRows.push(row);
  });

  const merged = [];
  const seen = new Set();

  normalizeCalculatorRows(calculatorRows).forEach((row) => {
    const key = normalizeSku(row.sku);
    const existing = key ? existingBySku.get(key) : null;
    const itemRow = {
      product: row.product || (existing ? existing.product : ''),
      sku: row.sku || (existing ? existing.sku : ''),
      lcm: toNum(row.lcm),
      wcm: toNum(row.wcm),
      hcm: toNum(row.hcm),
      notes: row.notes || (existing ? existing.notes : '')
    };

    if (key) {
      seen.add(key);
      merged.push(itemRow);
    } else if (itemRow.product || itemRow.lcm || itemRow.wcm || itemRow.hcm || itemRow.notes) {
      merged.push(itemRow);
    }
  });

  existingBySku.forEach((row, key) => {
    if (!seen.has(key)) merged.push(row);
  });

  return normalizeItemMasterRows([...merged, ...extraRows]);
}

function normalizeItemMasterRows(rows) {
  return normalizeArray(rows)
    .map((row) => ({
      product: normalizeString(row.product),
      sku: normalizeString(row.sku),
      lcm: toNum(row.lcm),
      wcm: toNum(row.wcm),
      hcm: toNum(row.hcm),
      notes: normalizeString(row.notes)
    }))
    .filter((row) => row.product || row.sku || row.lcm || row.wcm || row.hcm);
}

function normalizeStockRows(rows) {
  return normalizeArray(rows)
    .map((row) => ({
      sku: normalizeString(row.sku),
      product: normalizeString(row.product),
      boxes: toNum(row.boxes),
      notes: normalizeString(row.notes)
    }))
    .filter((row) => row.sku || row.product || row.boxes);
}

function normalizeCalculatorRows(rows) {
  return normalizeArray(rows)
    .map((row) => ({
      product: normalizeString(row.product),
      sku: normalizeString(row.sku),
      boxes: toNum(row.boxes),
      lcm: toNum(row.lcm),
      wcm: toNum(row.wcm),
      hcm: toNum(row.hcm),
      notes: normalizeString(row.notes)
    }))
    .filter((row) => row.product || row.sku || row.boxes || row.lcm || row.wcm || row.hcm);
}

function buildMappedCalculatorRows(itemMaster, stockRows) {
  const itemMap = new Map();
  normalizeItemMasterRows(itemMaster).forEach((row) => {
    const key = normalizeSku(row.sku);
    if (key) itemMap.set(key, row);
  });

  return normalizeStockRows(stockRows).map((row) => {
    const item = itemMap.get(normalizeSku(row.sku));
    const notes = [
      item && item.notes ? item.notes : '',
      row.notes || '',
      item ? '' : 'Missing item master match'
    ].filter(Boolean).join(' | ');

    return {
      product: row.product || (item ? item.product : ''),
      sku: row.sku || '',
      boxes: toNum(row.boxes),
      lcm: item ? toNum(item.lcm) : 0,
      wcm: item ? toNum(item.wcm) : 0,
      hcm: item ? toNum(item.hcm) : 0,
      notes
    };
  });
}

function normalizeStatePayload(payload) {
  const safePayload = normalizeObject(payload);
  const incomingItemMaster = normalizeArray(safePayload.itemMaster);
  const incomingStockRows = normalizeArray(safePayload.stockRows);
  const settings = normalizeObject(safePayload.settings);
  const rows = normalizeCalculatorRows(safePayload.rows);
  let itemMaster = normalizeItemMasterRows(incomingItemMaster.length ? incomingItemMaster : itemRowsFromCalculatorRows(rows));
  let stockRows = normalizeStockRows(incomingStockRows.length ? incomingStockRows : stockRowsFromCalculatorRows(rows));

  if (rows.length) {
    itemMaster = mergeItemMasterWithCalculatorRows(rows, itemMaster);
    stockRows = stockRowsFromCalculatorRows(rows);
  }

  return {
    settings,
    rows: rows.length ? rows : buildMappedCalculatorRows(itemMaster, stockRows),
    itemMaster,
    stockRows,
    selectedIndex: Number.isFinite(Number(safePayload.selectedIndex)) ? Math.max(0, Number(safePayload.selectedIndex)) : 0
  };
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

async function replaceRows(client, tableName, datasetId, columns, rows) {
  await client.query(`DELETE FROM ${tableName} WHERE dataset_id = $1`, [datasetId]);
  if (!rows.length) return;

  const values = [];
  const placeholders = rows.map((row, index) => {
    const rowValues = [datasetId, ...columns.map((column) => row[column])];
    values.push(...rowValues);
    const start = index * rowValues.length;
    return `(${rowValues.map((_, valueIndex) => `$${start + valueIndex + 1}`).join(', ')})`;
  }).join(', ');

  await client.query(
    `INSERT INTO ${tableName} (dataset_id, ${columns.join(', ')}) VALUES ${placeholders}`,
    values
  );
}

async function writeMappedState(client, datasetId, payload) {
  await client.query(`
    INSERT INTO ${TABLES.config} (id, settings, selected_index, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (id) DO UPDATE SET
      settings = EXCLUDED.settings,
      selected_index = EXCLUDED.selected_index,
      updated_at = NOW()
  `, [datasetId, payload.settings, payload.selectedIndex]);

  await replaceRows(client, TABLES.itemMaster, datasetId, ['sort_order', 'sku', 'product', 'lcm', 'wcm', 'hcm', 'notes'],
    payload.itemMaster.map((row, index) => ({
      sort_order: index,
      sku: row.sku,
      product: row.product,
      lcm: row.lcm,
      wcm: row.wcm,
      hcm: row.hcm,
      notes: row.notes
    }))
  );

  await replaceRows(client, TABLES.stock, datasetId, ['sort_order', 'sku', 'product', 'boxes', 'notes'],
    payload.stockRows.map((row, index) => ({
      sort_order: index,
      sku: row.sku,
      product: row.product,
      boxes: row.boxes,
      notes: row.notes
    }))
  );

  await replaceRows(client, TABLES.calculator, datasetId, ['sort_order', 'sku', 'product', 'boxes', 'lcm', 'wcm', 'hcm', 'notes'],
    payload.rows.map((row, index) => ({
      sort_order: index,
      sku: row.sku,
      product: row.product,
      boxes: row.boxes,
      lcm: row.lcm,
      wcm: row.wcm,
      hcm: row.hcm,
      notes: row.notes
    }))
  );
}

async function readMappedState(client, datasetId) {
  const [configResult, itemResult, stockResult, calcResult] = await Promise.all([
    client.query(`
      SELECT id, settings, selected_index AS "selectedIndex", updated_at AS "updatedAt"
      FROM ${TABLES.config}
      WHERE id = $1
      LIMIT 1
    `, [datasetId]),
    client.query(`
      SELECT sku, product, lcm, wcm, hcm, notes
      FROM ${TABLES.itemMaster}
      WHERE dataset_id = $1
      ORDER BY sort_order ASC, id ASC
    `, [datasetId]),
    client.query(`
      SELECT sku, product, boxes, notes
      FROM ${TABLES.stock}
      WHERE dataset_id = $1
      ORDER BY sort_order ASC, id ASC
    `, [datasetId]),
    client.query(`
      SELECT sku, product, boxes, lcm, wcm, hcm, notes
      FROM ${TABLES.calculator}
      WHERE dataset_id = $1
      ORDER BY sort_order ASC, id ASC
    `, [datasetId])
  ]);

  const config = configResult.rows[0] || null;
  let itemMaster = normalizeItemMasterRows(itemResult.rows);
  let stockRows = normalizeStockRows(stockResult.rows);
  const calcRows = normalizeCalculatorRows(calcResult.rows);
  const rows = calcRows.length ? calcRows : buildMappedCalculatorRows(itemMaster, stockRows);
  if (rows.length) {
    itemMaster = mergeItemMasterWithCalculatorRows(rows, itemMaster);
    stockRows = stockRowsFromCalculatorRows(rows);
  }
  const found = Boolean(config || itemMaster.length || stockRows.length || rows.length);

  return {
    found,
    updatedAt: config ? config.updatedAt : null,
    state: found ? {
      settings: config ? normalizeObject(config.settings) : {},
      rows,
      itemMaster,
      stockRows,
      selectedIndex: config && Number.isFinite(Number(config.selectedIndex)) ? Number(config.selectedIndex) : 0
    } : null
  };
}

async function migrateLegacyState(client) {
  const existing = await readMappedState(client, DEFAULT_STATE_ID);
  if (existing.found) return;

  const legacyResult = await client.query(`
    SELECT
      settings,
      rows,
      item_master AS "itemMaster",
      stock_rows AS "stockRows",
      selected_index AS "selectedIndex"
    FROM ${TABLES.legacy}
    WHERE id = $1
    LIMIT 1
  `, [DEFAULT_STATE_ID]).catch(() => ({ rows: [] }));

  if (!legacyResult.rows.length) return;
  const payload = normalizeStatePayload(legacyResult.rows[0]);
  await writeMappedState(client, DEFAULT_STATE_ID, payload);
}

async function bootstrapMappedTables(client, includeMigration = false) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
  await client.query(`SET search_path TO ${DB_SCHEMA}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLES.config} (
      id TEXT PRIMARY KEY,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      selected_index INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLES.itemMaster} (
      id BIGSERIAL PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES ${TABLES.config}(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      sku TEXT NOT NULL DEFAULT '',
      product TEXT NOT NULL DEFAULT '',
      lcm DOUBLE PRECISION NOT NULL DEFAULT 0,
      wcm DOUBLE PRECISION NOT NULL DEFAULT 0,
      hcm DOUBLE PRECISION NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLES.stock} (
      id BIGSERIAL PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES ${TABLES.config}(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      sku TEXT NOT NULL DEFAULT '',
      product TEXT NOT NULL DEFAULT '',
      boxes DOUBLE PRECISION NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLES.calculator} (
      id BIGSERIAL PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES ${TABLES.config}(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      sku TEXT NOT NULL DEFAULT '',
      product TEXT NOT NULL DEFAULT '',
      boxes DOUBLE PRECISION NOT NULL DEFAULT 0,
      lcm DOUBLE PRECISION NOT NULL DEFAULT 0,
      wcm DOUBLE PRECISION NOT NULL DEFAULT 0,
      hcm DOUBLE PRECISION NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS item_master_rows_dataset_order_idx ON ${TABLES.itemMaster} (dataset_id, sort_order, id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS item_master_rows_dataset_sku_idx ON ${TABLES.itemMaster} (dataset_id, upper(trim(sku)))`);
  await client.query(`CREATE INDEX IF NOT EXISTS stock_rows_dataset_order_idx ON ${TABLES.stock} (dataset_id, sort_order, id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS stock_rows_dataset_sku_idx ON ${TABLES.stock} (dataset_id, upper(trim(sku)))`);
  await client.query(`CREATE INDEX IF NOT EXISTS calculator_rows_dataset_order_idx ON ${TABLES.calculator} (dataset_id, sort_order, id)`);
  if (includeMigration) {
    await migrateLegacyState(client);
  }
}

async function ensureDb() {
  if (!pool) return false;
  if (!dbReadyPromise) {
    dbReadyPromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await bootstrapMappedTables(client, true);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        dbReadyPromise = null;
        throw error;
      } finally {
        client.release();
      }
    })();
  }

  await dbReadyPromise;
  return true;
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
    dbReady,
    storage: dbReady ? 'mapped-postgres-tables' : 'browser-only'
  });
}

async function handleGetState(res) {
  if (!await ensureDb()) {
    sendJson(res, 200, { ok: true, enabled: false, found: false });
    return;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${DB_SCHEMA}`);
      const result = await readMappedState(client, DEFAULT_STATE_ID);
      sendJson(res, 200, {
        ok: true,
        enabled: true,
        found: result.found,
        updatedAt: result.updatedAt,
        state: result.state
      });
      return;
    } catch (error) {
      if (!isUndefinedTableError(error) || attempt === 1) throw error;
      await bootstrapMappedTables(client, false);
    } finally {
      client.release();
    }
  }
}

async function handleSaveState(req, res) {
  if (!await ensureDb()) {
    sendJson(res, 503, { ok: false, enabled: false, message: 'DATABASE_URL is not configured for Railway database storage.' });
    return;
  }

  const payload = normalizeStatePayload(await readJsonBody(req));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${DB_SCHEMA}`);
      await client.query('BEGIN');
      await writeMappedState(client, DEFAULT_STATE_ID, payload);
      const saved = await readMappedState(client, DEFAULT_STATE_ID);
      await client.query('COMMIT');

      sendJson(res, 200, {
        ok: true,
        enabled: true,
        updatedAt: saved.updatedAt,
        state: saved.state,
        counts: {
          itemMaster: saved.state ? saved.state.itemMaster.length : payload.itemMaster.length,
          stockRows: saved.state ? saved.state.stockRows.length : payload.stockRows.length,
          calculatorRows: saved.state ? saved.state.rows.length : payload.rows.length
        }
      });
      return;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // Ignore rollback failures after the primary error.
      }
      if (!isUndefinedTableError(error) || attempt === 1) throw error;
      await bootstrapMappedTables(client, false);
    } finally {
      client.release();
    }
  }
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
    console.log('Railway database mode enabled with mapped tables.');
  } else {
    console.log('Railway database mode disabled. Set DATABASE_URL to enable shared saving.');
  }
});
