import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadAppProtocol } from './app-protocol.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
if (!args.get('app-root') || !args.get('site')) throw Error('Pass --app-root PINNED_APP_CHECKOUT --site CANDIDATE_DIRECTORY');
const site = resolve(args.get('site'));
const protocol = await loadAppProtocol(args.get('app-root'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const failures = [], entries = []; let fixtures = 0, regressionFixtures = 0;
const completeIds = new Set(['instrument-vsco-flute', 'instrument-vsco-violin-section', 'instrument-vsco-cello-section', 'instrument-vsco-french-horn', 'instrument-vsco-trumpet']);
let coverageScope;
const ownRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
function parseScope(raw) {
  if (!ownRecord(raw) || raw.schema !== 'momo.library-validation-scope/v1' || !ownRecord(raw.instruments)) throw Error('Invalid validation coverage scope');
  for (const [id, articulations] of Object.entries(raw.instruments)) {
    if (!/^[a-zA-Z0-9-]{1,120}$/.test(id) || !ownRecord(articulations) || !Object.keys(articulations).length) throw Error(`Invalid coverage instrument: ${id}`);
    for (const [articulation, ranges] of Object.entries(articulations)) {
      if (!articulation || articulation.length > 60 || !Array.isArray(ranges) || !ranges.length || ranges.length > 128) throw Error(`Invalid coverage articulation: ${id}/${articulation}`);
      let high = -1;
      for (const range of ranges) {
        if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger) || range[0] < 0 || range[1] > 127 || range[0] > range[1] || range[0] <= high) throw Error(`Invalid coverage ranges: ${id}/${articulation}`);
        high = range[1];
      }
    }
  }
  return raw.instruments;
}
function inside(file) {
  const target = resolve(site, file), local = relative(site, target);
  if (local.startsWith('..') || resolve(target) === site) throw Error(`Unsafe file: ${file}`);
  return target;
}
function checkScore(score, assets, duration, label, requireCoverage, declared) {
  const originalIssues = protocol.scoreIssues(score, assets, duration);
  if (originalIssues.length) throw Error(`${label}: existing score ${JSON.stringify(originalIssues)}`);
  for (const instrument of score.instruments) {
    const oneInstrument = { ...score, bpm: 60, instruments: [instrument], notes: [] };
    for (const region of instrument.regions) {
      for (const midi of new Set([region.keyLow, region.keyHigh])) {
        for (const velocity of new Set([region.velocityLow, region.velocityHigh])) {
          const note = { id: 'boundary', instrumentId: instrument.id, midi, velocity, articulation: region.articulation, start: 0, duration: 0.01 };
          // Different seeds exercise the alternating takes at the same boundary.
          const variants = instrument.regions.filter(r => r.articulation === region.articulation && r.keyLow === region.keyLow && r.keyHigh === region.keyHigh && r.velocityLow === region.velocityLow && r.velocityHigh === region.velocityHigh).length;
          for (let seed = 0; seed < variants; seed++) {
            const chosen = protocol.selectRegion(instrument, note, seed, new Map());
            if (!chosen) throw Error(`${label}: no region at MIDI ${midi}, velocity ${velocity}, ${region.articulation}`);
            const asset = assets[chosen.assetId];
            const rate = 2 ** (((chosen.fixedPitch ? 0 : midi - chosen.rootMidi) + chosen.tuneCents / 100) / 12);
            const available = chosen.synth ? 1 : (protocol.sampleFrames(asset) - (chosen.sampleOffset ?? 0)) / asset.sampleRate / rate;
            const durations = [Math.min(0.05, available / 4), chosen.loop || chosen.synth ? 4 : Math.max(available * 0.9, available - chosen.releaseSeconds - 0.02)];
            for (const held of durations) {
              const test = { ...note, duration: held };
              const end = protocol.noteEndSeconds(test, chosen, assets, 60);
              const issues = protocol.scoreIssues({ ...oneInstrument, notes: [test] }, assets, end + 0.01, seed);
              if (issues.length) throw Error(`${label}: MIDI ${midi}, velocity ${velocity}, ${region.articulation}, ${held}s: ${JSON.stringify(issues)}`);
              fixtures++;
            }
          }
        }
      }
    }
    if (requireCoverage) {
      const articulations = [...new Set(instrument.regions.map(r => r.articulation))];
      if (declared && (Object.keys(declared).length !== articulations.length || articulations.some(art => !Object.hasOwn(declared, art)))) throw Error(`${label}: coverage articulation declaration differs from mappings`);
      for (const articulation of articulations) {
        const regions = instrument.regions.filter(r => r.articulation === articulation);
        const low = Math.min(...regions.map(r => r.keyLow)), high = Math.max(...regions.map(r => r.keyHigh));
        const ranges = declared?.[articulation] ?? [[low, high]];
        const declaredKeys = new Set(ranges.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)));
        if (declared) for (let midi = 0; midi <= 127; midi++) {
          if (declaredKeys.has(midi) !== regions.some(r => midi >= r.keyLow && midi <= r.keyHigh)) throw Error(`${label}: coverage key declaration differs from mappings at MIDI ${midi}, ${articulation}`);
        }
        for (const midi of declaredKeys) for (let velocity = 1; velocity <= 127; velocity++) {
          if (!regions.some(r => midi >= r.keyLow && midi <= r.keyHigh && velocity >= r.velocityLow && velocity <= r.velocityHigh)) throw Error(`${label}: coverage hole at MIDI ${midi}, velocity ${velocity}, ${articulation}`);
        }
      }
    }
  }
}
function checkProject(project, label, coverage, declared) {
  const issues = protocol.projectScoreIssues(project);
  if (issues.length) throw Error(`${label}: project score ${JSON.stringify(issues)}`);
  for (const layer of project.inputs) {
    if (layer.player.score) checkScore(layer.player.score, project.assets, layer.player.duration, `${label}/${layer.id}`, coverage, declared);
    if (layer.player.mix) checkProject(layer.player.mix, `${label}/${layer.id}`, coverage, declared);
  }
}
function checkRegressions(project, id) {
  const cases = id === 'example-expanded-flute' ? [[71, 62, 0.25]]
    : id === 'example-expanded-cello' ? [[55, 48, 0.25], [55, 58, 0.25]]
      : id === 'example-expanded-violin' ? [67, 69].flatMap(midi => [1, 48, 58, 62, 63, 80, 127].map(velocity => [midi, velocity, 4])) : [];
  if (!cases.length) return;
  const layer = project.inputs.find(l => l.player.score?.instruments.some(i => i.regions.some(r => r.articulation === 'sustain')));
  if (!layer) throw Error(`${id}: missing sustain demonstration`);
  const instrument = layer.player.score.instruments.find(i => i.regions.some(r => r.articulation === 'sustain'));
  for (const [midi, velocity, duration] of cases) {
    const candidate = structuredClone(project), target = candidate.inputs.find(l => l.id === layer.id);
    target.player.duration = 12;
    target.player.score = { schema: 'momo.score/v1', bpm: 60, instruments: [instrument], notes: [{ id: 'regression', instrumentId: instrument.id, articulation: 'sustain', midi, velocity, duration, start: 0 }] };
    candidate.inputs = [target]; candidate.duration = 12;
    const issues = protocol.projectScoreIssues(candidate);
    if (issues.length) throw Error(`${id}: regression MIDI ${midi}, velocity ${velocity}, ${duration}s ${JSON.stringify(issues)}`);
    regressionFixtures++;
  }
}

