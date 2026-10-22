// Feature definitions. Each feature type declares its parameters (which drive
// the property panel) and a build(ctx, params, feature) function that turns
// the incoming model state into the outgoing one.
//
// State: { bodies: Map<id, Body>, sketches: Map<id, Sketch>, partCounter }
// Body:  { id, name, manifold, featureId }
// Kernel objects are immutable, so a feature never modifies its inputs; it
// replaces entries in the (copied) maps instead.

import { kernel, track, checkManifold, manifoldFromMesh } from './kernel.js';
import { findLoops, planeMatrix, planeLabel, sketchBounds } from './sketch.js';

// --- small matrix helpers (column-major 4x4, as Manifold expects) --------------

export function matMul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const translation = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** Frame matrix whose local Z axis points along `dir`, positioned at `pos`. */
export function frameAlong(pos, dir) {
  const l = Math.hypot(...dir) || 1;
  const n = dir.map((x) => x / l);
  const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let u = [ref[1] * n[2] - ref[2] * n[1], ref[2] * n[0] - ref[0] * n[2], ref[0] * n[1] - ref[1] * n[0]];
  const ul = Math.hypot(...u);
  u = u.map((x) => x / ul);
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, pos[0], pos[1], pos[2], 1];
}

// --- circle quality -------------------------------------------------------------

let quality = { maxAngle: 6, maxEdge: 0.6 };
export function setQuality(q) {
  quality = { draft: { maxAngle: 12, maxEdge: 1.5 }, normal: { maxAngle: 6, maxEdge: 0.6 }, fine: { maxAngle: 3, maxEdge: 0.25 } }[q] || quality;
}
export function segmentsFor(r) {
  const byAngle = Math.ceil(360 / quality.maxAngle);
  const byEdge = Math.ceil((2 * Math.PI * Math.abs(r)) / quality.maxEdge);
  return Math.ceil(Math.max(12, Math.min(byAngle, byEdge)) / 4) * 4;
}

// --- shared parameter blocks --------------------------------------------------------

const OPERATION = [
  { key: 'operation', label: 'Result', type: 'select', options: [['new', 'New part'], ['add', 'Add to part'], ['subtract', 'Remove from part'], ['intersect', 'Intersect with part']], default: 'new' },
  { key: 'targets', label: 'Parts', type: 'bodies', default: [], show: (p) => p.operation !== 'new', hint: 'Leave empty to use every part' },
];
const PLACEMENT = [
  { key: 'position', label: 'Position', type: 'vec3', unit: 'mm', default: [0, 0, 0] },
  { key: 'rotation', label: 'Rotation', type: 'vec3', unit: '°', default: [0, 0, 0] },
];
const AXES = [['X', 'X axis'], ['Y', 'Y axis'], ['Z', 'Z axis']];
const AXIS_VEC = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const PLANES = [['XY', 'Top (XY)'], ['XZ', 'Front (XZ)'], ['YZ', 'Right (YZ)']];
const PLANE_NORMAL = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };

// --- state helpers --------------------------------------------------------------------

function newBody(ctx, man, featureId, name, suffix = '') {
  const id = featureId + suffix;
  const body = { id, name: name || `Part ${ctx.state.partCounter++}`, manifold: man, featureId };
  ctx.state.bodies.set(id, body);
  return body;
}

function replaceBody(ctx, body, man) {
  ctx.state.bodies.set(body.id, { ...body, manifold: man });
}

function getBody(ctx, id) {
  const b = ctx.state.bodies.get(id);
  if (!b) throw new Error('A referenced part no longer exists');
  return b;
}

function getBodies(ctx, ids, { required = true } = {}) {
  const list = (ids || []).map((id) => ctx.state.bodies.get(id)).filter(Boolean);
  if (required && !list.length) throw new Error('Select at least one part');
  return list;
}

function placed(man, params) {
  const [rx, ry, rz] = params.rotation || [0, 0, 0];
  const [x, y, z] = params.position || [0, 0, 0];
  let m = man;
  if (rx || ry || rz) m = track(m.rotate([rx, ry, rz]));
  if (x || y || z) m = track(m.translate([x, y, z]));
  return m;
}

/**
 * Combine a freshly built tool solid with the model according to the
 * feature's operation parameter.
 */
function applyOperation(ctx, feature, man, name) {
  const { operation = 'new' } = feature.params;
  checkManifold(man);
  if (man.isEmpty()) throw new Error('The feature produced no geometry');
  if (operation === 'new') return newBody(ctx, man, feature.id, name);

  let targets = getBodies(ctx, feature.params.targets, { required: false });
  if (!targets.length) targets = [...ctx.state.bodies.values()];
  if (!targets.length) {
    if (operation === 'add') return newBody(ctx, man, feature.id, name);
    throw new Error('There are no parts to modify');
  }
  const { Manifold } = kernel();
  if (operation === 'add') {
    const [first, ...rest] = targets;
    let merged = track(Manifold.union([first.manifold, man, ...rest.map((b) => b.manifold)]));
    for (const b of rest) ctx.state.bodies.delete(b.id);
    replaceBody(ctx, first, checkManifold(merged));
    return;
  }
  const box = man.boundingBox();
  for (const t of targets) {
    if (operation === 'subtract') {
      if (!boxesOverlap(box, t.manifold.boundingBox())) continue;
      replaceBody(ctx, t, checkManifold(track(t.manifold.subtract(man))));
    } else {
      const res = track(t.manifold.intersect(man));
      if (res.isEmpty()) ctx.state.bodies.delete(t.id);
      else replaceBody(ctx, t, checkManifold(res));
    }
  }
}

