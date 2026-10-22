// Interactive 2D sketch editor that works on a sketch feature's entity list.

import * as THREE from 'three';
import { kernel } from '../core/kernel.js';
import { segmentsFor } from '../core/features.js';
import {
  entityPoints, snapPoints, arcFrom3Points, arcEndpoints, planeMatrix, planeFrame, ENTITY_LABELS,
} from '../core/sketch.js';
import { icon } from './icons.js';

const TOOLS = [
  ['select', 'Select / drag', 'V'],
  ['line', 'Line (polyline)', 'L'],
  ['rect', 'Corner rectangle', 'R'],
  ['crect', 'Centre rectangle', 'Shift+R'],
  ['circle', 'Circle', 'C'],
  ['arc', '3-point arc', 'A'],
  ['polygon', 'Polygon', 'P'],
  ['slot', 'Slot', 'S'],
  ['point', 'Point', 'O'],
];

const COLORS = { line: 0x1f6feb, construction: 0xe07b1a, selected: 0xf0a020, hover: 0x5aa0ff, draft: 0x6b8bc4, fill: 0x2f7cf6, point: 0x1d2633 };

let uid = 0;
const newId = () => `e${Date.now().toString(36)}${(uid++).toString(36)}`;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Build line geometry for a sketch (used for both editing and display). */
export function buildSketchObject(entities, { cs, selected = new Set(), hover = null, editing = false, regions = false } = {}) {
  const group = new THREE.Group();
  const solid = [], dashed = [], sel = [], hov = [];
  const verts = [];
  for (const e of entities) {
    const { closed, pts } = entityPoints(e, segmentsFor);
    const target = selected.has(e.id) ? sel : hover === e.id ? hov : e.construction ? dashed : solid;
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      target.push(a[0], a[1], 0, b[0], b[1], 0);
    }
    if (editing) for (const s of snapPoints(e)) if (s.kind !== 'mid') verts.push(s.p[0], s.p[1], 0);
  }
  const lineMat = (color, opts = {}) => (opts.dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 1.5, gapSize: 1, depthTest: !editing, transparent: true })
    : new THREE.LineBasicMaterial({ color, depthTest: !editing, transparent: true }));
  const add = (arr, color, opts) => {
    if (!arr.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const l = new THREE.LineSegments(g, lineMat(color, opts));
    if (opts?.dashed) l.computeLineDistances();
    l.renderOrder = 10;
    group.add(l);
  };
  add(solid, COLORS.line);
  add(dashed, COLORS.construction, { dashed: true });
  add(hov, COLORS.hover);
  add(sel, COLORS.selected);
  if (verts.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: COLORS.point, size: 6, sizeAttenuation: false, depthTest: false }));
    pts.renderOrder = 11;
    group.add(pts);
  }
  if (cs && !cs.isEmpty()) {
    const polys = cs.toPolygons();
    const tris = kernel().triangulate(polys);
    const flat = polys.flat();
    const pos = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => t.forEach((v, k) => { pos[i * 9 + k * 3] = flat[v][0]; pos[i * 9 + k * 3 + 1] = flat[v][1]; }));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: COLORS.fill, transparent: true, opacity: editing ? 0.16 : 0.1, side: THREE.DoubleSide, depthWrite: false, depthTest: !editing }));
    fill.renderOrder = 9;
    fill.raycast = () => {};
    group.add(fill);
    if (regions) {
      const parts = cs.decompose();
      group.userData.regionCenters = parts.map((p) => {
        const b = p.bounds();
        // Use the first triangle's centroid of each region as an anchor inside it.
        const pp = p.toPolygons(); const tt = kernel().triangulate(pp); const ff = pp.flat();
        let best = null, bestA = -1;
        for (const t of tt) {
          const [a, b2, c] = t.map((i) => ff[i]);
          const ar = Math.abs((b2[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b2[1] - a[1]));
          if (ar > bestA) { bestA = ar; best = [(a[0] + b2[0] + c[0]) / 3, (a[1] + b2[1] + c[1]) / 3]; }
        }
        p.delete();
        return best || [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
      });
    }
  }
  return group;
}

export class Sketcher {
  constructor(app) {
    this.app = app;
    this.vp = app.viewport;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.vp.overlay.add(this.group);
    this.active = false;
    this.snapStep = 1;
    this.gridSnap = true;
    this.polygonSides = 6;
    this.construction = false;
    this.input = document.createElement('input');
    this.input.className = 'value-input';
    this.input.hidden = true;
    this.vp.container.appendChild(this.input);
    this.input.addEventListener('keydown', (e) => this.onValueKey(e));
  }

  get entities() { return this.feature.params.entities; }

