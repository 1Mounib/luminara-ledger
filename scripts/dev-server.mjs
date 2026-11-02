/**
 * Local test server - runs the site on your own computer, no installs needed.
 *   node scripts/dev-server.mjs        then open http://localhost:3000
 * Optional: put GROQ_API_KEY=... in a file called .env next to package.json
 * It serves the public/ folder and runs api/*.js the same way Vercel does.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);

// Load .env (KEY=value lines) without any library
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.csv': 'text/csv', '.ico': 'image/x-icon'
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/[^a-z0-9-]/gi, '');
      const file = join(ROOT, 'api', `${name}.js`);
      if (!existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      req.body = raw && /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw) : raw;
      const { default: handler } = await import(`${new URL(`../api/${name}.js`, import.meta.url)}?t=${Date.now()}`);
      return await handler(req, res);
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(PUBLIC, path);
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
    const body = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch (error) {
    res.statusCode = error.code === 'ENOENT' ? 404 : 500;
    res.end(error.code === 'ENOENT' ? 'Not found' : String(error.stack));
  }
}).listen(PORT, () => {
  console.log(`Luminara Ledger running at http://localhost:${PORT}`);
  console.log(process.env.GROQ_API_KEY ? 'Cloud AI: Groq key found' : 'Cloud AI: no key - on-device agents only');
});