function boxesOverlap(a, b) {
  for (let k = 0; k < 3; k++) if (a.max[k] < b.min[k] - 1e-6 || b.max[k] < a.min[k] - 1e-6) return false;
  return true;
}

function modelSize(ctx) {
  let size = 100;
  for (const b of ctx.state.bodies.values()) {
    const bb = b.manifold.boundingBox();
    for (let k = 0; k < 3; k++) size = Math.max(size, Math.abs(bb.min[k]), Math.abs(bb.max[k]));
  }
  return size * 4;
}

function sketchCrossSection(ctx, sketchId) {
  const sk = ctx.state.sketches.get(sketchId);
  if (!sk) throw new Error('Select a sketch');
  if (!sk.cs || sk.cs.isEmpty()) throw new Error('The sketch has no closed profile');
  return sk;
}

function pickRegions(ctx, cs, regions) {
  if (!regions || !String(regions).trim() || String(regions).trim().toLowerCase() === 'all') return cs;
  const wanted = String(regions).split(/[\s,]+/).map((x) => parseInt(x, 10) - 1).filter((x) => x >= 0);
  const parts = track(cs.decompose());
  const chosen = wanted.map((i) => parts[i]).filter(Boolean);
  if (!chosen.length) throw new Error('None of the listed regions exist');
  return track(kernel().CrossSection.compose(chosen));
}

// --- feature registry -----------------------------------------------------------------

