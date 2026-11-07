/* Laser & CNC pages: a 2D design canvas with objects, toolpaths, G-code generation and preview. */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v); return e; };
  const PT = 0.3528; // mm per point

  /* ---------- pixel helpers (shared with dialogs) ---------- */
  function processPixels(d, o) {
    const b = (o.brightness || 0) * 2.55;
    const c = o.contrast || 0;
    const f = (259 * (c + 255)) / (255 * (259 - c));
    const mode = o.mode;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      let g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a + 255 * (1 - a);
      g = f * (g + b - 128) + 128;
      if (o.invert) g = 255 - g;
      if (mode === 'bitmap' || mode === 'vector') g = g < (o.threshold ?? 128) ? 0 : 255;
      g = Math.max(0, Math.min(255, g));
      d[i] = d[i + 1] = d[i + 2] = g;
      d[i + 3] = 255;
    }
  }
  App.editor2dUtil = { processPixels };

  const imgCache = new Map();
  const pendingProc = new Map();
  function loadImage(src) {
    if (imgCache.has(src)) return imgCache.get(src);
    const p = new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    imgCache.set(src, p);
    return p;
  }

  /* ---------- geometry ---------- */
  function rotPt(x, y, o) {
    const a = ((o.rot || 0) * Math.PI) / 180;
    const sx = o.flipX ? -1 : 1, sy = o.flipY ? -1 : 1;
    x *= sx; y *= sy;
    return [o.x + x * Math.cos(a) - y * Math.sin(a), o.y + x * Math.sin(a) + y * Math.cos(a)];
  }
  function shapeLocal(o) {
    // returns polylines in local coords centred at 0,0 (unrotated) or null for raster-only types
    const w = o.w, hh = o.h;
    if (o.type === 'rect') {
      const r = Math.min(o.radius || 0, w / 2, hh / 2);
      if (!r) return [{ pts: [[-w / 2, -hh / 2], [w / 2, -hh / 2], [w / 2, hh / 2], [-w / 2, hh / 2], [-w / 2, -hh / 2]], closed: true }];
      const pts = [];
      const corner = (cx, cy, a0) => { for (let i = 0; i <= 8; i++) { const a = a0 + (i / 8) * (Math.PI / 2); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
      corner(w / 2 - r, hh / 2 - r, 0); corner(-w / 2 + r, hh / 2 - r, Math.PI / 2); corner(-w / 2 + r, -hh / 2 + r, Math.PI); corner(w / 2 - r, -hh / 2 + r, 1.5 * Math.PI);
      pts.push(pts[0]);
      return [{ pts, closed: true }];
    }
    if (o.type === 'ellipse') {
      const pts = [];
      for (let i = 0; i <= 96; i++) { const a = (i / 96) * Math.PI * 2; pts.push([(w / 2) * Math.cos(a), (hh / 2) * Math.sin(a)]); }
      return [{ pts, closed: true }];
    }
    if (o.type === 'polygon' || o.type === 'star') {
      const n = o.sides || (o.type === 'star' ? 5 : 6);
      const pts = [];
      const k = o.type === 'star' ? 2 : 1;
      for (let i = 0; i <= n * k; i++) {
        const a = -Math.PI / 2 + (i / (n * k)) * Math.PI * 2;
        const r = o.type === 'star' && i % 2 ? 0.45 : 1;
        pts.push([(w / 2) * r * Math.cos(a), (hh / 2) * r * Math.sin(a)]);
      }
      return [{ pts, closed: true }];
    }
    if (o.type === 'path') return o.polylines.map((pl) => ({ pts: pl.pts.map(([nx, ny]) => [(nx - 0.5) * w, (ny - 0.5) * hh]), closed: pl.closed }));
    return null;
  }

  /* ---------- rasterize any object (white background, black ink) ---------- */
  async function rasterize(o, res, mode) {
    const corners = [[-o.w / 2, -o.h / 2], [o.w / 2, -o.h / 2], [o.w / 2, o.h / 2], [-o.w / 2, o.h / 2]].map(([x, y]) => rotPt(x, y, o));
    const x0 = Math.min(...corners.map((c) => c[0])), y0 = Math.min(...corners.map((c) => c[1]));
    const x1 = Math.max(...corners.map((c) => c[0])), y1 = Math.max(...corners.map((c) => c[1]));
    const W = Math.max(1, Math.ceil((x1 - x0) * res)), H = Math.max(1, Math.ceil((y1 - y0) * res));
    if (W * H > 16e6) throw new Error('Image is too large at this density. Lower the line density or the object size.');
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate((o.x - x0) * res, (o.y - y0) * res);
    ctx.rotate(((o.rot || 0) * Math.PI) / 180);
    ctx.scale((o.flipX ? -1 : 1) * res, (o.flipY ? -1 : 1) * res);
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 0.3;
    if (o.type === 'image') {
      const img = await loadImage(o.src);
      ctx.drawImage(img, -o.w / 2, -o.h / 2, o.w, o.h);
    } else if (o.type === 'text') {
      drawText(ctx, o);
    } else {
      const pls = shapeLocal(o);
      ctx.beginPath();
      pls.forEach((pl) => pl.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))));
      if (pls.some((p) => p.closed)) ctx.fill('evenodd'); else ctx.stroke();
    }
    ctx.restore();
    const id = ctx.getImageData(0, 0, W, H);
    if (o.type === 'image') processPixels(id.data, Object.assign({}, o, { mode }));
    else if (mode !== 'greyscale' && mode !== 'relief') processPixels(id.data, { mode: 'bitmap', threshold: 128 });
    const gray = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) gray[i] = id.data[i * 4];
    return { gray, W, H, x0, y0, res };
  }
  function textLines(o) { return String(o.text || '').split('\n'); }
  function drawText(ctx, o) {
    const lines = textLines(o);
    const fs = 100; // draw at a fixed size then scale into the box
    ctx.save();
    ctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${fs}px "${o.font}"`;
    const lh = fs * (o.lineHeight || 1.2);
    const widths = lines.map((l) => ctx.measureText(l).width);
    const natW = Math.max(1, ...widths), natH = lh * lines.length;
    ctx.scale(o.w / natW, o.h / natH);
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => {
      const y = -natH / 2 + lh * (i + 0.5);
      const x = o.align === 'left' ? -natW / 2 : o.align === 'right' ? natW / 2 - widths[i] : -widths[i] / 2;
      ctx.fillText(l, x, y);
    });
    ctx.restore();
  }
  function measureText(o) {
    const c = document.createElement('canvas').getContext('2d');
    c.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}100px "${o.font}"`;
    const lines = textLines(o);
    const natW = Math.max(1, ...lines.map((l) => c.measureText(l).width));
    const natH = 100 * (o.lineHeight || 1.2) * lines.length;
    const scale = (o.fontSize * PT) / 100;
    return { w: natW * scale, h: natH * scale };
  }

  // marching squares outline of a raster → closed polylines in world coords
  function traceRaster(r) {
    const { gray, W, H, x0, y0, res } = r;
    const ink = (x, y) => x >= 0 && y >= 0 && x < W && y < H && gray[y * W + x] < 128;
    const segs = [];
    for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
      const a = ink(x, y), b = ink(x + 1, y), c = ink(x + 1, y + 1), d = ink(x, y + 1);
      const idx = (a ? 8 : 0) | (b ? 4 : 0) | (c ? 2 : 0) | (d ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const T = [x + 1, y + 0.5], R = [x + 1.5, y + 1], B = [x + 1, y + 1.5], L = [x + 0.5, y + 1];
      const add = (p, q) => segs.push([p, q]);
      switch (idx) {
        case 1: add(L, B); break; case 2: add(B, R); break; case 3: add(L, R); break; case 4: add(R, T); break;
        case 5: add(L, T); add(R, B); break; case 6: add(B, T); break; case 7: add(L, T); break; case 8: add(T, L); break;
        case 9: add(T, B); break; case 10: add(T, R); add(B, L); break; case 11: add(T, R); break; case 12: add(R, L); break;
        case 13: add(R, B); break; case 14: add(B, L); break;
      }
    }
    const key = (p) => p[0] * 2 + ',' + p[1] * 2;
    const map = new Map();
    segs.forEach((s, i) => { const k = key(s[0]); if (!map.has(k)) map.set(k, []); map.get(k).push(i); });
    const used = new Uint8Array(segs.length);
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const pts = [segs[i][0], segs[i][1]];
      for (;;) {
        const c = map.get(key(pts[pts.length - 1]));
        const j = c && c.find((k) => !used[k]);
        if (j == null) break;
        used[j] = 1;
        pts.push(segs[j][1]);
      }
      if (pts.length < 4) continue;
      // drop collinear points
      const simp = [pts[0]];
      for (let k = 1; k < pts.length - 1; k++) {
        const p = simp[simp.length - 1], q = pts[k], n = pts[k + 1];
        if ((q[0] - p[0]) * (n[1] - p[1]) - (q[1] - p[1]) * (n[0] - p[0]) !== 0) simp.push(q);
      }
      simp.push(pts[pts.length - 1]);
      out.push({ pts: simp.map(([x, y]) => [x0 + x / res, y0 + y / res]), closed: true });
    }
    return out;
  }

  async function worldPolylines(o) {
    const loc = shapeLocal(o);
    if (loc) return loc.map((pl) => ({ closed: pl.closed, pts: pl.pts.map(([x, y]) => rotPt(x, y, o)) }));
    const r = await rasterize(o, o.type === 'text' ? 10 : 5, 'vector');
    return traceRaster(r);
  }

  function polyArea(p) { let a = 0; for (let i = 0; i < p.length - 1; i++) a += p[i][0] * p[i + 1][1] - p[i + 1][0] * p[i][1]; return a / 2; }
  function offsetPolyline(pts, d) {
    // closed polyline (first == last); d > 0 grows outward
    const n = pts.length - 1;
    if (n < 3) return null;
    const sign = polyArea(pts) > 0 ? 1 : -1; // y-down canvas: positive area = clockwise on screen
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
      const e1 = [b[0] - a[0], b[1] - a[1]], e2 = [c[0] - b[0], c[1] - b[1]];
      const l1 = Math.hypot(...e1) || 1, l2 = Math.hypot(...e2) || 1;
      const n1 = [(e1[1] / l1) * sign, (-e1[0] / l1) * sign], n2 = [(e2[1] / l2) * sign, (-e2[0] / l2) * sign];
      let m = [n1[0] + n2[0], n1[1] + n2[1]];
      const ml = Math.hypot(...m) || 1;
      m = [m[0] / ml, m[1] / ml];
      const cos = Math.max(0.3, m[0] * n1[0] + m[1] * n1[1]);
      out.push([b[0] - (m[0] * d) / cos, b[1] - (m[1] * d) / cos]);
    }
    out.push(out[0]);
    const a0 = polyArea(pts), a1 = polyArea(out);
    if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < 0.05) return null;
    if (d < 0 && Math.abs(a1) > Math.abs(a0)) return null;
    return out;
  }
  function scanLines(polys, spacing, angle, inset = 0) {
    const flat = polys.map((p) => p.pts.flat());
    return App.slicerUtil.scanFill(flat, angle, spacing, inset).map((l) => [[l[0], l[1]], [l[2], l[3]]]);
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function pathLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }

  /* ---------- the editor factory ---------- */
  function makeEditor(kind) {
    const isLaser = kind === 'laser';
    const E = {
      kind,
      projectName: 'Untitled',
      objects: [],
      selection: [],
      tool: 'select',
      mode: 'edit',
      preview: null,
      showTravel: false,
      bg: null,
      job: null,
      history: new App.History(),
      savedState: null,
      view: { x: 0, y: 0, scale: 3 },
      title() { return `${isLaser ? 'Laser' : 'CNC'} — ${this.projectName}${this.isDirty() ? ' *' : ''}`; },

      defaultJob() {
        const m = App.machine();
        const size = (isLaser ? m.laserSize : m.cncSize) || { x: 200, y: 200 };
        return { width: Math.min(150, size.x), height: Math.min(150, size.y), thickness: isLaser ? 3 : 10, origin: 'bottom-left', zOrigin: 'top', safeZ: 5, autoFocus: true };
      },
      defaultToolpath(o) {
        if (isLaser) {
          const mode = o.type === 'image' ? 'greyscale' : o.type === 'text' ? 'bitmap' : 'vector';
          return { name: '', mode, fillVector: false, power: mode === 'vector' ? 100 : 60, workSpeed: mode === 'vector' ? 10 : 60, travelSpeed: 100, density: 10, direction: 'h', passes: 1, passDepth: 0, airAssist: false, visible: true };
        }
        const t = App.lib.tools.all()[0];
        return { name: '', mode: o.type === 'image' ? 'relief' : o.type === 'text' ? 'pocket' : 'outline', toolId: t.id, targetDepth: 1, stepDown: t.stepDown, feedRate: t.feedRate, plungeRate: t.plungeRate, stepOver: t.stepOver, spindle: t.spindle, tabs: false, tabHeight: 1, visible: true };
      },

      /* ---------- state ---------- */
      snapshot() { return { objects: this.objects, job: this.job, bg: this.bg }; },
      restore(s) {
        this.objects = App.deepClone(s.objects);
        this.job = Object.assign({}, s.job);
        this.bg = s.bg || null;
        this.selection = this.selection.filter((id) => this.objects.some((o) => o.id === id));
        this.invalidate();
        this.refresh();
      },
      commit() { this.history.push(this.snapshot()); this.invalidate(); this.refresh(); },
      isDirty() { return this.savedState !== null && JSON.stringify(this.snapshot()) !== this.savedState; },
      markSaved(clean = true) { this.savedState = clean ? JSON.stringify(this.snapshot()) : ''; App.updateTitle(); },
      invalidate() { if (this.mode === 'preview' || this.preview) { this.mode = 'edit'; this.preview = null; } },
      sel() { return this.objects.filter((o) => this.selection.includes(o.id)); },

      newProject(name = 'Untitled') {
        this.projectName = name;
        this.objects = [];
        this.selection = [];
        this.bg = null;
        this.job = this.defaultJob();
        this.mode = 'edit';
        this.preview = null;
        this.history.reset(this.snapshot());
        this.markSaved();
        this.fitView();
        this.refresh();
      },
      serialize() { return { app: 'maker-studio', version: 1, type: kind, machine: { id: App.prefs.machineId }, data: App.deepClone(this.snapshot()) }; },
      loadProject(proj, name) {
        this.projectName = name;
        this.selection = [];
        this.restore(proj.data);
        this.history.reset(this.snapshot());
        this.markSaved();
        this.fitView();
      },
      saveProject(asNew) {
        const doSave = (n) => {
          this.projectName = n;
          const proj = this.serialize();
          App.download(n + '.msproj', JSON.stringify(proj), 'application/json');
          App.recent.add(proj, n);
          this.markSaved();
          App.toast('Project saved', 'ok');
        };
        if (asNew || this.projectName === 'Untitled') App.prompt('Project name', this.projectName, 'Save Project').then((n) => n && doSave(n));
        else doSave(this.projectName);
      },

      addObject(o, tp) {
        const base = { id: App.uid('o'), name: '', x: this.job.width / 2, y: this.job.height / 2, w: 40, h: 40, rot: 0, flipX: false, flipY: false, visible: true };
        const obj = Object.assign(base, o);
        if (obj.type === 'text') {
          Object.assign(obj, Object.assign({ text: 'Text', font: 'Arial', fontSize: 24, bold: false, italic: false, align: 'center', lineHeight: 1.2 }, o));
          Object.assign(obj, measureText(obj));
        }
        if (obj.type === 'polygon' && !obj.sides) obj.sides = 6;
        if (obj.type === 'star' && !obj.sides) obj.sides = 5;
        if (obj.type === 'image') Object.assign(obj, { threshold: 128, invert: false, brightness: 0, contrast: 0 }, o);
        const typeName = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', path: 'Path', text: 'Text', image: 'Image' }[obj.type];
        obj.name = obj.name || `${typeName} ${this.objects.filter((x) => x.type === obj.type).length + 1}`;
        obj.tp = Object.assign(this.defaultToolpath(obj), tp || {});
        if (!obj.tp.name) obj.tp.name = `Toolpath – ${obj.name}`;
        obj.mode = obj.tp.mode;
        this.objects.push(obj);
        this.selection = [obj.id];
        this.commit();
        return obj;
      },
      async importFiles() {
        const files = await App.pickFiles('.svg,.png,.jpg,.jpeg,.bmp,.gif,.webp', true);
        for (const f of files) {
          try {
            if (/\.svg$/i.test(f.name)) await this.importSVG(await App.readFile(f), f.name);
            else await this.importImage(await App.readFile(f, 'dataurl'), f.name);
          } catch (e) { App.toast(`Could not import ${f.name}: ${e.message}`, 'error'); }
        }
      },
      async importImage(src, name) {
        const img = await loadImage(src);
        let w = (img.naturalWidth * 25.4) / 96, hh = (img.naturalHeight * 25.4) / 96;
        const s = Math.min(1, (this.job.width * 0.8) / w, (this.job.height * 0.8) / hh);
        w *= s; hh *= s;
        this.addObject({ type: 'image', src, w, h: hh, name: name.replace(/\.\w+$/, '') });
      },
      async importSVG(text, name) {
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        const root = doc.documentElement;
        if (root.nodeName !== 'svg') throw new Error('not an SVG file');
        const holder = h('div', { style: { position: 'absolute', left: '-10000px', top: 0, visibility: 'hidden' } });
        const svgEl = document.importNode(root, true);
        holder.append(svgEl);
        document.body.append(holder);
        try {
          const vb = svgEl.viewBox && svgEl.viewBox.baseVal && svgEl.viewBox.baseVal.width ? svgEl.viewBox.baseVal : null;
          const unit = (attr, fallback) => {
            const v = root.getAttribute(attr);
            if (!v) return fallback;
            const n = parseFloat(v);
            if (/mm$/.test(v)) return n; if (/cm$/.test(v)) return n * 10; if (/in$/.test(v)) return n * 25.4; if (/pt$/.test(v)) return n * PT;
            return (n * 25.4) / 96;
          };
          const pxW = vb ? vb.width : parseFloat(root.getAttribute('width')) || 100;
          const mmW = unit('width', (pxW * 25.4) / 96);
          const k = mmW / pxW;
          const polylines = [];
          svgEl.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon').forEach((el) => {
            if (typeof el.getTotalLength !== 'function') return;
            const L = el.getTotalLength();
            if (!L) return;
            const m = el.getCTM();
            const vbOff = vb ? [vb.x, vb.y] : [0, 0];
            const steps = Math.min(4000, Math.max(16, Math.ceil(L / 0.5)));
            const step = L / steps;
            let cur = [];
            let prev = null;
            for (let i = 0; i <= steps; i++) {
              let p = el.getPointAtLength(i * step);
              if (m) { const q = svgEl.createSVGPoint(); q.x = p.x; q.y = p.y; p = q.matrixTransform(m); }
              const pt = [(p.x - (m ? 0 : vbOff[0])) * k, (p.y - (m ? 0 : vbOff[1])) * k];
              if (prev && dist(prev, pt) > step * k * 3 + 0.2) { if (cur.length > 1) polylines.push(cur); cur = []; }
              cur.push(pt);
              prev = pt;
            }
            if (cur.length > 1) polylines.push(cur);
          });
          if (!polylines.length) throw new Error('no drawable shapes found');
          const all = polylines.flat();
          const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
          const y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
          let w = Math.max(0.1, x1 - x0), hh = Math.max(0.1, y1 - y0);
          const norm = polylines.map((pl) => ({ pts: pl.map(([x, y]) => [(x - x0) / w, (y - y0) / hh]), closed: dist(pl[0], pl[pl.length - 1]) < 0.3 }));
          const s = Math.min(1, (this.job.width * 0.9) / w, (this.job.height * 0.9) / hh);
          w *= s; hh *= s;
          this.addObject({ type: 'path', polylines: norm, w, h: hh, name: name.replace(/\.\w+$/, '') });
        } finally { holder.remove(); }
      },

      /* ---------- commands ---------- */
      cmd(name) {
        const sel = this.sel();
        switch (name) {
          case 'undo': { const s = this.history.undo(); if (s) this.restore(s); return true; }
          case 'redo': { const s = this.history.redo(); if (s) this.restore(s); return true; }
          case 'selectAll': this.selection = this.objects.filter((o) => o.visible).map((o) => o.id); this.refresh(); return true;
          case 'unselect': this.selection = []; this.refresh(); return true;
          case 'delete': if (sel.length) { this.objects = this.objects.filter((o) => !this.selection.includes(o.id)); this.selection = []; this.commit(); } return true;
          case 'clearAll': if (this.objects.length) App.confirm('Remove all objects?', { danger: true, okLabel: 'Clear' }).then((ok) => { if (ok) { this.objects = []; this.selection = []; this.commit(); } }); return true;
          case 'copy': case 'cut':
            if (!sel.length) return true;
            App.clipboard = { kind: '2d', data: App.deepClone(sel) };
            if (name === 'cut') { this.objects = this.objects.filter((o) => !this.selection.includes(o.id)); this.selection = []; this.commit(); }
            return true;
          case 'paste': case 'duplicate': {
            const src = name === 'paste' ? (App.clipboard && App.clipboard.kind === '2d' ? App.clipboard.data : []) : App.deepClone(sel);
            if (!src.length) return true;
            this.selection = [];
            src.forEach((o) => { const c = Object.assign(App.deepClone(o), { id: App.uid('o'), x: o.x + 5, y: o.y + 5, name: o.name + ' copy' }); c.tp.name = `Toolpath – ${c.name}`; this.objects.push(c); this.selection.push(c.id); });
            this.commit();
            return true;
          }
          case 'import': this.importFiles(); return true;
          case 'exportModels': App.toast('Use File → Export G-code for laser and CNC projects'); return true;
          case 'exportGcode': if (this.preview) App.dialogs.exportGcode(this.preview.gcode, this.projectName, kind); else App.toast('Generate G-code first'); return true;
          case 'save': this.saveProject(); return true;
          case 'saveAs': this.saveProject(true); return true;
          default: return false;
        }
      },
      onKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        const k = e.key.toLowerCase();
        const step = e.shiftKey ? 10 : 1;
        const nudge = (dx, dy) => { const s = this.sel(); if (!s.length) return; s.forEach((o) => { o.x += dx; o.y += dy; }); this.commit(); };
        if (k === 'arrowleft') { nudge(-step, 0); return true; }
        if (k === 'arrowright') { nudge(step, 0); return true; }
        if (k === 'arrowup') { nudge(0, -step); return true; }
        if (k === 'arrowdown') { nudge(0, step); return true; }
        const map = { v: 'select', t: 'text', r: 'rect', e: 'ellipse', p: 'pen', l: 'line' };
        if (map[k]) { this.setTool(map[k]); return true; }
        return false;
      },
      setTool(t) {
        this.tool = t;
        App.$$('.tool-btn', this.leftEl).forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
        this.stage.style.cursor = t === 'select' ? 'default' : 'crosshair';
        if (t === 'image') { this.setTool('select'); this.importFiles(); }
        if (t === 'camera') { this.setTool('select'); App.dialogs.cameraCapture((src) => { this.bg = src; this.commit(); }); }
      },

      /* ---------- view ---------- */
      fitView() {
        if (!this.stage) return;
        const r = this.stage.getBoundingClientRect();
        if (!r.width) return;
        const pad = 40;
        this.view.scale = Math.min((r.width - pad * 2) / this.job.width, (r.height - pad * 2) / this.job.height);
        this.view.x = (r.width - this.job.width * this.view.scale) / 2;
        this.view.y = (r.height - this.job.height * this.view.scale) / 2;
        this.applyView();
      },
      zoom(f, cx, cy) {
        const r = this.stage.getBoundingClientRect();
        cx = cx ?? r.width / 2; cy = cy ?? r.height / 2;
        const ns = App.clamp(this.view.scale * f, 0.3, 80);
        this.view.x = cx - ((cx - this.view.x) * ns) / this.view.scale;
        this.view.y = cy - ((cy - this.view.y) * ns) / this.view.scale;
        this.view.scale = ns;
        this.applyView();
      },
      applyView() { this.root.setAttribute('transform', `translate(${this.view.x} ${this.view.y}) scale(${this.view.scale})`); this.renderSelection(); },
      toWorld(e) {
        const r = this.stage.getBoundingClientRect();
        return [(e.clientX - r.left - this.view.x) / this.view.scale, (e.clientY - r.top - this.view.y) / this.view.scale];
      },

      /* ---------- rendering ---------- */
      mount(el) {
        this.job = this.defaultJob();
        this.history.reset(this.snapshot());
        this.savedState = JSON.stringify(this.snapshot());
        const tb = App.toolbar([
          { icon: 'home', label: 'Home', action: () => App.go('home') },
          { icon: 'workspace', label: 'Workspace', action: () => App.go('workspace') }, '|',
          { icon: 'plus', label: 'New', action: () => App.dialogs.newProject(kind) },
          { icon: 'open', label: 'Open', action: () => App.dialogs.openProject() },
          { icon: 'save', label: 'Save', action: () => this.saveProject() }, '|',
          { icon: 'undo', label: 'Undo', id: 'undo', action: () => this.cmd('undo') },
          { icon: 'redo', label: 'Redo', id: 'redo', action: () => this.cmd('redo') }, '|',
          { icon: 'import', label: 'Import', action: () => this.importFiles() },
          { icon: 'export', label: 'Export', action: () => this.cmd('exportGcode') }, '|',
          { icon: 'target', label: 'Job Setup', action: () => App.dialogs.jobSetup(kind, this.job, (j) => { this.job = j; this.commit(); this.fitView(); }) },
          isLaser ? { icon: 'camera', label: 'Camera', action: () => this.setTool('camera') } : { icon: 'library', label: 'Tools', action: () => App.dialogs.toolLibrary() },
          isLaser ? { icon: 'library', label: 'Library', action: () => App.dialogs.laserLibrary() } : null,
          { icon: 'copy', label: 'Duplicate', action: () => this.cmd('duplicate') },
          { icon: 'trash', label: 'Delete', action: () => this.cmd('delete') },
          '->', App.machineChip(),
        ].filter(Boolean));
        this.toolbarEl = tb;
        const left = h('div.left-tools');
        const tools = [['select', 'select', 'Select (V)'], ['text', 'text', 'Text (T)'], ['rect', 'rect', 'Rectangle (R)'], ['ellipse', 'ellipse', 'Ellipse (E)'], ['polygon', 'polygon', 'Polygon'], ['star', 'star', 'Star'], ['line', 'line', 'Line (L)'], ['pen', 'pen', 'Pen (P)'], '|', ['image', 'image', 'Upload image / SVG'], isLaser ? ['camera', 'camera', 'Camera capture'] : null];
        tools.filter(Boolean).forEach((t) => {
          if (t === '|') { left.append(h('div.tool-sep')); return; }
          const b = h('button.tool-btn', { title: t[2], 'aria-label': t[2], on: { click: () => this.setTool(t[0]) } }, App.icon(t[1]));
          b.dataset.tool = t[0];
          left.append(b);
        });
        this.leftEl = left;
        const vpEl = h('div.viewport');
        this.stage = sv('svg', { class: 'stage' });
        this.root = sv('g');
        this.bgLayer = sv('g');
        this.objLayer = sv('g');
        this.prevLayer = sv('g');
        this.selLayer = sv('g'); // in screen space
        this.root.append(this.bgLayer, this.objLayer, this.prevLayer);
        this.stage.append(this.root, this.selLayer);
        this.infoEl = h('div.vp-info');
        this.legendEl = h('div.vp-info.legend.hidden');
        vpEl.append(this.stage,
          h('div.vp-overlay.tl', this.infoEl),
          h('div.vp-overlay.tr', this.legendEl),
          h('div.vp-overlay.bl',
            h('button.btn.small.icon', { title: 'Zoom in', on: { click: () => this.zoom(1.25) } }, App.icon('zoomIn')),
            h('button.btn.small.icon', { title: 'Zoom out', on: { click: () => this.zoom(0.8) } }, App.icon('zoomOut')),
            h('button.btn.small.icon', { title: 'Fit to view', on: { click: () => this.fitView() } }, App.icon('fit'))));
        vpEl.addEventListener('dragover', (e) => e.preventDefault());
        vpEl.addEventListener('drop', async (e) => {
          e.preventDefault();
          for (const f of Array.from(e.dataTransfer.files)) {
            try { if (/\.svg$/i.test(f.name)) await this.importSVG(await App.readFile(f), f.name); else if (/^image\//.test(f.type)) await this.importImage(await App.readFile(f, 'dataurl'), f.name); else App.toast(`${f.name}: unsupported file`, 'error'); } catch (err) { App.toast(err.message, 'error'); }
          }
        });
        this.bindStage();
        const right = h('div.right-panel');
        this.panelScroll = h('div.scroll');
        this.footerEl = h('div.footer');
        right.append(this.panelScroll, this.footerEl);
        this.status = h('div.statusbar');
        el.append(tb, h('div.editor', left, vpEl, right), this.status);
        new ResizeObserver(() => { if (!this._fitted && this.stage.getBoundingClientRect().width) { this._fitted = true; this.fitView(); } this.renderSelection(); }).observe(vpEl);
        App.bus.on('machine', () => this.refresh());
        App.bus.on('prefs', () => this.refresh());
        this.setTool('select');
        this.refresh();
      },
      onShow() { this.refresh(); setTimeout(() => this.renderSelection()); },

      refresh() {
        if (!this.stage) return;
        this.renderCanvas();
        this.renderPanel();
        this.renderFooter();
        this.renderPreview();
        this.renderSelection();
        const n = this.objects.length;
        this.infoEl.textContent = this.mode === 'preview' ? `Preview · ${this.preview.stats.lines.toLocaleString()} lines of G-code` : `${n} object${n === 1 ? '' : 's'} · ${this.job.width} × ${this.job.height} mm`;
        const mc = App.machine();
        const size = isLaser ? mc.laserSize : mc.cncSize;
        this.status.innerHTML = '';
        this.status.append(h('span', `${mc.name} · ${isLaser ? 'Laser' : 'CNC'}`), h('span', `Work origin: ${this.job.origin.replace('-', ' ')}`),
          !size ? h('span', { style: { color: 'var(--danger)' } }, `This machine has no ${isLaser ? 'laser' : 'CNC'} module`) :
            this.job.width > size.x || this.job.height > size.y ? h('span', { style: { color: 'var(--danger)' } }, `Material is larger than the work area (${size.x} × ${size.y} mm)`) : h('span', `Work area ${size.x} × ${size.y} mm`));
        App.$('[data-id=undo]', this.toolbarEl).disabled = !this.history.canUndo();
        App.$('[data-id=redo]', this.toolbarEl).disabled = !this.history.canRedo();
        App.updateTitle();
      },
      renderCanvas() {
        const J = this.job;
        const dark = document.documentElement.dataset.theme === 'dark';
        this.bgLayer.innerHTML = '';
        this.bgLayer.append(sv('rect', { x: 0, y: 0, width: J.width, height: J.height, fill: isLaser ? (dark ? '#3a3226' : '#f3e6cf') : (dark ? '#33302a' : '#e8d9bd'), stroke: dark ? '#776' : '#b9a27a', 'stroke-width': 0.3 }));
        if (this.bg) this.bgLayer.append(sv('image', { href: this.bg, x: 0, y: 0, width: J.width, height: J.height, preserveAspectRatio: 'none', opacity: 0.7 }));
        const grid = sv('path', { d: (() => { let d = ''; for (let x = 10; x < J.width; x += 10) d += `M${x} 0V${J.height}`; for (let y = 10; y < J.height; y += 10) d += `M0 ${y}H${J.width}`; return d; })(), stroke: dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.08)', 'stroke-width': 0.2, fill: 'none' });
        this.bgLayer.append(grid);
        const [ox, oy] = this.originPoint();
        this.bgLayer.append(sv('circle', { cx: ox, cy: oy, r: 1.6, fill: '#d64545' }), sv('path', { d: `M${ox} ${oy}h8M${ox} ${oy}v-8`, stroke: '#d64545', 'stroke-width': 0.5 }));
        this.objLayer.innerHTML = '';
        this.objLayer.setAttribute('opacity', this.mode === 'preview' ? 0.25 : 1);
        for (const o of this.objects) {
          if (!o.visible) continue;
          const g = sv('g', { transform: `translate(${o.x} ${o.y}) rotate(${o.rot || 0}) scale(${o.flipX ? -1 : 1} ${o.flipY ? -1 : 1})`, 'data-id': o.id, style: 'cursor:move' });
          const ink = isLaser ? '#1d1d1d' : '#5a4a2e';
          const stroke = { fill: o.tp.mode === 'vector' && !o.tp.fillVector || ['outline', 'outside', 'inside'].includes(o.tp.mode) ? 'none' : ink, stroke: ink, 'stroke-width': 0.4, 'vector-effect': 'non-scaling-stroke' };
          if (o.type === 'image') {
            g.append(sv('image', { href: o._proc || o.src, x: -o.w / 2, y: -o.h / 2, width: o.w, height: o.h, preserveAspectRatio: 'none' }));
            if (!o._proc || o._procKey !== this.procKey(o)) this.processImage(o);
          } else if (o.type === 'text') {
            const lines = textLines(o);
            const fs = 100, lh = fs * (o.lineHeight || 1.2);
            const m = measureText(Object.assign({}, o, { fontSize: 100 / PT }));
            const t = sv('text', { 'font-family': o.font, 'font-size': fs, 'font-weight': o.bold ? 700 : 400, 'font-style': o.italic ? 'italic' : 'normal', 'text-anchor': o.align === 'left' ? 'start' : o.align === 'right' ? 'end' : 'middle', transform: `scale(${o.w / m.w} ${o.h / m.h})`, fill: stroke.fill === 'none' ? 'none' : ink, stroke: stroke.fill === 'none' ? ink : 'none', 'stroke-width': 1.2 });
            const ax = o.align === 'left' ? -m.w / 2 : o.align === 'right' ? m.w / 2 : 0;
            lines.forEach((l, i) => { const ts = sv('tspan', { x: ax, y: -m.h / 2 + lh * (i + 0.5), 'dominant-baseline': 'middle' }); ts.textContent = l || ' '; t.append(ts); });
            g.append(t);
          } else {
            const pls = shapeLocal(o);
            const d = pls.map((pl) => 'M' + pl.pts.map((p) => p.map((v) => v.toFixed(3)).join(' ')).join('L') + (pl.closed ? 'Z' : '')).join('');
            g.append(sv('path', Object.assign({ d, 'fill-rule': 'evenodd' }, pls.every((p) => !p.closed) ? Object.assign({}, stroke, { fill: 'none' }) : stroke)));
          }
          g.append(sv('rect', { x: -o.w / 2, y: -o.h / 2, width: o.w, height: o.h, fill: 'transparent' }));
          this.objLayer.append(g);
        }
      },
      procKey(o) { return [o.src.length, o.tp.mode, o.threshold, o.invert, o.brightness, o.contrast].join('|'); },
      async processImage(o) {
        const key = this.procKey(o);
        if (pendingProc.get(o.id) === key) return;
        pendingProc.set(o.id, key);
        try {
          const img = await loadImage(o.src);
          const s = Math.min(1, 600 / Math.max(img.naturalWidth, img.naturalHeight));
          const c = h('canvas', { width: Math.max(1, Math.round(img.naturalWidth * s)), height: Math.max(1, Math.round(img.naturalHeight * s)) });
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, c.width, c.height);
          const d = ctx.getImageData(0, 0, c.width, c.height);
          processPixels(d.data, Object.assign({}, o, { mode: o.tp.mode === 'relief' ? 'greyscale' : o.tp.mode }));
          ctx.putImageData(d, 0, 0);
          Object.defineProperty(o, '_proc', { value: c.toDataURL(), writable: true, configurable: true, enumerable: false });
          Object.defineProperty(o, '_procKey', { value: key, writable: true, configurable: true, enumerable: false });
          this.renderCanvas();
        } catch (e) { /* ignore broken image */ }
        pendingProc.delete(o.id);
      },
      originPoint() {
        const J = this.job;
        return { 'bottom-left': [0, J.height], 'top-left': [0, 0], center: [J.width / 2, J.height / 2], 'top-right': [J.width, 0], 'bottom-right': [J.width, J.height] }[J.origin] || [0, J.height];
      },
      renderSelection() {
        const L = this.selLayer;
        if (!L) return;
        L.innerHTML = '';
        if (this.mode === 'preview') return;
        const sel = this.sel();
        const V = this.view;
        const S = (x, y) => [V.x + x * V.scale, V.y + y * V.scale];
        sel.forEach((o) => {
          const c = [[-o.w / 2, -o.h / 2], [o.w / 2, -o.h / 2], [o.w / 2, o.h / 2], [-o.w / 2, o.h / 2]].map(([x, y]) => {
            const a = ((o.rot || 0) * Math.PI) / 180;
            return S(o.x + x * Math.cos(a) - y * Math.sin(a), o.y + x * Math.sin(a) + y * Math.cos(a));
          });
          L.append(sv('polygon', { points: c.map((p) => p.join(',')).join(' '), fill: 'none', stroke: '#1f7ae0', 'stroke-width': 1, 'stroke-dasharray': '4 3' }));
          if (sel.length === 1) {
            c.forEach((p, i) => { const hd = sv('rect', { x: p[0] - 5, y: p[1] - 5, width: 10, height: 10, fill: '#fff', stroke: '#1f7ae0', 'stroke-width': 1.5, style: 'cursor:nwse-resize' }); hd.dataset.handle = 'r' + i; L.append(hd); });
            const a = ((o.rot || 0) * Math.PI) / 180;
            const top = S(o.x + (o.h / 2 + 8 / V.scale + 6 / V.scale) * Math.sin(a), o.y - (o.h / 2 + 14 / V.scale) * Math.cos(a));
            const mid = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
            L.append(sv('line', { x1: mid[0], y1: mid[1], x2: top[0], y2: top[1], stroke: '#1f7ae0' }));
            const rh = sv('circle', { cx: top[0], cy: top[1], r: 6, fill: '#fff', stroke: '#1f7ae0', 'stroke-width': 1.5, style: 'cursor:grab' });
            rh.dataset.handle = 'rot';
            L.append(rh);
          }
        });
      },
      bindStage() {
        const st = this.stage;
        let drag = null;
        let spaceDown = false;
        document.addEventListener('keydown', (e) => { if (e.code === 'Space' && App.current === this && !/input|textarea|select/i.test(document.activeElement.tagName)) { spaceDown = true; e.preventDefault(); } });
        document.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
        st.addEventListener('wheel', (e) => { e.preventDefault(); const r = st.getBoundingClientRect(); this.zoom(e.deltaY > 0 ? 1 / 1.12 : 1.12, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
        st.addEventListener('dblclick', (e) => {
          const g = e.target.closest('[data-id]');
          const o = g && this.objects.find((x) => x.id === g.dataset.id);
          if (o && o.type === 'text') this.editText(o);
          if (o && o.type === 'image') this.editImage(o);
        });
        st.addEventListener('pointerdown', (e) => {
          st.setPointerCapture(e.pointerId);
          const w = this.toWorld(e);
          if (e.button === 1 || e.button === 2 || spaceDown) { drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y }; return; }
          if (this.mode === 'preview') { drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y }; return; }
          const handle = e.target.dataset && e.target.dataset.handle;
          const o = this.sel()[0];
          if (handle && o) {
            drag = { type: handle === 'rot' ? 'rotate' : 'resize', o, start: w, orig: App.deepClone({ x: o.x, y: o.y, w: o.w, h: o.h, rot: o.rot }), corner: Number(handle.slice(1)) };
            return;
          }
          if (this.tool === 'select') {
            const g = e.target.closest('[data-id]');
            if (g) {
              const id = g.dataset.id;
              if (e.shiftKey) this.selection = this.selection.includes(id) ? this.selection.filter((x) => x !== id) : this.selection.concat(id);
              else if (!this.selection.includes(id)) this.selection = [id];
              drag = { type: 'move', start: w, orig: this.sel().map((x) => [x, x.x, x.y]), moved: false };
              this.refreshLight();
            } else {
              if (!e.shiftKey) this.selection = [];
              drag = { type: 'marquee', start: w, el: sv('rect', { fill: 'rgba(31,122,224,.1)', stroke: '#1f7ae0', 'stroke-width': 0.3 }) };
              this.root.append(drag.el);
              this.refreshLight();
            }
            return;
          }
          if (this.tool === 'text') { const t = this.addObject({ type: 'text', x: w[0], y: w[1] }); this.setTool('select'); this.editText(t); return; }
          drag = { type: 'create', tool: this.tool, start: w, pts: [w], el: sv('path', { fill: 'none', stroke: '#1f7ae0', 'stroke-width': 0.4, 'vector-effect': 'non-scaling-stroke' }) };
          this.root.append(drag.el);
        });
        st.addEventListener('pointermove', (e) => {
          if (!drag) return;
          const w = this.toWorld(e);
          if (drag.type === 'pan') { this.view.x = drag.vx + e.clientX - drag.sx; this.view.y = drag.vy + e.clientY - drag.sy; this.applyView(); return; }
          if (drag.type === 'move') {
            const dx = w[0] - drag.start[0], dy = w[1] - drag.start[1];
            if (Math.abs(dx) + Math.abs(dy) > 0.2) drag.moved = true;
            drag.orig.forEach(([o, x, y]) => { o.x = x + dx; o.y = y + dy; });
            this.renderCanvas(); this.renderSelection();
            return;
          }
          if (drag.type === 'resize') {
            const o = drag.o, g = drag.orig;
            const a = ((g.rot || 0) * Math.PI) / 180;
            const lx = (w[0] - g.x) * Math.cos(a) + (w[1] - g.y) * Math.sin(a);
            const ly = -(w[0] - g.x) * Math.sin(a) + (w[1] - g.y) * Math.cos(a);
            const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]][drag.corner];
            // opposite corner stays fixed
            const fx = -signs[0] * g.w / 2, fy = -signs[1] * g.h / 2;
            let nw = Math.max(0.5, (lx - fx) * signs[0]), nh = Math.max(0.5, (ly - fy) * signs[1]);
            if (e.shiftKey || o.type === 'text' || o.type === 'image' || o.lockRatio) { const s = Math.max(nw / g.w, nh / g.h); nw = g.w * s; nh = g.h * s; }
            const cx = fx + (signs[0] * nw) / 2, cy = fy + (signs[1] * nh) / 2;
            o.w = nw; o.h = nh;
            o.x = g.x + cx * Math.cos(a) - cy * Math.sin(a);
            o.y = g.y + cx * Math.sin(a) + cy * Math.cos(a);
            if (o.type === 'text') o.fontSize = App.round((g.w ? nw / g.w : 1) * (drag.fs0 || (drag.fs0 = o.fontSize)), 1);
            this.renderCanvas(); this.renderSelection();
            return;
          }
          if (drag.type === 'rotate') {
            const o = drag.o;
            let ang = (Math.atan2(w[1] - o.y, w[0] - o.x) * 180) / Math.PI + 90;
            if (e.shiftKey) ang = Math.round(ang / 15) * 15;
            o.rot = App.round(((ang % 360) + 360) % 360, 1);
            this.renderCanvas(); this.renderSelection();
            return;
          }
          if (drag.type === 'marquee') {
            const [x0, y0] = drag.start;
            Object.entries({ x: Math.min(x0, w[0]), y: Math.min(y0, w[1]), width: Math.abs(w[0] - x0), height: Math.abs(w[1] - y0) }).forEach(([k, v]) => drag.el.setAttribute(k, v));
            drag.end = w;
            return;
          }
          if (drag.type === 'create') {
            const [x0, y0] = drag.start;
            if (drag.tool === 'pen') { drag.pts.push(w); drag.el.setAttribute('d', 'M' + drag.pts.map((p) => p.join(' ')).join('L')); return; }
            if (drag.tool === 'line') { drag.el.setAttribute('d', `M${x0} ${y0}L${w[0]} ${w[1]}`); drag.end = w; return; }
            const x = Math.min(x0, w[0]), y = Math.min(y0, w[1]), ww = Math.abs(w[0] - x0), hh = Math.abs(w[1] - y0);
            drag.el.setAttribute('d', drag.tool === 'ellipse' ? `M${x} ${y + hh / 2}a${ww / 2} ${hh / 2} 0 1 0 ${ww} 0a${ww / 2} ${hh / 2} 0 1 0 ${-ww} 0` : `M${x} ${y}h${ww}v${hh}h${-ww}z`);
            drag.end = w;
          }
        });
        st.addEventListener('pointerup', () => {
          if (!drag) return;
          const d = drag;
          drag = null;
          if (d.type === 'move') { if (d.moved) this.commit(); else this.refreshLight(); return; }
          if (d.type === 'resize' || d.type === 'rotate') { this.commit(); return; }
          if (d.type === 'marquee') {
            d.el.remove();
            if (d.end) {
              const x0 = Math.min(d.start[0], d.end[0]), x1 = Math.max(d.start[0], d.end[0]), y0 = Math.min(d.start[1], d.end[1]), y1 = Math.max(d.start[1], d.end[1]);
              this.objects.forEach((o) => { if (o.visible && o.x > x0 && o.x < x1 && o.y > y0 && o.y < y1 && !this.selection.includes(o.id)) this.selection.push(o.id); });
            }
            this.refreshLight();
            return;
          }
          if (d.type === 'create') {
            d.el.remove();
            const [x0, y0] = d.start;
            const end = d.end || [x0, y0];
            let ww = Math.abs(end[0] - x0), hh = Math.abs(end[1] - y0);
            if (d.tool === 'pen') {
              if (d.pts.length < 3) return;
              const xs = d.pts.map((p) => p[0]), ys = d.pts.map((p) => p[1]);
              const bx = Math.min(...xs), by = Math.min(...ys), bw = Math.max(0.5, Math.max(...xs) - bx), bh = Math.max(0.5, Math.max(...ys) - by);
              const pts = d.pts.filter((p, i) => i % 2 === 0 || i === d.pts.length - 1).map(([x, y]) => [(x - bx) / bw, (y - by) / bh]);
              this.addObject({ type: 'path', polylines: [{ pts, closed: false }], x: bx + bw / 2, y: by + bh / 2, w: bw, h: bh });
            } else if (d.tool === 'line') {
              if (ww + hh < 1) { ww = 30; end[0] = x0 + 30; end[1] = y0; }
              const bw = Math.max(0.5, ww), bh = Math.max(0.5, hh);
              const pts = [[end[0] >= x0 ? 0 : 1, end[1] >= y0 ? 0 : 1], [end[0] >= x0 ? 1 : 0, end[1] >= y0 ? 1 : 0]];
              this.addObject({ type: 'path', polylines: [{ pts, closed: false }], x: (x0 + end[0]) / 2, y: (y0 + end[1]) / 2, w: bw, h: bh, name: 'Line ' + (this.objects.length + 1) });
            } else {
              if (ww < 1 && hh < 1) { ww = 40; hh = 40; this.addObject({ type: d.tool, x: x0, y: y0, w: ww, h: hh }); }
              else this.addObject({ type: d.tool, x: Math.min(x0, end[0]) + ww / 2, y: Math.min(y0, end[1]) + hh / 2, w: Math.max(1, ww), h: Math.max(1, hh) });
            }
            this.setTool('select');
          }
        });
        st.addEventListener('contextmenu', (e) => e.preventDefault());
      },
      refreshLight() { this.renderSelection(); this.renderPanel(); },

      editText(o) {
        App.dialogs.textEdit(o, (st) => {
          Object.assign(o, { text: st.text || ' ', font: st.font, fontSize: st.size, bold: st.bold, italic: st.italic, align: st.align, lineHeight: st.lineHeight });
          Object.assign(o, measureText(o));
          this.commit();
        });
      },
      editImage(o) {
        App.dialogs.imageProcess(Object.assign({}, o, { mode: o.tp.mode }), kind, (st) => {
          Object.assign(o, { threshold: st.threshold, invert: st.invert, brightness: st.brightness, contrast: st.contrast });
          if (st.mode) o.tp.mode = st.mode;
          this.commit();
        });
      },

      /* ---------- right panel ---------- */
      renderPanel() {
        const s = this.panelScroll;
        const top = s.scrollTop;
        s.innerHTML = '';
        const sel = this.sel();
        const J = this.job;
        if (sel.length === 1) {
          const o = sel[0];
          const vals = { x: App.round(o.x, 2), y: App.round(J.height - o.y, 2), w: App.round(o.w, 2), h: App.round(o.h, 2), rot: o.rot || 0, lock: !!o.lockRatio || o.type === 'text' || o.type === 'image' };
          const f = App.form([
            { key: 'x', label: 'X (center)', type: 'number', unit: 'mm' },
            { key: 'y', label: 'Y (center)', type: 'number', unit: 'mm' },
            { key: 'w', label: 'Width', type: 'number', unit: 'mm', min: 0.5 },
            { key: 'h', label: 'Height', type: 'number', unit: 'mm', min: 0.5 },
            { key: 'lock', label: 'Keep proportions', type: 'checkbox', disabled: o.type === 'text' || o.type === 'image' },
            { key: 'rot', label: 'Rotation', type: 'number', unit: '°' },
          ], vals, (k, v) => {
            if (k === 'x') o.x = v;
            if (k === 'y') o.y = J.height - v;
            if (k === 'w') { if (vals.lock) { o.h = (o.h * v) / o.w; } if (o.type === 'text') o.fontSize = App.round((o.fontSize * v) / o.w, 1); o.w = v; }
            if (k === 'h') { if (vals.lock) { o.w = (o.w * v) / o.h; } if (o.type === 'text') o.fontSize = App.round((o.fontSize * v) / o.h, 1); o.h = v; }
            if (k === 'lock') o.lockRatio = v;
            if (k === 'rot') o.rot = v;
            this.commit();
          });
          const extra = [];
          if (o.type === 'text') extra.push(h('button.btn.small', { on: { click: () => this.editText(o) } }, App.icon('text'), 'Edit text…'), h('div.hint', `${o.font}, ${o.fontSize} pt`));
          if (o.type === 'image') extra.push(h('button.btn.small', { on: { click: () => this.editImage(o) } }, App.icon('image'), 'Image processing…'));
          if (o.type === 'polygon' || o.type === 'star') extra.push(App.form([{ key: 'sides', label: o.type === 'star' ? 'Points' : 'Sides', type: 'number', min: 3, max: 40, step: 1 }], { sides: o.sides }, (k, v) => { o.sides = Math.round(v); this.commit(); }));
          if (o.type === 'rect') extra.push(App.form([{ key: 'radius', label: 'Corner radius', type: 'number', unit: 'mm', min: 0 }], { radius: o.radius || 0 }, (k, v) => { o.radius = v; this.commit(); }));
          const modeOpts = isLaser ? [['vector', 'Vector'], ['bitmap', 'Fill (B&W)'], ['greyscale', 'Greyscale']] : [['outline', 'On path'], ['outside', 'Outside'], ['inside', 'Inside'], ['pocket', 'Pocket'], ['relief', 'Relief']];
          const allowed = modeOpts.filter(([m]) => (o.type === 'image' ? true : m !== 'relief' && m !== 'greyscale') && !(o.type === 'path' && o.polylines.every((p) => !p.closed) && ['bitmap', 'pocket', 'inside', 'outside'].includes(m)));
          extra.push(h('div.field', h('label', 'Processing'), h('select', { on: { change: (e) => { o.tp.mode = e.target.value; this.commit(); } } }, allowed.map(([m, l]) => h('option', { value: m, selected: o.tp.mode === m }, l)))));
          s.append(App.section(`${o.name}`, [
            f, ...extra,
            h('div.row.wrap',
              h('button.btn.small', { title: 'Flip horizontally', on: { click: () => { o.flipX = !o.flipX; this.commit(); } } }, App.icon('flipH'), 'Flip H'),
              h('button.btn.small', { title: 'Flip vertically', on: { click: () => { o.flipY = !o.flipY; this.commit(); } } }, App.icon('flipV'), 'Flip V'),
              h('button.btn.small', { title: 'Center on material', on: { click: () => { o.x = J.width / 2; o.y = J.height / 2; this.commit(); } } }, App.icon('target'), 'Center'),
              h('button.btn.small', { title: 'Rename', on: { click: async () => { const n = await App.prompt('Name', o.name); if (n) { o.name = n; this.commit(); } } } }, App.icon('edit'), 'Rename')),
          ]));
        } else if (sel.length > 1) {
          s.append(App.section(`${sel.length} objects selected`, [
            h('div.row.wrap',
              ['left', 'center', 'right', 'top', 'middle', 'bottom'].map((a) => h('button.btn.small', { on: { click: () => this.align(a) } }, 'Align ' + a))),
          ]));
        }
        // toolpaths
        const list = h('div.list', { style: { maxHeight: '300px' } });
        if (!this.objects.length) list.append(h('div.empty', 'Add text, shapes or images. Each object gets its own toolpath.'));
        const modeName = { vector: 'Vector', bitmap: 'Fill', greyscale: 'Greyscale', outline: 'On path', outside: 'Outside', inside: 'Inside', pocket: 'Pocket', relief: 'Relief' };
        this.objects.forEach((o, i) => {
          list.append(h('div.li' + (this.selection.includes(o.id) ? '.active' : ''), { on: { click: (e) => { if (e.target.closest('button')) return; this.selection = [o.id]; this.refreshLight(); } } },
            h('span.name', { title: o.tp.name }, o.tp.name),
            h('span.badge.blue', modeName[o.tp.mode] || o.tp.mode),
            h('button.btn.small.icon', { title: 'Move up', disabled: i === 0, on: { click: () => { this.objects.splice(i - 1, 0, this.objects.splice(i, 1)[0]); this.commit(); } } }, App.icon('up')),
            h('button.btn.small.icon', { title: o.visible ? 'Hide' : 'Show', on: { click: () => { o.visible = !o.visible; this.commit(); } } }, App.icon(o.visible ? 'eye' : 'eyeOff')),
            h('button.btn.small.icon', { title: 'Toolpath settings', on: { click: () => App.dialogs.toolpathSettings(kind, o.tp, (tp) => { o.tp = tp; this.commit(); }) } }, App.icon('settings')),
            h('button.btn.small.icon', { title: 'Delete', on: { click: () => { this.objects.splice(i, 1); this.selection = this.selection.filter((x) => x !== o.id); this.commit(); } } }, App.icon('trash'))));
        });
        s.append(App.section(`Toolpaths (${this.objects.length})`, [list, h('div.hint', 'Toolpaths run from top to bottom. Use the arrows to change the order.')]));
        const J2 = this.job;
        s.append(App.section(isLaser ? 'Material' : 'Stock', [
          h('div.stats', h('div.stat', h('div.k', 'Size'), h('div.v', `${J2.width} × ${J2.height} mm`)), h('div.stat', h('div.k', 'Thickness'), h('div.v', `${J2.thickness} mm`))),
          h('button.btn.small', { on: { click: () => App.dialogs.jobSetup(kind, this.job, (j) => { this.job = j; this.commit(); this.fitView(); }) } }, App.icon('target'), 'Job setup…'),
          this.bg ? h('button.btn.small', { on: { click: () => { this.bg = null; this.commit(); } } }, 'Remove camera background') : null,
        ], { collapsed: sel.length > 0 }));
        s.scrollTop = top;
      },
      align(a) {
        const sel = this.sel();
        const boxes = sel.map((o) => ({ o, x0: o.x - o.w / 2, x1: o.x + o.w / 2, y0: o.y - o.h / 2, y1: o.y + o.h / 2 }));
        const X0 = Math.min(...boxes.map((b) => b.x0)), X1 = Math.max(...boxes.map((b) => b.x1)), Y0 = Math.min(...boxes.map((b) => b.y0)), Y1 = Math.max(...boxes.map((b) => b.y1));
        boxes.forEach(({ o }) => {
          if (a === 'left') o.x = X0 + o.w / 2; if (a === 'right') o.x = X1 - o.w / 2; if (a === 'center') o.x = (X0 + X1) / 2;
          if (a === 'top') o.y = Y0 + o.h / 2; if (a === 'bottom') o.y = Y1 - o.h / 2; if (a === 'middle') o.y = (Y0 + Y1) / 2;
        });
        this.commit();
      },
      renderFooter() {
        const f = this.footerEl;
        f.innerHTML = '';
        if (this.generating) {
          f.append(h('div.row', h('span.grow', 'Generating G-code…'), h('span', Math.round(this.generating.p * 100) + '%')), h('div.progress', h('div', { style: { width: this.generating.p * 100 + '%' } })));
          return;
        }
        if (this.mode === 'preview' && this.preview) {
          const st = this.preview.stats;
          f.append(h('div.stats',
            h('div.stat', h('div.k', 'Estimated time'), h('div.v', App.fmtTime(st.time))),
            h('div.stat', h('div.k', 'Toolpaths'), h('div.v', String(st.toolpaths))),
            h('div.stat', h('div.k', 'Cut distance'), h('div.v', (st.cut / 1000).toFixed(2) + ' m')),
            h('div.stat', h('div.k', 'Travel distance'), h('div.v', (st.travel / 1000).toFixed(2) + ' m'))),
          h('div.row', h('button.btn.grow', { on: { click: () => { this.mode = 'edit'; this.refresh(); } } }, App.icon('edit'), 'Back to edit'),
            h('button.btn.grow', { on: { click: () => this.cmd('exportGcode') } }, App.icon('export'), 'Export')),
          h('button.btn.primary.block', { on: { click: () => App.dialogs.sendToDevice(this.preview.gcode, this.projectName + (isLaser ? '.nc' : '.cnc'), kind) } }, App.icon('send'), 'Send to Workspace'));
          return;
        }
        f.append(h('button.btn.primary.block', { disabled: !this.objects.some((o) => o.visible && o.tp.visible !== false), style: { height: '38px' }, on: { click: () => this.generate() } }, App.icon('gcode'), 'Generate G-code'));
      },
      renderPreview() {
        this.prevLayer.innerHTML = '';
        this.legendEl.classList.toggle('hidden', this.mode !== 'preview');
        if (this.mode !== 'preview' || !this.preview) return;
        const cutCol = isLaser ? '#d63a1f' : '#1f7a4a';
        const mk = (segs, col, w, dash) => {
          let d = '';
          for (const pl of segs) d += 'M' + pl.map((p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L');
          return sv('path', { d, fill: 'none', stroke: col, 'stroke-width': w, 'vector-effect': 'non-scaling-stroke', 'stroke-dasharray': dash, 'stroke-linecap': 'round' });
        };
        this.prevLayer.append(mk(this.preview.cut, cutCol, 1));
        if (this.showTravel) this.prevLayer.append(mk(this.preview.travel, 'rgba(31,122,224,.6)', 0.7, '3 3'));
        this.legendEl.innerHTML = '';
        this.legendEl.append(h('b', 'Preview'), h('label', h('span.sw', { style: { background: cutCol } }), isLaser ? 'Laser on' : 'Cutting'),
          h('label', h('input', { type: 'checkbox', checked: this.showTravel, on: { change: (e) => { this.showTravel = e.target.checked; this.renderPreview(); } } }), h('span.sw', { style: { background: '#1f7ae0' } }), 'Travel moves'));
      },

      /* ---------- G-code ---------- */
      async generate() {
        this.generating = { p: 0 };
        this.renderFooter();
        try {
          this.preview = await this.buildGcode((p) => { this.generating.p = p; this.renderFooter(); });
          this.mode = 'preview';
          this.selection = [];
          App.toast('G-code generated', 'ok');
        } catch (e) {
          App.toast('Could not generate G-code: ' + e.message, 'error');
        }
        this.generating = null;
        this.refresh();
      },
      async buildGcode(onProgress) {
        const J = this.job;
        const [ox, oy] = this.originPoint();
        const X = (x) => (x - ox).toFixed(3), Y = (y) => (oy - y).toFixed(3);
        const grbl = App.prefs.gcodeFlavor === 'grbl';
        const maxS = isLaser ? (grbl ? 1000 : App.prefs.laserMaxS || 255) : 1;
        const g = [`;Generated by ${App.name} ${App.version}`, `;Mode: ${isLaser ? 'Laser' : 'CNC'}`, `;Material: ${J.width} x ${J.height} x ${J.thickness} mm`, `;Origin: ${J.origin}`, 'G90', 'G21'];
        const cut = [], travel = [];
        let pos = [ox, oy], z = 0, time = 0, cutDist = 0, travelDist = 0;
        const list = this.objects.filter((o) => o.visible && o.tp.visible !== false);
        if (isLaser) {
          g.push(grbl ? 'M4 S0 ;dynamic laser power, off during G0' : 'M3 I S0 ;inline laser power: S applies to G1 moves only', 'G0 F6000');
          if (J.autoFocus) g.push(`;Focus: raise laser by material thickness ${J.thickness} mm before starting`);
        } else {
          g.push(`G0 Z${J.safeZ}`);
        }
        const safeZ = J.safeZ || 5;
        const surf = !isLaser && J.zOrigin === 'bottom' ? J.thickness : 0;
        const go = (p, speedMmS) => {
          const d = dist(pos, p);
          if (d > 0.01) { travel.push([pos, p]); travelDist += d; time += d / speedMmS; }
          pos = p;
        };
        const cutTo = (p, speedMmS) => { const d = dist(pos, p); cutDist += d; time += d / speedMmS; pos = p; };

        for (let ti = 0; ti < list.length; ti++) {
          const o = list[ti];
          const tp = o.tp;
          g.push(`;TOOLPATH: ${tp.name} (${tp.mode})`);
          onProgress(ti / list.length);
          await new Promise((r) => setTimeout(r, 0));
          if (isLaser) {
            const S = Math.round((tp.power / 100) * maxS);
            const F = tp.workSpeed * 60, FT = tp.travelSpeed * 60;
            if (tp.airAssist) g.push('M8');
            for (let pass = 0; pass < tp.passes; pass++) {
              if (pass > 0 && tp.passDepth) g.push('G91', `G0 Z-${tp.passDepth}`, 'G90');
              let lines = [];
              if (tp.mode === 'vector') {
                const pls = await worldPolylines(o);
                if (tp.fillVector) {
                  const closed = pls.filter((p) => p.closed);
                  const ang = tp.direction === 'v' ? 90 : tp.direction === 'd' ? 45 : 0;
                  lines = scanLines(closed, 1 / tp.density, ang).map((l) => ({ pts: l, s: S }));
                  pls.forEach((pl) => lines.push({ pts: pl.pts, s: S }));
                } else lines = pls.map((pl) => ({ pts: pl.pts, s: S }));
                for (const ln of lines) {
                  g.push(`G0 X${X(ln.pts[0][0])} Y${Y(ln.pts[0][1])} F${FT}`);
                  go(ln.pts[0], tp.travelSpeed);
                  const seg = [ln.pts[0]];
                  ln.pts.slice(1).forEach((p, i) => { g.push(`G1 X${X(p[0])} Y${Y(p[1])}${i === 0 ? ` F${F} S${ln.s}` : ''}`); cutTo(p, tp.workSpeed); seg.push(p); });
                  cut.push(seg);
                }
              } else {
                // raster: bitmap or greyscale
                const r = await rasterize(o, tp.density, tp.mode);
                const vertical = tp.direction === 'v';
                const rows = vertical ? r.W : r.H, cols = vertical ? r.H : r.W;
                const px = (row, col) => (vertical ? r.gray[col * r.W + row] : r.gray[row * r.W + col]);
                const toW = (row, col) => (vertical ? [r.x0 + (row + 0.5) / r.res, r.y0 + col / r.res] : [r.x0 + col / r.res, r.y0 + (row + 0.5) / r.res]);
                let rev = false;
                for (let row = 0; row < rows; row++) {
                  // runs of equal power
                  const runs = [];
                  let c = 0;
                  while (c < cols) {
                    const v = px(row, c);
                    const pw = tp.mode === 'greyscale' ? Math.round(((255 - v) / 255) * S) : v < 128 ? S : 0;
                    let e = c + 1;
                    while (e < cols) { const v2 = px(row, e); const p2 = tp.mode === 'greyscale' ? Math.round(((255 - v2) / 255) * S) : v2 < 128 ? S : 0; if (Math.abs(p2 - pw) > (tp.mode === 'greyscale' ? 2 : 0)) break; e++; }
                    if (pw > 0) runs.push([c, e, pw]);
                    c = e;
                  }
                  if (!runs.length) continue;
                  if (rev) runs.reverse();
                  let first = true;
                  for (const [c0, c1, pw] of runs) {
                    const a = toW(row, rev ? c1 : c0), b = toW(row, rev ? c0 : c1);
                    const near = dist(pos, a) < 2 / r.res && !first;
                    g.push(`${near ? 'G1' : 'G0'} X${X(a[0])} Y${Y(a[1])}${near ? ' S0' : ''}${first ? ` F${FT}` : ''}`);
                    go(a, tp.travelSpeed);
                    g.push(`G1 X${X(b[0])} Y${Y(b[1])} S${pw} F${F}`);
                    cutTo(b, tp.workSpeed);
                    cut.push([a, b]);
                    first = false;
                  }
                  rev = !rev;
                  if (row % 50 === 0) await new Promise((res) => setTimeout(res, 0));
                }
              }
            }
            if (tp.passes > 1 && tp.passDepth) g.push('G91', `G0 Z${(tp.passDepth * (tp.passes - 1)).toFixed(3)}`, 'G90');
            if (tp.airAssist) g.push('M9');
          } else {
            const tool = App.lib.tools.get(tp.toolId) || App.lib.tools.all()[0];
            const R = tool.diameter / 2;
            const F = tp.feedRate, FP = tp.plungeRate;
            g.push(`;Tool: ${tool.name}`, `M3 S${tp.spindle}`, 'G4 P2');
            const depths = [];
            for (let d = tp.stepDown; d < tp.targetDepth - 1e-6; d += tp.stepDown) depths.push(d);
            depths.push(tp.targetDepth);
            const zAt = (d) => (surf - d).toFixed(3);
            const runPath = (pts, d, closed) => {
              const tabZ = tp.tabs && closed && d > tp.targetDepth - tp.tabHeight ? tp.targetDepth - tp.tabHeight : null;
              const total = pathLen(pts);
              let acc = 0;
              g.push(`G0 Z${safeZ + surf}`, `G0 X${X(pts[0][0])} Y${Y(pts[0][1])}`);
              go(pts[0], 40);
              g.push(`G1 Z${zAt(tabZ != null && inTab(0) ? tabZ : d)} F${FP}`);
              time += d / (FP / 60);
              function inTab(s) { if (tabZ == null) return false; for (let k = 0; k < 4; k++) { const c = (total * (k + 0.5)) / 4; if (Math.abs(s - c) < tool.diameter * 1.5) return true; } return false; }
              const seg = [pts[0]];
              for (let i = 1; i < pts.length; i++) {
                const p0 = pts[i - 1], p1 = pts[i];
                const L = dist(p0, p1);
                const n = tabZ != null ? Math.max(1, Math.ceil(L / 1)) : 1;
                for (let k = 1; k <= n; k++) {
                  const p = [p0[0] + ((p1[0] - p0[0]) * k) / n, p0[1] + ((p1[1] - p0[1]) * k) / n];
                  acc += L / n;
                  const zz = inTab(acc) ? tabZ : d;
                  g.push(`G1 X${X(p[0])} Y${Y(p[1])} Z${zAt(zz)} F${F}`);
                  cutTo(p, F / 60);
                  seg.push(p);
                }
              }
              cut.push(seg);
            };
            if (tp.mode === 'relief') {
              if (o.type !== 'image') throw new Error(`"${o.name}": relief works with images only`);
              const step = Math.max(0.05, tool.diameter * (tp.stepOver / 100));
              const r = await rasterize(o, 1 / step, 'greyscale');
              for (const d of depths) {
                let rev = false;
                for (let row = 0; row < r.H; row++) {
                  const y = r.y0 + (row + 0.5) / r.res;
                  const cols = [...Array(r.W).keys()];
                  if (rev) cols.reverse();
                  const pts = cols.map((c) => [r.x0 + (c + 0.5) / r.res, y]);
                  const zs = cols.map((c) => Math.min(d, (1 - r.gray[row * r.W + c] / 255) * tp.targetDepth));
                  g.push(`G0 Z${safeZ + surf}`, `G0 X${X(pts[0][0])} Y${Y(pts[0][1])}`);
                  go(pts[0], 40);
                  g.push(`G1 Z${zAt(zs[0])} F${FP}`);
                  pts.forEach((p, i) => { if (i) { g.push(`G1 X${X(p[0])} Z${zAt(zs[i])} F${F}`); cutTo(p, F / 60); } });
                  cut.push(pts);
                  rev = !rev;
                  if (row % 40 === 0) await new Promise((res) => setTimeout(res, 0));
                }
              }
            } else {
              const pls = await worldPolylines(o);
              let paths;
              if (tp.mode === 'outline') paths = pls.map((p) => ({ pts: p.pts, closed: p.closed }));
              else if (tp.mode === 'outside' || tp.mode === 'inside') {
                paths = pls.filter((p) => p.closed).map((p) => ({ pts: offsetPolyline(p.pts, tp.mode === 'outside' ? R : -R), closed: true })).filter((p) => p.pts);
                if (!paths.length) throw new Error(`"${o.name}": the shape is too small for this tool`);
              } else {
                // pocket: zig-zag fill inset by the tool radius, then a finishing pass around each boundary
                const closed = pls.filter((p) => p.closed);
                if (!closed.length) throw new Error(`"${o.name}": pocket needs a closed shape`);
                const so = Math.max(0.05, tool.diameter * (tp.stepOver / 100));
                const inner = closed.map((p) => {
                  // boundaries offset into the material (outer shrink, holes grow)
                  const depth = closed.filter((q) => q !== p && App.slicerUtil.inside(p.pts[0][0], p.pts[0][1], q.pts.flat())).length;
                  return { pts: offsetPolyline(p.pts, depth % 2 ? R : -R), closed: true };
                }).filter((p) => p.pts);
                paths = scanLines(inner.length ? inner : closed, so, 0, 0).map((l) => ({ pts: l, closed: false })).concat(inner);
              }
              for (const d of depths) for (const p of paths) runPath(p.pts, d, p.closed);
            }
            g.push(`G0 Z${safeZ + surf}`);
          }
        }
        if (isLaser) g.push('M5', `G0 X${X(ox)} Y${Y(oy)}`);
        else g.push('M5', `G0 Z${safeZ + surf}`, `G0 X${X(ox)} Y${Y(oy)}`);
        g.push(';END');
        onProgress(1);
        return { gcode: g.join('\n') + '\n', cut, travel, stats: { time: time * 1.05, cut: cutDist, travel: travelDist, toolpaths: list.length, lines: g.length } };
      },
    };
    return E;
  }

  App.registerPage('laser', makeEditor('laser'));
  App.registerPage('cnc', makeEditor('cnc'));
})();
