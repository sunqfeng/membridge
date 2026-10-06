import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AppError } from './model';

export function cacheIdentity(url: string | undefined, namespace: string, agent: string) {
  return createHash('sha256').update(JSON.stringify([url?.replace(/\/$/, ''), namespace, agent])).digest('hex');
}
export function legacyIdentity(url: string | undefined, token: string | undefined, agent: string) {
  return createHash('sha256').update(JSON.stringify([url, token, agent])).digest('hex');
}
export function secureCache(path: string) {
  if (path === ':memory:') return;
  const parent = dirname(resolve(path));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const dir = lstatSync(parent);
    if (dir.isSymbolicLink() || dir.uid !== process.getuid?.()) throw new AppError('CACHE_DIRECTORY_NOT_OWNED');
    // Configured cache directories must be dedicated to this client's private data.
    chmodSync(parent, 0o700);
  }
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new AppError('CACHE_NOT_REGULAR_FILE');
  if (process.platform !== 'win32' && existsSync(path) && lstatSync(path).uid !== process.getuid?.()) throw new AppError('CACHE_FILE_NOT_OWNED');
  closeSync(openSync(path, 'a', 0o600));
  if (process.platform !== 'win32') for (const file of [path, path + '-wal', path + '-shm']) if (existsSync(file)) {
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()) throw new AppError('CACHE_FILE_NOT_OWNED');
    chmodSync(file, 0o600);
  }
}
export function selectCachePath(directory: string, options: { url?: string; token?: string; namespace: string; agent: string; legacyPath?: string }) {
  const target = join(directory, cacheIdentity(options.url, options.namespace, options.agent).slice(0, 16) + '.db');
  const oldPath = options.legacyPath ?? join(directory, legacyIdentity(options.url, options.token, options.agent).slice(0, 16) + '.db');
  if (!existsSync(target) && existsSync(oldPath)) {
    if (!lstatSync(oldPath).isFile() || lstatSync(oldPath).isSymbolicLink()) throw new AppError('CACHE_NOT_REGULAR_FILE');
    const temporary = target + '.' + crypto.randomUUID() + '.import';
    secureCache(temporary);
    let old: Database | undefined;
    try {
      old = new Database(oldPath, { readonly: true });
      writeFileSync(temporary, old.serialize(), { mode: 0o600 });
      // Publish atomically without overwriting a cache created by another process.
      try { linkSync(temporary, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { old?.close(); if (existsSync(temporary)) unlinkSync(temporary); }
  }
  return target;
}