  // --- lifecycle -------------------------------------------------------------------------

  start(feature, panel) {
    this.feature = feature;
    this.panel = panel;
    feature.params.entities ||= [];
    const M = new THREE.Matrix4().fromArray(planeMatrix(feature.params.plane));
    this.matrix = M;
    this.inverse = M.clone().invert();
    this.group.matrix.copy(M);
    this.group.matrixWorldNeedsUpdate = true;
    const { o, n, v } = planeFrame(feature.params.plane);
    this.normal = new THREE.Vector3(...n);
    this.threePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.normal, new THREE.Vector3(...o));
    this.active = true;
    this.tool = feature.params.entities.length ? 'select' : 'line';
    this.selected = new Set();
    this.draft = null;
    this.hover = null;
    this.cursor = null;
    this.savedButtons = { ...this.vp.controls.mouseButtons };
    this.vp.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    this.vp.setGridVisible(false);
    // Look straight at the sketch plane.
    const box = new THREE.Box3();
    if (feature.params.entities.length) {
      for (const e of feature.params.entities) for (const p of entityPoints(e, 16).pts) box.expandByPoint(new THREE.Vector3(p[0], p[1], 0).applyMatrix4(M));
    } else {
      box.setFromCenterAndSize(new THREE.Vector3(...o), new THREE.Vector3(80, 80, 80));
    }
    if (!this.vp.bodyViews.size || feature.params.entities.length) this.vp.lookAlong(this.normal, new THREE.Vector3(...v), box);
    else this.vp.lookAlong(this.normal, new THREE.Vector3(...v), this.vp.modelBox().union(box));
    this.renderPanel();
    this.render();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.vp.controls.mouseButtons = this.savedButtons;
    this.vp.setGridVisible(true);
    this.input.hidden = true;
    this.clearGroup();
    this.feature = null;
  }

  clearGroup() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); if (o.element) o.element.remove(); });
    }
  }

  changed() {
    this.app.preview();
  }

  // --- coordinates and snapping ---------------------------------------------------------------

  localFromEvent(e) {
    const w = this.vp.pickPlane(e, this.threePlane);
    if (!w) return null;
    const l = w.clone().applyMatrix4(this.inverse);
    return [l.x, l.y];
  }

  tolerance() {
    const c = new THREE.Vector3().setFromMatrixPosition(this.matrix);
    return this.vp.worldPerPixel(this.cursorWorld || c) * 9;
  }

  snap(raw, from = null, exclude = null) {
    const tol = this.tolerance();
    let best = null, bestD = tol;
    const consider = (p, kind) => {
      const d = dist(p, raw);
      if (d < bestD) { bestD = d; best = { p: [p[0], p[1]], kind }; }
    };
    consider([0, 0], 'origin');
    for (const e of this.entities) {
      if (exclude && exclude.has(e.id)) continue;
      for (const s of snapPoints(e)) consider(s.p, s.kind);
    }
    if (this.draftStart) consider(this.draftStart, 'end');
    if (best) return best;
    let p = raw.slice();
    let kind = 'free';
    if (this.gridSnap && this.snapStep > 0) {
      p = [Math.round(p[0] / this.snapStep) * this.snapStep, Math.round(p[1] / this.snapStep) * this.snapStep];
      kind = 'grid';
    }
    if (from) {
      if (Math.abs(raw[1] - from[1]) < tol) { p[1] = from[1]; kind = 'horizontal'; }
      else if (Math.abs(raw[0] - from[0]) < tol) { p[0] = from[0]; kind = 'vertical'; }
    }
    return { p, kind };
  }

  hitEntity(p) {
    const tol = this.tolerance();
    let best = null, bestD = tol;
    for (const e of this.entities) {
      const { closed, pts } = entityPoints(e, 48);
      const n = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) {
        const d = segDist(p, pts[i], pts[(i + 1) % pts.length]);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (e.type === 'point' && dist(e.p, p) < bestD) { bestD = dist(e.p, p); best = e; }
    }
    return best;
  }

  /** Handles (draggable points) near p: list of { entity, key } that share the point. */
  hitHandle(p) {
    const tol = this.tolerance();
    let anchor = null, bestD = tol;
    for (const e of this.entities) {
      for (const h of handlesOf(e)) {
        const d = dist(h.p, p);
        if (d < bestD) { bestD = d; anchor = h.p; }
      }
    }
    if (!anchor) return null;
    const refs = [];
    for (const e of this.entities) for (const h of handlesOf(e)) if (dist(h.p, anchor) < 1e-6) refs.push({ entity: e, key: h.key });
    return { p: anchor, refs };
  }

  // --- pointer handling --------------------------------------------------------------------

  handle(type, e) {
    if (!this.active) return false;
    if (type === 'down' && e.button !== 0) return true;
    const raw = this.localFromEvent(e);
    if (!raw) return true;
    this.cursorWorld = new THREE.Vector3(raw[0], raw[1], 0).applyMatrix4(this.matrix);
    if (this.tool === 'select') return this.handleSelect(type, e, raw);

    const from = this.draft?.anchor || null;
    const s = this.snap(raw, this.tool === 'line' || this.tool === 'slot' ? from : null);
    this.cursor = s;
    if (type === 'move' || type === 'drag') {
      this.updateDraft(s.p);
      this.render();
    } else if (type === 'click') {
      this.clickTool(s.p, s);
      this.render();
    } else if (type === 'dblclick') {
      this.endDraft();
      this.render();
    }
    return true;
  }

  handleSelect(type, e, raw) {
    if (type === 'move') {
      const h = this.hitHandle(raw);
      const ent = h ? null : this.hitEntity(raw);
      this.hoverHandle = h;
      const hv = ent?.id || null;
      this.vp.renderer.domElement.style.cursor = h ? 'move' : ent ? 'pointer' : '';
      if (hv !== this.hover) { this.hover = hv; this.render(); }
    } else if (type === 'down') {
      const h = this.hitHandle(raw);
      const ent = h ? null : this.hitEntity(raw);
      if (h) {
        this.drag = { kind: 'handle', refs: h.refs, start: raw, moved: false };
      } else if (ent) {
        if (!this.selected.has(ent.id)) {
          if (!e.shiftKey) this.selected.clear();
          this.selected.add(ent.id);
          this.renderPanel();
        }
        this.drag = { kind: 'move', start: raw, moved: false };
      } else {
        this.drag = null;
      }
    } else if (type === 'drag' && this.drag) {
      if (!this.drag.moved) { this.app.checkpoint('Edit sketch'); this.drag.moved = true; }
      if (this.drag.kind === 'handle') {
        const ids = new Set(this.drag.refs.map((r) => r.entity.id));
        const s = this.snap(raw, null, ids);
        for (const r of this.drag.refs) setHandle(r.entity, r.key, s.p);
      } else {
        const step = this.gridSnap ? this.snapStep : 0;
        const total = [raw[0] - this.drag.start[0], raw[1] - this.drag.start[1]].map((v) => (step ? Math.round(v / step) * step : v));
        const applied = this.drag.applied || [0, 0];
        const d = [total[0] - applied[0], total[1] - applied[1]];
        if (d[0] || d[1]) {
          for (const id of this.selected) moveEntity(this.entities.find((x) => x.id === id), d);
          this.drag.applied = total;
        }
      }
      this.render();
      this.changed();
      this.renderPanel();
    } else if (type === 'up') {
      this.drag = null;
    } else if (type === 'click') {
      const ent = this.hitEntity(raw);
      if (!ent && !this.hitHandle(raw)) { this.selected.clear(); this.renderPanel(); this.render(); }
      else if (ent && !e.shiftKey && this.selected.size > 1) { this.selected = new Set([ent.id]); this.renderPanel(); this.render(); }
    }
    return true;
  }

  setTool(tool) {
    this.endDraft();
    this.tool = tool;
    this.hover = null;
    this.vp.renderer.domElement.style.cursor = tool === 'select' ? '' : 'crosshair';
    this.renderPanel();
    this.render();
  }

  addEntity(ent) {
    this.app.checkpoint('Sketch');
    ent.id = newId();
    if (this.construction) ent.construction = true;
    this.entities.push(ent);
    this.changed();
    return ent;
  }

  clickTool(p, s) {
    const d = this.draft;
    switch (this.tool) {
      case 'point':
        this.addEntity({ type: 'point', p });
        break;
      case 'line':
        if (!d) {
          this.draft = { anchor: p, cur: p };
          this.draftStart = p;
        } else if (dist(d.anchor, p) > 1e-9) {
          this.addEntity({ type: 'line', a: d.anchor, b: p });
          const closedLoop = this.draftStart && dist(p, this.draftStart) < 1e-9;
          if (closedLoop) this.endDraft();
          else this.draft = { anchor: p, cur: p };
        }
        break;
      case 'rect': case 'crect': case 'circle': case 'polygon':
        if (!d) this.draft = { anchor: p, cur: p };
        else { const ent = this.draftEntity(); if (ent) this.addEntity(ent); this.endDraft(); }
        break;
      case 'arc': case 'slot':
        if (!d) this.draft = { anchor: p, cur: p, stage: 0 };
        else if (d.stage === 0) { if (dist(d.anchor, p) > 1e-9) this.draft = { ...d, second: p, cur: p, stage: 1 }; }
        else { const ent = this.draftEntity(); if (ent) this.addEntity(ent); this.endDraft(); }
        break;
    }
  }

  updateDraft(p) {
    if (this.draft) this.draft.cur = p;
  }

  endDraft() {
    this.draft = null;
    this.draftStart = null;
    this.input.hidden = true;
  }

  /** The entity the current draft would create. */
  draftEntity() {
    const d = this.draft;
    if (!d) return null;
    const { anchor: a, cur: c } = d;
    switch (this.tool) {
      case 'line': return dist(a, c) > 1e-9 ? { type: 'line', a, b: c } : null;
      case 'rect': return Math.abs(a[0] - c[0]) > 1e-9 && Math.abs(a[1] - c[1]) > 1e-9 ? { type: 'rect', a, b: c } : null;
      case 'crect': {
        const o = [2 * a[0] - c[0], 2 * a[1] - c[1]];
        return Math.abs(a[0] - c[0]) > 1e-9 && Math.abs(a[1] - c[1]) > 1e-9 ? { type: 'rect', a: o, b: c } : null;
      }
      case 'circle': return dist(a, c) > 1e-9 ? { type: 'circle', c: a, r: r3(dist(a, c)) } : null;
      case 'polygon': return dist(a, c) > 1e-9 ? { type: 'polygon', c: a, r: r3(dist(a, c)), n: this.polygonSides, rot: Math.atan2(c[1] - a[1], c[0] - a[0]) } : null;
      case 'arc': {
        if (d.stage === 0) return dist(a, c) > 1e-9 ? { type: 'line', a, b: c, preview: true } : null;
        const arc = arcFrom3Points(a, c, d.second);
        return arc ? { type: 'arc', ...arc } : null;
      }
      case 'slot': {
        if (d.stage === 0) return dist(a, c) > 1e-9 ? { type: 'line', a, b: c, preview: true } : null;
        const r = segDist(c, a, d.second);
        return r > 1e-9 ? { type: 'slot', a, b: d.second, r: r3(r) } : null;
      }
    }
    return null;
  }

  // --- typed dimensions ----------------------------------------------------------------------

  onKey(e) {
    if (!this.active) return false;
    if (e.target === this.input) return true;
    if (this.draft && /^[0-9.]$/.test(e.key)) {
      const prompts = { line: 'Length', rect: 'Width, height', crect: 'Width, height', circle: 'Diameter', polygon: 'Radius', arc: null, slot: this.draft.stage ? 'Width' : 'Length' };
      const label = prompts[this.tool];
      if (!label) return false;
      this.input.hidden = false;
      this.input.placeholder = label;
      this.input.value = e.key;
      const r = this.vp.renderer.domElement.getBoundingClientRect();
      const s = this.cursorWorld.clone().project(this.vp.camera);
      this.input.style.left = `${((s.x + 1) / 2) * r.width + 16}px`;
      this.input.style.top = `${((1 - s.y) / 2) * r.height + 16}px`;
      this.input.focus();
      e.preventDefault();
      return true;
    }
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') {
      if (this.draft) this.endDraft();
      else if (this.tool !== 'select') this.setTool('select');
      else if (this.selected.size) this.selected.clear();
      else return false;
      this.renderPanel();
      this.render();
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected.size) {
      this.deleteSelected();
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const map = { v: 'select', l: 'line', r: e.shiftKey ? 'crect' : 'rect', c: 'circle', a: 'arc', p: 'polygon', s: 'slot', o: 'point' };
    if (map[k]) { this.setTool(map[k]); return true; }
    if (k === 'x') { this.toggleConstruction(); return true; }
    return false;
  }

  onValueKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') { this.input.hidden = true; this.vp.renderer.domElement.focus(); return; }
    if (e.key !== 'Enter') return;
    const nums = this.input.value.split(/[\s,x×]+/).map(parseFloat).filter((x) => !Number.isNaN(x));
    this.input.hidden = true;
    if (!nums.length || !this.draft) return;
    const d = this.draft;
    const a = d.anchor;
    let dir = [d.cur[0] - a[0], d.cur[1] - a[1]];
    const len = Math.hypot(...dir);
    dir = len > 1e-9 ? [dir[0] / len, dir[1] / len] : [1, 0];
    const sx = Math.sign(d.cur[0] - a[0]) || 1, sy = Math.sign(d.cur[1] - a[1]) || 1;
    switch (this.tool) {
      case 'line': {
        const b = [r3(a[0] + dir[0] * nums[0]), r3(a[1] + dir[1] * nums[0])];
        this.clickTool(b, { kind: 'typed' });
        break;
      }
      case 'rect': case 'crect': {
        const w = nums[0], h = nums[1] ?? nums[0];
        const half = this.tool === 'crect' ? 0.5 : 1;
        d.cur = [a[0] + sx * w * half, a[1] + sy * h * half];
        this.clickTool(d.cur, {});
        break;
      }
      case 'circle':
        d.cur = [a[0] + nums[0] / 2, a[1]];
        this.clickTool(d.cur, {});
        break;
      case 'polygon':
        d.cur = [a[0] + dir[0] * nums[0], a[1] + dir[1] * nums[0]];
        this.clickTool(d.cur, {});
        break;
      case 'slot':
        if (!d.stage) this.clickTool([a[0] + dir[0] * nums[0], a[1] + dir[1] * nums[0]], {});
        else {
          const ax = [d.second[0] - a[0], d.second[1] - a[1]];
          const l = Math.hypot(...ax);
          d.cur = [a[0] - (ax[1] / l) * nums[0] / 2, a[1] + (ax[0] / l) * nums[0] / 2];
          this.clickTool(d.cur, {});
        }
        break;
    }
    this.render();
    this.vp.renderer.domElement.focus();
  }

  // --- editing commands ------------------------------------------------------------------------

  deleteSelected() {
    if (!this.selected.size) return;
    this.app.checkpoint('Delete sketch entities');
    this.feature.params.entities = this.entities.filter((e) => !this.selected.has(e.id));
    this.selected.clear();
    this.changed();
    this.renderPanel();
    this.render();
  }

  toggleConstruction() {
    if (this.selected.size) {
      this.app.checkpoint('Construction');
      const on = ![...this.selected].every((id) => this.entities.find((e) => e.id === id)?.construction);
      for (const e of this.entities) if (this.selected.has(e.id)) e.construction = on;
      this.changed();
    } else {
      this.construction = !this.construction;
    }
    this.renderPanel();
    this.render();
  }

  /** Add the outline of every part cut by the sketch plane as sketch lines. */
  useSection() {
    const inv = this.inverse.elements;
    let added = 0;
    const lines = [];
    for (const body of this.app.state.bodies.values()) {
      const local = body.manifold.transform(Array.from(inv));
      const cs = local.slice(0);
      for (const poly of cs.toPolygons()) {
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          lines.push({ type: 'line', a: [r3(a[0]), r3(a[1])], b: [r3(b[0]), r3(b[1])] });
        }
      }
      cs.delete();
      local.delete();
    }
    if (!lines.length) { this.app.toast('No parts cross the sketch plane'); return; }
    this.app.checkpoint('Use section');
    for (const l of lines) { l.id = newId(); this.entities.push(l); added++; }
    this.changed();
    this.renderPanel();
    this.render();
    this.app.toast(`Added ${added} lines from the section`);
  }

  // --- rendering ----------------------------------------------------------------------------------

  render() {
    if (!this.active) return;
    this.clearGroup();
    const sk = this.app.state?.sketches.get(this.feature.id);
    const ents = this.entities;
    this.group.add(buildSketchObject(ents, { cs: sk?.cs, selected: this.selected, hover: this.hover, editing: true }));
    this.group.add(this.buildPlaneGrid());
    const ent = this.draftEntity();
    if (ent) {
      const g = buildSketchObject([{ ...ent, id: '_draft' }], { editing: true, selected: new Set(['_draft']) });
      this.group.add(g);
      const lbl = this.draftLabel(ent);
      if (lbl) {
        const at = this.draft.cur;
        this.group.add(this.vp.label(lbl, new THREE.Vector3(at[0], at[1], 0), 'tag dim'));
      }
    }
    if (this.cursor && this.tool !== 'select' && this.cursor.kind !== 'free' && this.cursor.kind !== 'grid') {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([this.cursor.p[0], this.cursor.p[1], 0], 3));
      const m = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xf0a020, size: 11, sizeAttenuation: false, depthTest: false }));
      m.renderOrder = 12;
      this.group.add(m);
      const names = { end: 'endpoint', mid: 'midpoint', center: 'centre', origin: 'origin', horizontal: 'horizontal', vertical: 'vertical' };
      if (names[this.cursor.kind]) this.group.add(this.vp.label(names[this.cursor.kind], new THREE.Vector3(this.cursor.p[0], this.cursor.p[1], 0), 'tag snap'));
    }
    // Labels for the selected entity's dimensions.
    for (const id of this.selected) {
      const e = ents.find((x) => x.id === id);
      const t = e && this.dimText(e);
      if (t) this.group.add(this.vp.label(t.text, new THREE.Vector3(t.at[0], t.at[1], 0), 'tag dim'));
    }
  }

  draftLabel(ent) {
    if (ent.type === 'line') return `${dist(ent.a, ent.b).toFixed(2)} mm`;
    if (ent.type === 'rect') return `${Math.abs(ent.b[0] - ent.a[0]).toFixed(2)} × ${Math.abs(ent.b[1] - ent.a[1]).toFixed(2)}`;
    if (ent.type === 'circle') return `⌀ ${(ent.r * 2).toFixed(2)}`;
    if (ent.type === 'polygon') return `R ${ent.r.toFixed(2)}`;
    if (ent.type === 'arc') return `R ${ent.r.toFixed(2)}`;
    if (ent.type === 'slot') return `W ${(ent.r * 2).toFixed(2)}`;
    return null;
  }

  dimText(e) {
    if (e.type === 'line') return { text: `${dist(e.a, e.b).toFixed(2)}`, at: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2] };
    if (e.type === 'circle') return { text: `⌀${(e.r * 2).toFixed(2)}`, at: [e.c[0] + e.r * 0.707, e.c[1] + e.r * 0.707] };
    if (e.type === 'rect') return { text: `${Math.abs(e.b[0] - e.a[0]).toFixed(2)} × ${Math.abs(e.b[1] - e.a[1]).toFixed(2)}`, at: [Math.max(e.a[0], e.b[0]), Math.max(e.a[1], e.b[1])] };
    if (e.type === 'arc' || e.type === 'polygon') return { text: `R${e.r.toFixed(2)}`, at: e.c };
    return null;
  }

  buildPlaneGrid() {
    const tgt = this.vp.controls.target.clone().applyMatrix4(this.inverse);
    const wpp = this.vp.worldPerPixel(this.vp.controls.target);
    const step = Math.max(this.snapStep || 1, Math.pow(10, Math.floor(Math.log10(wpp * 12))));
    const major = step * 10;
    const half = Math.ceil((wpp * Math.max(this.vp.container.clientWidth, this.vp.container.clientHeight)) / major) * major;
    const cx = Math.round(tgt.x / major) * major, cy = Math.round(tgt.y / major) * major;
    const minor = [], maj = [];
    for (let x = cx - half; x <= cx + half + 1e-9; x += step) {
      const arr = Math.abs(Math.round(x / major) * major - x) < step / 2 ? maj : minor;
      arr.push(x, cy - half, 0, x, cy + half, 0);
    }
    for (let y = cy - half; y <= cy + half + 1e-9; y += step) {
      const arr = Math.abs(Math.round(y / major) * major - y) < step / 2 ? maj : minor;
      arr.push(cx - half, y, 0, cx + half, y, 0);
    }
    const g = new THREE.Group();
    const dark = this.vp.dark;
    const mk = (arr, color, opacity) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      l.renderOrder = -1;
      return l;
    };
    g.add(mk(minor, dark ? 0x3a4250 : 0xc9d3e0, 0.55), mk(maj, dark ? 0x4d5666 : 0xaab6c7, 0.9));
    g.add(mk([-half * 2 + cx, 0, 0, half * 2 + cx, 0, 0], 0xe5484d, 0.7), mk([0, -half * 2 + cy, 0, 0, half * 2 + cy, 0], 0x30a46c, 0.7));
    return g;
  }

  // --- side panel ------------------------------------------------------------------------------------

  renderPanel() {
    if (!this.panel || !this.active) return;
    const p = this.panel;
    const toolButtons = TOOLS.map(([id, label, key]) =>
      `<button class="tool ${this.tool === id ? 'on' : ''}" data-tool="${id}" title="${label} (${key})">${icon(id, 18)}</button>`).join('');
    const sel = this.entities.filter((e) => this.selected.has(e.id));
    p.querySelector('.sk-tools').innerHTML = `
      <div class="toolgrid">${toolButtons}
        <button class="tool ${this.construction ? 'on' : ''}" data-act="construction" title="Construction geometry (X)">${icon('construction', 18)}</button>
      </div>
      <div class="row tight">
        <label class="chk"><input type="checkbox" data-act="gridsnap" ${this.gridSnap ? 'checked' : ''}> Snap to grid</label>
        <select data-act="snapstep">${[0.1, 0.5, 1, 2, 5, 10].map((s) => `<option value="${s}" ${s === this.snapStep ? 'selected' : ''}>${s} mm</option>`).join('')}</select>
      </div>
      ${this.tool === 'polygon' ? `<div class="row tight"><span>Sides</span><input type="number" min="3" max="64" step="1" data-act="sides" value="${this.polygonSides}"></div>` : ''}
      <div class="row tight">
        <button class="btn small" data-act="section" title="Add the outline of parts cut by this plane">Use part section</button>
        <button class="btn small" data-act="delete" ${sel.length ? '' : 'disabled'}>Delete</button>
      </div>
      <p class="hint">${this.hintText()}</p>`;
    p.querySelector('.sk-props').innerHTML = sel.length === 1 ? entityForm(sel[0]) : sel.length ? `<p class="hint">${sel.length} entities selected</p>` : `<p class="hint">${this.entities.length} entities. Select one to edit its dimensions.</p>`;
    p.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    const on = (sel2, ev, fn) => p.querySelector(sel2)?.addEventListener(ev, fn);
    on('[data-act=construction]', 'click', () => this.toggleConstruction());
    on('[data-act=gridsnap]', 'change', (e) => { this.gridSnap = e.target.checked; });
    on('[data-act=snapstep]', 'change', (e) => { this.snapStep = parseFloat(e.target.value); this.render(); });
    on('[data-act=sides]', 'change', (e) => { this.polygonSides = Math.max(3, Math.min(64, parseInt(e.target.value, 10) || 6)); });
    on('[data-act=section]', 'click', () => this.useSection());
    on('[data-act=delete]', 'click', () => this.deleteSelected());
    p.querySelectorAll('.sk-props input[data-field]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const ent = sel[0];
        this.app.checkpoint('Edit dimension');
        applyField(ent, inp.dataset.field, inp.type === 'checkbox' ? inp.checked : parseFloat(inp.value));
        this.changed();
        this.renderPanel();
        this.render();
      });
    });
  }

  hintText() {
    const h = {
      select: 'Click to select, drag points or shapes to move them. Delete removes.',
      line: 'Click points to draw connected lines. Click the start point to close, double-click or Esc to finish. Type a number for an exact length.',
      rect: 'Click two opposite corners. Type “w, h” for an exact size.',
      crect: 'Click the centre, then a corner. Type “w, h” for an exact size.',
      circle: 'Click the centre, then a point on the circle. Type a diameter.',
      arc: 'Click the start, the end, then a point the arc passes through.',
      polygon: 'Click the centre, then a corner. Type a radius.',
      slot: 'Click the two end centres, then set the width.',
      point: 'Click to place a point.',
    }[this.tool];
    return `${h} Middle-drag orbits, right-drag pans.`;
  }
}

