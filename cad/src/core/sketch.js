// 2D sketch geometry: entities, tessellation, loop detection and sketch planes.
// Pure math, no kernel or rendering dependencies.

export const ENTITY_LABELS = {
  line: 'Line', arc: 'Arc', circle: 'Circle', rect: 'Rectangle', polygon: 'Polygon', slot: 'Slot', point: 'Point',
};

// --- sketch planes -----------------------------------------------------------

const NAMED_PLANES = {
  XY: { normal: [0, 0, 1], xDir: [1, 0, 0], label: 'Top' },
  XZ: { normal: [0, -1, 0], xDir: [1, 0, 0], label: 'Front' },
  YZ: { normal: [1, 0, 0], xDir: [0, 1, 0], label: 'Right' },
};

export function planeLabel(plane) {
  if (NAMED_PLANES[plane.type]) {
    const off = plane.offset ? ` ${plane.offset > 0 ? '+' : '−'}${Math.abs(plane.offset)}` : '';
    return `${NAMED_PLANES[plane.type].label}${off}`;
  }
  return 'Face';
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => { const l = Math.hypot(...a) || 1; return scale(a, 1 / l); };

/** Orthonormal frame { o, u, v, n } of a sketch plane. */
export function planeFrame(plane) {
  let o, n, u;
  if (NAMED_PLANES[plane.type]) {
    n = NAMED_PLANES[plane.type].normal;
    u = NAMED_PLANES[plane.type].xDir;
    o = scale(n, plane.offset || 0);
  } else {
    n = norm(plane.normal);
    u = norm(sub(plane.xDir, scale(n, dot(plane.xDir, n))));
    const off = scale(n, plane.offset || 0);
    o = [plane.origin[0] + off[0], plane.origin[1] + off[1], plane.origin[2] + off[2]];
  }
  if (plane.flip) { n = scale(n, -1); u = scale(u, -1); }
  return { o, u, v: cross(n, u), n };
}

/** Column-major 4x4 matrix mapping sketch-local (x, y, z) to world. */
export function planeMatrix(plane) {
  const { o, u, v, n } = planeFrame(plane);
  return [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, o[0], o[1], o[2], 1];
}

/** Plane through a face hit: world point + world normal. */
export function planeFromFace(point, normal) {
  const n = norm(normal);
  const up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  let u = norm(cross(up, n));
  if (Math.abs(n[2]) >= 0.9) u = n[2] > 0 ? [1, 0, 0] : [-1, 0, 0];
  // Origin: the world origin projected onto the face plane, so sketch
  // coordinates line up with the global grid.
  const d = dot(point, n);
  return { type: 'custom', origin: scale(n, d), normal: n, xDir: u, offset: 0 };
}

export function toWorld(plane, x, y) {
  const { o, u, v } = planeFrame(plane);
  return [o[0] + u[0] * x + v[0] * y, o[1] + u[1] * x + v[1] * y, o[2] + u[2] * x + v[2] * y];
}

export function toLocal(plane, p) {
  const { o, u, v } = planeFrame(plane);
  const d = sub(p, o);
  return [dot(d, u), dot(d, v)];
}

// --- tessellation ------------------------------------------------------------

function arcPoints(c, r, a0, a1, segments) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(2, Math.ceil((segments * sweep) / (Math.PI * 2)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return pts;
}

export function arcEndpoints(e) {
  return [
    [e.c[0] + e.r * Math.cos(e.a0), e.c[1] + e.r * Math.sin(e.a0)],
    [e.c[0] + e.r * Math.cos(e.a1), e.c[1] + e.r * Math.sin(e.a1)],
  ];
}

/** Arc through three points (start, any point on the arc, end). */
export function arcFrom3Points(p0, pm, p1) {
  const ax = p0[0], ay = p0[1], bx = pm[0], by = pm[1], cx = p1[0], cy = p1[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const ang = (p) => Math.atan2(p[1] - uy, p[0] - ux);
  let a0 = ang(p0), am = ang(pm), a1 = ang(p1);
  const ccwSpan = (from, to) => { let s = to - from; while (s < 0) s += Math.PI * 2; return s; };
  // Arcs are stored counter-clockwise; swap ends when the arc runs clockwise.
  if (ccwSpan(a0, am) > ccwSpan(a0, a1)) [a0, a1] = [a1, a0];
  return { c: [ux, uy], r, a0, a1 };
}

/** Points along an entity. Closed entities return a loop without repeating the first point. */
export function entityPoints(e, segments = 64) {
  if (typeof segments === 'function') segments = segments(e.r || 1);
  switch (e.type) {
    case 'line': return { closed: false, pts: [e.a, e.b] };
    case 'arc': return { closed: false, pts: arcPoints(e.c, e.r, e.a0, e.a1, segments) };
    case 'circle': {
      const pts = arcPoints(e.c, e.r, 0, Math.PI * 2, segments);
      pts.pop();
      return { closed: true, pts };
    }
    case 'rect': {
      const [x0, y0] = e.a, [x1, y1] = e.b;
      return { closed: true, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
    }
    case 'polygon': {
      const pts = [];
      for (let i = 0; i < e.n; i++) {
        const a = (e.rot || 0) + (i * Math.PI * 2) / e.n;
        pts.push([e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)]);
      }
      return { closed: true, pts };
    }
    case 'slot': {
      const ang = Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]);
      const half = Math.max(8, segments / 2);
      const pts = [
        ...arcPoints(e.b, e.r, ang - Math.PI / 2, ang + Math.PI / 2, half * 2),
        ...arcPoints(e.a, e.r, ang + Math.PI / 2, ang + Math.PI * 1.5, half * 2),
      ];
      return { closed: true, pts };
    }
    default: return { closed: false, pts: [] };
  }
}

/** Points the user can snap to: endpoints, centres and midpoints. */
export function snapPoints(e) {
  switch (e.type) {
    case 'line': return [{ p: e.a, kind: 'end' }, { p: e.b, kind: 'end' }, { p: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], kind: 'mid' }];
    case 'arc': { const [s, t] = arcEndpoints(e); return [{ p: s, kind: 'end' }, { p: t, kind: 'end' }, { p: e.c, kind: 'center' }]; }
    case 'circle': case 'polygon': return [{ p: e.c, kind: 'center' }, ...entityPoints(e, 4).pts.slice(0, e.type === 'polygon' ? e.n : 4).map((p) => ({ p, kind: 'end' }))];
    case 'rect': return [...entityPoints(e).pts.map((p) => ({ p, kind: 'end' })), { p: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], kind: 'center' }];
    case 'slot': return [{ p: e.a, kind: 'center' }, { p: e.b, kind: 'center' }];
    case 'point': return [{ p: e.p, kind: 'end' }];
    default: return [];
  }
}

