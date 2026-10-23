// iCloud sync for the server: the shared CalDAV code, with the account saved
// in data/apple.json on this computer.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createCalDav } from '../public/shared/caldav.js';

export function createApple({ dataDir, base, allowHost }) {
  const file = path.join(dataDir, 'apple.json');
  const store = {
    load: () => readFile(file, 'utf8').then(JSON.parse, () => null),
    async save(account) {
      await mkdir(dataDir, { recursive: true });
      await writeFile(file, JSON.stringify(account), { mode: 0o600 });
    },
    clear: () => rm(file, { force: true }),
  };
  return createCalDav({ store, ...(base ? { base } : {}), ...(allowHost ? { allowHost } : {}) });
}
