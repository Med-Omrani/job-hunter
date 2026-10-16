'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.DASHBOARD_PORT || 8090);
const API_HOST = process.env.DASHBOARD_API_HOST || '127.0.0.1';
const API_PORT = Number(process.env.DASHBOARD_API_PORT || 3144);
const DIR = __dirname;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function log(ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), proc: 'dashboard', ...ev });
  try { fs.appendFileSync(path.join(DIR, 'events-dashboard.log'), line + '\n'); } catch (_) {}
  console.log(line);
}

function proxyHttp(req, res) {
  const upstream = http.request({
    host: API_HOST,
    port: API_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: API_HOST + ':' + API_PORT },
  }, (pr) => {
    res.writeHead(pr.statusCode || 502, pr.headers);
    pr.pipe(res);
  });
  upstream.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('api unreachable: ' + e.message);
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = String(req.url || '/');
  if (url.startsWith('/api/') || url === '/health') return proxyHttp(req, res);

  let p = decodeURIComponent(url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(DIR, p));
  if (!file.startsWith(DIR + path.sep) && file !== DIR) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.on('upgrade', (req, socket, head) => {
  const upstream = http.request({
    host: API_HOST,
    port: API_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  });
  upstream.on('upgrade', (pres, psock, phead) => {
    let hdr = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (const [k, v] of Object.entries(pres.headers)) hdr += k + ': ' + (Array.isArray(v) ? v.join(', ') : v) + '\r\n';
    socket.write(hdr + '\r\n');
    if (head && head.length) psock.write(head);
    if (phead && phead.length) socket.write(phead);
    psock.pipe(socket);
    socket.pipe(psock);
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

server.listen(PORT, '127.0.0.1', () => {
  log({ type: 'listening', port: PORT, api: API_HOST + ':' + API_PORT });
});
