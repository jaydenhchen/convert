import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertPdfToStl } from './converter.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const threeDir = join(root, 'node_modules', 'three');

const port = Number(process.env.PORT ?? 3000);
const maxUploadBytes = 100 * 1024 * 1024;

function send(response, status, body, contentType, headers = {}) {
  response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body), ...headers });
  response.end(body);
}

async function readRequestBody(request) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (declaredLength > maxUploadBytes) throw new Error('The PDF is larger than the 100 MB upload limit.');
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxUploadBytes) throw new Error('The PDF is larger than the 100 MB upload limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeStaticPath(urlPath) {
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const relative = normalize(requested).replace(/^([/\\])+/, '');
  const path = join(publicDir, relative);
  return path.startsWith(`${publicDir}${sep}`) ? path : null;
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const vendorFiles = {
  '/vendor/three.module.js': join(threeDir, 'build', 'three.module.js'),
  '/vendor/three.core.js': join(threeDir, 'build', 'three.core.js'),
  '/vendor/controls/OrbitControls.js': join(threeDir, 'examples', 'jsm', 'controls', 'OrbitControls.js'),
  '/vendor/loaders/STLLoader.js': join(threeDir, 'examples', 'jsm', 'loaders', 'STLLoader.js')
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname === '/api/convert') {
      if (request.method !== 'POST') {
        send(response, 405, JSON.stringify({ error: 'Use POST to upload a PDF.' }), 'application/json; charset=utf-8', { Allow: 'POST' });
        return;
      }
      const pdf = await readRequestBody(request);
      const { stl, triangleCount } = await convertPdfToStl(pdf);
      send(response, stl.length ? 200 : 422, stl, 'model/stl', {
        'Content-Disposition': 'attachment; filename="converted-model.stl"',
        'X-Triangle-Count': String(triangleCount)
      });
      return;
    }

    const vendorPath = vendorFiles[url.pathname];
    if (vendorPath) {
      const body = await readFile(vendorPath);
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': body.length });
        response.end();
      } else {
        send(response, 200, body, 'text/javascript; charset=utf-8');
      }
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'Method not allowed', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD, POST' });
      return;
    }
    const filePath = safeStaticPath(url.pathname);
    if (!filePath) {
      send(response, 403, 'Forbidden', 'text/plain; charset=utf-8');
      return;
    }
    const body = await readFile(filePath);
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream', 'Content-Length': body.length });
      response.end();
      return;
    }
    send(response, 200, body, mimeTypes[extname(filePath)] ?? 'application/octet-stream');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Conversion failed.';
    const isApi = request.url?.startsWith('/api/');
    if (isApi) send(response, 422, JSON.stringify({ error: message }), 'application/json; charset=utf-8');
    else send(response, 500, message, 'text/plain; charset=utf-8');
  }
});

server.listen(port, () => {
  console.log(`PDF to STL converter listening on http://localhost:${port}`);
});
