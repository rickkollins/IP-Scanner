/* A compact FDM slicer: planar sections → loops → walls, infill/skin, support, adhesion → G-code.
   It is deliberately simple (approximate wall offsets, line infill) but produces real, printable-looking toolpaths. */
(function () {
  'use strict';
  const App = window.App;

  function sectionSegments(t, z) {
    const segs = [];
    for (let i = 0; i < t.length; i += 9) {
      const z0 = t[i + 2], z1 = t[i + 5], z2 = t[i + 8];
      if ((z0 < z && z1 < z && z2 < z) || (z0 > z && z1 > z && z2 > z)) continue;
      const pts = [];
      const edge = (a, b) => {
        const za = t[a + 2], zb = t[b + 2];
        if ((za < z) === (zb < z)) return;
        const k = (z - za) / (zb - za);
        pts.push(t[a] + (t[b] - t[a]) * k, t[a + 1] + (t[b + 1] - t[a + 1]) * k);
      };
      edge(i, i + 3); edge(i + 3, i + 6); edge(i + 6, i);
      if (pts.length === 4) segs.push(pts);
    }
    return segs;
  }

  function chain(segs) {
    const key = (x, y) => `${Math.round(x * 200)},${Math.round(y * 200)}`;
    const starts = new Map();
    segs.forEach((s, i) => { const k = key(s[0], s[1]); if (!starts.has(k)) starts.set(k, []); starts.get(k).push(i); });
    const used = new Uint8Array(segs.length);
    const loops = [];
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const pts = [segs[i][0], segs[i][1], segs[i][2], segs[i][3]];
      let ex = segs[i][2], ey = segs[i][3];
      for (let guard = 0; guard < segs.length; guard++) {
        const cand = starts.get(key(ex, ey));
        let next = -1;
        if (cand) for (const j of cand) if (!used[j]) { next = j; break; }
        if (next < 0) break;
        used[next] = 1;
        ex = segs[next][2]; ey = segs[next][3];
        pts.push(ex, ey);
      }
      if (pts.length >= 6) loops.push(pts);
    }
    return loops;
  }

  function area(p) {
    let a = 0;
    for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length;
      a += p[i] * p[j + 1] - p[j] * p[i + 1];
    }
    return a / 2;
  }
  function inside(x, y, p) {
    let c = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      if ((p[i + 1] > y) !== (p[j + 1] > y) && x < ((p[j] - p[i]) * (y - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
    }
    return c;
  }
  // offset a closed loop by d (positive = into material)
  function offsetLoop(p, d, orient) {
    const n = p.length / 2;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      let dx1 = p[i * 2] - p[a * 2], dy1 = p[i * 2 + 1] - p[a * 2 + 1];
      let dx2 = p[b * 2] - p[i * 2], dy2 = p[b * 2 + 1] - p[i * 2 + 1];
      const l1 = Math.hypot(dx1, dy1) || 1, l2 = Math.hypot(dx2, dy2) || 1;
      const n1 = [(-dy1 / l1) * orient, (dx1 / l1) * orient], n2 = [(-dy2 / l2) * orient, (dx2 / l2) * orient];
      let mx = n1[0] + n2[0], my = n1[1] + n2[1];
      const ml = Math.hypot(mx, my) || 1;
      mx /= ml; my /= ml;
      const cos = Math.max(0.35, mx * n1[0] + my * n1[1]);
      out.push(p[i * 2] + (mx * d) / cos, p[i * 2 + 1] + (my * d) / cos);
    }
    return Math.abs(area(out)) > 0.5 && Math.sign(area(out)) === Math.sign(area(p)) ? out : null;
  }
  function simplifyLoop(p, tol = 0.05) {
    if (p.length <= 8) return p;
    const out = [p[0], p[1]];
    for (let i = 2; i < p.length - 2; i += 2) {
      const ax = out[out.length - 2], ay = out[out.length - 1], bx = p[i + 2], by = p[i + 3];
      const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
      const dist = Math.abs((p[i] - ax) * dy - (p[i + 1] - ay) * dx) / l;
      if (dist > tol) out.push(p[i], p[i + 1]);
    }
    out.push(p[p.length - 2], p[p.length - 1]);
    return out;
  }
  // even-odd scanline fill of loops, at angle (deg), spacing, with inset at both ends
  function scanFill(loops, angle, spacing, inset) {
    const ca = Math.cos((angle * Math.PI) / 180), sa = Math.sin((angle * Math.PI) / 180);
    const rot = loops.map((p) => { const r = new Array(p.length); for (let i = 0; i < p.length; i += 2) { r[i] = p[i] * ca + p[i + 1] * sa; r[i + 1] = -p[i] * sa + p[i + 1] * ca; } return r; });
    let minY = Infinity, maxY = -Infinity;
    rot.forEach((p) => { for (let i = 1; i < p.length; i += 2) { minY = Math.min(minY, p[i]); maxY = Math.max(maxY, p[i]); } });
    const lines = [];
    let flip = false;
    for (let y = Math.ceil(minY / spacing) * spacing + spacing / 2; y < maxY; y += spacing) {
      const xs = [];
      rot.forEach((p) => {
        for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
          const y1 = p[j + 1], y2 = p[i + 1];
          if ((y1 > y) !== (y2 > y)) xs.push(p[j] + ((y - y1) * (p[i] - p[j])) / (y2 - y1));
        }
      });
      xs.sort((a, b) => a - b);
      const row = [];
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = xs[k] + inset, x1 = xs[k + 1] - inset;
        if (x1 - x0 > 0.3) row.push([x0, x1]);
      }
      if (flip) row.reverse();
      for (const [x0, x1] of row) {
        const [a, b] = flip ? [x1, x0] : [x0, x1];
        lines.push([a * ca - y * sa, a * sa + y * ca, b * ca - y * sa, b * sa + y * ca]);
      }
      flip = !flip;
    }
    return lines;
  }
  function hull(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }

  function overhangPoints(t, angle, spacing, minZ) {
    const lim = -Math.sin((angle * Math.PI) / 180);
    const pts = new Map();
    for (let i = 0; i < t.length; i += 9) {
      const n = App.mesh.normal(t, i);
      if (n[2] > lim) continue;
      const xs = [t[i], t[i + 3], t[i + 6]], ys = [t[i + 1], t[i + 4], t[i + 7]], zs = [t[i + 2], t[i + 5], t[i + 8]];
      const x0 = Math.floor(Math.min(...xs) / spacing), x1 = Math.ceil(Math.max(...xs) / spacing);
      const y0 = Math.floor(Math.min(...ys) / spacing), y1 = Math.ceil(Math.max(...ys) / spacing);
      const det = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2]);
      if (Math.abs(det) < 1e-9) continue;
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const x = gx * spacing, y = gy * spacing;
        const l1 = ((ys[1] - ys[2]) * (x - xs[2]) + (xs[2] - xs[1]) * (y - ys[2])) / det;
        const l2 = ((ys[2] - ys[0]) * (x - xs[2]) + (xs[0] - xs[2]) * (y - ys[2])) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const z = l1 * zs[0] + l2 * zs[1] + l3 * zs[2];
        if (z < minZ) continue;
        const k = gx + ',' + gy;
        const prev = pts.get(k);
        if (!prev || z < prev[2]) pts.set(k, [x, y, z]);
      }
    }
    return Array.from(pts.values());
  }
  // lowest surface above a point – used to cut support columns that would go through the model
  function blockedBelow(t, x, y, zTop) {
    for (let i = 0; i < t.length; i += 9) {
      const n2 = App.mesh.normal(t, i)[2];
      if (n2 <= 0.2) continue; // only upward facing surfaces block
      const xs = [t[i], t[i + 3], t[i + 6]], ys = [t[i + 1], t[i + 4], t[i + 7]];
      if (x < Math.min(...xs) || x > Math.max(...xs) || y < Math.min(...ys) || y > Math.max(...ys)) continue;
      if (Math.max(t[i + 2], t[i + 5], t[i + 8]) < zTop - 0.5) return true;
    }
    return false;
  }

  /**
   * models: [{world, extruder, name}] profile: print profile; materials: [mat0, mat1]
   * returns {layers:[{z, paths:[{type, ext, pts}]}], gcode, stats}
   */
  App.slice = async function (models, profile, materials, machine, onProgress, isCancelled) {
    const P = profile;
    const lw = P.lineWidth;
    const fil = materials[0].diameter || 1.75;
    const filArea = Math.PI * (fil / 2) ** 2;
    let raftZ = 0;
    if (P.adhesion === 'raft') raftZ = P.raftLayers * 0.3;

    const maxZ = Math.max(...models.map((m) => App.mesh.bounds(m.world).max[2]));
    const zs = [];
    for (let z = P.firstLayerHeight; z <= maxZ + 1e-6; z += P.layerHeight) zs.push(z);
    if (!zs.length) throw new Error('Nothing to slice: models are too thin.');

    const layers = [];
    // raft layers
    const allPts = [];
    models.forEach((m) => { const t = m.world; for (let i = 0; i < t.length; i += 3) if (t[i + 2] < P.firstLayerHeight * 2) allPts.push([t[i], t[i + 1]]); });
    const firstHull = hull(allPts.length ? allPts : [[0, 0]]);
    if (raftZ) {
      for (let r = 0; r < P.raftLayers; r++) {
        const loop = [];
        const hb = firstHull;
        const cx = hb.reduce((s, p) => s + p[0], 0) / hb.length, cy = hb.reduce((s, p) => s + p[1], 0) / hb.length;
        hb.forEach((p) => { const dx = p[0] - cx, dy = p[1] - cy, l = Math.hypot(dx, dy) || 1; loop.push(p[0] + (dx / l) * 3, p[1] + (dy / l) * 3); });
        const lines = scanFill([loop], r % 2 ? 0 : 90, r === 0 ? lw * 2.5 : lw * 1.2, 0);
        layers.push({ z: 0.3 * (r + 1), paths: lines.map((l) => ({ type: 'support', ext: 0, pts: l, w: r === 0 ? 1.5 : 1 })) });
      }
    }

    // support columns per model
    const supports = models.map((m) => {
      if (!P.support) return [];
      const spacing = lw * (100 / Math.max(5, P.supportDensity));
      let pts = overhangPoints(m.world, P.supportAngle, Math.max(1.2, spacing), P.firstLayerHeight + P.layerHeight);
      if (P.supportBuildplateOnly) pts = pts.filter((p) => !blockedBelow(m.world, p[0], p[1], p[2]));
      return pts.map((p) => ({ x: p[0], y: p[1], top: p[2] - P.layerHeight * 1.5, s: Math.max(1.2, spacing) }));
    });

    const total = zs.length;
    for (let li = 0; li < total; li++) {
      if (isCancelled && isCancelled()) throw new Error('cancelled');
      const z = zs[li];
      const paths = [];
      models.forEach((m, mi) => {
        const ext = m.extruder || 0;
        const mb = App.mesh.bounds(m.world);
        const loops = chain(sectionSegments(m.world, z)).map((l) => simplifyLoop(l));
        if (loops.length) {
          // classify loops: depth = how many other loops contain it
          const info = loops.map((p, i) => {
            let depth = 0;
            loops.forEach((q, j) => { if (i !== j && inside(p[0], p[1], q)) depth++; });
            const a = area(p);
            return { p, orient: Math.sign(a) * (depth % 2 === 0 ? 1 : -1) };
          });
          // walls
          const inner = [];
          info.forEach(({ p, orient }) => {
            for (let w = 0; w < P.wallCount; w++) {
              const o = offsetLoop(p, lw / 2 + w * lw, orient);
              if (!o) break;
              paths.push({ type: w === 0 ? 'outer' : 'inner', ext, pts: o.concat([o[0], o[1]]) });
            }
            const lastIn = offsetLoop(p, P.wallCount * lw, orient);
            if (lastIn) inner.push(lastIn);
          });
          // infill or skin
          const fromBottom = (z - mb.min[2]) / P.layerHeight, fromTop = (mb.max[2] - z) / P.layerHeight;
          const skin = li === 0 || fromBottom < P.bottomLayers || fromTop < P.topLayers;
          const fillLoops = inner.length ? inner : [];
          if (fillLoops.length) {
            if (skin) {
              scanFill(fillLoops, li % 2 ? 45 : 135, lw, 0).forEach((l) => paths.push({ type: 'skin', ext, pts: l }));
            } else if (P.infillDensity > 0) {
              const spacing = (lw * 100) / P.infillDensity;
              const angles = P.infillPattern === 'grid' ? [45, 135] : [li % 2 ? 45 : 135];
              angles.forEach((a) => scanFill(fillLoops, a, spacing * angles.length, 0).forEach((l) => paths.push({ type: 'infill', ext, pts: l })));
            }
          }
        }
        // support
        const sp = supports[mi];
        if (sp.length) {
          sp.forEach((s) => {
            if (z >= s.top) return;
            if (loops.some((l) => inside(s.x, s.y, l))) return;
            const half = s.s * 0.45;
            paths.push({ type: 'support', ext, pts: li % 2 ? [s.x - half, s.y, s.x + half, s.y] : [s.x, s.y - half, s.x, s.y + half] });
          });
        }
      });
      // adhesion on first layer
      if (li === 0 && (P.adhesion === 'skirt' || P.adhesion === 'brim')) {
        const hb = firstHull;
        const cx = hb.reduce((s, p) => s + p[0], 0) / hb.length, cy = hb.reduce((s, p) => s + p[1], 0) / hb.length;
        const count = P.adhesion === 'skirt' ? P.skirtLines : Math.max(1, Math.round(P.brimWidth / lw));
        const base = P.adhesion === 'skirt' ? 4 : 0;
        for (let k = count; k >= 1; k--) {
          const d = base + k * lw;
          const loop = [];
          hb.forEach((p) => { const dx = p[0] - cx, dy = p[1] - cy, l = Math.hypot(dx, dy) || 1; loop.push(p[0] + (dx / l) * d, p[1] + (dy / l) * d); });
          if (loop.length >= 6) paths.unshift({ type: 'skirt', ext: 0, pts: loop.concat([loop[0], loop[1]]) });
        }
      }
      layers.push({ z: z + raftZ, paths });
      if (li % 4 === 0) { onProgress && onProgress(li / total); await new Promise((r) => setTimeout(r, 0)); }
    }
    onProgress && onProgress(1);
    return buildGcode(layers, P, materials, machine, filArea);
  };

  function buildGcode(layers, P, materials, machine, filArea) {
    const g = [];
    const m0 = materials[0], m1 = materials[1] || materials[0];
    const dual = machine.toolhead === 'dual';
    g.push(';FLAVOR:Marlin', ';Generated by Maker Studio', `;MACHINE:${machine.name}`, `;LAYER_HEIGHT:${P.layerHeight}`, `;LAYER_COUNT:${layers.length}`);
    g.push(`M140 S${m0.bedTemp}`, `M104 S${m0.nozzleTemp}${dual ? ' T0' : ''}`);
    if (dual) g.push(`M104 S${m1.nozzleTemp} T1`);
    g.push(`M190 S${m0.bedTemp}`, `M109 S${m0.nozzleTemp}${dual ? ' T0' : ''}`, 'G28 ;home', 'G90', 'M83 ;relative extrusion', 'G92 E0', 'T0');
    g.push('G1 Z5 F3000', 'G1 X2 Y10 F6000', 'G1 Z0.3 F600', 'G1 Y120 E15 F1200 ;purge', 'G1 X2.6 F1200', 'G1 Y10 E15', 'G1 Z2 F600');
    let x = 0, y = 0, time = 0, filament = [0, 0], tool = 0;
    let travelDist = 0;
    const previewLayers = [];
    layers.forEach((layer, li) => {
      g.push(`;LAYER:${li}`, `G0 Z${layer.z.toFixed(3)} F600`);
      if (li === P.fanFirstLayers) g.push(`M106 S${Math.round((P.fanSpeed / 100) * 255)}`);
      const lh = li === 0 ? P.firstLayerHeight : P.layerHeight;
      // greedy nearest ordering
      const todo = layer.paths.slice();
      const out = [];
      while (todo.length) {
        let best = 0, bd = Infinity, rev = false;
        for (let i = 0; i < todo.length; i++) {
          const p = todo[i].pts;
          const d0 = (p[0] - x) ** 2 + (p[1] - y) ** 2;
          if (d0 < bd) { bd = d0; best = i; rev = false; }
          const n = p.length;
          const closed = p[0] === p[n - 2] && p[1] === p[n - 1];
          if (!closed) { const d1 = (p[n - 2] - x) ** 2 + (p[n - 1] - y) ** 2; if (d1 < bd) { bd = d1; best = i; rev = true; } }
        }
        const path = todo.splice(best, 1)[0];
        let pts = path.pts;
        if (rev) { const r = []; for (let i = pts.length - 2; i >= 0; i -= 2) r.push(pts[i], pts[i + 1]); pts = r; }
        // tool change
        if (dual && path.ext !== tool) {
          tool = path.ext;
          g.push(`T${tool}`);
        }
        const td = Math.hypot(pts[0] - x, pts[1] - y);
        const travelPts = [x, y, pts[0], pts[1]];
        if (td > 2 && P.retraction) g.push(`G1 E-${P.retractDistance} F${P.retractSpeed * 60}`);
        if (td > 2 && P.zHop) g.push(`G0 Z${(layer.z + P.zHopHeight).toFixed(3)}`);
        g.push(`G0 F${P.travelSpeed * 60} X${pts[0].toFixed(3)} Y${pts[1].toFixed(3)}`);
        if (td > 2 && P.zHop) g.push(`G0 Z${layer.z.toFixed(3)}`);
        if (td > 2 && P.retraction) g.push(`G1 E${P.retractDistance} F${P.retractSpeed * 60}`);
        time += td / P.travelSpeed;
        travelDist += td;
        out.push({ type: 'travel', pts: travelPts });
        const speed = li === 0 ? P.firstLayerSpeed : path.type === 'outer' || path.type === 'inner' ? P.wallSpeed : path.type === 'infill' || path.type === 'skin' ? P.infillSpeed : P.printSpeed;
        g.push(`;TYPE:${path.type.toUpperCase()}`);
        let first = true;
        for (let i = 2; i < pts.length; i += 2) {
          const d = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
          const e = (d * lh * P.lineWidth * (path.w || 1)) / filArea;
          filament[path.ext || 0] += e;
          time += d / speed;
          g.push(`G1${first ? ` F${speed * 60}` : ''} X${pts[i].toFixed(3)} Y${pts[i + 1].toFixed(3)} E${e.toFixed(5)}`);
          first = false;
        }
        x = pts[pts.length - 2]; y = pts[pts.length - 1];
        out.push({ type: path.type, ext: path.ext, pts });
      }
      previewLayers.push({ z: layer.z, paths: out });
    });
    g.push(';END', 'M107', 'M104 S0', dual ? 'M104 S0 T1' : null, 'M140 S0', 'G91', 'G1 E-2 F2400', 'G1 Z10 F600', 'G90', 'G28 X Y', 'M84');
    const gcode = g.filter(Boolean).join('\n') + '\n';
    const r = (fil) => (fil * filArea) / 1000; // cm3
    const weight = [r(filament[0]) * m0.density, r(filament[1]) * m1.density];
    return {
      layers: previewLayers,
      gcode,
      stats: {
        time: time * 1.12 + layers.length * 0.5,
        filament: filament.map((f) => f / 1000),
        weight,
        cost: weight[0] / 1000 * m0.cost + weight[1] / 1000 * m1.cost,
        layers: layers.length,
        travel: travelDist / 1000,
        lines: g.length,
      },
    };
  }

  App.slicerUtil = { hull, scanFill, inside, area };
})();
