/** `npm run reset` — delete the local database so the next start re-seeds demo data. */
import { existsSync, rmSync } from 'node:fs';
import { config } from './config.js';

for (const suffix of ['', '-wal', '-shm']) {
  const file = `${config.dbPath}${suffix}`;
  if (existsSync(file)) {
    rmSync(file);
    console.log(`Removed ${file}`);
  }
}
console.log('Database reset. Run `npm start` or `npm run dev` to re-seed.');