// --- entity editing helpers --------------------------------------------------------------------------

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function handlesOf(e) {
  switch (e.type) {
    case 'line': return [{ key: 'a', p: e.a }, { key: 'b', p: e.b }];
    case 'rect': return [{ key: 'c0', p: e.a }, { key: 'c1', p: [e.b[0], e.a[1]] }, { key: 'c2', p: e.b }, { key: 'c3', p: [e.a[0], e.b[1]] }];
    case 'circle': case 'polygon': return [{ key: 'c', p: e.c }];
    case 'arc': { const [s, t] = arcEndpoints(e); return [{ key: 'c', p: e.c }, { key: 'start', p: s }, { key: 'end', p: t }]; }
    case 'slot': return [{ key: 'a', p: e.a }, { key: 'b', p: e.b }];
    case 'point': return [{ key: 'p', p: e.p }];
    default: return [];
  }
}

function setHandle(e, key, p) {
  const q = [p[0], p[1]];
  if (e.type === 'rect') {
    if (key === 'c0') e.a = q;
    else if (key === 'c2') e.b = q;
    else if (key === 'c1') { e.b = [q[0], e.b[1]]; e.a = [e.a[0], q[1]]; }
    else if (key === 'c3') { e.a = [q[0], e.a[1]]; e.b = [e.b[0], q[1]]; }
  } else if (e.type === 'arc' && (key === 'start' || key === 'end')) {
    const ang = Math.atan2(q[1] - e.c[1], q[0] - e.c[0]);
    if (key === 'start') e.a0 = ang; else e.a1 = ang;
  } else {
    e[key] = q;
  }
}

