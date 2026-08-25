// @ts-nocheck
import { createApp } from './src/server.js';
import { describeBackend } from './src/polymarket/persistence.js';
import dotenv from 'dotenv';
import os from 'os';
dotenv.config();

// Perf tuning
process.env.UV_THREADPOOL_SIZE = String(Math.min(32, Math.max(8, os.cpus().length * 2)));
process.setMaxListeners(0);
const PORT = parseInt(process.env.PORT || '3000', 10);

// Prevent crashes from unhandled errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled:', err?.message || err);
});

const app = await createApp();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🚀 Zinger Launcher live`);
  console.log(`     http://0.0.0.0:${PORT}`);
  console.log(`     Mainnet · Polygon (137)`);
  console.log(`     Thread pool: ${process.env.UV_THREADPOOL_SIZE} · Node ${process.version}`);
  // Backlog item 15 — never let the operator guess which store is live.
  const store = describeBackend();
  console.log(
    `     Store: ${store.backend.toUpperCase()} · ${store.reason}` +
      (store.docCount != null ? ` · ${store.docCount} docs` : '') +
      `\n     Data dir: ${store.dataDir}\n`,
  );
});

server.keepAliveTimeout = 30000;
server.headersTimeout = 31000;
