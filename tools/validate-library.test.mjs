import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { loadAppProtocol } from './app-protocol.mjs';

test('publisher accepts a complete graph and rejects inline objects, velocity holes and unsupported long notes', async () => {
  assert.ok(process.env.PROTOCOL_APP_ROOT, 'Set PROTOCOL_APP_ROOT to the pinned application checkout');
  const appRoot = resolve(process.env.PROTOCOL_APP_ROOT);
  const protocol = await loadAppProtocol(appRoot);
  const site = await mkdtemp(join(tmpdir(), 'momo-publisher-test-'));
  try {
    await mkdir(join(site, 'remote'));
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    async function store(raw) {
      const bytes = gzipSync(raw), sha256 = digest(bytes), file = `remote/${sha256}.bin`;
      await writeFile(join(site, file), bytes);
      return { file, sha256, bytes: bytes.length, decodedBytes: raw.length };
    }
    const asset = { id: 'sample', name: 'Test', sampleRate: 8000, channels: [protocol.encodeSamples(new Float32Array(8000).fill(0.1))] };
    const region = { id: 'region', assetId: asset.id, rootMidi: 60, keyLow: 60, keyHigh: 61, velocityLow: 1, velocityHigh: 127, articulation: 'sustain', roundRobin: 0, tuneCents: 0, gainDb: 0, releaseSeconds: 0.1 };
    const definition = { schema: 'momo.instrument/v1', assets: { sample: asset }, instrument: { id: 'instrument', name: 'Test', keyRange: { low: 60, high: 61 }, regions: [region] } };
    const audio = new Map(), entries = [];
    async function seal(resource) {
      return protocol.sealResource(resource, async (ref, raw) => audio.set(ref.audioId, { ...ref, format: 'pcm', ...await store(raw) }));
    }
    async function add(graph) {
      entries.push({ ...graph.entry, contentId: graph.root, ...await store(Buffer.from(JSON.stringify(graph))) });
    }
    await add(await seal(protocol.resourceFromDefinition(definition, 'test-complete')));
    const inline = await seal(protocol.resourceFromDefinition(definition, 'test-inline'));
    // Rehash the malformed graph: transfer and object hashes alone must not
    // accidentally pass an invalid inline object like the orchestra regression.
    const rebuilt = {};
    async function rewrite(id) {
      const object = structuredClone(inline.objects[id]);
      if (object.kind === 'instrument') object.value.keyRange = { low: 60, high: 61 };
      async function refs(value) {
        if (Array.isArray(value)) return Promise.all(value.map(refs));
        if (value && typeof value === 'object') {
          if (value.$ref) return { $ref: await rewrite(value.$ref) };
          return value;
        }
        return value;
      }
      for (const key of Object.keys(object.value)) object.value[key] = await refs(object.value[key]);
      const next = await protocol.contentId(object.kind, object);
      rebuilt[next] = object;
      return next;
    }
    inline.root = await rewrite(inline.root); inline.objects = rebuilt;
    await add(inline);
    const hole = structuredClone(definition);
    hole.instrument.regions[0].velocityLow = 63;
    await add(await seal(protocol.resourceFromDefinition(hole, 'instrument-vsco-flute')));
    const project = protocol.makeProject('Unsupported long note');
    project.duration = 3; project.assets = definition.assets;
    project.inputs = [protocol.makeLayer({ type: 'instrument', duration: 3, score: { schema: 'momo.score/v1', bpm: 60, instruments: [definition.instrument], notes: [{ id: 'long', instrumentId: 'instrument', midi: 60, velocity: 62, articulation: 'sustain', start: 0, duration: 2 }] } })];
    await add(await seal(protocol.resourceFromProject(project, [], 'test-long-note')));
    await writeFile(join(site, 'index.json'), JSON.stringify({ schema: 'momo.remote-sound-library/v1', libraryId: 'publisher-tests', name: 'Publisher tests', entries, audio: [...audio.values()] }));
    const reportPath = join(site, 'report.json');
    const result = spawnSync(process.execPath, [resolve('tools/validate-library.mjs'), '--app-root', appRoot, '--site', site, '--report', reportPath], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.entries, 1);
    assert.ok(report.noteFixtures > 0);
    assert.deepEqual(report.failures.map(f => f.id).sort(), ['instrument-vsco-flute', 'test-inline', 'test-long-note']);
    assert.match(report.failures.find(f => f.id === 'test-inline').error, /resources.invalid/);
    assert.match(report.failures.find(f => f.id === 'instrument-vsco-flute').error, /coverage hole/);
    assert.match(report.failures.find(f => f.id === 'test-long-note').error, /score.noSustain/);
  } finally { await protocol.close(); await rm(site, { recursive: true, force: true }); }
});