function moveEntity(e, d) {
  if (!e) return;
  const mv = (p) => [p[0] + d[0], p[1] + d[1]];
  for (const k of ['a', 'b', 'c', 'p']) if (e[k]) e[k] = mv(e[k]);
}

const num = (v) => (Math.round(v * 1000) / 1000).toString();

function entityForm(e) {
  const f = (field, label, value, unit = 'mm', extra = '') => `<label class="field"><span>${label}</span><span class="inputwrap"><input type="number" step="any" data-field="${field}" value="${num(value)}" ${extra}><em>${unit}</em></span></label>`;
  const rows = [];
  switch (e.type) {
    case 'line': {
      const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      const ang = (Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]) * 180) / Math.PI;
      rows.push(f('ax', 'Start X', e.a[0]), f('ay', 'Start Y', e.a[1]), f('bx', 'End X', e.b[0]), f('by', 'End Y', e.b[1]), f('length', 'Length', len), f('angle', 'Angle', ang, '°'));
      break;
    }
    case 'rect':
      rows.push(f('x', 'Corner X', Math.min(e.a[0], e.b[0])), f('y', 'Corner Y', Math.min(e.a[1], e.b[1])), f('w', 'Width', Math.abs(e.b[0] - e.a[0])), f('h', 'Height', Math.abs(e.b[1] - e.a[1])));
      break;
    case 'circle':
      rows.push(f('cx', 'Centre X', e.c[0]), f('cy', 'Centre Y', e.c[1]), f('d', 'Diameter', e.r * 2));
      break;
    case 'arc':
      rows.push(f('cx', 'Centre X', e.c[0]), f('cy', 'Centre Y', e.c[1]), f('r', 'Radius', e.r), f('a0', 'Start angle', (e.a0 * 180) / Math.PI, '°'), f('a1', 'End angle', (e.a1 * 180) / Math.PI, '°'));
      break;
    case 'polygon':
      rows.push(f('cx', 'Centre X', e.c[0]), f('cy', 'Centre Y', e.c[1]), f('r', 'Radius', e.r), f('n', 'Sides', e.n, '', 'min="3" step="1"'), f('rot', 'Rotation', ((e.rot || 0) * 180) / Math.PI, '°'));
      break;
    case 'slot':
      rows.push(f('ax', 'Centre 1 X', e.a[0]), f('ay', 'Centre 1 Y', e.a[1]), f('bx', 'Centre 2 X', e.b[0]), f('by', 'Centre 2 Y', e.b[1]), f('w', 'Width', e.r * 2));
      break;
    case 'point':
      rows.push(f('px', 'X', e.p[0]), f('py', 'Y', e.p[1]));
      break;
  }
  return `<div class="sk-entity"><div class="sk-entity-title">${ENTITY_LABELS[e.type]}${e.construction ? ' <em>(construction)</em>' : ''}</div>${rows.join('')}
    <label class="chk"><input type="checkbox" data-field="construction" ${e.construction ? 'checked' : ''}> Construction</label></div>`;
}

