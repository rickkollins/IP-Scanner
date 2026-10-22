import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initKernel, meshFromManifold } from '../src/core/kernel.js';
import { Regenerator } from '../src/core/regen.js';
import { defaultParams } from '../src/core/features.js';
import { parseSTL, writeBinarySTL, writeAsciiSTL, parseOBJ, writeOBJ, parsePLY, encodeMesh, decodeMesh } from '../src/core/formats.js';
import { weld, repair, massProperties, toSoup } from '../src/core/mesh.js';
import { findLoops, arcFrom3Points, planeFrame, planeFromFace } from '../src/core/sketch.js';

before(async () => { await initKernel(); });

let nextId = 1;
const feature = (type, params = {}) => ({ id: `f${nextId++}`, type, name: type, params: { ...defaultParams(type), ...params } });
const doc = (features) => ({ features, settings: { quality: 'normal' }, rollback: null });
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b}, got ${a}`);

function run(features, blobs = new Map()) {
  const regen = new Regenerator(blobs);
  return { regen, ...regen.run(doc(features)) };
}

function assertOk(results) {
  for (const [id, r] of results) assert.ok(r.status === 'ok' || r.status === 'warning', `${id}: ${r.status} ${r.message || ''}`);
}

test('box primitive has the right volume', () => {
  const { state, results } = run([feature('box', { size: [10, 20, 30] })]);
  assertOk(results);
  const [body] = state.bodies.values();
  close(body.manifold.volume(), 6000, 1e-6, 'volume');
});

test('sketch rectangle with a circular hole extrudes to a plate with a hole', () => {
  const sk = feature('sketch', {
    plane: { type: 'XY', offset: 0 },
    entities: [
      { id: 'e1', type: 'rect', a: [0, 0], b: [40, 20] },
      { id: 'e2', type: 'circle', c: [20, 10], r: 5 },
    ],
  });
  const ex = feature('extrude', { sketch: sk.id, depth: 5 });
  const { state, results } = run([sk, ex]);
  assertOk(results);
  const [body] = state.bodies.values();
  close(body.manifold.volume(), (800 - Math.PI * 25) * 5, 2, 'plate volume');
  assert.equal(body.manifold.genus(), 1);
});

test('sketch on the front plane extrudes along -Y', () => {
  const sk = feature('sketch', { plane: { type: 'XZ' }, entities: [{ id: 'e', type: 'rect', a: [0, 0], b: [10, 10] }] });
  const { state } = run([sk, feature('extrude', { sketch: sk.id, depth: 7 })]);
  const bb = [...state.bodies.values()][0].manifold.boundingBox();
  close(bb.min[1], -7, 1e-6, 'min y');
  close(bb.max[2], 10, 1e-6, 'max z');
});

test('lines chained into a closed triangle form a profile', () => {
  const ents = [
    { type: 'line', a: [0, 0], b: [10, 0] },
    { type: 'line', a: [0, 10], b: [10, 0] }, // reversed on purpose
    { type: 'line', a: [0, 10], b: [0, 0] },
  ];
  const { loops, openEnds } = findLoops(ents);
  assert.equal(loops.length, 1);
  assert.equal(openEnds, 0);
  const sk = feature('sketch', { plane: { type: 'XY' }, entities: ents });
  const { state } = run([sk, feature('extrude', { sketch: sk.id, depth: 2 })]);
  close([...state.bodies.values()][0].manifold.volume(), 100, 1e-6, 'triangle prism');
});

test('open sketch reports a warning and extrude errors cleanly', () => {
  const sk = feature('sketch', { plane: { type: 'XY' }, entities: [{ type: 'line', a: [0, 0], b: [10, 0] }] });
  const ex = feature('extrude', { sketch: sk.id });
  const { results } = run([sk, ex]);
  assert.equal(results.get(sk.id).status, 'warning');
  assert.equal(results.get(ex.id).status, 'error');
});

test('arc from three points', () => {
  const a = arcFrom3Points([10, 0], [0, 10], [-10, 0]);
  close(a.r, 10, 1e-9, 'radius');
  close(a.c[0], 0, 1e-9, 'cx');
  // Clockwise input gets normalised to counter-clockwise.
  const b = arcFrom3Points([-10, 0], [0, 10], [10, 0]);
  close(b.a0, 0, 1e-9, 'a0');
});

test('revolve a rectangle into a ring', () => {
  const sk = feature('sketch', { plane: { type: 'XZ' }, entities: [{ type: 'rect', a: [10, 0], b: [20, 5] }] });
  const rv = feature('revolve', { sketch: sk.id, axis: 'v', angle: 360 });
  const { state, results } = run([sk, rv]);
  assertOk(results);
  const m = [...state.bodies.values()][0].manifold;
  close(m.volume(), Math.PI * (400 - 100) * 5, 30, 'ring volume');
  const bb = m.boundingBox();
  close(bb.max[2], 5, 1e-4, 'ring height along world Z');
  close(bb.max[0], 20, 0.1, 'outer radius');
});

test('half revolve, flipped, mirrors across the sketch plane', () => {
  const sk = feature('sketch', { plane: { type: 'XY' }, entities: [{ type: 'rect', a: [5, 0], b: [10, 10] }] });
  const a = run([sk, feature('revolve', { sketch: sk.id, angle: 180 })]).state;
  const b = run([sk, feature('revolve', { sketch: sk.id, angle: 180, flip: true })]).state;
  const ma = [...a.bodies.values()][0].manifold, mb = [...b.bodies.values()][0].manifold;
  assert.ok(ma.volume() > 0 && mb.volume() > 0);
  close(ma.volume(), mb.volume(), 1e-6, 'same volume');
  close(ma.boundingBox().max[2], -mb.boundingBox().min[2], 1e-6, 'mirrored');
});

test('extrude with subtract removes material from the target', () => {
  const box = feature('box', { size: [20, 20, 20] });
  const sk = feature('sketch', { plane: { type: 'XY', offset: 20 }, entities: [{ type: 'circle', c: [10, 10], r: 3 }] });
  const cut = feature('extrude', { sketch: sk.id, direction: 'reverse', throughAll: true, operation: 'subtract' });
  const { state, results } = run([box, sk, cut]);
  assertOk(results);
  const m = [...state.bodies.values()][0].manifold;
  assert.equal(state.bodies.size, 1);
  close(m.volume(), 8000 - Math.PI * 9 * 20, 10, 'drilled box');
});

test('extrude fillet and chamfer edges shrink the volume', () => {
  const sk = feature('sketch', { plane: { type: 'XY' }, entities: [{ type: 'rect', a: [0, 0], b: [20, 20] }] });
  const sharp = run([sk, feature('extrude', { sketch: sk.id, depth: 10 })]).state;
  const fil = run([sk, feature('extrude', { sketch: sk.id, depth: 10, edge: 'fillet', edgeSize: 2 })]).state;
  const cha = run([sk, feature('extrude', { sketch: sk.id, depth: 10, edge: 'chamfer', edgeSize: 2 })]).state;
  const v = (s) => [...s.bodies.values()][0].manifold.volume();
  assert.ok(v(fil) < v(sharp) && v(fil) > v(sharp) * 0.8);
  assert.ok(v(cha) < v(fil));
  const bb = [...fil.bodies.values()][0].manifold.boundingBox();
  close(bb.max[0], 20, 1e-3, 'fillet keeps footprint');
});

test('boolean union, subtract and keep tools', () => {
  const a = feature('box', { size: [10, 10, 10] });
  const b = feature('box', { size: [10, 10, 10], position: [5, 0, 0] });
  const u = feature('boolean', { op: 'union', target: a.id, tools: [b.id] });
  let r = run([a, b, u]);
  assertOk(r.results);
  assert.equal(r.state.bodies.size, 1);
  close(r.state.bodies.get(a.id).manifold.volume(), 1500, 1e-6, 'union');
  const s = feature('boolean', { op: 'subtract', target: a.id, tools: [b.id], keepTools: true });
  r = run([a, b, s]);
  assert.equal(r.state.bodies.size, 2);
  close(r.state.bodies.get(a.id).manifold.volume(), 500, 1e-6, 'subtract');
});

test('counterbore hole on a face', () => {
  const box = feature('box', { size: [30, 30, 10] });
  const hole = feature('hole', { position: [15, 15, 10], normal: [0, 0, 1], style: 'counterbore', diameter: 4, throughAll: true, cbDiameter: 8, cbDepth: 3 });
  const { state, results } = run([box, hole]);
  assertOk(results);
  const expected = 9000 - Math.PI * 4 * 7 - Math.PI * 16 * 3;
  close([...state.bodies.values()][0].manifold.volume(), expected, 3, 'counterbored volume');
});

test('patterns, mirror and transform', () => {
  const b = feature('cylinder', { radius: 2, height: 5 });
  let r = run([b, feature('linearPattern', { bodies: [b.id], axis: 'X', count: 4, spacing: 10, axis2: 'Y', count2: 2, spacing2: 10 })]);
  close(r.state.bodies.get(b.id).manifold.volume(), 8 * Math.PI * 4 * 5, 8, 'linear pattern');
  r = run([b, feature('circularPattern', { bodies: [b.id], axis: 'Z', center: [20, 0, 0], count: 6, merge: false })]);
  assert.equal(r.state.bodies.size, 6);
  const box = feature('box', { size: [10, 10, 10], position: [5, 0, 0] });
  r = run([box, feature('mirror', { bodies: [box.id], plane: 'YZ', merge: true })]);
  close(r.state.bodies.get(box.id).manifold.volume(), 2000, 1e-6, 'mirror');
  r = run([box, feature('transform', { bodies: [box.id], translate: [0, 0, 5], rotate: [0, 0, 90], copy: true })]);
  assert.equal(r.state.bodies.size, 2);
});

test('split keeps both halves as separate parts', () => {
  const s = feature('sphere', { radius: 10 });
  const { state } = run([s, feature('split', { bodies: [s.id], plane: 'XY', keep: 'both' })]);
  assert.equal(state.bodies.size, 2);
  const [p, q] = [...state.bodies.values()];
  close(p.manifold.volume(), q.manifold.volume(), 1, 'halves');
});

test('suppressed and rolled-back features are skipped', () => {
  const a = feature('box');
  const b = { ...feature('sphere', { position: [50, 0, 0] }), suppressed: true };
  const c = feature('cylinder', { position: [-50, 0, 0] });
  const regen = new Regenerator(new Map());
  let { state, results } = regen.run({ features: [a, b, c], settings: {}, rollback: null });
  assert.equal(state.bodies.size, 2);
  assert.equal(results.get(b.id).status, 'suppressed');
  ({ state, results } = regen.run({ features: [a, b, c], settings: {}, rollback: 1 }));
  assert.equal(state.bodies.size, 1);
  assert.equal(results.get(c.id).status, 'rolledback');
});

test('regeneration reuses cached features and frees kernel memory', () => {
  const regen = new Regenerator(new Map());
  const a = feature('box', { size: [10, 10, 10] });
  const b = feature('sphere', { radius: 3 });
  const features = [a, b, feature('boolean', { op: 'subtract', target: a.id, tools: [b.id] })];
  regen.run(doc(features));
  const first = regen.cache.size;
  for (let i = 0; i < 20; i++) {
    features[1] = { ...b, params: { ...b.params, radius: 2 + (i % 3) } };
    regen.run(doc(features));
  }
  assert.equal(regen.cache.size, first);
  assert.ok(regen.registry.size < 50, `tracked ${regen.registry.size}`);
});

// --- mesh import -------------------------------------------------------------

function cubeSTL() {
  const regen = new Regenerator(new Map());
  const { state } = regen.run(doc([feature('box', { size: [10, 10, 10] })]));
  const mesh = meshFromManifold([...state.bodies.values()][0].manifold);
  return { mesh, binary: writeBinarySTL([mesh]), ascii: writeAsciiSTL([{ ...mesh, name: 'cube' }]) };
}

test('binary and ASCII STL round trip into a solid', () => {
  const { binary, ascii } = cubeSTL();
  for (const data of [binary, new TextEncoder().encode(ascii).buffer]) {
    const soup = parseSTL(data);
    assert.equal(soup.length, 12 * 9);
    const mesh = weld(soup);
    assert.equal(mesh.positions.length, 8 * 3);
    close(massProperties(mesh).volume, 1000, 1e-3, 'volume');
  }
});

test('binary STL whose header starts with "solid" is still read as binary', () => {
  const { binary } = cubeSTL();
  const bytes = new Uint8Array(binary);
  new TextEncoder().encodeInto('solid evil header', bytes);
  assert.equal(parseSTL(binary).length, 12 * 9);
});

test('import feature turns an STL into a part that supports booleans', () => {
  const { binary } = cubeSTL();
  const mesh = weld(parseSTL(binary));
  const blobs = new Map([['b1', mesh]]);
  const imp = feature('import', { blob: 'b1', name: 'Cube', units: '10', placeOnGrid: true });
  const hole = feature('cylinder', { radius: 10, height: 200, centered: true, operation: 'subtract' });
  const { state, results } = run([imp, hole], blobs);
  assertOk(results);
  const body = state.bodies.get(imp.id);
  assert.equal(body.name, 'Cube');
  close(body.manifold.volume(), 1e6 - Math.PI * 100 * 100, 150, 'imported cube in cm, drilled');
  close(body.manifold.boundingBox().min[2], 0, 1e-6, 'sits on grid');
});

test('repair fixes flipped triangles, holes and inside-out meshes', () => {
  const { mesh } = cubeSTL();
  // Flip one triangle and drop another.
  const idx = Array.from(mesh.indices);
  [idx[1], idx[2]] = [idx[2], idx[1]];
  idx.splice(9, 3);
  const broken = { positions: mesh.positions, indices: new Uint32Array(idx) };
  const { mesh: fixed, report } = repair(broken);
  assert.ok(report.flipped >= 1);
  assert.equal(report.holesFilled, 1);
  close(massProperties(fixed).volume, 1000, 1e-3, 'volume after repair');
  // Fully inverted mesh.
  const inv = Array.from(mesh.indices);
  for (let t = 0; t < inv.length; t += 3) [inv[t + 1], inv[t + 2]] = [inv[t + 2], inv[t + 1]];
  const r2 = repair({ positions: mesh.positions, indices: new Uint32Array(inv) });
  assert.ok(r2.report.inverted);
  close(massProperties(r2.mesh).volume, 1000, 1e-3, 'un-inverted');
});

test('OBJ and PLY readers', () => {
  const { mesh } = cubeSTL();
  const obj = writeOBJ([{ ...mesh, name: 'c' }]);
  close(massProperties(weld(parseOBJ(obj))).volume, 1000, 1e-3, 'obj');
  const ply = ['ply', 'format ascii 1.0', 'element vertex 4', 'property float x', 'property float y', 'property float z',
    'element face 4', 'property list uchar int vertex_indices', 'end_header',
    '0 0 0', '1 0 0', '0 1 0', '0 0 1', '3 0 2 1', '3 0 1 3', '3 0 3 2', '3 1 2 3'].join('\n');
  close(massProperties(weld(parsePLY(new TextEncoder().encode(ply).buffer))).volume, 1 / 6, 1e-6, 'ply tetra');
});

test('mesh base64 encoding round trip', () => {
  const { mesh } = cubeSTL();
  const back = decodeMesh(encodeMesh(mesh));
  assert.deepEqual(Array.from(back.indices), Array.from(mesh.indices));
  assert.deepEqual(Array.from(toSoup(back)), Array.from(toSoup(mesh)));
});

test('face planes produce an orthonormal frame', () => {
  const plane = planeFromFace([3, 4, 10], [0, 0, 1]);
  const { o, u, v, n } = planeFrame(plane);
  assert.deepEqual(n, [0, 0, 1]);
  close(o[2], 10, 1e-9, 'origin height');
  close(u[0] * v[0] + u[1] * v[1] + u[2] * v[2], 0, 1e-9, 'u.v');
  const side = planeFrame(planeFromFace([10, 0, 5], [1, 0, 0]));
  close(side.v[2], 1, 1e-9, 'side face sketches have Z up');
});

test('tapered and twisted extrude stays a valid solid', () => {
  const sk = feature('sketch', { plane: { type: 'XY' }, entities: [{ type: 'polygon', c: [50, 0], r: 10, n: 6, rot: 0 }] });
  const { state, results } = run([sk, feature('extrude', { sketch: sk.id, depth: 30, twist: 60, taper: 60 })]);
  assertOk(results);
  const m = [...state.bodies.values()][0].manifold;
  const area = (3 * Math.sqrt(3) / 2) * 100;
  // Frustum volume with a top scaled to 60 %.
  close(m.volume(), (area * 30 * (1 + 0.6 + 0.36)) / 3, area * 30 * 0.03, 'tapered volume');
  const bb = m.boundingBox();
  close((bb.min[0] + bb.max[0]) / 2, 50, 1.5, 'taper is about the profile centre');
});

test('unplaced sketch is skipped without errors', () => {
  const sk = feature('sketch', { plane: null, entities: [] });
  const { results } = run([sk]);
  assert.equal(results.get(sk.id).status, 'ok');
});
