import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildVcslSite, snapshotPath } from './build-vcsl-site.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(root) {
  const snapshot = join(root, 'snapshot');
  await mkdir(join(snapshot, 'remote'), { recursive: true });
  await mkdir(join(snapshot, 'provenance'));
  const graph = Buffer.from('Immutable graph transfer bytes');
  const records = [
    { file: 'remote/graph.bin', bytes: graph.length, sha256: digest(graph) },
    { file: 'provenance/LICENSE.txt', bytes: 3, sha256: digest('CC0') },
  ];
  const index = Buffer.from(JSON.stringify({ schema: 'momo.remote-sound-library/v1', libraryId: 'vcsl-test', entries: [{ id: 'instrument-vcsl-test', kind: 'instrument', name: '测试乐器', names: { zh: '测试乐器', en: 'Test instrument' }, decodedBytes: graph.length, ...records[0] }], audio: [] }, null, 2) + '\n');
  const scope = Buffer.from(JSON.stringify({ schema: 'momo.library-validation-scope/v1', instruments: { 'instrument-vcsl-test': { normal: [[60, 61]] } } }));
  records.push({ file: 'index.json', bytes: index.length, sha256: digest(index) }, { file: 'validation-scope.json', bytes: scope.length, sha256: digest(scope) });
  await writeFile(join(snapshot, 'remote/graph.bin'), graph);
  await writeFile(join(snapshot, 'provenance/LICENSE.txt'), 'CC0');
  await writeFile(join(snapshot, 'index.json'), index);
  await writeFile(join(snapshot, 'validation-scope.json'), scope);
  const manifest = { schema: 'momo.library-snapshot/v1', files: records };
  await writeFile(join(snapshot, 'snapshot-manifest.json'), JSON.stringify(manifest));
  return { snapshot, manifest, index };
}

test('snapshot restore preserves original index bytes and refuses to overwrite a candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'momo-vcsl-snapshot-'));
  try {
    const { snapshot, index } = await fixture(root), output = join(root, 'site');
    const report = await buildVcslSite(snapshot, output);
    assert.equal(report.entries, 1);
    assert.equal(report.indexSha256, digest(index));
    assert.deepEqual(await readFile(join(output, 'index.json')), index);
    assert.equal((await readFile(join(output, 'provenance/LICENSE.txt'), 'utf8')), 'CC0');
    await assert.rejects(buildVcslSite(snapshot, output), /EEXIST/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('snapshot restore rejects traversal, tampering, unlisted files and catalog/manifest disagreement', async () => {
  for (const value of ['../escape', '/absolute', 'C:/escape', 'remote\\escape', 'remote/../escape', 'remote//file', 'remote/./file', 'remote/']) assert.throws(() => snapshotPath(value), /Unsafe/);
  const root = await mkdtemp(join(tmpdir(), 'momo-vcsl-invalid-'));
  try {
    const { snapshot, manifest } = await fixture(root);
    await writeFile(join(snapshot, 'remote/graph.bin'), 'Changed graph transfer bytes!!');
    await assert.rejects(buildVcslSite(snapshot, join(root, 'changed')), /hash mismatch/);
    const graph = Buffer.from('Immutable graph transfer bytes');
    await writeFile(join(snapshot, 'remote/graph.bin'), graph);
    await writeFile(join(snapshot, 'unlisted.txt'), 'Unexpected');
    await assert.rejects(buildVcslSite(snapshot, join(root, 'unlisted')), /unlisted/);
    await rm(join(snapshot, 'unlisted.txt'));
    manifest.files[0].file = '../escape';
    await writeFile(join(snapshot, 'snapshot-manifest.json'), JSON.stringify(manifest));
    await assert.rejects(buildVcslSite(snapshot, join(root, 'traversal')), /Unsafe/);
    manifest.files[0].file = 'remote/graph.bin';
    const index = JSON.parse(await readFile(join(snapshot, 'index.json')));
    index.entries[0].sha256 = '0'.repeat(64);
    const indexBytes = Buffer.from(JSON.stringify(index));
    await writeFile(join(snapshot, 'index.json'), indexBytes);
    Object.assign(manifest.files.find(x => x.file === 'index.json'), { bytes: indexBytes.length, sha256: digest(indexBytes) });
    await writeFile(join(snapshot, 'snapshot-manifest.json'), JSON.stringify(manifest));
    await assert.rejects(buildVcslSite(snapshot, join(root, 'catalog')), /Catalog differs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('snapshot restore rejects symbolic links before following them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'momo-vcsl-link-'));
  try {
    const { snapshot } = await fixture(root), outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret'), 'Do not copy');
    try { await symlink(outside, join(snapshot, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code === 'EPERM') return t.skip('Host disallows creating symlinks'); throw error; }
    await assert.rejects(buildVcslSite(snapshot, join(root, 'site')), /symlink rejected/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('snapshot restore checks the full site size before reading large files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'momo-vcsl-budget-'));
  try {
    const { snapshot, manifest } = await fixture(root);
    const file = join(snapshot, 'remote/oversized.bin');
    await writeFile(file, '');
    await truncate(file, 1024 * 1024 * 1024);
    manifest.files.push({ file: 'remote/oversized.bin', bytes: 1024 * 1024 * 1024, sha256: 'a'.repeat(64) });
    await writeFile(join(snapshot, 'snapshot-manifest.json'), JSON.stringify(manifest));
    await assert.rejects(buildVcslSite(snapshot, join(root, 'site')), /1 GiB site budget/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