export const FEATURES = {
  sketch: {
    label: 'Sketch',
    icon: 'sketch',
    params: [
      { key: 'fill', label: 'Profile fill', type: 'select', options: [['EvenOdd', 'Nested loops are holes'], ['NonZero', 'Merge overlapping loops']], default: 'EvenOdd' },
      { key: 'cornerRadius', label: 'Round corners', type: 'number', unit: 'mm', min: 0, default: 0, hint: 'Rounds every corner of the profile' },
    ],
    describe: (f) => (f.params.plane ? `${f.params.entities?.length || 0} entities on ${planeLabel(f.params.plane)}` : 'choosing a plane'),
    build(ctx, p, f) {
      if (!p.plane) return; // still choosing a plane
      const { CrossSection } = kernel();
      const { loops, openEnds } = findLoops(p.entities || [], segmentsFor);
      let cs = null;
      if (loops.length) {
        cs = track(new CrossSection(loops, p.fill || 'EvenOdd'));
        const r = p.cornerRadius || 0;
        if (r > 0) {
          const seg = segmentsFor(r);
          cs = track(track(track(track(cs.offset(-r, 'Round', 2, seg)).offset(2 * r, 'Round', 2, seg)).offset(-r, 'Round', 2, seg)).simplify(1e-4));
        }
      }
      ctx.state.sketches.set(f.id, { id: f.id, name: f.name, plane: p.plane, entities: p.entities || [], loops, cs, openEnds });
      if (!loops.length && (p.entities || []).some((e) => !e.construction)) ctx.warn(openEnds ? `Profile is open (${openEnds} loose ends)` : 'No closed profile');
    },
  },

  extrude: {
    label: 'Extrude',
    icon: 'extrude',
    params: [
      { key: 'sketch', label: 'Sketch', type: 'sketch', default: null },
      { key: 'regions', label: 'Regions', type: 'text', default: 'all', hint: '"all", or region numbers such as 1, 3' },
      { key: 'direction', label: 'Direction', type: 'select', options: [['normal', 'One side'], ['reverse', 'One side (flipped)'], ['symmetric', 'Symmetric'], ['both', 'Two sides']], default: 'normal' },
      { key: 'depth', label: 'Depth', type: 'number', unit: 'mm', min: 0.001, default: 10, show: (p) => !p.throughAll },
      { key: 'depth2', label: 'Second depth', type: 'number', unit: 'mm', min: 0, default: 5, show: (p) => p.direction === 'both' && !p.throughAll },
      { key: 'throughAll', label: 'Through all', type: 'bool', default: false, show: (p) => p.operation === 'subtract' || p.operation === 'intersect' },
      { key: 'taper', label: 'Top scale', type: 'number', unit: '%', min: 0, default: 100, hint: 'Scales the end profile about its centre (taper)' },
      { key: 'twist', label: 'Twist', type: 'number', unit: '°', default: 0 },
      { key: 'thin', label: 'Thin wall', type: 'number', unit: 'mm', min: 0, default: 0, hint: '0 = solid; otherwise extrude a wall of this thickness' },
      { key: 'edge', label: 'Edges', type: 'select', options: [['none', 'Sharp'], ['fillet', 'Fillet'], ['chamfer', 'Chamfer']], default: 'none' },
      { key: 'edgeSize', label: 'Edge size', type: 'number', unit: 'mm', min: 0.01, default: 1, show: (p) => p.edge !== 'none' },
      ...OPERATION,
    ],
    describe: (f) => `${f.params.throughAll ? 'through all' : `${f.params.depth} mm`}`,
    build(ctx, p, f) {
      const { Manifold, CrossSection } = kernel();
      const sk = sketchCrossSection(ctx, p.sketch);
      let cs = pickRegions(ctx, sk.cs, p.regions);
      if (p.thin > 0) cs = track(cs.subtract(track(cs.offset(-p.thin, 'Miter', 2))));
      if (cs.isEmpty()) throw new Error('Profile is empty');

      let dir = p.direction;
      let d1 = p.depth, d2 = 0;
      if (p.throughAll) { d1 = modelSize(ctx); dir = dir === 'normal' || dir === 'reverse' ? dir : 'symmetric'; }
      if (dir === 'symmetric') { d2 = d1 / 2; d1 = d1 / 2; }
      else if (dir === 'both') d2 = p.depth2 || 0;
      else if (dir === 'reverse') { d2 = d1; d1 = 0; }
      const height = d1 + d2;
      if (!(height > 0)) throw new Error('Depth must be greater than zero');

      // Taper and twist act about the profile centre.
      const bb = cs.bounds();
      const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
      const scaleTop = Math.max(0, (p.taper ?? 100) / 100);
      const scaleVec = [scaleTop, scaleTop]; // a scalar scaleTop is mis-read by the kernel binding
      const centred = scaleTop !== 1 || p.twist;
      let base = centred ? track(cs.translate([-cx, -cy])) : cs;

      let man;
      const r = p.edge !== 'none' ? Math.min(p.edgeSize || 0, height / 2 - 1e-3) : 0;
      if (r > 0) {
        if (scaleTop !== 1 || p.twist) throw new Error('Edge fillets and chamfers need a straight extrude (no taper or twist)');
        man = edgeTreatedExtrude(base, height, r, p.edge);
      } else {
        man = track(base.extrude(height, p.twist ? Math.ceil(Math.abs(p.twist) / 5) : 0, p.twist || 0, scaleVec));
      }
      let local = translation(centred ? cx : 0, centred ? cy : 0, -d2);
      man = track(man.transform(matMul(planeMatrix(sk.plane), local)));
      applyOperation(ctx, f, man);
    },
  },

  revolve: {
    label: 'Revolve',
    icon: 'revolve',
    params: [
      { key: 'sketch', label: 'Sketch', type: 'sketch', default: null },
      { key: 'axis', label: 'Axis', type: 'select', options: [['v', 'Sketch vertical axis'], ['u', 'Sketch horizontal axis'], ['construction', 'First construction line']], default: 'v' },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', min: 0.1, max: 360, default: 360 },
      { key: 'flip', label: 'Flip direction', type: 'bool', default: false, show: (p) => p.angle < 360 },
      ...OPERATION,
    ],
    describe: (f) => `${f.params.angle}°`,
    build(ctx, p, f) {
      const { Manifold } = kernel();
      const sk = sketchCrossSection(ctx, p.sketch);
      // 2D axis as point + direction.
      let ap = [0, 0], ad = [0, 1];
      if (p.axis === 'u') ad = [1, 0];
      else if (p.axis === 'construction') {
        const line = sk.entities.find((e) => e.construction && e.type === 'line');
        if (!line) throw new Error('The sketch has no construction line to use as an axis');
        ap = line.a;
        ad = [line.b[0] - line.a[0], line.b[1] - line.a[1]];
      }
      // 2D transform taking the axis onto +Y through the origin.
      let ang = Math.atan2(ad[1], ad[0]) - Math.PI / 2;
      const rot2 = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
      let T = matMul(rot2(-ang), translation(-ap[0], -ap[1], 0));
      let cs = track(sk.cs.translate([-ap[0], -ap[1]]));
      cs = track(cs.rotate((-ang * 180) / Math.PI));
      if (cs.bounds().max[0] <= 1e-9) {
        // Profile lies on the other side of the axis: spin it round.
        cs = track(cs.rotate(180));
        T = matMul(rot2(Math.PI), T);
      }
      const angle = Math.min(360, p.angle || 360);
      let man = track(Manifold.revolve(cs, segmentsFor(Math.abs(cs.bounds().max[0])), angle));
      // Revolve output: radial x, axis along z. Map back: out x->x, out z->y, out y->-z.
      // Flipping mirrors the result through the sketch plane.
      const outToLocal = [1, 0, 0, 0, 0, 0, p.flip ? 1 : -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
      const M = matMul(planeMatrix(sk.plane), matMul(invertRigid2D(T), outToLocal));
      man = track(man.transform(M));
      applyOperation(ctx, f, man);
    },
  },

  box: {
    label: 'Box', icon: 'box', group: 'primitive',
    params: [
      { key: 'size', label: 'Size (W × D × H)', type: 'vec3', unit: 'mm', default: [20, 20, 20] },
      { key: 'centered', label: 'Centre on position', type: 'bool', default: false },
      ...PLACEMENT, ...OPERATION,
    ],
    describe: (f) => f.params.size.join(' × '),
    build(ctx, p, f) {
      const { Manifold } = kernel();
      if (p.size.some((s) => !(s > 0))) throw new Error('All sizes must be positive');
      applyOperation(ctx, f, placed(track(Manifold.cube(p.size, !!p.centered)), p));
    },
  },

  cylinder: {
    label: 'Cylinder', icon: 'cylinder', group: 'primitive',
    params: [
      { key: 'radius', label: 'Radius', type: 'number', unit: 'mm', min: 0.001, default: 10 },
      { key: 'height', label: 'Height', type: 'number', unit: 'mm', min: 0.001, default: 20 },
      { key: 'centered', label: 'Centre on position', type: 'bool', default: false },
      ...PLACEMENT, ...OPERATION,
    ],
    describe: (f) => `r${f.params.radius} × ${f.params.height}`,
    build(ctx, p, f) {
      const { Manifold } = kernel();
      applyOperation(ctx, f, placed(track(Manifold.cylinder(p.height, p.radius, p.radius, segmentsFor(p.radius), !!p.centered)), p));
    },
  },

  sphere: {
    label: 'Sphere', icon: 'sphere', group: 'primitive',
    params: [{ key: 'radius', label: 'Radius', type: 'number', unit: 'mm', min: 0.001, default: 10 }, ...PLACEMENT, ...OPERATION],
    describe: (f) => `r${f.params.radius}`,
    build(ctx, p, f) {
      const { Manifold } = kernel();
      applyOperation(ctx, f, placed(track(Manifold.sphere(p.radius, segmentsFor(p.radius))), p));
    },
  },

  cone: {
    label: 'Cone', icon: 'cone', group: 'primitive',
    params: [
      { key: 'radius', label: 'Base radius', type: 'number', unit: 'mm', min: 0.001, default: 10 },
      { key: 'topRadius', label: 'Top radius', type: 'number', unit: 'mm', min: 0, default: 0 },
      { key: 'height', label: 'Height', type: 'number', unit: 'mm', min: 0.001, default: 20 },
      ...PLACEMENT, ...OPERATION,
    ],
    describe: (f) => `r${f.params.radius} → r${f.params.topRadius}`,
    build(ctx, p, f) {
      const { Manifold } = kernel();
      applyOperation(ctx, f, placed(track(Manifold.cylinder(p.height, p.radius, p.topRadius, segmentsFor(Math.max(p.radius, p.topRadius)))), p));
    },
  },

  torus: {
    label: 'Torus', icon: 'torus', group: 'primitive',
    params: [
      { key: 'major', label: 'Ring radius', type: 'number', unit: 'mm', min: 0.001, default: 20 },
      { key: 'minor', label: 'Tube radius', type: 'number', unit: 'mm', min: 0.001, default: 5 },
      ...PLACEMENT, ...OPERATION,
    ],
    describe: (f) => `R${f.params.major} r${f.params.minor}`,
    build(ctx, p, f) {
      const { Manifold, CrossSection } = kernel();
      if (p.minor >= p.major) throw new Error('Tube radius must be smaller than the ring radius');
      const circle = track(track(CrossSection.circle(p.minor, segmentsFor(p.minor))).translate([p.major, 0]));
      applyOperation(ctx, f, placed(track(Manifold.revolve(circle, segmentsFor(p.major + p.minor))), p));
    },
  },

  tube: {
    label: 'Tube', icon: 'tube', group: 'primitive',
    params: [
      { key: 'radius', label: 'Outer radius', type: 'number', unit: 'mm', min: 0.001, default: 10 },
      { key: 'inner', label: 'Inner radius', type: 'number', unit: 'mm', min: 0, default: 7 },
      { key: 'height', label: 'Height', type: 'number', unit: 'mm', min: 0.001, default: 20 },
      ...PLACEMENT, ...OPERATION,
    ],
    describe: (f) => `⌀${f.params.radius * 2} / ⌀${f.params.inner * 2}`,
    build(ctx, p, f) {
      const { CrossSection } = kernel();
      if (p.inner >= p.radius) throw new Error('Inner radius must be smaller than the outer radius');
      const ring = track(track(CrossSection.circle(p.radius, segmentsFor(p.radius))).subtract(track(CrossSection.circle(p.inner, segmentsFor(p.inner)))));
      applyOperation(ctx, f, placed(track(ring.extrude(p.height)), p));
    },
  },

  wedge: {
    label: 'Wedge', icon: 'wedge', group: 'primitive',
    params: [{ key: 'size', label: 'Size (W × D × H)', type: 'vec3', unit: 'mm', default: [20, 20, 10] }, ...PLACEMENT, ...OPERATION],
    describe: (f) => f.params.size.join(' × '),
    build(ctx, p, f) {
      const { CrossSection } = kernel();
      const [w, d, h] = p.size;
      const tri = track(new CrossSection([[[0, 0], [w, 0], [0, h]]]));
      // Extrude the triangle along Y.
      const man = track(track(tri.extrude(d)).transform([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, d, 0, 1]));
      applyOperation(ctx, f, placed(man, p));
    },
  },

  hole: {
    label: 'Hole',
    icon: 'hole',
    params: [
      { key: 'pick', label: 'Placement', type: 'pickFace', hint: 'Click a face to place the hole' },
      { key: 'position', label: 'Position', type: 'vec3', unit: 'mm', default: [0, 0, 0] },
      { key: 'normal', label: 'Face normal', type: 'vec3', default: [0, 0, 1] },
      { key: 'style', label: 'Style', type: 'select', options: [['simple', 'Simple'], ['counterbore', 'Counterbore'], ['countersink', 'Countersink']], default: 'simple' },
      { key: 'diameter', label: 'Diameter', type: 'number', unit: 'mm', min: 0.01, default: 5 },
      { key: 'depth', label: 'Depth', type: 'number', unit: 'mm', min: 0.01, default: 10, show: (p) => !p.throughAll },
      { key: 'throughAll', label: 'Through all', type: 'bool', default: false },
      { key: 'cbDiameter', label: 'Counterbore ⌀', type: 'number', unit: 'mm', min: 0.01, default: 9, show: (p) => p.style === 'counterbore' },
      { key: 'cbDepth', label: 'Counterbore depth', type: 'number', unit: 'mm', min: 0.01, default: 3, show: (p) => p.style === 'counterbore' },
      { key: 'csDiameter', label: 'Countersink ⌀', type: 'number', unit: 'mm', min: 0.01, default: 10, show: (p) => p.style === 'countersink' },
      { key: 'csAngle', label: 'Countersink angle', type: 'number', unit: '°', min: 1, max: 179, default: 90, show: (p) => p.style === 'countersink' },
      { key: 'targets', label: 'Parts', type: 'bodies', default: [], hint: 'Leave empty to drill every part' },
    ],
    describe: (f) => `⌀${f.params.diameter} ${f.params.style}`,
    build(ctx, p, f) {
      const { Manifold } = kernel();
      const r = p.diameter / 2;
      const depth = p.throughAll ? modelSize(ctx) : p.depth;
      const eps = Math.max(0.05, r * 0.05);
      const parts = [track(track(Manifold.cylinder(depth + eps, r, r, segmentsFor(r))).translate([0, 0, -depth]))];
      if (p.style === 'counterbore') {
        const R = p.cbDiameter / 2;
        parts.push(track(track(Manifold.cylinder(p.cbDepth + eps, R, R, segmentsFor(R))).translate([0, 0, -p.cbDepth])));
      } else if (p.style === 'countersink') {
        const R = p.csDiameter / 2;
        const h = (R - r) / Math.tan(((p.csAngle || 90) * Math.PI) / 360);
        if (h > 0) {
          parts.push(track(track(Manifold.cylinder(h, r, R, segmentsFor(R))).translate([0, 0, -h])));
          parts.push(track(Manifold.cylinder(eps, R, R, segmentsFor(R))));
        }
      }
      const tool = track(track(Manifold.union(parts)).transform(frameAlong(p.position, p.normal)));
      applyOperation(ctx, { ...f, params: { ...p, operation: 'subtract' } }, tool);
    },
  },

  boolean: {
    label: 'Boolean',
    icon: 'boolean',
    params: [
      { key: 'op', label: 'Operation', type: 'select', options: [['union', 'Union'], ['subtract', 'Subtract'], ['intersect', 'Intersect']], default: 'union' },
      { key: 'target', label: 'Target part', type: 'body', default: null },
      { key: 'tools', label: 'Tool parts', type: 'bodies', default: [] },
      { key: 'keepTools', label: 'Keep tool parts', type: 'bool', default: false },
    ],
    describe: (f) => f.params.op,
    build(ctx, p) {
      const { Manifold } = kernel();
      const target = getBody(ctx, p.target);
      const tools = getBodies(ctx, p.tools).filter((b) => b.id !== target.id);
      if (!tools.length) throw new Error('Select tool parts different from the target');
      const toolMan = tools.length === 1 ? tools[0].manifold : track(Manifold.union(tools.map((b) => b.manifold)));
      const fn = { union: 'add', subtract: 'subtract', intersect: 'intersect' }[p.op];
      const res = checkManifold(track(target.manifold[fn](toolMan)));
      if (res.isEmpty()) throw new Error('The result is empty');
      replaceBody(ctx, target, res);
      if (!p.keepTools) tools.forEach((b) => ctx.state.bodies.delete(b.id));
    },
  },

  transform: {
    label: 'Move / Rotate',
    icon: 'move',
    params: [
      { key: 'bodies', label: 'Parts', type: 'bodies', default: [] },
      { key: 'translate', label: 'Translate', type: 'vec3', unit: 'mm', default: [0, 0, 0] },
      { key: 'rotate', label: 'Rotate', type: 'vec3', unit: '°', default: [0, 0, 0] },
      { key: 'scale', label: 'Scale', type: 'number', min: 0.0001, default: 1 },
      { key: 'pivot', label: 'Pivot', type: 'select', options: [['center', 'Centre of selection'], ['origin', 'World origin']], default: 'center' },
      { key: 'copy', label: 'Make a copy', type: 'bool', default: false },
    ],
    describe: (f) => (f.params.copy ? 'copy' : ''),
    build(ctx, p, f) {
      const bodies = getBodies(ctx, p.bodies);
      const M = transformMatrix(p, bodies);
      bodies.forEach((b, i) => {
        const man = track(b.manifold.transform(M));
        if (p.copy) newBody(ctx, man, f.id, `${b.name} copy`, `.${i}`);
        else replaceBody(ctx, b, man);
      });
    },
  },

  mirror: {
    label: 'Mirror',
    icon: 'mirror',
    params: [
      { key: 'bodies', label: 'Parts', type: 'bodies', default: [] },
      { key: 'plane', label: 'Mirror plane', type: 'select', options: PLANES, default: 'YZ' },
      { key: 'offset', label: 'Plane offset', type: 'number', unit: 'mm', default: 0 },
      { key: 'merge', label: 'Merge with original', type: 'bool', default: true },
    ],
    describe: (f) => f.params.plane,
    build(ctx, p, f) {
      const { Manifold } = kernel();
      const n = PLANE_NORMAL[p.plane];
      getBodies(ctx, p.bodies).forEach((b, i) => {
        const off = n.map((x) => x * (p.offset || 0));
        const m = track(track(track(b.manifold.translate(off.map((x) => -x))).mirror(n)).translate(off));
        if (p.merge) replaceBody(ctx, b, track(Manifold.union(b.manifold, m)));
        else newBody(ctx, m, f.id, `${b.name} mirror`, `.${i}`);
      });
    },
  },

  linearPattern: {
    label: 'Linear pattern',
    icon: 'linear',
    params: [
      { key: 'bodies', label: 'Parts', type: 'bodies', default: [] },
      { key: 'axis', label: 'Direction', type: 'select', options: AXES, default: 'X' },
      { key: 'count', label: 'Count', type: 'int', min: 1, default: 3 },
      { key: 'spacing', label: 'Spacing', type: 'number', unit: 'mm', default: 25 },
      { key: 'axis2', label: 'Second direction', type: 'select', options: [['none', 'None'], ...AXES], default: 'none' },
      { key: 'count2', label: 'Second count', type: 'int', min: 1, default: 2, show: (p) => p.axis2 !== 'none' },
      { key: 'spacing2', label: 'Second spacing', type: 'number', unit: 'mm', default: 25, show: (p) => p.axis2 !== 'none' },
      { key: 'merge', label: 'Merge instances', type: 'bool', default: true },
    ],
    describe: (f) => `${f.params.count}${f.params.axis2 !== 'none' ? ` × ${f.params.count2}` : ''}`,
    build(ctx, p, f) {
      const offsets = [];
      const d1 = AXIS_VEC[p.axis], d2 = AXIS_VEC[p.axis2] || [0, 0, 0];
      const n2 = p.axis2 !== 'none' ? p.count2 : 1;
      for (let j = 0; j < n2; j++) for (let i = 0; i < p.count; i++) {
        if (!i && !j) continue;
        offsets.push(d1.map((x, k) => x * p.spacing * i + d2[k] * (p.spacing2 || 0) * j));
      }
      patternBodies(ctx, p, f, offsets.map((o) => translation(...o)));
    },
  },

  circularPattern: {
    label: 'Circular pattern',
    icon: 'circular',
    params: [
      { key: 'bodies', label: 'Parts', type: 'bodies', default: [] },
      { key: 'axis', label: 'Axis', type: 'select', options: AXES, default: 'Z' },
      { key: 'center', label: 'Axis through', type: 'vec3', unit: 'mm', default: [0, 0, 0] },
      { key: 'count', label: 'Count', type: 'int', min: 1, default: 6 },
      { key: 'angle', label: 'Total angle', type: 'number', unit: '°', default: 360 },
      { key: 'merge', label: 'Merge instances', type: 'bool', default: true },
    ],
    describe: (f) => `${f.params.count} × ${f.params.angle}°`,
    build(ctx, p, f) {
      const full = Math.abs(Math.abs(p.angle) - 360) < 1e-9;
      const step = p.count > 1 ? p.angle / (full ? p.count : p.count - 1) : 0;
      const mats = [];
      for (let i = 1; i < p.count; i++) {
        const a = ((step * i) * Math.PI) / 180;
        mats.push(matMul(translation(...p.center), matMul(axisRotation(p.axis, a), translation(...p.center.map((x) => -x)))));
      }
      patternBodies(ctx, p, f, mats);
    },
  },

  split: {
    label: 'Split',
    icon: 'split',
    params: [
      { key: 'bodies', label: 'Parts', type: 'bodies', default: [] },
      { key: 'plane', label: 'Split plane', type: 'select', options: PLANES, default: 'XY' },
      { key: 'offset', label: 'Plane offset', type: 'number', unit: 'mm', default: 0 },
      { key: 'keep', label: 'Keep', type: 'select', options: [['both', 'Both sides (two parts)'], ['above', 'Positive side'], ['below', 'Negative side']], default: 'both' },
    ],
    describe: (f) => `${f.params.plane} @ ${f.params.offset}`,
    build(ctx, p, f) {
      const n = PLANE_NORMAL[p.plane];
      getBodies(ctx, p.bodies).forEach((b, i) => {
        const [pos, neg] = track(b.manifold.splitByPlane(n, p.offset || 0));
        ctx.state.bodies.delete(b.id);
        if (p.keep !== 'below' && !pos.isEmpty()) ctx.state.bodies.set(b.id, { ...b, manifold: pos });
        if (p.keep !== 'above' && !neg.isEmpty()) {
          if (p.keep === 'below') ctx.state.bodies.set(b.id, { ...b, manifold: neg });
          else newBody(ctx, neg, f.id, `${b.name} (split)`, `.${i}`);
        }
      });
    },
  },

  hull: {
    label: 'Convex hull',
    icon: 'hull',
    params: [
      { key: 'bodies', label: 'Parts', type: 'bodies', default: [] },
      { key: 'keep', label: 'Keep originals', type: 'bool', default: false },
    ],
    build(ctx, p, f) {
      const { Manifold } = kernel();
      const bodies = getBodies(ctx, p.bodies);
      const hull = track(Manifold.hull(bodies.map((b) => b.manifold)));
      if (!p.keep) bodies.forEach((b) => ctx.state.bodies.delete(b.id));
      newBody(ctx, hull, f.id, p.keep ? undefined : bodies[0].name);
    },
  },

  smooth: {
    label: 'Smooth',
    icon: 'smooth',
    params: [
      { key: 'bodies', label: 'Parts', type: 'bodies', default: [] },
      { key: 'sharpAngle', label: 'Keep edges sharper than', type: 'number', unit: '°', min: 0, max: 180, default: 60 },
      { key: 'refine', label: 'Subdivisions', type: 'int', min: 1, max: 6, default: 3 },
    ],
    describe: (f) => `×${f.params.refine}`,
    build(ctx, p) {
      getBodies(ctx, p.bodies).forEach((b) => {
        if (b.manifold.numTri() * p.refine * p.refine > 3e6) throw new Error('Too many triangles; lower the subdivisions');
        replaceBody(ctx, b, track(track(b.manifold.smoothOut(p.sharpAngle, 0)).refine(p.refine)));
      });
    },
  },

  simplify: {
    label: 'Simplify mesh',
    icon: 'simplify',
    params: [
      { key: 'bodies', label: 'Parts', type: 'bodies', default: [] },
      { key: 'tolerance', label: 'Tolerance', type: 'number', unit: 'mm', min: 0, default: 0.05 },
    ],
    describe: (f) => `${f.params.tolerance} mm`,
    build(ctx, p) {
      getBodies(ctx, p.bodies).forEach((b) => replaceBody(ctx, b, track(b.manifold.simplify(p.tolerance))));
    },
  },

  import: {
    label: 'Import mesh',
    icon: 'import',
    params: [
      { key: 'name', label: 'Part name', type: 'text', default: 'Imported part' },
      { key: 'units', label: 'File units', type: 'select', options: [['1', 'Millimetres'], ['10', 'Centimetres'], ['1000', 'Metres'], ['25.4', 'Inches']], default: '1' },
      { key: 'scale', label: 'Extra scale', type: 'number', min: 0.000001, default: 1 },
      { key: 'placeOnGrid', label: 'Centre on grid', type: 'bool', default: true, hint: 'Centres the model and drops it onto the XY plane' },
      ...PLACEMENT,
    ],
    describe: (f) => f.params.fileName || '',
    build(ctx, p, f) {
      const blob = ctx.blobs.get(p.blob);
      if (!blob) throw new Error('Imported mesh data is missing');
      let man = ctx.cached(`mesh:${p.blob}`, () => manifoldFromMesh(blob.positions, blob.indices));
      const s = (parseFloat(p.units) || 1) * (p.scale || 1);
      if (s !== 1) man = track(man.scale(s));
      if (p.placeOnGrid) {
        const bb = man.boundingBox();
        man = track(man.translate([-(bb.min[0] + bb.max[0]) / 2, -(bb.min[1] + bb.max[1]) / 2, -bb.min[2]]));
      }
      newBody(ctx, placed(man, p), f.id, p.name);
    },
  },

  deleteBody: {
    label: 'Delete parts',
    icon: 'trash',
    params: [{ key: 'bodies', label: 'Parts', type: 'bodies', default: [] }],
    build(ctx, p) {
      getBodies(ctx, p.bodies).forEach((b) => ctx.state.bodies.delete(b.id));
    },
  },
};

/**
 * Extrude a cross-section with rounded (fillet) or bevelled (chamfer) top and
 * bottom edges. Every contour is inset along its vertex bisectors to build
 * matching rings, which are lofted together and capped.
 */
function edgeTreatedExtrude(cs, height, r, kind) {
  const { triangulate } = kernel();
  const loops = cs.toPolygons();
  // Height/inset pairs from the bottom cap up to the top cap.
  const steps = kind === 'fillet' ? Math.max(3, Math.ceil(segmentsFor(r) / 4)) : 1;
  const band = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * (Math.PI / 2);
    band.push(kind === 'fillet' ? [r * (1 - Math.cos(t)), r * (1 - Math.sin(t))] : [r * (i / steps), r * (1 - i / steps)]);
  }
  const rings = [...band, ...band.slice().reverse().map(([z, d]) => [height - z, d])];
  if (height - 2 * r < 1e-6) rings.splice(band.length, 1);

  // Unit outward (away from material) offset direction per vertex, miter-scaled.
  const dirs = loops.map((loop) => loop.map((p, i) => {
    const a = loop[(i + loop.length - 1) % loop.length], b = loop[(i + 1) % loop.length];
    const n1 = norm2([p[1] - a[1], a[0] - p[0]]), n2 = norm2([b[1] - p[1], p[0] - b[0]]);
    const m = norm2([n1[0] + n2[0], n1[1] + n2[1]]);
    const scale = Math.min(4, 1 / Math.max(0.25, m[0] * n1[0] + m[1] * n1[1]));
    return [m[0] * scale, m[1] * scale];
  }));
  const positions = [];
  const loopBase = []; // [ring][loop] -> first vertex index
  rings.forEach(([z, d]) => {
    const bases = [];
    loops.forEach((loop, li) => {
      bases.push(positions.length / 3);
      loop.forEach((p, i) => positions.push(p[0] - dirs[li][i][0] * d, p[1] - dirs[li][i][1] * d, z));
    });
    loopBase.push(bases);
  });
  const tris = [];
  for (let j = 0; j + 1 < rings.length; j++) {
    loops.forEach((loop, li) => {
      const n = loop.length, b0 = loopBase[j][li], b1 = loopBase[j + 1][li];
      for (let i = 0; i < n; i++) {
        const i2 = (i + 1) % n;
        tris.push(b0 + i, b0 + i2, b1 + i2, b0 + i, b1 + i2, b1 + i);
      }
    });
  }
  const flatBase = [];
  let acc = 0;
  for (const loop of loops) { flatBase.push(acc); acc += loop.length; }
  const toVertex = (ring, flat) => {
    let li = flatBase.length - 1;
    while (flatBase[li] > flat) li--;
    return loopBase[ring][li] + flat - flatBase[li];
  };
  const capPolys = (ring) => loops.map((loop, li) => loop.map((_, i) => [positions[(loopBase[ring][li] + i) * 3], positions[(loopBase[ring][li] + i) * 3 + 1]]));
  for (const t of triangulate(capPolys(0))) tris.push(toVertex(0, t[0]), toVertex(0, t[2]), toVertex(0, t[1]));
  const top = rings.length - 1;
  for (const t of triangulate(capPolys(top))) tris.push(toVertex(top, t[0]), toVertex(top, t[1]), toVertex(top, t[2]));
  try {
    return manifoldFromMesh(new Float32Array(positions), new Uint32Array(tris));
  } catch {
    throw new Error('Edge size is too large for this profile');
  }
}