test('new VCSL instruments require full velocity coverage on every declared discrete key and cannot omit scope entries', async () => {
  assert.ok(process.env.PROTOCOL_APP_ROOT, 'Set PROTOCOL_APP_ROOT to the pinned application checkout');
  const appRoot = resolve(process.env.PROTOCOL_APP_ROOT), protocol = await loadAppProtocol(appRoot);
  const root = await mkdtemp(join(tmpdir(), 'momo-vcsl-coverage-'));
  try {
    await mkdir(join(root, 'remote'));
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    async function store(raw) {
      const bytes = gzipSync(raw), sha256 = digest(bytes), file = `remote/${sha256}.bin`;
      await writeFile(join(root, file), bytes);
      return { file, sha256, bytes: bytes.length, decodedBytes: raw.length };
    }
    const asset = { id: 'sample', name: 'Test', sampleRate: 8000, channels: [protocol.encodeSamples(new Float32Array(8000).fill(0.1))] };
    const region = { id: 'first', assetId: 'sample', rootMidi: 60, keyLow: 60, keyHigh: 60, velocityLow: 1, velocityHigh: 127, articulation: 'normal', roundRobin: 0, tuneCents: 0, gainDb: 0, releaseSeconds: 0.1 };
    const definition = { schema: 'momo.instrument/v1', assets: { sample: asset }, instrument: { id: 'instrument', name: 'Discrete drum', keyRange: { low: 60, high: 62 }, regions: [region, { ...region, id: 'second', rootMidi: 62, keyLow: 62, keyHigh: 62 }] } };
    const audio = new Map();
    async function seal(id, d = definition) {
      const graph = await protocol.sealResource(protocol.resourceFromDefinition(d, id), async (ref, raw) => audio.set(ref.audioId, { ...ref, format: 'pcm', ...await store(raw) }));
      return { ...graph.entry, contentId: graph.root, ...await store(Buffer.from(JSON.stringify(graph))) };
    }
    const good = await seal('instrument-vcsl-discrete');
    const holeDefinition = structuredClone(definition);
    holeDefinition.instrument.regions[0].velocityLow = 63;
    const hole = await seal('instrument-vcsl-velocity-hole', holeDefinition);
    const undeclared = await seal('instrument-vcsl-undeclared');
    const scope = { schema: 'momo.library-validation-scope/v1', instruments: { [good.id]: { normal: [[60, 60], [62, 62]] }, [hole.id]: { normal: [[60, 60], [62, 62]] } } };
    const base = { schema: 'momo.remote-sound-library/v1', libraryId: 'publisher-scope-tests', name: 'Publisher scope tests', audio: [...audio.values()] };
    async function run(entries, declared = scope) {
      await writeFile(join(root, 'index.json'), JSON.stringify({ ...base, entries }));
      if (declared) await writeFile(join(root, 'validation-scope.json'), JSON.stringify(declared));
      else await rm(join(root, 'validation-scope.json'), { force: true });
      const reportPath = join(root, 'report.json');
      const result = spawnSync(process.execPath, [resolve('tools/validate-library.mjs'), '--app-root', appRoot, '--site', root, '--report', reportPath], { encoding: 'utf8' });
      assert.ok([0, 1].includes(result.status), result.stderr + result.stdout);
      return { status: result.status, report: JSON.parse(await readFile(reportPath, 'utf8')) };
    }
    const invalid = await run([good, hole, undeclared]);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.report.entries, 1);
    assert.deepEqual(invalid.report.failures.map(x => x.id).sort(), [undeclared.id, hole.id].sort());
    assert.match(invalid.report.failures.find(x => x.id === hole.id).error, /coverage hole/);
    assert.match(invalid.report.failures.find(x => x.id === undeclared.id).error, /Missing VCSL/);
    const onlyGood = { schema: scope.schema, instruments: { [good.id]: scope.instruments[good.id] } };
    assert.equal((await run([good], onlyGood)).status, 0, 'Explicitly declared gaps between drum keys are valid');
    const hideKey = structuredClone(onlyGood);
    hideKey.instruments[good.id].normal = [[60, 60]];
    assert.match((await run([good], hideKey)).report.failures[0].error, /key declaration differs/);
    const hideArticulation = structuredClone(onlyGood);
    hideArticulation.instruments[good.id].unused = [[60, 60]];
    assert.match((await run([good], hideArticulation)).report.failures[0].error, /articulation declaration differs/);
    const withoutScope = await run([good], null);
    assert.match(withoutScope.report.failures[0].error, /coverage hole at MIDI 61/, 'New VCSL instruments are checked even without a scope file');
  } finally { await protocol.close(); await rm(root, { recursive: true, force: true }); }
});