function applyField(e, field, v) {
  if (field === 'construction') { e.construction = v; return; }
  if (Number.isNaN(v)) return;
  const deg = (x) => (x * Math.PI) / 180;
  switch (e.type) {
    case 'line': {
      if (field === 'ax') e.a = [v, e.a[1]];
      if (field === 'ay') e.a = [e.a[0], v];
      if (field === 'bx') e.b = [v, e.b[1]];
      if (field === 'by') e.b = [e.b[0], v];
      const ang = Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]);
      const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      if (field === 'length' && v > 0) e.b = [e.a[0] + Math.cos(ang) * v, e.a[1] + Math.sin(ang) * v];
      if (field === 'angle') e.b = [e.a[0] + Math.cos(deg(v)) * len, e.a[1] + Math.sin(deg(v)) * len];
      break;
    }
    case 'rect': {
      let x = Math.min(e.a[0], e.b[0]), y = Math.min(e.a[1], e.b[1]);
      let w = Math.abs(e.b[0] - e.a[0]), h = Math.abs(e.b[1] - e.a[1]);
      if (field === 'x') x = v; if (field === 'y') y = v;
      if (field === 'w' && v > 0) w = v; if (field === 'h' && v > 0) h = v;
      e.a = [x, y]; e.b = [x + w, y + h];
      break;
    }
    case 'circle': case 'arc': case 'polygon':
      if (field === 'cx') e.c = [v, e.c[1]];
      if (field === 'cy') e.c = [e.c[0], v];
      if (field === 'd' && v > 0) e.r = v / 2;
      if (field === 'r' && v > 0) e.r = v;
      if (field === 'a0') e.a0 = deg(v);
      if (field === 'a1') e.a1 = deg(v);
      if (field === 'n') e.n = Math.max(3, Math.round(v));
      if (field === 'rot') e.rot = deg(v);
      break;
    case 'slot':
      if (field === 'ax') e.a = [v, e.a[1]];
      if (field === 'ay') e.a = [e.a[0], v];
      if (field === 'bx') e.b = [v, e.b[1]];
      if (field === 'by') e.b = [e.b[0], v];
      if (field === 'w' && v > 0) e.r = v / 2;
      break;
    case 'point':
      if (field === 'px') e.p = [v, e.p[1]];
      if (field === 'py') e.p = [e.p[0], v];
      break;
  }
}