// --- loop detection ------------------------------------------------------------

const keyOf = (p) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;

export function signedArea(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Find the closed loops of a sketch. Closed entities are loops on their own;
 * lines and arcs are chained end to end. Returns { loops, openEnds } where
 * openEnds counts dangling endpoints (a hint that a profile isn't closed).
 */
export function findLoops(entities, segments = 64) {
  const loops = [];
  const chains = [];
  for (const e of entities) {
    if (e.construction) continue;
    const { closed, pts } = entityPoints(e, segments);
    if (closed) loops.push(pts);
    else if (pts.length >= 2) chains.push(pts);
  }

  const byEnd = new Map();
  chains.forEach((c, i) => {
    for (const end of [c[0], c[c.length - 1]]) {
      const k = keyOf(end);
      if (!byEnd.has(k)) byEnd.set(k, []);
      byEnd.get(k).push(i);
    }
  });

  const used = new Uint8Array(chains.length);
  let openEnds = 0;
  for (const list of byEnd.values()) if (list.length === 1) openEnds++;

  for (let s = 0; s < chains.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const path = chains[s].slice();
    const startKey = keyOf(path[0]);
    let closed = false;
    for (let guard = 0; guard < chains.length; guard++) {
      const endKey = keyOf(path[path.length - 1]);
      if (endKey === startKey && path.length > 2) { closed = true; break; }
      const nextIdx = (byEnd.get(endKey) || []).find((i) => !used[i]);
      if (nextIdx === undefined) break;
      used[nextIdx] = 1;
      let c = chains[nextIdx];
      if (keyOf(c[0]) !== endKey) c = c.slice().reverse();
      path.push(...c.slice(1));
    }
    if (closed || keyOf(path[0]) === keyOf(path[path.length - 1])) {
      path.pop();
      if (path.length >= 3) loops.push(path);
    }
  }
  return { loops: loops.filter((l) => Math.abs(signedArea(l)) > 1e-9), openEnds };
}

/** Axis-aligned bounds of a sketch's entities in sketch coordinates. */
export function sketchBounds(entities) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of entities) {
    for (const p of entityPoints(e, 16).pts) {
      minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
    }
  }
  return { minX, minY, maxX, maxY };
}