try {
  const index = protocol.parseRemoteIndex(JSON.parse(await readFile(join(site, 'index.json'), 'utf8')), 'https://validation.invalid/index.json');
  try { coverageScope = parseScope(JSON.parse(await readFile(args.get('coverage-file') ? resolve(args.get('coverage-file')) : join(site, 'validation-scope.json'), 'utf8'))); }
  catch (error) { if (args.get('coverage-file') || error.code !== 'ENOENT') throw error; }
  if (coverageScope) for (const id of Object.keys(coverageScope)) {
    if (!index.entries.some(entry => entry.id === id && entry.kind === 'instrument')) failures.push({ id, error: 'Coverage scope references an unknown instrument entry' });
  }
  const audio = new Map(index.audio.map(a => [a.audioId, a]));
  for (const entry of index.entries) {
    try {
      const packed = await readFile(inside(entry.file));
      if (packed.length !== entry.bytes || sha256(packed) !== entry.sha256) throw Error('graph transfer mismatch');
      const decoded = gunzipSync(packed, { maxOutputLength: protocol.GRAPH_BYTES });
      if (decoded.length !== entry.decodedBytes) throw Error('decoded graph size mismatch');
      const graph = JSON.parse(decoded);
      if (graph.root !== entry.contentId || graph.entry.id !== entry.id || graph.entry.kind !== entry.kind) throw Error('catalog identity mismatch');
      const opened = await protocol.openResourceGraph(graph);
      let packedBytes = packed.length;
      for (const [id, ref] of opened.audio) {
        const file = audio.get(id);
        if (!file || file.frames !== ref.frames || file.sampleRate !== ref.sampleRate || file.channelCount !== ref.channelCount) throw Error(`incomplete audio dependency ${id}`);
        packedBytes += file.bytes;
      }
      if (packedBytes > protocol.PACKAGE_BYTES) throw Error(`complete resource exceeds packed package budget: ${packedBytes}`);
      const isVcsl = entry.kind === 'instrument' && entry.id.startsWith('instrument-vcsl-');
      if (isVcsl && coverageScope && !Object.hasOwn(coverageScope, entry.id)) throw Error('Missing VCSL instrument coverage declaration');
      const declared = coverageScope?.[entry.id];
      const coverage = !!declared || isVcsl || completeIds.has(entry.id) || /^example-expanded-(flute|violin|cello)$/.test(entry.id);
      if (entry.kind === 'instrument' || entry.kind === 'sound') {
        const project = protocol.resourceProject(opened.resource);
        checkProject(project, entry.id, coverage, declared);
        checkRegressions(project, entry.id);
      }
      entries.push({ id: entry.id, contentId: graph.root, audio: opened.audio.size });
    } catch (error) { failures.push({ id: entry.id, error: error.message }); }
  }
  // Verify both transfer bytes and decoded PCM identity, including unused keys.
  for (const item of index.audio) {
    try {
      const bytes = await readFile(inside(item.file));
      if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw Error('audio transfer mismatch');
      const raw = new Uint8Array(gunzipSync(bytes, { maxOutputLength: item.decodedBytes }));
      if (raw.length !== item.decodedBytes) throw Error('decoded audio size mismatch');
      const pcm = item.format === 'pcm' ? raw : protocol.builtinPCM(raw, item);
      const ref = await protocol.audioReference(pcm);
      if (ref.audioId !== item.audioId || ref.frames !== item.frames || ref.sampleRate !== item.sampleRate || ref.channelCount !== item.channelCount) throw Error('audio content identity mismatch');
    } catch (error) { failures.push({ id: item.audioId, error: error.message }); }
  }
  const report = { entries: entries.length, audio: index.audio.length, noteFixtures: fixtures, regressionFixtures, failures };
  if (args.get('report')) await writeFile(resolve(args.get('report')), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
} finally { await protocol.close(); }
