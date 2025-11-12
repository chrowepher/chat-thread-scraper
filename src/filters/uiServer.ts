import http from 'node:http';
import { spawn } from 'node:child_process';
import { FilterDeckStore } from './store.js';
import type { FilterRow } from './types.js';
import { renderFilterUiPage } from './uiTemplate.js';

export interface FilterUiServerOptions {
  host?: string;
  port?: number;
  open?: boolean;
}

export const runFilterUiServer = async (options: FilterUiServerOptions = {}): Promise<void> => {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4343;
  const store = new FilterDeckStore();
  await store.ensureInitialized();

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(404).end();
        return;
      }

      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
          renderFilterUiPage(),
        );
        return;
      }

      if (req.method === 'GET' && req.url === '/api/decks') {
        const decks = await store.loadAllDecks();
        const payload = {
          flag: decks.find((deck) => deck.kind === 'flag'),
          suggest: decks.find((deck) => deck.kind === 'suggest'),
        };
        res
          .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify(payload));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/save') {
        const body = await readBody(req);
        const parsed = JSON.parse(body.toString()) as {
          flag?: FilterRow[];
          suggest?: FilterRow[];
        };
        await store.replaceDeck('flag', sanitizeRows(parsed.flag ?? []));
        await store.replaceDeck('suggest', sanitizeRows(parsed.suggest ?? []));
        const decks = await store.loadAllDecks();
        const payload = {
          flag: decks.find((deck) => deck.kind === 'flag'),
          suggest: decks.find((deck) => deck.kind === 'suggest'),
        };
        res
          .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404).end();
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Internal Server Error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      console.log(`Filter Deck UI running at ${url}`);
      console.log('Press Ctrl+C to stop the server.');
      if (options.open) {
        openBrowser(url);
      }
    });

    const shutdown = () => {
      console.log('\nShutting down Filter Deck UI…');
      server.close(() => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
};

const readBody = (req: http.IncomingMessage): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
};

const sanitizeRows = (rows: FilterRow[]): FilterRow[] => {
  return rows.map((row) => ({
    ...row,
    tags: row.tags?.filter(Boolean),
    insightQuality:
      row.insightQuality === undefined || row.insightQuality === null
        ? undefined
        : Number(row.insightQuality),
  }));
};

const openBrowser = (url: string): void => {
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'win32') {
    command = 'powershell.exe';
    args = ['-NoLogo', '-Command', `Start-Process '${url}'`];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, { stdio: 'ignore' });
  child.on('error', (error) => {
    console.warn(`Failed to open browser automatically: ${error.message}`);
  });
};
