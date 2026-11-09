#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SITE_BYTES = 1024 * 1024 * 1024;
const INDEX_BYTES = 8 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function snapshotPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1000 || /[\\:\x00-\x1f\x7f]/.test(value)
    || value.startsWith('/') || isAbsolute(value) || posix.normalize(value) !== value
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw Error(`Unsafe snapshot path: ${value}`);
  return value;
}
async function inventory(root, prefix = '') {
  const files = [];
  for (const name of await readdir(join(root, prefix))) {
    const file = snapshotPath(prefix ? `${prefix}/${name}` : name);
    const info = await lstat(join(root, file));
    if (info.isSymbolicLink()) throw Error(`Snapshot symlink rejected: ${file}`);
    if (info.isDirectory()) files.push(...await inventory(root, file));
    else if (info.isFile()) files.push({ file, bytes: info.size });
    else throw Error(`Snapshot special file rejected: ${file}`);
  }
  return files;
}

/** Restore an already extracted immutable snapshot without rewriting any bytes. */
export async function buildVcslSite(snapshotDirectory, outputDirectory) {
  const snapshot = resolve(snapshotDirectory), output = resolve(outputDirectory);
  const contains = (parent, child) => { const local = relative(parent, child); return !local || (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`)); };
  if (contains(snapshot, output) || contains(output, snapshot)) {
    throw Error('Snapshot and output directories must be separate');
  }
  const rootInfo = await lstat(snapshot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error('Snapshot must be a real directory');
  const actual = await inventory(snapshot);
  const manifestInfo = actual.find(item => item.file === 'snapshot-manifest.json');
  if (!manifestInfo || manifestInfo.bytes > INDEX_BYTES) throw Error('Missing or oversized snapshot-manifest.json');
  const manifestBytes = await readFile(join(snapshot, 'snapshot-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schema !== 'momo.library-snapshot/v1' || !Array.isArray(manifest.files) || manifest.files.length > 20000) throw Error('Invalid snapshot manifest');
  const records = new Map();
  for (const item of manifest.files) {
    snapshotPath(item.file);
    if (item.file === 'snapshot-manifest.json' || records.has(item.file) || !Number.isSafeInteger(item.bytes) || item.bytes < 0
      || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error(`Invalid snapshot file: ${item.file}`);
    records.set(item.file, item);
  }
  if (actual.length !== records.size + 1 || actual.some(item => item.file !== 'snapshot-manifest.json' && !records.has(item.file))) throw Error('Snapshot contains unlisted files');
  const totalBytes = actual.reduce((total, item) => total + item.bytes, 0);
  if (totalBytes >= SITE_BYTES) throw Error(`Snapshot exceeds 1 GiB site budget: ${totalBytes}`);
  if (actual.some(item => item.bytes > 64 * 1024 * 1024)) throw Error('Snapshot file exceeds its 64 MiB transfer budget');
  for (const { file, bytes } of actual) {
    if (file === 'snapshot-manifest.json') continue;
    const expected = records.get(file);
    if (bytes !== expected.bytes || digest(await readFile(join(snapshot, file))) !== expected.sha256) throw Error(`Snapshot hash mismatch: ${file}`);
  }
  const indexRecord = records.get('index.json');
  if (!indexRecord || indexRecord.bytes > INDEX_BYTES || !records.has('validation-scope.json')) throw Error('Snapshot requires index.json and validation-scope.json');
  const index = JSON.parse(await readFile(join(snapshot, 'index.json'), 'utf8'));
  if (index.schema !== 'momo.remote-sound-library/v1' || !Array.isArray(index.entries) || !Array.isArray(index.audio)
    || index.entries.length < 1 || index.entries.length > 5000 || index.audio.length > 4096) throw Error('Invalid snapshot catalog');
  for (const item of [...index.entries, ...index.audio]) {
    const record = records.get(snapshotPath(item.file));
    if (!record || record.sha256 !== item.sha256 || record.bytes !== item.bytes) throw Error(`Catalog differs from snapshot manifest: ${item.file}`);
    if (!Number.isSafeInteger(item.decodedBytes) || item.decodedBytes < 1
      || item.decodedBytes > (item.audioId ? 48 : 16) * 1024 * 1024) throw Error(`Catalog decoded budget exceeded: ${item.file}`);
  }
  for (const item of index.entries.filter(item => item.kind === 'instrument' && item.id.startsWith('instrument-vcsl-'))) {
    if (!item.names?.zh?.trim() || !item.names?.en?.trim() || /builtin\.instrument\./.test(item.name + item.names.zh + item.names.en)) throw Error(`Missing readable bilingual instrument name: ${item.id}`);
  }
  // mkdir without recursive intentionally refuses an existing output and prevents
  // an accidental overwrite of another verified candidate.
  await mkdir(output);
  for (const { file } of actual) {
    await mkdir(dirname(join(output, file)), { recursive: true });
    await copyFile(join(snapshot, file), join(output, file));
    const copied = await readFile(join(output, file));
    if (file === 'snapshot-manifest.json' ? digest(copied) !== digest(manifestBytes) : digest(copied) !== records.get(file).sha256) throw Error(`Snapshot changed while copying: ${file}`);
  }
  return { libraryId: index.libraryId, entries: index.entries.length, audio: index.audio.length, files: actual.length, bytes: totalBytes, indexSha256: indexRecord.sha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
  if (!args.get('snapshot') || !args.get('output')) throw Error('Pass --snapshot EXTRACTED_IMMUTABLE_SNAPSHOT --output NEW_SITE_DIRECTORY');
  console.log(JSON.stringify(await buildVcslSite(args.get('snapshot'), args.get('output')), null, 2));
}