function norm2(v) {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

function patternBodies(ctx, p, f, matrices) {
  const { Manifold } = kernel();
  getBodies(ctx, p.bodies).forEach((b, i) => {
    const copies = matrices.map((m) => track(b.manifold.transform(m)));
    if (p.merge) replaceBody(ctx, b, track(Manifold.union([b.manifold, ...copies])));
    else copies.forEach((c, j) => newBody(ctx, c, f.id, `${b.name} (${j + 2})`, `.${i}.${j}`));
  });
}

function axisRotation(axis, a) {
  const c = Math.cos(a), s = Math.sin(a);
  if (axis === 'X') return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  if (axis === 'Y') return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Matrix for a transform feature: scale and rotate about the pivot, then translate. */
export function transformMatrix(p, bodies) {
  let pivot = [0, 0, 0];
  if (p.pivot !== 'origin' && bodies.length) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const b of bodies) {
      const bb = b.manifold.boundingBox();
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], bb.min[k]); max[k] = Math.max(max[k], bb.max[k]); }
    }
    pivot = min.map((x, k) => (x + max[k]) / 2);
  }
  const [rx, ry, rz] = (p.rotate || [0, 0, 0]).map((d) => (d * Math.PI) / 180);
  const s = p.scale || 1;
  const S = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
  // Rotation order X, then Y, then Z (matches Manifold.rotate).
  const R = matMul(axisRotation('Z', rz), matMul(axisRotation('Y', ry), axisRotation('X', rx)));
  const t = p.translate || [0, 0, 0];
  return matMul(translation(pivot[0] + t[0], pivot[1] + t[1], pivot[2] + t[2]), matMul(R, matMul(S, translation(-pivot[0], -pivot[1], -pivot[2]))));
}

function invertRigid2D(m) {
  // m is a rotation about Z plus translation; invert as R^T and -R^T t.
  const r = [m[0], m[1], m[4], m[5]];
  const tx = m[12], ty = m[13];
  const ix = -(r[0] * tx + r[1] * ty), iy = -(r[2] * tx + r[3] * ty);
  return [r[0], r[2], 0, 0, r[1], r[3], 0, 0, 0, 0, 1, 0, ix, iy, 0, 1];
}

export function defaultParams(type) {
  const params = {};
  for (const p of FEATURES[type].params) if ('default' in p) params[p.key] = structuredClone(p.default);
  return params;
}

export { sketchBounds };
