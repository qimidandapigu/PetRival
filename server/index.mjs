import { resolve } from 'node:path';
import { createApp } from './http.mjs';
const app = createApp({ dataDir: process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : undefined });
const port = Number(process.env.PORT || 4388), host = process.env.HOST || '127.0.0.1';
app.server.listen(port, host, () => console.log(`PetRival: http://${host}:${port} | AI mode: ${app.brain.mode} | local prototype, not production hosting`));
let closing = false;
async function stop() { if (closing) return; closing = true; await app.close(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
