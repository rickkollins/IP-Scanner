/* A small canvas 3D renderer: orbit camera, build volume, flat-shaded meshes, picking. Z is up. */
(function () {
  'use strict';
  const App = window.App;

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  function hexToRgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  class Viewport3D {
    constructor(container, opts = {}) {
      this.canvas = App.h('canvas');
      container.append(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.volume = opts.volume || { x: 200, y: 200, z: 200 };
      this.cam = { theta: -Math.PI / 2 - 0.6, phi: 0.55, dist: 500, target: [0, 0, 0] };
      this.fov = 40;
      this.models = [];
      this.overlay = null; // fn(ctx, view)
      this.faces = [];
      this.onPick = null;
      this.onDragModel = null;
      this.onDragEnd = null;
      this.fit();
      this.bind();
      new ResizeObserver(() => this.render()).observe(container);
    }
    setVolume(v) { this.volume = v; this.fit(); }
    fit() {
      const v = this.volume;
      this.cam.target = [v.x / 2, v.y / 2, v.z / 4];
      this.cam.dist = Math.max(v.x, v.y, v.z) * 2.1;
      this.render();
    }
    setView(name) {
      const views = { iso: [-Math.PI / 2 - 0.6, 0.55], front: [-Math.PI / 2, 0.05], top: [-Math.PI / 2, 1.5699], left: [Math.PI, 0.05], right: [0, 0.05], back: [Math.PI / 2, 0.05] };
      const [t, p] = views[name] || views.iso;
      this.cam.theta = t; this.cam.phi = p;
      this.fit();
    }
    zoom(f) { this.cam.dist = App.clamp(this.cam.dist * f, 20, 5000); this.render(); }
    basis() {
      const c = this.cam;
      const eye = [c.target[0] + c.dist * Math.cos(c.phi) * Math.cos(c.theta), c.target[1] + c.dist * Math.cos(c.phi) * Math.sin(c.theta), c.target[2] + c.dist * Math.sin(c.phi)];
      const f = norm(sub(c.target, eye));
      const r = norm(cross(f, [0, 0, 1]));
      const u = cross(r, f);
      const w = this.canvas.clientWidth, hgt = this.canvas.clientHeight;
      const focal = hgt / 2 / Math.tan((this.fov * Math.PI) / 360);
      return { eye, f, r, u, w, h: hgt, cx: w / 2, cy: hgt / 2, focal };
    }
    project(p, B) {
      const v = sub(p, B.eye);
      const z = dot(v, B.f);
      if (z < 1) return null;
      return [B.cx + (dot(v, B.r) * B.focal) / z, B.cy - (dot(v, B.u) * B.focal) / z, z];
    }
    rayToPlane(sx, sy, planeZ = 0) {
      const B = this.basis();
      const dx = (sx - B.cx) / B.focal, dy = -(sy - B.cy) / B.focal;
      const d = [B.f[0] + B.r[0] * dx + B.u[0] * dy, B.f[1] + B.r[1] * dx + B.u[1] * dy, B.f[2] + B.r[2] * dx + B.u[2] * dy];
      if (Math.abs(d[2]) < 1e-6) return null;
      const t = (planeZ - B.eye[2]) / d[2];
      if (t < 0) return null;
      return [B.eye[0] + d[0] * t, B.eye[1] + d[1] * t, planeZ];
    }

    bind() {
      const c = this.canvas;
      let drag = null;
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      c.addEventListener('pointerdown', (e) => {
        c.setPointerCapture(e.pointerId);
        const r = c.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        const mode = e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'orbit';
        drag = { x, y, sx: x, sy: y, mode, moved: false };
        if (mode === 'orbit' && e.button === 0) {
          const hit = this.pick(x, y);
          if (hit && this.onDragModel && hit.draggable !== false) {
            drag.mode = 'model';
            drag.model = hit;
            drag.start = this.rayToPlane(x, y, 0);
          }
          drag.hit = hit;
        }
      });
      c.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const r = c.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        const dx = x - drag.x, dy = y - drag.y;
        if (Math.abs(x - drag.sx) + Math.abs(y - drag.sy) > 3) drag.moved = true;
        drag.x = x; drag.y = y;
        if (drag.mode === 'orbit') {
          this.cam.theta -= dx * 0.008;
          this.cam.phi = App.clamp(this.cam.phi + dy * 0.008, -1.5, 1.5699);
          this.render();
        } else if (drag.mode === 'pan') {
          const B = this.basis();
          const s = this.cam.dist / B.focal;
          for (let k = 0; k < 3; k++) this.cam.target[k] += (-dx * B.r[k] + dy * B.u[k]) * s;
          this.render();
        } else if (drag.mode === 'model' && drag.moved) {
          const p = this.rayToPlane(x, y, 0);
          if (p && drag.start) { this.onDragModel(drag.model, p[0] - drag.start[0], p[1] - drag.start[1]); drag.start = p; }
        }
      });
      c.addEventListener('pointerup', () => {
        if (!drag) return;
        if (!drag.moved && this.onPick) this.onPick(drag.hit || null);
        if (drag.mode === 'model' && drag.moved && this.onDragEnd) this.onDragEnd(drag.model);
        drag = null;
      });
      c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(e.deltaY > 0 ? 1.1 : 1 / 1.1); }, { passive: false });
    }

    pick(x, y) {
      // faces are sorted far → near; walk backwards for the nearest hit
      for (let i = this.faces.length - 1; i >= 0; i--) {
        const f = this.faces[i];
        if (inTri(x, y, f.p)) return f.model;
      }
      return null;
    }

    render() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this.draw(); });
    }
    draw() {
      const c = this.canvas, dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, hgt = c.clientHeight;
      if (!w || !hgt) return;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hgt);
      const B = this.basis();
      const dark = document.documentElement.dataset.theme === 'dark';
      this.drawPlate(ctx, B, dark);
      this.faces = [];
      if (!this.hideModels) this.drawModels(ctx, B);
      if (this.overlay) this.overlay(ctx, B, this);
      this.drawVolume(ctx, B, dark);
      this.drawAxes(ctx, B);
    }
    line(ctx, B, a, b) {
      const p = this.project(a, B), q = this.project(b, B);
      if (!p || !q) return;
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(q[0], q[1]);
    }
    drawPlate(ctx, B, dark) {
      const v = this.volume;
      const corners = [[0, 0, 0], [v.x, 0, 0], [v.x, v.y, 0], [0, v.y, 0]].map((p) => this.project(p, B));
      if (corners.every(Boolean)) {
        ctx.beginPath();
        corners.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.closePath();
        ctx.fillStyle = dark ? '#2a323c' : '#f8fafc';
        ctx.fill();
      }
      ctx.beginPath();
      const step = v.x > 300 ? 20 : 10;
      for (let x = 0; x <= v.x + 0.01; x += step) this.line(ctx, B, [x, 0, 0], [x, v.y, 0]);
      for (let y = 0; y <= v.y + 0.01; y += step) this.line(ctx, B, [0, y, 0], [v.x, y, 0]);
      ctx.strokeStyle = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.08)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    drawVolume(ctx, B, dark) {
      const v = this.volume;
      if (!v.z) return;
      ctx.beginPath();
      const P = [[0, 0], [v.x, 0], [v.x, v.y], [0, v.y]];
      for (let i = 0; i < 4; i++) {
        const a = P[i], b = P[(i + 1) % 4];
        this.line(ctx, B, [a[0], a[1], 0], [b[0], b[1], 0]);
        this.line(ctx, B, [a[0], a[1], v.z], [b[0], b[1], v.z]);
        this.line(ctx, B, [a[0], a[1], 0], [a[0], a[1], v.z]);
      }
      ctx.strokeStyle = dark ? 'rgba(140,170,210,.35)' : 'rgba(31,122,224,.35)';
      ctx.stroke();
    }
    drawAxes(ctx, B) {
      const L = Math.min(this.volume.x, this.volume.y) * 0.15;
      [[[L, 0, 0], '#d64545'], [[0, L, 0], '#2f9e5b'], [[0, 0, L], '#1f7ae0']].forEach(([e, col]) => {
        ctx.beginPath();
        this.line(ctx, B, [0, 0, 0], e);
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.stroke();
      });
      ctx.lineWidth = 1;
    }
    drawModels(ctx, B) {
      const faces = [];
      const L = norm([B.f[0] * -1 + B.u[0] * 0.5 + B.r[0] * 0.3, B.f[1] * -1 + B.u[1] * 0.5 + B.r[1] * 0.3, B.f[2] * -1 + B.u[2] * 0.5 + B.r[2] * 0.3]);
      const vol = this.volume;
      for (const m of this.models) {
        if (m.visible === false || !m.world) continue;
        const t = m.world;
        const base = hexToRgb(m.color || '#3d8ee8');
        const sel = m.selected;
        const out = m.outOfBounds;
        for (let i = 0; i < t.length; i += 9) {
          const a = [t[i], t[i + 1], t[i + 2]], b = [t[i + 3], t[i + 4], t[i + 5]], cc = [t[i + 6], t[i + 7], t[i + 8]];
          const n = norm(cross(sub(b, a), sub(cc, a)));
          if (dot(n, sub(a, B.eye)) > 0) continue; // back-face
          const pa = this.project(a, B), pb = this.project(b, B), pc = this.project(cc, B);
          if (!pa || !pb || !pc) continue;
          const shade = 0.45 + 0.55 * Math.max(0, dot(n, L));
          let col = base.map((x) => x * shade);
          if (sel) col = col.map((x, k) => x * 0.7 + [31, 122, 224][k] * 0.3 * shade + 25);
          if (out) col = [col[0] * 0.5 + 120, col[1] * 0.4, col[2] * 0.4];
          faces.push({ d: (pa[2] + pb[2] + pc[2]) / 3, p: [pa, pb, pc], c: `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`, model: m });
        }
      }
      faces.sort((x, y) => y.d - x.d);
      for (const f of faces) {
        ctx.beginPath();
        ctx.moveTo(f.p[0][0], f.p[0][1]);
        ctx.lineTo(f.p[1][0], f.p[1][1]);
        ctx.lineTo(f.p[2][0], f.p[2][1]);
        ctx.closePath();
        ctx.fillStyle = f.c;
        ctx.strokeStyle = f.c;
        ctx.lineWidth = 0.6;
        ctx.fill();
        ctx.stroke();
      }
      this.faces = faces;
      // selection bounding box
      for (const m of this.models) {
        if (!m.selected || !m.world || m.visible === false) continue;
        const bb = App.mesh.bounds(m.world);
        const [x0, y0, z0] = bb.min, [x1, y1, z1] = bb.max;
        ctx.beginPath();
        const P = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        for (let i = 0; i < 4; i++) {
          const a = P[i], b = P[(i + 1) % 4];
          this.line(ctx, B, [a[0], a[1], z0], [b[0], b[1], z0]);
          this.line(ctx, B, [a[0], a[1], z1], [b[0], b[1], z1]);
          this.line(ctx, B, [a[0], a[1], z0], [a[0], a[1], z1]);
        }
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#1f7ae0';
        ctx.stroke();
        ctx.setLineDash([]);
      }
      void vol;
    }
  }
  function inTri(x, y, p) {
    const s = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const d1 = s(p[0], p[1]), d2 = s(p[1], p[2]), d3 = s(p[2], p[0]);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  }
  App.Viewport3D = Viewport3D;
})();
