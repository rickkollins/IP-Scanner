/* Triangle meshes: primitives, STL/OBJ import & export, transforms, repair, simplify.
   A mesh is a Float32Array with 9 floats per triangle (x,y,z × 3), z up. */
(function () {
  'use strict';
  const App = window.App;
  const M = (App.mesh = {});

  function fromTris(list) { return new Float32Array(list); }

  M.box = function (w = 20, d = 20, hgt = 20) {
    const x = w / 2, y = d / 2, z = hgt / 2;
    const v = [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const out = [];
    f.forEach((t) => t.forEach((i) => out.push(...v[i])));
    return fromTris(out);
  };

  // generic lathe: profile = [[r,z],...] from bottom to top, revolved around Z
  function lathe(profile, seg) {
    const out = [];
    for (let i = 0; i < profile.length - 1; i++) {
      const [r0, z0] = profile[i], [r1, z1] = profile[i + 1];
      for (let s = 0; s < seg; s++) {
        const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
        const p00 = [r0 * Math.cos(a0), r0 * Math.sin(a0), z0], p01 = [r0 * Math.cos(a1), r0 * Math.sin(a1), z0];
        const p10 = [r1 * Math.cos(a0), r1 * Math.sin(a0), z1], p11 = [r1 * Math.cos(a1), r1 * Math.sin(a1), z1];
        if (r0 > 1e-9) out.push(...p00, ...p01, ...p11);
        if (r1 > 1e-9) out.push(...p00, ...p11, ...p10);
      }
    }
    return out;
  }
  M.cylinder = (r = 10, hgt = 20, seg = 48) => fromTris(lathe([[0, -hgt / 2], [r, -hgt / 2], [r, hgt / 2], [0, hgt / 2]], seg));
  M.cone = (r = 10, hgt = 20, seg = 48) => fromTris(lathe([[0, -hgt / 2], [r, -hgt / 2], [0, hgt / 2]], seg));
  M.sphere = function (r = 10, seg = 32, rings = 18) {
    const prof = [];
    for (let i = 0; i <= rings; i++) { const a = -Math.PI / 2 + (i / rings) * Math.PI; prof.push([r * Math.cos(a), r * Math.sin(a)]); }
    prof[0][0] = 0; prof[rings][0] = 0;
    return fromTris(lathe(prof, seg));
  };
  M.torus = function (R = 12, r = 4, seg = 48, sides = 20) {
    const out = [];
    const p = (u, v) => [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)];
    for (let i = 0; i < seg; i++) for (let j = 0; j < sides; j++) {
      const u0 = (i / seg) * 2 * Math.PI, u1 = ((i + 1) / seg) * 2 * Math.PI, v0 = (j / sides) * 2 * Math.PI, v1 = ((j + 1) / sides) * 2 * Math.PI;
      out.push(...p(u0, v0), ...p(u1, v0), ...p(u1, v1), ...p(u0, v0), ...p(u1, v1), ...p(u0, v1));
    }
    return fromTris(out);
  };
  // hollow cylinder (vase with base)
  M.vase = (r = 20, hgt = 60, wall = 1.6) => fromTris(lathe([[0, -hgt / 2], [r, -hgt / 2], [r * 1.15, 0], [r * 0.8, hgt / 2], [r * 0.8 - wall, hgt / 2], [r * 1.15 - wall, 0], [r - wall, -hgt / 2 + wall], [0, -hgt / 2 + wall]], 64));

  M.bounds = function (tris) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) {
      const v = tris[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
    if (!tris.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
    return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
  };
  M.center = function (tris) {
    const b = M.bounds(tris);
    const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const out = new Float32Array(tris.length);
    for (let i = 0; i < tris.length; i += 3) { out[i] = tris[i] - c[0]; out[i + 1] = tris[i + 1] - c[1]; out[i + 2] = tris[i + 2] - c[2]; }
    return out;
  };

  /* ---------- transforms ---------- */
  M.matrix = function (t) {
    // R = Rz * Ry * Rx, then scale applied first: v' = R * (S * v)
    const d = Math.PI / 180;
    const [a, b, c] = [t.rot.x * d, t.rot.y * d, t.rot.z * d];
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
    const R = [
      cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa,
      sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa,
      -sb, cb * sa, cb * ca,
    ];
    const sx = t.scale.x * (t.mirror && t.mirror.x ? -1 : 1), sy = t.scale.y * (t.mirror && t.mirror.y ? -1 : 1), sz = t.scale.z * (t.mirror && t.mirror.z ? -1 : 1);
    return [R[0] * sx, R[1] * sy, R[2] * sz, R[3] * sx, R[4] * sy, R[5] * sz, R[6] * sx, R[7] * sy, R[8] * sz];
  };
  M.transform = function (tris, m, offset = [0, 0, 0]) {
    const out = new Float32Array(tris.length);
    const flip = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]) < 0;
    for (let i = 0; i < tris.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const s = i + (flip && k > 0 ? (3 - k) * 3 : k * 3);
        const x = tris[s], y = tris[s + 1], z = tris[s + 2];
        const o = i + k * 3;
        out[o] = m[0] * x + m[1] * y + m[2] * z + offset[0];
        out[o + 1] = m[3] * x + m[4] * y + m[5] * z + offset[1];
        out[o + 2] = m[6] * x + m[7] * y + m[8] * z + offset[2];
      }
    }
    return out;
  };
  // world mesh, dropped to plate (minZ = 0), centred on pos.x/pos.y
  M.world = function (model) {
    const t = M.transform(model.mesh, M.matrix(model));
    const b = M.bounds(t);
    const off = [model.pos.x - (b.min[0] + b.max[0]) / 2, model.pos.y - (b.min[1] + b.max[1]) / 2, -b.min[2]];
    for (let i = 0; i < t.length; i += 3) { t[i] += off[0]; t[i + 1] += off[1]; t[i + 2] += off[2]; }
    return t;
  };

  /* ---------- import ---------- */
  M.parseSTL = function (buf) {
    const dv = new DataView(buf);
    const isBinary = () => {
      if (buf.byteLength < 84) return false;
      const n = dv.getUint32(80, true);
      if (84 + n * 50 === buf.byteLength) return true;
      const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(256, buf.byteLength)));
      return !/^\s*solid[\s\S]*facet/.test(head);
    };
    if (isBinary()) {
      const n = dv.getUint32(80, true);
      const out = new Float32Array(n * 9);
      let o = 84;
      for (let i = 0; i < n; i++) {
        o += 12;
        for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(o + k * 4, true);
        o += 38;
      }
      return out;
    }
    const txt = new TextDecoder().decode(buf);
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    const out = [];
    let m;
    while ((m = re.exec(txt))) out.push(+m[1], +m[2], +m[3]);
    return new Float32Array(out.slice(0, out.length - (out.length % 9)));
  };
  M.parseOBJ = function (txt) {
    const v = [], out = [];
    for (const line of txt.split(/\r?\n/)) {
      const p = line.trim().split(/\s+/);
      if (p[0] === 'v') v.push([+p[1], +p[2], +p[3]]);
      else if (p[0] === 'f') {
        const idx = p.slice(1).map((s) => { const i = parseInt(s.split('/')[0], 10); return i < 0 ? v.length + i : i - 1; });
        for (let i = 1; i < idx.length - 1; i++) [idx[0], idx[i], idx[i + 1]].forEach((j) => out.push(...(v[j] || [0, 0, 0])));
      }
    }
    // OBJ files are usually Y-up: convert to Z-up
    const t = new Float32Array(out);
    for (let i = 0; i < t.length; i += 3) { const y = t[i + 1]; t[i + 1] = -t[i + 2]; t[i + 2] = y; }
    return t;
  };

  /* ---------- export ---------- */
  function normal(t, i) {
    const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
    const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  }
  M.normal = normal;
  M.toSTLBinary = function (t) {
    const n = t.length / 9;
    const buf = new ArrayBuffer(84 + n * 50);
    const dv = new DataView(buf);
    const head = 'Exported by Maker Studio';
    for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
    dv.setUint32(80, n, true);
    let o = 84;
    for (let i = 0; i < t.length; i += 9) {
      const nn = normal(t, i);
      nn.forEach((v, k) => dv.setFloat32(o + k * 4, v, true));
      for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, t[i + k], true);
      o += 50;
    }
    return buf;
  };
  M.toSTLAscii = function (t, name = 'model') {
    const L = [`solid ${name}`];
    for (let i = 0; i < t.length; i += 9) {
      const n = normal(t, i);
      L.push(` facet normal ${n.map((x) => x.toFixed(6)).join(' ')}`, '  outer loop');
      for (let k = 0; k < 9; k += 3) L.push(`   vertex ${t[i + k].toFixed(5)} ${t[i + k + 1].toFixed(5)} ${t[i + k + 2].toFixed(5)}`);
      L.push('  endloop', ' endfacet');
    }
    L.push(`endsolid ${name}`);
    return L.join('\n');
  };
  M.toOBJ = function (t) {
    const L = ['# Exported by Maker Studio'];
    const map = new Map();
    const idx = [];
    for (let i = 0; i < t.length; i += 3) {
      // write as Y-up
      const key = `${t[i].toFixed(5)} ${t[i + 2].toFixed(5)} ${(-t[i + 1]).toFixed(5)}`;
      if (!map.has(key)) { map.set(key, map.size + 1); L.push('v ' + key); }
      idx.push(map.get(key));
    }
    for (let i = 0; i < idx.length; i += 3) L.push(`f ${idx[i]} ${idx[i + 1]} ${idx[i + 2]}`);
    return L.join('\n');
  };

  /* ---------- analysis / repair / simplify ---------- */
  M.volume = function (t) {
    let v = 0;
    for (let i = 0; i < t.length; i += 9) {
      v += (t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7]) - t[i + 1] * (t[i + 3] * t[i + 8] - t[i + 5] * t[i + 6]) + t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6])) / 6;
    }
    return v;
  };
  M.area = function (t) {
    let a = 0;
    for (let i = 0; i < t.length; i += 9) {
      const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
      const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
      a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    return a;
  };
  // Counts boundary edges (edges used by one triangle) to detect holes.
  M.openEdges = function (t) {
    const q = (i) => `${Math.round(t[i] * 1e4)},${Math.round(t[i + 1] * 1e4)},${Math.round(t[i + 2] * 1e4)}`;
    const edges = new Map();
    for (let i = 0; i < t.length; i += 9) {
      const a = q(i), b = q(i + 3), c = q(i + 6);
      [[a, b], [b, c], [c, a]].forEach(([p, r]) => { const k = p < r ? p + '|' + r : r + '|' + p; edges.set(k, (edges.get(k) || 0) + 1); });
    }
    let open = 0;
    edges.forEach((n) => { if (n === 1) open++; });
    return open;
  };
  M.repair = function (t) {
    const keep = [];
    let degenerate = 0, duplicate = 0;
    const seen = new Set();
    for (let i = 0; i < t.length; i += 9) {
      const n = normal(t, i);
      const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
      const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
      const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      if (area < 1e-9 || !Number.isFinite(n[0])) { degenerate++; continue; }
      const key = [0, 3, 6].map((k) => `${t[i + k].toFixed(4)},${t[i + k + 1].toFixed(4)},${t[i + k + 2].toFixed(4)}`).sort().join('|');
      if (seen.has(key)) { duplicate++; continue; }
      seen.add(key);
      for (let k = 0; k < 9; k++) keep.push(t[i + k]);
    }
    let out = new Float32Array(keep);
    let flipped = false;
    if (M.volume(out) < 0) {
      flipped = true;
      for (let i = 0; i < out.length; i += 9) for (let k = 0; k < 3; k++) { const a = out[i + 3 + k]; out[i + 3 + k] = out[i + 6 + k]; out[i + 6 + k] = a; }
    }
    return { mesh: out, degenerate, duplicate, flipped, openEdges: M.openEdges(out) };
  };
  // Vertex clustering decimation: snaps vertices to a grid and drops collapsed triangles.
  M.simplify = function (t, ratio) {
    const target = Math.max(4, Math.floor((t.length / 9) * ratio));
    const b = M.bounds(t);
    const diag = Math.hypot(...b.size) || 1;
    let lo = diag / 2000, hi = diag / 4, best = t;
    for (let iter = 0; iter < 18; iter++) {
      const cell = (lo + hi) / 2;
      const r = cluster(t, cell);
      if (r.length / 9 > target) lo = cell; else { hi = cell; best = r; }
    }
    return best;
  };
  function cluster(t, cell) {
    const sums = new Map();
    const keys = new Array(t.length / 3);
    for (let i = 0, v = 0; i < t.length; i += 3, v++) {
      const k = `${Math.floor(t[i] / cell)},${Math.floor(t[i + 1] / cell)},${Math.floor(t[i + 2] / cell)}`;
      keys[v] = k;
      const s = sums.get(k) || [0, 0, 0, 0];
      s[0] += t[i]; s[1] += t[i + 1]; s[2] += t[i + 2]; s[3]++;
      sums.set(k, s);
    }
    const out = [];
    for (let v = 0; v < keys.length; v += 3) {
      const a = keys[v], b = keys[v + 1], c = keys[v + 2];
      if (a === b || b === c || a === c) continue;
      [a, b, c].forEach((k) => { const s = sums.get(k); out.push(s[0] / s[3], s[1] / s[3], s[2] / s[3]); });
    }
    return new Float32Array(out);
  }

  // Try 6 axis-aligned orientations, pick the one with the largest contact area at the base.
  M.layFlat = function (model) {
    const cands = [[0, 0], [90, 0], [-90, 0], [180, 0], [0, 90], [0, -90]];
    let best = null;
    for (const [rx, ry] of cands) {
      const t = M.transform(model.mesh, M.matrix({ ...model, rot: { x: rx, y: ry, z: model.rot.z } }));
      const b = M.bounds(t);
      let area = 0;
      for (let i = 0; i < t.length; i += 9) {
        if (t[i + 2] - b.min[2] < 0.05 && t[i + 5] - b.min[2] < 0.05 && t[i + 8] - b.min[2] < 0.05) {
          area += Math.abs((t[i + 3] - t[i]) * (t[i + 7] - t[i + 1]) - (t[i + 6] - t[i]) * (t[i + 4] - t[i + 1])) / 2;
        }
      }
      const score = area - b.size[2] * 1e-3;
      if (!best || score > best.score) best = { score, rx, ry };
    }
    return { x: best.rx, y: best.ry, z: model.rot.z };
  };

  /* ---------- serialisation for projects ---------- */
  M.encode = function (t) {
    const bytes = new Uint8Array(t.buffer, t.byteOffset, t.byteLength);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  M.decode = function (b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  };
})();
