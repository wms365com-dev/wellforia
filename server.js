const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

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

function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(body);
}

function safePath(urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const normalized = decoded === '/' ? '/index.html' : decoded;
  const absolute = path.normalize(path.join(ROOT, normalized));
  return absolute.startsWith(ROOT) ? absolute : null;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    return send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
  }

  const filePath = safePath(req.url);
  if (!filePath) {
    return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const stream = fs.createReadStream(filePath);

    res.writeHead(200, { 'Content-Type': contentType });
    stream.pipe(res);
    stream.on('error', () => send(res, 500, 'Server Error', 'text/plain; charset=utf-8'));
  });
});

server.listen(PORT, () => {
  console.log(`Wellforia app listening on port ${PORT}`);
});
