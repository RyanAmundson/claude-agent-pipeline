import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ICON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const cache = new Map();

export function iconDataUri(name) {
  if (cache.has(name)) return cache.get(name);
  const b64 = readFileSync(join(ICON_DIR, `${name}.png`)).toString('base64');
  const uri = `data:image/png;base64,${b64}`;
  cache.set(name, uri);
  return uri;
}
