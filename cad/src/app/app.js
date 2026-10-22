// Application controller: document, history, selection and all UI panels.

import * as THREE from 'three';
import { FEATURES, defaultParams } from '../core/features.js';
import { Regenerator } from '../core/regen.js';
import { meshFromManifold } from '../core/kernel.js';
import { massProperties } from '../core/mesh.js';
import { planeFromFace, planeLabel, planeMatrix } from '../core/sketch.js';
import { Viewport, PALETTE } from './viewport.js';
import { Sketcher, buildSketchObject } from './sketcher.js';
import { icon } from './icons.js';
import {
  download, pickFiles, prepareMesh, describeRepair, serializeProject, parseProject, exportBodies, saveLocal, loadLocal, MESH_EXTENSIONS,
} from './files.js';
import { exampleDocument } from './example.js';

const MATERIALS = [
  ['PLA', 1.24], ['PETG', 1.27], ['ABS', 1.04], ['Nylon', 1.14], ['Resin', 1.18], ['Aluminium', 2.7], ['Steel', 7.85], ['Stainless steel', 8.0], ['Brass', 8.5], ['Titanium', 4.43], ['Wood (oak)', 0.75],
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x, d = 2) => (Math.abs(x) < 1e-9 ? '0' : (+x.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d }));

export function newDocument() {
  return { name: 'Untitled', features: [], rollback: null, bodyProps: {}, settings: { quality: 'normal' }, nextId: 1 };
}

export class App {
  constructor(root) {
    this.root = root;
    this.blobs = new Map();
    this.regen = new Regenerator(this.blobs);
    this.doc = newDocument();
    this.undoStack = [];
    this.redoStack = [];
    this.selection = new Set();
    this.selectedFeature = null;
    this.editing = null;
    this.mode = null; // null | 'measure' | { pick: fn }
    this.measurements = [];
    this.material = 'PLA';
    this.showSketches = true;

    this.$ = (sel) => document.querySelector(sel);
    this.viewport = new Viewport(this.$('#viewport'), {
      onPointer: (type, e) => this.onPointer(type, e),
      onCameraChange: () => { if (this.sketcher?.active) this.queueSketchRender(); },
    });
    this.sketcher = new Sketcher(this);
    this.measureGroup = new THREE.Group();
    this.viewport.overlay.add(this.measureGroup);

    this.buildToolbar();
    this.bindGlobalEvents();
    this.regenerate();
    this.viewport.setView('iso');
  }

  // --- document and history ----------------------------------------------------------------

  snapshot() {
    return JSON.stringify(this.doc);
  }

  /** Record the current document so the next change can be undone. */
  checkpoint(label = 'Change') {
    this.undoStack.push({ label, doc: this.snapshot() });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
  }

  restore(json) {
    this.doc = JSON.parse(json);
    this.rebindEditing();
    this.regenerate();
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return this.toast('Nothing to undo');
    this.redoStack.push({ label: entry.label, doc: this.snapshot() });
    this.restore(entry.doc);
    this.toast(`Undo: ${entry.label}`);
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return this.toast('Nothing to redo');
    this.undoStack.push({ label: entry.label, doc: this.snapshot() });
    this.restore(entry.doc);
    this.toast(`Redo: ${entry.label}`);
  }

  /** After undo/redo during an edit session, point the session at the new feature object. */
  rebindEditing() {
    if (!this.editing) return;
    const f = this.feature(this.editing.id);
    if (!f) {
      this.sketcher.stop();
      this.editing = null;
      this.closeDialog();
      return;
    }
    if (this.sketcher.active) {
      this.sketcher.feature = f;
      this.sketcher.selected = new Set([...this.sketcher.selected].filter((id) => f.params.entities.some((e) => e.id === id)));
      this.sketcher.renderPanel();
    } else {
      this.renderDialog();
    }
  }

  feature(id) {
    return this.doc.features.find((f) => f.id === id);
  }

  featureIndex(id) {
    return this.doc.features.findIndex((f) => f.id === id);
  }

  setDocument(doc, blobs) {
    this.endEditing(false);
    this.doc = { ...newDocument(), ...doc };
    if (blobs) { this.blobs.clear(); for (const [k, v] of blobs) this.blobs.set(k, v); }
    this.undoStack = [];
    this.redoStack = [];
    this.selection.clear();
    this.selectedFeature = null;
    this.clearMeasurements();
    this.regenerate();
    this.viewport.setView('iso', this.viewport.modelBox());
  }

  // --- regeneration ---------------------------------------------------------------------------

  /** Schedule a regeneration (coalesced to one per frame) for live previews. */
  preview() {
    if (this.previewQueued) return;
    this.previewQueued = true;
    requestAnimationFrame(() => {
      this.previewQueued = false;
      this.regenerate();
    });
  }

  regenerate() {
    const t0 = performance.now();
    const { state, results } = this.regen.run(this.doc);
    this.state = state;
    this.results = results;
    this.lastRegenMs = performance.now() - t0;
    for (const id of [...this.selection]) if (!state.bodies.has(id)) this.selection.delete(id);
    this.refreshScene();
    this.renderTree();
    this.renderParts();
    this.renderInfo();
    if (this.editing && !this.sketcher.active) {
      this.renderDialogStatus();
      const f = this.feature(this.editing.id);
      if (f?.type === 'transform') this.updateGizmo(f);
    }
    if (this.sketcher.active) this.sketcher.render();
    this.renderStatus();
    this.scheduleAutosave();
  }

  refreshScene() {
    const hidden = new Set(Object.entries(this.doc.bodyProps).filter(([, p]) => p.hidden).map(([id]) => id));
    const highlight = new Set();
    const field = this.activeField();
    if (field) {
      const f = this.feature(this.editing.id);
      const v = f?.params[field.key];
      (Array.isArray(v) ? v : v ? [v] : []).forEach((id) => highlight.add(id));
    }
    this.viewport.syncBodies(this.state.bodies, this.doc.bodyProps, { selected: this.selection, hidden, highlight });
    this.renderSketches();
  }

  /** Visible sketches: ones not yet used by a later feature, or the one a dialog refers to. */
  renderSketches() {
    const g = this.viewport.sketchGroup;
    for (const c of [...g.children]) { g.remove(c); c.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); o.element?.remove(); }); }
    if (!this.showSketches) return;
    const consumed = new Set();
    for (const f of this.doc.features) if (f.params?.sketch && !f.suppressed) consumed.add(f.params.sketch);
    const editingF = this.editing && this.feature(this.editing.id);
    const focus = editingF?.params?.sketch;
    for (const sk of this.state.sketches.values()) {
      if (this.sketcher.active && this.sketcher.feature?.id === sk.id) continue;
      const f = this.feature(sk.id);
      const show = f?.show ?? !consumed.has(sk.id);
      if (!show && focus !== sk.id) continue;
      const obj = buildSketchObject(sk.entities, { cs: sk.cs, regions: focus === sk.id });
      obj.matrixAutoUpdate = false;
      obj.matrix.fromArray(planeMatrix(sk.plane));
      if (focus === sk.id && obj.userData.regionCenters?.length > 1) {
        obj.userData.regionCenters.forEach((c, i) => obj.add(this.viewport.label(String(i + 1), new THREE.Vector3(c[0], c[1], 0), 'tag region')));
      }
      g.add(obj);
    }
  }

  queueSketchRender() {
    if (this.sketchRenderQueued) return;
    this.sketchRenderQueued = true;
    requestAnimationFrame(() => { this.sketchRenderQueued = false; this.sketcher.render(); });
  }

  // --- feature editing ---------------------------------------------------------------------------

  defaultsFor(type) {
    const params = defaultParams(type);
    const sel = [...this.selection];
    const insertAt = this.doc.rollback ?? this.doc.features.length;
    const before = this.doc.features.slice(0, insertAt);
    const lastSketch = [...before].reverse().find((f) => f.type === 'sketch');
    const chosenSketch = this.selectedFeature && this.feature(this.selectedFeature)?.type === 'sketch' ? this.selectedFeature : lastSketch?.id;
    if ('sketch' in params) {
      params.sketch = chosenSketch || null;
      const plane = this.feature(chosenSketch)?.params.plane;
      if (plane?.bodyId && this.state.bodies.has(plane.bodyId)) {
        params.operation = 'add';
        params.targets = [plane.bodyId];
      }
    }
    if ('bodies' in params) params.bodies = sel;
    if (type === 'boolean') { params.target = sel[0] || null; params.tools = sel.slice(1); }
    if (type === 'hole' && sel.length) params.targets = sel;
    return params;
  }

  /** Create a feature and open its dialog. */
  startFeature(type, overrides = {}) {
    if (this.editing) this.okEdit();
    this.setMode(null);
    const def = FEATURES[type];
    const startUndo = this.undoStack.length;
    const before = this.snapshot();
    this.checkpoint(`Add ${def.label}`);
    const count = this.doc.features.filter((f) => f.type === type).length + 1;
    const f = { id: `f${this.doc.nextId++}`, type, name: `${def.label} ${count}`, params: { ...this.defaultsFor(type), ...overrides } };
    const at = this.doc.rollback ?? this.doc.features.length;
    this.doc.features.splice(at, 0, f);
    if (this.doc.rollback != null) this.doc.rollback++;
    this.selectedFeature = f.id;
    this.editing = { id: f.id, isNew: true, snapshot: before, startUndo };
    this.openEditor(f);
    this.regenerate();
    return f;
  }

  editFeature(id) {
    if (this.editing?.id === id) return;
    if (this.editing) this.okEdit();
    const f = this.feature(id);
    if (!f) return;
    this.setMode(null);
    const before = this.snapshot();
    const startUndo = this.undoStack.length;
    this.checkpoint(`Edit ${f.name}`);
    this.editing = { id, isNew: false, snapshot: before, startUndo };
    this.selectedFeature = id;
    this.openEditor(f);
    this.regenerate();
  }

  openEditor(f) {
    if (f.type === 'sketch') this.openSketchDialog(f);
    else this.renderDialog();
  }

  okEdit() {
    if (!this.editing) return;
    const f = this.feature(this.editing.id);
    // Collapse the session into one undo step.
    this.undoStack.length = this.editing.startUndo;
    this.undoStack.push({ label: `${this.editing.isNew ? 'Add' : 'Edit'} ${f?.name || 'feature'}`, doc: this.editing.snapshot });
    if (f?.type === 'sketch' && !f.params.plane) {
      // A sketch that never got a plane is discarded.
      this.doc.features.splice(this.featureIndex(f.id), 1);
      this.undoStack.pop();
    }
    this.endEditing(true);
  }

  cancelEdit() {
    if (!this.editing) return;
    const { snapshot, startUndo } = this.editing;
    this.undoStack.length = startUndo;
    this.endEditing(false);
    this.doc = JSON.parse(snapshot);
    this.regenerate();
  }

  endEditing(regen) {
    if (!this.editing) return;
    this.sketcher.stop();
    this.viewport.detachGizmo();
    this.editing = null;
    this.activeFieldKey = null;
    this.setMode(null);
    this.closeDialog();
    if (regen) this.regenerate();
  }

  setParam(key, value, { regen = true } = {}) {
    const f = this.feature(this.editing?.id);
    if (!f) return;
    f.params[key] = value;
    // Cutting from a sketch on a face should go into the part by default.
    if (f.type === 'extrude' && key === 'operation' && value === 'subtract' && f.params.direction === 'normal') {
      const plane = this.feature(f.params.sketch)?.params.plane;
      if (plane?.type === 'custom') f.params.direction = 'reverse';
    }
    if (regen) this.preview();
  }

  // --- dialog -----------------------------------------------------------------------------------

  activeField() {
    if (!this.editing || this.sketcher.active) return null;
    const f = this.feature(this.editing.id);
    if (!f) return null;
    const fields = FEATURES[f.type].params.filter((p) => (p.type === 'bodies' || p.type === 'body') && (!p.show || p.show(f.params)));
    return fields.find((p) => p.key === this.activeFieldKey) || fields[0] || null;
  }

  renderDialog() {
    const f = this.feature(this.editing?.id);
    if (!f) return;
    const def = FEATURES[f.type];
    const dlg = this.$('#dialog');
    dlg.hidden = false;
    dlg.className = 'dialog';
    const fields = def.params.filter((p) => !p.show || p.show(f.params));
    const active = this.activeField();
    dlg.innerHTML = `
      <header>${icon(def.icon, 18)}<input class="dlg-title" value="${esc(f.name)}" aria-label="Feature name">
        <button class="iconbtn ok" title="Accept (Enter)">${icon('check', 18)}</button>
        <button class="iconbtn cancel" title="Cancel (Esc)">${icon('close', 18)}</button></header>
      <div class="dlg-body">${fields.map((p) => this.fieldHTML(f, p, active)).join('')}</div>
      <footer class="dlg-status"></footer>`;
    dlg.querySelector('.ok').onclick = () => this.okEdit();
    dlg.querySelector('.cancel').onclick = () => this.cancelEdit();
    dlg.querySelector('.dlg-title').onchange = (e) => { f.name = e.target.value || f.name; this.renderTree(); };
    this.bindFields(dlg, f, def);
    this.renderDialogStatus();
    this.updateGizmo(f);
    if (f.type === 'hole' && this.editing.isNew && !this.holePicked) this.startFacePick((hit) => this.placeHole(hit));
  }

  fieldHTML(f, p, active) {
    const v = f.params[p.key];
    const unit = p.unit ? `<em>${esc(p.unit)}</em>` : '';
    const hint = p.hint ? `<small>${esc(p.hint)}</small>` : '';
    const wrap = (inner, cls = '') => `<div class="field ${cls}" data-key="${p.key}"><span class="lbl">${esc(p.label)}</span>${inner}${hint}</div>`;
    switch (p.type) {
      case 'number': case 'int':
        return wrap(`<span class="inputwrap"><input type="number" data-k="${p.key}" value="${v ?? ''}" step="${p.type === 'int' ? 1 : 'any'}" ${p.min != null ? `min="${p.min}"` : ''} ${p.max != null ? `max="${p.max}"` : ''}>${unit}</span>`);
      case 'text':
        return wrap(`<input type="text" data-k="${p.key}" value="${esc(v)}">`);
      case 'bool':
        return `<label class="field chk" data-key="${p.key}"><input type="checkbox" data-k="${p.key}" ${v ? 'checked' : ''}> ${esc(p.label)}${hint}</label>`;
      case 'select':
        return wrap(`<select data-k="${p.key}">${p.options.map(([val, label]) => `<option value="${val}" ${String(v) === String(val) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`);
      case 'vec3':
        return wrap(`<span class="vec3">${['X', 'Y', 'Z'].map((ax, i) => `<label><b>${ax}</b><input type="number" step="any" data-k="${p.key}" data-i="${i}" value="${v?.[i] ?? 0}"></label>`).join('')}</span>${unit ? `<span class="unit">${esc(p.unit)}</span>` : ''}`);
      case 'sketch': {
        const idx = this.featureIndex(f.id);
        const sketches = this.doc.features.slice(0, idx).filter((x) => x.type === 'sketch');
        return wrap(`<select data-k="${p.key}"><option value="">— choose a sketch —</option>${sketches.map((s) => `<option value="${s.id}" ${s.id === v ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`);
      }
      case 'body': case 'bodies': {
        const ids = p.type === 'body' ? (v ? [v] : []) : v || [];
        const chips = ids.map((id) => `<span class="chip" style="--c:${this.bodyColor(id)}">${esc(this.bodyName(id))}<button data-remove="${id}" title="Remove">×</button></span>`).join('');
        const isActive = active?.key === p.key;
        return wrap(`<div class="picker ${isActive ? 'active' : ''}" data-pick="${p.key}" tabindex="0">${chips || `<span class="placeholder">${isActive ? 'Click parts in the view' : 'Click to choose parts'}</span>`}</div>`);
      }
      case 'pickFace':
        return wrap(`<button class="btn small ${this.mode?.pick ? 'on' : ''}" data-pickface>${icon('select', 16)} ${this.mode?.pick ? 'Click a face…' : 'Pick a face'}</button>`);
      default:
        return '';
    }
  }

  bindFields(dlg, f, def) {
    dlg.querySelectorAll('[data-k]').forEach((el) => {
      const p = def.params.find((x) => x.key === el.dataset.k);
      const read = () => {
        if (p.type === 'bool') return el.checked;
        if (p.type === 'number') return el.value === '' ? f.params[p.key] : parseFloat(el.value);
        if (p.type === 'int') return Math.round(parseFloat(el.value) || p.min || 1);
        if (p.type === 'vec3') { const arr = [...f.params[p.key]]; arr[+el.dataset.i] = parseFloat(el.value) || 0; return arr; }
        if (p.type === 'sketch') return el.value || null;
        return el.value;
      };
      const structural = p.type === 'select' || p.type === 'bool' || p.type === 'sketch';
      el.addEventListener(structural ? 'change' : 'input', () => {
        this.setParam(p.key, read());
        if (structural) this.renderDialog();
      });
    });
    dlg.querySelectorAll('[data-pick]').forEach((el) => {
      el.addEventListener('click', (e) => {
        const rm = e.target.closest('[data-remove]');
        const p = def.params.find((x) => x.key === el.dataset.pick);
        if (rm) {
          const id = rm.dataset.remove;
          this.setParam(p.key, p.type === 'body' ? null : f.params[p.key].filter((x) => x !== id));
        }
        this.activeFieldKey = p.key;
        this.renderDialog();
        this.refreshScene();
      });
    });
    dlg.querySelector('[data-pickface]')?.addEventListener('click', () => {
      if (this.mode?.pick) this.setMode(null);
      else this.startFacePick((hit) => this.placeHole(hit));
      this.renderDialog();
    });
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); e.target.blur?.(); this.okEdit(); }
      if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(); }
      e.stopPropagation();
    });
  }

  renderDialogStatus() {
    const el = this.$('#dialog .dlg-status');
    if (!el || !this.editing) return;
    const r = this.results?.get(this.editing.id);
    if (!r) { el.innerHTML = ''; return; }
    if (r.status === 'error') el.innerHTML = `<span class="err">${icon('error', 16)} ${esc(r.message)}</span>`;
    else if (r.status === 'warning') el.innerHTML = `<span class="warn">${icon('warning', 16)} ${esc(r.message)}</span>`;
    else if (r.status === 'rolledback') el.innerHTML = '<span class="warn">This feature is after the rollback bar</span>';
    else el.innerHTML = `<span class="okmsg">${icon('check', 16)} Preview up to date · ${fmt(r.ms ?? 0, 0)} ms</span>`;
  }

  closeDialog() {
    const dlg = this.$('#dialog');
    dlg.hidden = true;
    dlg.innerHTML = '';
  }

  // --- sketch dialog ---------------------------------------------------------------------------------

  openSketchDialog(f) {
    const dlg = this.$('#dialog');
    dlg.hidden = false;
    dlg.className = 'dialog sketch';
    const def = FEATURES.sketch;
    if (!f.params.plane) {
      dlg.innerHTML = `
        <header>${icon('sketch', 18)}<input class="dlg-title" value="${esc(f.name)}">
          <button class="iconbtn cancel" title="Cancel (Esc)">${icon('close', 18)}</button></header>
        <div class="dlg-body">
          <p class="hint strong">Choose a sketch plane, or click a flat face of a part.</p>
          <div class="planes">
            <button class="btn" data-plane="XY">${icon('rect', 16)} Top (XY)</button>
            <button class="btn" data-plane="XZ">${icon('rect', 16)} Front (XZ)</button>
            <button class="btn" data-plane="YZ">${icon('rect', 16)} Right (YZ)</button>
          </div>
          <div class="field"><span class="lbl">Offset</span><span class="inputwrap"><input type="number" step="any" value="0" class="plane-offset"><em>mm</em></span></div>
        </div>`;
      dlg.querySelector('.cancel').onclick = () => this.cancelEdit();
      dlg.querySelectorAll('[data-plane]').forEach((b) => b.addEventListener('click', () => {
        const offset = parseFloat(dlg.querySelector('.plane-offset').value) || 0;
        this.beginSketch(f, { type: b.dataset.plane, offset });
      }));
      this.startFacePick((hit) => {
        const plane = planeFromFace(hit.point.toArray(), hit.normal.toArray());
        plane.bodyId = hit.bodyId;
        this.beginSketch(f, plane);
      }, { planarOnly: true });
      return;
    }
    this.setMode(null);
    dlg.innerHTML = `
      <header>${icon('sketch', 18)}<input class="dlg-title" value="${esc(f.name)}">
        <button class="iconbtn ok" title="Finish sketch (Enter)">${icon('check', 18)}</button>
        <button class="iconbtn cancel" title="Cancel (Esc)">${icon('close', 18)}</button></header>
      <div class="dlg-body">
        <div class="sk-plane">${icon('rect', 14)} ${esc(planeLabel(f.params.plane))}</div>
        <div class="sk-tools"></div>
        <div class="sk-props"></div>
        <details class="sk-settings"><summary>Profile options</summary>
          ${def.params.map((p) => this.fieldHTML(f, p)).join('')}
        </details>
      </div>
      <footer class="dlg-status"></footer>`;
    dlg.querySelector('.ok').onclick = () => this.okEdit();
    dlg.querySelector('.cancel').onclick = () => this.cancelEdit();
    dlg.querySelector('.dlg-title').onchange = (e) => { f.name = e.target.value || f.name; this.renderTree(); };
    dlg.querySelectorAll('.sk-settings [data-k]').forEach((el) => {
      el.addEventListener('change', () => {
        const p = def.params.find((x) => x.key === el.dataset.k);
        this.feature(f.id).params[p.key] = p.type === 'number' ? parseFloat(el.value) || 0 : el.value;
        this.preview();
      });
    });
    this.sketcher.start(f, dlg);
    this.regenerate();
  }

  beginSketch(f, plane) {
    this.setMode(null);
    f.params.plane = plane;
    this.openSketchDialog(f);
  }

  // --- modes: face picking, measuring --------------------------------------------------------------------

  setMode(mode) {
    this.mode = mode;
    this.viewport.showHoverFace(null);
    this.viewport.renderer.domElement.style.cursor = mode ? 'crosshair' : '';
    this.$('#tb-measure')?.classList.toggle('on', mode === 'measure');
    this.$('#measure-panel').hidden = mode !== 'measure' && !this.measurements.length;
    if (mode !== 'measure') this.measureStart = null;
    this.renderMeasurements();
  }

  startFacePick(fn, opts = {}) {
    this.mode = { pick: fn, ...opts };
    this.viewport.renderer.domElement.style.cursor = 'crosshair';
  }

  placeHole(hit) {
    this.holePicked = true;
    const snap = this.viewport.snapVertex(hit, 10);
    const p = (snap || hit.point).toArray().map((x) => Math.round(x * 1000) / 1000);
    this.setParam('position', p, { regen: false });
    this.setParam('normal', hit.normal.toArray().map((x) => Math.round(x * 1e6) / 1e6), { regen: false });
    const f = this.feature(this.editing.id);
    if (!f.params.targets.length) f.params.targets = [hit.bodyId];
    this.setMode(null);
    this.renderDialog();
    this.preview();
    this.holePicked = false;
  }

  onPointer(type, e) {
    if (this.sketcher.active) { this.sketcher.handle(type, e); return; }
    const vp = this.viewport;
    if (this.mode?.pick) {
      if (type === 'move') {
        const hit = vp.pickBody(e);
        vp.showHoverFace(hit);
      } else if (type === 'click' && e.button === 0) {
        const hit = vp.pickBody(e);
        if (hit) { vp.showHoverFace(null); this.mode.pick(hit); }
      }
      return;
    }
    if (this.mode === 'measure') { this.measurePointer(type, e); return; }
    if (type === 'move') {
      const hit = vp.pickBody(e);
      const id = hit?.bodyId || null;
      if (id !== this.hoverBody) {
        this.hoverBody = id;
        vp.renderer.domElement.style.cursor = id ? 'pointer' : '';
        this.renderStatus();
      }
    } else if (type === 'click' && e.button === 0) {
      const hit = vp.pickBody(e);
      const field = this.activeField();
      if (field && hit) {
        const f = this.feature(this.editing.id);
        if (field.type === 'body') this.setParam(field.key, hit.bodyId);
        else {
          const list = f.params[field.key] || [];
          this.setParam(field.key, list.includes(hit.bodyId) ? list.filter((x) => x !== hit.bodyId) : [...list, hit.bodyId]);
        }
        this.renderDialog();
        return;
      }
      if (this.editing) return;
      if (!hit) { if (!e.shiftKey) this.select([]); return; }
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const s = new Set(this.selection);
        s.has(hit.bodyId) ? s.delete(hit.bodyId) : s.add(hit.bodyId);
        this.select([...s]);
      } else this.select([hit.bodyId]);
    } else if (type === 'dblclick') {
      const hit = vp.pickBody(e);
      const body = hit && this.state.bodies.get(hit.bodyId);
      if (body && !this.editing) this.editFeature(body.featureId.split('.')[0]);
    }
  }

  select(ids) {
    this.selection = new Set(ids);
    this.refreshScene();
    this.renderParts();
    this.renderInfo();
    this.renderStatus();
  }

  // --- measuring ------------------------------------------------------------------------------------------

  measurePointer(type, e) {
    const vp = this.viewport;
    if (type !== 'move' && type !== 'click') return;
    const hit = vp.pickBody(e);
    const p = hit ? (vp.snapVertex(hit) || hit.point).clone() : null;
    if (type === 'move') {
      this.measureHover = p;
      this.renderMeasurements();
      return;
    }
    if (e.button !== 0 || !p) return;
    if (!this.measureStart) {
      this.measureStart = p;
    } else {
      this.measurements.push({ a: this.measureStart, b: p });
      this.measureStart = null;
    }
    this.$('#measure-panel').hidden = false;
    this.renderMeasurements();
  }

  clearMeasurements() {
    this.measurements = [];
    this.measureStart = null;
    this.renderMeasurements();
  }

  renderMeasurements() {
    const g = this.measureGroup;
    for (const c of [...g.children]) { g.remove(c); c.geometry?.dispose(); c.element?.remove(); }
    const dot = (p, color) => {
      const geo = new THREE.BufferGeometry().setFromPoints([p]);
      const m = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 9, sizeAttenuation: false, depthTest: false }));
      m.renderOrder = 20;
      g.add(m);
    };
    const line = (a, b) => {
      const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
      const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xf0a020, depthTest: false }));
      l.renderOrder = 20;
      g.add(l);
    };
    this.measurements.forEach((m, i) => {
      line(m.a, m.b);
      dot(m.a, 0xf0a020); dot(m.b, 0xf0a020);
      g.add(this.viewport.label(`${i + 1}: ${fmt(m.a.distanceTo(m.b), 3)} mm`, m.a.clone().lerp(m.b, 0.5), 'tag measure'));
    });
    if (this.mode === 'measure') {
      if (this.measureStart) {
        dot(this.measureStart, 0x2f7cf6);
        if (this.measureHover) {
          line(this.measureStart, this.measureHover);
          g.add(this.viewport.label(`${fmt(this.measureStart.distanceTo(this.measureHover), 3)} mm`, this.measureStart.clone().lerp(this.measureHover, 0.5), 'tag measure'));
        }
      }
      if (this.measureHover) dot(this.measureHover, 0x2f7cf6);
    }
    const panel = this.$('#measure-panel');
    if (!panel) return;
    panel.innerHTML = `<header>${icon('measure', 16)} Measure <button class="iconbtn" data-close title="Close">${icon('close', 14)}</button></header>
      <p class="hint">${this.mode === 'measure' ? (this.measureStart ? 'Click a second point.' : 'Click a point on a part (snaps to corners).') : 'Measure tool is off.'}</p>
      ${this.measurements.map((m, i) => {
        const d = m.b.clone().sub(m.a);
        return `<div class="mrow"><b>${i + 1}</b> ${fmt(d.length(), 3)} mm <small>ΔX ${fmt(d.x, 3)} · ΔY ${fmt(d.y, 3)} · ΔZ ${fmt(d.z, 3)}</small></div>`;
      }).join('')}
      ${this.measurements.length ? '<button class="btn small" data-clear>Clear all</button>' : ''}`;
    panel.querySelector('[data-close]').onclick = () => { this.clearMeasurements(); this.setMode(null); panel.hidden = true; };
    panel.querySelector('[data-clear]')?.addEventListener('click', () => this.clearMeasurements());
  }

  // --- gizmo for Move / Rotate -------------------------------------------------------------------------------

  updateGizmo(f) {
    const vp = this.viewport;
    if (f.type !== 'transform' || !f.params.bodies?.length) { vp.detachGizmo(); return; }
    const box = new THREE.Box3();
    for (const id of f.params.bodies) {
      const b = this.bodyBeforeFeature(f, id);
      if (b) { const bb = b.manifold.boundingBox(); box.expandByPoint(new THREE.Vector3(...bb.min)); box.expandByPoint(new THREE.Vector3(...bb.max)); }
    }
    if (box.isEmpty()) return;
    const pivot = f.params.pivot === 'origin' ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const mode = this.gizmoMode || 'translate';
    if (!vp.gizmo.object || this.gizmoFor !== f.id || this.gizmoModeFor !== mode || !vp.gizmoPivot.equals(pivot)) {
      this.gizmoFor = f.id;
      this.gizmoModeFor = mode;
      vp.attachGizmo(pivot, mode, (t, rot) => {
        const r = (x) => Math.round(x * 1000) / 1000;
        const ff = this.feature(this.editing?.id);
        if (!ff) return;
        ff.params.translate = [r(t.x), r(t.y), r(t.z)];
        ff.params.rotate = [rot.x, rot.y, rot.z].map((a) => r(THREE.MathUtils.radToDeg(a)));
        this.syncDialogInputs(ff);
        this.preview();
      });
    }
    vp.setGizmoState(new THREE.Vector3(...f.params.translate), f.params.rotate);
  }

  syncDialogInputs(f) {
    for (const key of ['translate', 'rotate']) {
      this.$('#dialog')?.querySelectorAll(`[data-k="${key}"]`).forEach((el) => { el.value = f.params[key][+el.dataset.i]; });
    }
  }

  /** The body as it was before feature `f` ran (for gizmo pivots). */
  bodyBeforeFeature(f, id) {
    return this.regen.stateBefore?.get(f.id)?.bodies.get(id);
  }

  // --- panels: feature tree ---------------------------------------------------------------------------------

  renderTree() {
    const el = this.$('#tree');
    const rb = this.doc.rollback ?? this.doc.features.length;
    const rows = [];
    this.doc.features.forEach((f, i) => {
      if (i === rb) rows.push(this.rollbackRow());
      const def = FEATURES[f.type] || { label: f.type, icon: 'part' };
      const r = this.results?.get(f.id) || {};
      const status = r.status === 'error' ? `<span class="st err" title="${esc(r.message)}">${icon('error', 15)}</span>`
        : r.status === 'warning' ? `<span class="st warn" title="${esc(r.message)}">${icon('warning', 15)}</span>` : '';
      const desc = def.describe ? esc(def.describe(f)) : '';
      const sketchEye = f.type === 'sketch' ? `<button class="iconbtn tiny eye" data-eye="${f.id}" title="Show or hide sketch">${icon(this.sketchVisible(f) ? 'eye' : 'eyeOff', 14)}</button>` : '';
      rows.push(`<div class="frow ${f.id === this.selectedFeature ? 'sel' : ''} ${f.suppressed ? 'suppressed' : ''} ${i >= rb ? 'rolled' : ''} ${this.editing?.id === f.id ? 'editing' : ''}" data-id="${f.id}" draggable="true">
        ${icon(def.icon, 17)}<span class="fname">${esc(f.name)}</span><span class="fdesc">${desc}</span>${status}${sketchEye}</div>`);
    });
    if (rb >= this.doc.features.length && this.doc.features.length) rows.push(this.rollbackRow());
    el.innerHTML = rows.join('') || '<p class="empty">No features yet.<br>Start with a <b>Sketch</b>, a primitive, or <b>Import</b> an STL.</p>';
    el.querySelectorAll('.frow').forEach((row) => {
      const id = row.dataset.id;
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-eye]')) return;
        this.selectedFeature = id;
        const f = this.feature(id);
        // Selecting a feature selects the parts it made.
        const made = [...this.state.bodies.values()].filter((b) => b.featureId.split('.')[0] === id).map((b) => b.id);
        if (made.length) this.select(made);
        else this.renderTree();
        if (f.type === 'sketch') this.renderTree();
      });
      row.addEventListener('dblclick', () => this.editFeature(id));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.featureMenu(id, e.clientX, e.clientY); });
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/feature', id); row.classList.add('dragging'); });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('dropover'); });
      row.addEventListener('dragleave', () => row.classList.remove('dropover'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('dropover');
        const src = e.dataTransfer.getData('text/feature');
        if (src && src !== id) this.moveFeatureTo(src, this.featureIndex(id));
      });
    });
    el.querySelectorAll('[data-eye]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const f = this.feature(b.dataset.eye);
      f.show = !this.sketchVisible(f);
      this.renderTree();
      this.renderSketches();
    }));
    const bar = el.querySelector('.rollback');
    if (bar) {
      bar.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/rollback', '1'));
      el.querySelectorAll('.frow').forEach((row) => row.addEventListener('drop', (e) => {
        if (e.dataTransfer.getData('text/rollback')) this.setRollback(this.featureIndex(row.dataset.id) + 1);
      }));
      bar.querySelector('button')?.addEventListener('click', () => this.setRollback(null));
    }
  }

  rollbackRow() {
    const atEnd = this.doc.rollback == null;
    return `<div class="rollback ${atEnd ? 'end' : ''}" draggable="true" title="Drag onto a feature to roll the model back to it">
      <span></span>${atEnd ? '' : `<button class="btn tiny">Roll to end</button>`}</div>`;
  }

  sketchVisible(f) {
    if (f.show != null) return f.show;
    return !this.doc.features.some((g) => g.params?.sketch === f.id && !g.suppressed);
  }

  setRollback(index) {
    this.endEditing(false);
    this.checkpoint('Roll back');
    this.doc.rollback = index == null || index >= this.doc.features.length ? null : Math.max(0, index);
    this.regenerate();
  }

  moveFeatureTo(id, to) {
    this.checkpoint('Reorder');
    const from = this.featureIndex(id);
    const [f] = this.doc.features.splice(from, 1);
    this.doc.features.splice(Math.max(0, Math.min(to, this.doc.features.length)), 0, f);
    this.regenerate();
  }

  featureMenu(id, x, y) {
    const f = this.feature(id);
    const i = this.featureIndex(id);
    this.contextMenu(x, y, [
      ['Edit', () => this.editFeature(id)],
      ['Rename', () => this.renameFeature(id)],
      [f.suppressed ? 'Unsuppress' : 'Suppress', () => { this.checkpoint('Suppress'); f.suppressed = !f.suppressed; this.regenerate(); }],
      ['Roll back to here', () => this.setRollback(i + 1)],
      f.type === 'sketch' ? [this.sketchVisible(f) ? 'Hide sketch' : 'Show sketch', () => { f.show = !this.sketchVisible(f); this.renderTree(); this.renderSketches(); }] : null,
      ['Move up', () => this.moveFeatureTo(id, i - 1), i === 0],
      ['Move down', () => this.moveFeatureTo(id, i + 1), i === this.doc.features.length - 1],
      '-',
      ['Delete', () => this.deleteFeature(id), false, 'danger'],
    ]);
  }

  renameFeature(id) {
    const row = this.$(`#tree .frow[data-id="${id}"] .fname`);
    const f = this.feature(id);
    if (!row) return;
    const input = document.createElement('input');
    input.value = f.name;
    input.className = 'rename';
    row.replaceWith(input);
    input.focus();
    input.select();
    const done = (save) => {
      if (save && input.value.trim() && input.value !== f.name) { this.checkpoint('Rename'); f.name = input.value.trim(); }
      this.renderTree();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    input.addEventListener('blur', () => done(true));
  }

  deleteFeature(id) {
    if (this.editing?.id === id) this.cancelEdit();
    this.checkpoint('Delete feature');
    const i = this.featureIndex(id);
    this.doc.features.splice(i, 1);
    if (this.doc.rollback != null && i < this.doc.rollback) this.doc.rollback--;
    if (this.selectedFeature === id) this.selectedFeature = null;
    this.regenerate();
  }

  // --- panels: parts list -----------------------------------------------------------------------------------

  bodyName(id) {
    return this.doc.bodyProps[id]?.name || this.state?.bodies.get(id)?.name || 'Missing part';
  }

  bodyColor(id) {
    if (this.doc.bodyProps[id]?.color) return this.doc.bodyProps[id].color;
    const i = [...(this.state?.bodies.keys() || [])].indexOf(id);
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
  }

  renderParts() {
    const el = this.$('#parts');
    const bodies = [...this.state.bodies.values()];
    this.$('#parts-count').textContent = bodies.length ? `(${bodies.length})` : '';
    el.innerHTML = bodies.map((b) => {
      const hidden = this.doc.bodyProps[b.id]?.hidden;
      return `<div class="prow ${this.selection.has(b.id) ? 'sel' : ''} ${hidden ? 'hiddenpart' : ''}" data-id="${b.id}">
        <span class="swatch" style="background:${this.bodyColor(b.id)}"></span>
        <span class="pname">${esc(this.bodyName(b.id))}</span>
        <button class="iconbtn tiny" data-hide="${b.id}" title="${hidden ? 'Show' : 'Hide'}">${icon(hidden ? 'eyeOff' : 'eye', 14)}</button></div>`;
    }).join('') || '<p class="empty">No parts</p>';
    el.querySelectorAll('.prow').forEach((row) => {
      row.addEventListener('click', (e) => {
        const id = row.dataset.id;
        if (e.target.closest('[data-hide]')) {
          const props = (this.doc.bodyProps[id] ||= {});
          props.hidden = !props.hidden;
          this.refreshScene();
          this.renderParts();
          this.scheduleAutosave();
          return;
        }
        const field = this.activeField();
        if (field) {
          const f = this.feature(this.editing.id);
          if (field.type === 'body') this.setParam(field.key, id);
          else { const list = f.params[field.key] || []; this.setParam(field.key, list.includes(id) ? list.filter((x) => x !== id) : [...list, id]); }
          this.renderDialog();
          return;
        }
        if (e.shiftKey || e.ctrlKey || e.metaKey) { const s = new Set(this.selection); s.has(id) ? s.delete(id) : s.add(id); this.select([...s]); }
        else this.select([id]);
      });
      row.addEventListener('dblclick', () => this.renamePart(row.dataset.id));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const id = row.dataset.id;
        if (!this.selection.has(id)) this.select([id]);
        this.partMenu(e.clientX, e.clientY);
      });
    });
  }

  renamePart(id) {
    const row = this.$(`#parts .prow[data-id="${id}"] .pname`);
    if (!row) return;
    const input = document.createElement('input');
    input.value = this.bodyName(id);
    input.className = 'rename';
    row.replaceWith(input);
    input.focus();
    input.select();
    const done = (save) => {
      if (save && input.value.trim()) { this.checkpoint('Rename part'); (this.doc.bodyProps[id] ||= {}).name = input.value.trim(); }
      this.renderParts();
      this.renderInfo();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    input.addEventListener('blur', () => done(true));
  }

  partMenu(x, y) {
    const ids = [...this.selection];
    const one = ids.length === 1;
    this.contextMenu(x, y, [
      one ? ['Rename', () => this.renamePart(ids[0])] : null,
      one ? ['Edit creating feature', () => this.editFeature(this.state.bodies.get(ids[0]).featureId.split('.')[0])] : null,
      ['Move / rotate', () => this.startFeature('transform')],
      ['Mirror', () => this.startFeature('mirror')],
      ids.length >= 2 ? ['Union', () => this.startFeature('boolean', { op: 'union' })] : null,
      ids.length >= 2 ? ['Subtract', () => this.startFeature('boolean', { op: 'subtract' })] : null,
      ['Zoom to part', () => this.viewport.fit(this.viewport.modelBox(new Set(ids)))],
      ['Export STL', () => this.exportSelection('stl')],
      ['Hide', () => { ids.forEach((id) => { (this.doc.bodyProps[id] ||= {}).hidden = true; }); this.refreshScene(); this.renderParts(); }],
      '-',
      ['Delete', () => this.deleteSelectedParts(), false, 'danger'],
    ]);
  }

  deleteSelectedParts() {
    if (!this.selection.size) return;
    this.startFeature('deleteBody', { bodies: [...this.selection] });
    this.okEdit();
    this.select([]);
  }

  // --- panels: properties of the selection -------------------------------------------------------------------

  renderInfo() {
    const el = this.$('#info');
    const bodies = [...this.selection].map((id) => this.state.bodies.get(id)).filter(Boolean);
    if (!bodies.length || this.editing) { el.hidden = true; return; }
    el.hidden = false;
    let vol = 0, area = 0, tris = 0;
    const box = new THREE.Box3();
    const cen = new THREE.Vector3();
    for (const b of bodies) {
      const m = b.manifold;
      vol += m.volume();
      area += m.surfaceArea();
      tris += m.numTri();
      const bb = m.boundingBox();
      box.expandByPoint(new THREE.Vector3(...bb.min)).expandByPoint(new THREE.Vector3(...bb.max));
      cen.addScaledVector(new THREE.Vector3(...this.centroid(b)), m.volume());
    }
    if (vol) cen.multiplyScalar(1 / vol);
    const size = box.getSize(new THREE.Vector3());
    const density = MATERIALS.find(([n]) => n === this.material)?.[1] || 1;
    const massG = (vol / 1000) * density;
    const one = bodies.length === 1 ? bodies[0] : null;
    const genus = one ? one.manifold.genus() : null;
    el.innerHTML = `
      <header>${one ? `<input type="color" value="${this.bodyColor(one.id)}" class="colorpick" title="Part colour"> <span class="title">${esc(this.bodyName(one.id))}</span>` : `<span class="title">${bodies.length} parts</span>`}
        <button class="iconbtn tiny" data-close title="Clear selection">${icon('close', 14)}</button></header>
      <dl>
        <dt>Volume</dt><dd>${fmt(vol / 1000, 3)} cm³ <small>(${fmt(vol, 1)} mm³)</small></dd>
        <dt>Surface area</dt><dd>${fmt(area / 100, 2)} cm²</dd>
        <dt>Mass</dt><dd>${massG >= 1000 ? `${fmt(massG / 1000, 3)} kg` : `${fmt(massG, 2)} g`}
          <select class="matsel">${MATERIALS.map(([n, d]) => `<option ${n === this.material ? 'selected' : ''} value="${n}">${n} (${d} g/cm³)</option>`).join('')}</select></dd>
        <dt>Size</dt><dd>${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} mm</dd>
        <dt>Centre of mass</dt><dd>${fmt(cen.x)}, ${fmt(cen.y)}, ${fmt(cen.z)}</dd>
        <dt>Triangles</dt><dd>${tris.toLocaleString()}${genus != null ? ` · ${genus} through-hole${genus === 1 ? '' : 's'}` : ''}</dd>
      </dl>`;
    el.querySelector('[data-close]').onclick = () => this.select([]);
    el.querySelector('.matsel').onchange = (e) => { this.material = e.target.value; this.renderInfo(); };
    el.querySelector('.colorpick')?.addEventListener('input', (e) => {
      (this.doc.bodyProps[one.id] ||= {}).color = e.target.value;
      this.refreshScene();
      this.renderParts();
    });
  }

  centroid(body) {
    this.centroids ||= new WeakMap();
    let c = this.centroids.get(body.manifold);
    if (!c) {
      c = massProperties(meshFromManifold(body.manifold)).centroid;
      this.centroids.set(body.manifold, c);
    }
    return c;
  }

  renderStatus() {
    const el = this.$('#status');
    const errors = [...(this.results?.values() || [])].filter((r) => r.status === 'error').length;
    const hover = this.hoverBody ? `${esc(this.bodyName(this.hoverBody))}` : '';
    const sel = this.selection.size ? `${this.selection.size} selected` : '';
    el.innerHTML = `<span>${this.state.bodies.size} part${this.state.bodies.size === 1 ? '' : 's'}</span>
      ${sel ? `<span>${sel}</span>` : ''}${hover ? `<span class="hover">${hover}</span>` : ''}
      ${errors ? `<span class="err">${icon('error', 14)} ${errors} feature error${errors > 1 ? 's' : ''}</span>` : ''}
      <span class="grow"></span>
      <span>Rebuild ${fmt(this.lastRegenMs || 0, 0)} ms</span><span>Units: mm</span>`;
  }

  // --- context menu and toasts --------------------------------------------------------------------------

  contextMenu(x, y, items) {
    this.closeMenus();
    const menu = document.createElement('div');
    menu.className = 'menu ctx';
    for (const item of items) {
      if (!item) continue;
      if (item === '-') { menu.insertAdjacentHTML('beforeend', '<hr>'); continue; }
      const [label, fn, disabled, cls] = item;
      const b = document.createElement('button');
      b.textContent = label;
      b.disabled = !!disabled;
      if (cls) b.className = cls;
      b.onclick = () => { this.closeMenus(); fn(); };
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  }

  closeMenus() {
    document.querySelectorAll('.menu.ctx').forEach((m) => m.remove());
    document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
  }

  toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = msg;
    this.$('#toasts').appendChild(t);
    setTimeout(() => t.classList.add('out'), kind === 'error' ? 6000 : 2600);
    setTimeout(() => t.remove(), kind === 'error' ? 6500 : 3100);
  }

  // --- toolbar --------------------------------------------------------------------------------------------

  buildToolbar() {
    const tb = this.$('#toolbar');
    const btn = (id, ic, label, title, act) => ({ id, ic, label, title, act });
    const groups = [
      [btn('tb-undo', 'undo', '', 'Undo (Ctrl+Z)', () => this.undo()), btn('tb-redo', 'redo', '', 'Redo (Ctrl+Shift+Z)', () => this.redo())],
      [btn('tb-sketch', 'sketch', 'Sketch', 'New sketch (Shift+S)', () => this.startFeature('sketch'))],
      [btn('tb-extrude', 'extrude', 'Extrude', 'Extrude a sketch (Shift+E)', () => this.startFeature('extrude')),
        btn('tb-revolve', 'revolve', 'Revolve', 'Revolve a sketch (Shift+W)', () => this.startFeature('revolve')),
        btn('tb-hole', 'hole', 'Hole', 'Hole on a face (Shift+H)', () => this.startFeature('hole')),
        { dropdown: true, ic: 'box', label: 'Primitive', items: ['box', 'cylinder', 'sphere', 'cone', 'torus', 'tube', 'wedge'].map((t) => [t, FEATURES[t].label, () => this.startFeature(t)]) }],
      [btn('tb-union', 'union', '', 'Union parts', () => this.startFeature('boolean', { op: 'union' })),
        btn('tb-subtract', 'subtract', '', 'Subtract parts', () => this.startFeature('boolean', { op: 'subtract' })),
        btn('tb-intersect', 'intersect', '', 'Intersect parts', () => this.startFeature('boolean', { op: 'intersect' }))],
      [btn('tb-move', 'move', 'Move', 'Move / rotate / scale parts (M)', () => this.startFeature('transform')),
        btn('tb-mirror', 'mirror', '', 'Mirror parts', () => this.startFeature('mirror')),
        btn('tb-linear', 'linear', '', 'Linear pattern', () => this.startFeature('linearPattern')),
        btn('tb-circular', 'circular', '', 'Circular pattern', () => this.startFeature('circularPattern')),
        { dropdown: true, ic: 'modify', label: 'Modify', items: [['split', 'Split by plane', () => this.startFeature('split')], ['hull', 'Convex hull', () => this.startFeature('hull')], ['smooth', 'Smooth (subdivide)', () => this.startFeature('smooth')], ['simplify', 'Simplify mesh', () => this.startFeature('simplify')], ['trash', 'Delete parts', () => this.startFeature('deleteBody')]] }],
      [btn('tb-import', 'import', 'Import', 'Import STL / OBJ / PLY (Ctrl+I)', () => this.importDialog()),
        { dropdown: true, ic: 'export', label: 'Export', items: [['export', 'STL (binary)', () => this.exportSelection('stl')], ['export', 'STL (ASCII)', () => this.exportSelection('stl-ascii')], ['export', 'OBJ', () => this.exportSelection('obj')], ['export', 'glTF binary (.glb)', () => this.exportSelection('glb')]] }],
      [btn('tb-measure', 'measure', 'Measure', 'Measure distances (Shift+M)', () => this.setMode(this.mode === 'measure' ? null : 'measure')),
        btn('tb-section', 'section', 'Section', 'Section view', () => this.toggleSection())],
    ];
    tb.innerHTML = groups.map((g) => `<div class="tgroup">${g.map((b, i) => {
      if (b.dropdown) {
        return `<div class="dropdown" data-dd="${i}"><button class="tbtn" title="${b.label}">${icon(b.ic)}<span>${b.label}</span>${icon('chevron', 12)}</button><div class="menu">${b.items.map(([ic, label], j) => `<button data-item="${j}">${icon(ic, 16)} ${label}</button>`).join('')}</div></div>`;
      }
      return `<button class="tbtn ${['tb-sketch', 'tb-extrude'].includes(b.id) ? 'primary' : ''}" id="${b.id}" title="${b.title}">${icon(b.ic)}${b.label ? `<span>${b.label}</span>` : ''}</button>`;
    }).join('')}</div>`).join('');
    groups.flat().forEach((b) => {
      if (!b.dropdown) tb.querySelector(`#${b.id}`).addEventListener('click', (e) => { e.currentTarget.blur(); b.act(); });
    });
    tb.querySelectorAll('.tgroup').forEach((gEl, gi) => {
      gEl.querySelectorAll('.dropdown').forEach((dd) => {
        const def = groups[gi][+dd.dataset.dd];
        dd.querySelector('.tbtn').addEventListener('click', (e) => {
          e.stopPropagation();
          const open = dd.classList.contains('open');
          this.closeMenus();
          if (!open) dd.classList.add('open');
        });
        dd.querySelectorAll('[data-item]').forEach((it) => it.addEventListener('click', () => { this.closeMenus(); def.items[+it.dataset.item][2](); }));
      });
    });

    // File menu
    const fileItems = [
      ['file', 'New', () => this.newProject()],
      ['folder', 'Open project…', () => this.openProjectDialog()],
      ['save', 'Save project', () => this.saveProject()],
      '-',
      ['import', 'Import mesh (STL, OBJ, PLY)…', () => this.importDialog()],
      ['export', 'Export STL', () => this.exportSelection('stl')],
      '-',
      ['cube', 'Load example model', () => this.loadExample()],
    ];
    const fm = this.$('#filemenu');
    fm.querySelector('.menu').innerHTML = fileItems.map((it, i) => (it === '-' ? '<hr>' : `<button data-i="${i}">${icon(it[0], 16)} ${it[1]}</button>`)).join('');
    fm.querySelector('.tbtn').addEventListener('click', (e) => { e.stopPropagation(); const o = fm.classList.contains('open'); this.closeMenus(); if (!o) fm.classList.add('open'); });
    fm.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => { this.closeMenus(); fileItems[+b.dataset.i][2](); }));

    // Quality select
    const q = this.$('#quality');
    q.addEventListener('change', () => { this.checkpoint('Quality'); this.doc.settings.quality = q.value; this.regenerate(); });

    // View bar
    const vb = this.$('#viewbar');
    const views = [['iso', 'Isometric (0)'], ['front', 'Front (1)'], ['top', 'Top (7)'], ['right', 'Right (3)']];
    vb.innerHTML = `
      <div class="seg">${views.map(([v, t]) => `<button data-view="${v}" title="${t}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
      <button class="iconbtn" data-act="fit" title="Zoom to fit (F)">${icon('fit', 18)}</button>
      <button class="iconbtn" data-act="proj" title="Toggle perspective / orthographic (O)">${icon('persp', 18)}</button>
      <div class="seg">${[['edges', 'Shaded with edges'], ['shaded', 'Shaded'], ['wire', 'Wireframe'], ['xray', 'X-ray']].map(([m, t]) => `<button data-mode="${m}" title="${t}" class="${m === 'edges' ? 'on' : ''}">${icon(m === 'shaded' ? 'cube' : m, 17)}</button>`).join('')}</div>
      <button class="iconbtn" data-act="sketches" title="Show sketches">${icon('sketch', 18)}</button>`;
    vb.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => this.viewport.setView(b.dataset.view)));
    vb.querySelector('[data-act=fit]').addEventListener('click', () => this.viewport.fit());
    vb.querySelector('[data-act=proj]').addEventListener('click', (e) => this.toggleProjection(e.currentTarget));
    vb.querySelector('[data-act=sketches]').addEventListener('click', (e) => {
      this.showSketches = !this.showSketches;
      e.currentTarget.classList.toggle('off', !this.showSketches);
      this.renderSketches();
    });
    vb.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      vb.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      this.viewport.setDisplayMode(b.dataset.mode);
    }));

    this.$('#theme').addEventListener('click', () => this.toggleTheme());
    this.$('#help').addEventListener('click', () => this.$('#helpdlg').showModal());
    this.$('#helpdlg [data-close]').addEventListener('click', () => this.$('#helpdlg').close());
  }

  toggleProjection(btn) {
    const ortho = this.viewport.camera !== this.viewport.ortho;
    this.viewport.setProjection(ortho ? 'ortho' : 'persp');
    btn?.classList.toggle('on', ortho);
    this.$('#viewbar [data-act=proj]')?.classList.toggle('on', ortho);
  }

  toggleTheme() {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try { localStorage.setItem('forge-theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
    this.$('#theme').innerHTML = icon(dark ? 'sun' : 'moon', 18);
    this.viewport.applyTheme();
    if (this.sketcher.active) this.sketcher.render();
  }

  toggleSection() {
    const panel = this.$('#section-panel');
    const on = !this.viewport.section.enabled;
    this.$('#tb-section').classList.toggle('on', on);
    panel.hidden = !on;
    if (on) {
      const box = this.viewport.modelBox();
      const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
      this.viewport.setSection({ enabled: true, offset: +c.x.toFixed(2) });
      this.renderSectionPanel();
    } else {
      this.viewport.setSection({ enabled: false });
    }
  }

  renderSectionPanel() {
    const panel = this.$('#section-panel');
    const s = this.viewport.section;
    const box = this.viewport.modelBox();
    const k = { X: 'x', Y: 'y', Z: 'z' }[s.axis];
    const min = box.isEmpty() ? -100 : box.min[k] - 1, max = box.isEmpty() ? 100 : box.max[k] + 1;
    panel.innerHTML = `<header>${icon('section', 16)} Section view</header>
      <div class="seg">${['X', 'Y', 'Z'].map((a) => `<button data-axis="${a}" class="${a === s.axis ? 'on' : ''}">${a}</button>`).join('')}</div>
      <input type="range" min="${min}" max="${max}" step="${(max - min) / 400}" value="${s.offset}">
      <div class="row tight"><span class="inputwrap"><input type="number" step="any" value="${+s.offset.toFixed(3)}" class="secnum"><em>mm</em></span>
      <label class="chk"><input type="checkbox" ${s.flip ? 'checked' : ''} class="secflip"> Flip</label></div>`;
    panel.querySelectorAll('[data-axis]').forEach((b) => b.addEventListener('click', () => {
      const bb = this.viewport.modelBox();
      const kk = { X: 'x', Y: 'y', Z: 'z' }[b.dataset.axis];
      this.viewport.setSection({ axis: b.dataset.axis, offset: bb.isEmpty() ? 0 : +bb.getCenter(new THREE.Vector3())[kk].toFixed(2) });
      this.renderSectionPanel();
    }));
    const range = panel.querySelector('input[type=range]');
    const num = panel.querySelector('.secnum');
    range.addEventListener('input', () => { this.viewport.setSection({ offset: +range.value }); num.value = (+range.value).toFixed(2); });
    num.addEventListener('input', () => { this.viewport.setSection({ offset: parseFloat(num.value) || 0 }); range.value = num.value; });
    panel.querySelector('.secflip').addEventListener('change', (e) => this.viewport.setSection({ flip: e.target.checked }));
  }

  // --- files ----------------------------------------------------------------------------------------

  /** In-page confirmation (browser confirm() is unavailable in some hosts). */
  askConfirm(message, okLabel) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'confirm';
      dlg.innerHTML = `<p>${esc(message)}</p><div class="row"><button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>${esc(okLabel)}</button></div>`;
      document.body.appendChild(dlg);
      const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
      dlg.querySelector('[data-yes]').onclick = () => done(true);
      dlg.querySelector('[data-no]').onclick = () => done(false);
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
      dlg.showModal();
      dlg.querySelector('[data-yes]').focus();
    });
  }

  async newProject() {
    if (this.doc.features.length && !(await this.askConfirm('Start a new project? Changes you have not saved to a project file will be lost.', 'Start new'))) return;
    this.setDocument(newDocument(), new Map());
  }

  async loadExample() {
    if (this.doc.features.length && !(await this.askConfirm('Replace the current model with the example? Save your project first to keep it.', 'Load example'))) return;
    this.setDocument(exampleDocument(), new Map());
    this.toast('Loaded the example bracket. Double-click any feature to edit it.');
  }

  async saveProject() {
    const text = serializeProject(this.doc, this.blobs);
    const name = `${(this.doc.name || 'model').replace(/[^\w\- ]+/g, '') || 'model'}.forge.json`;
    if (window.showSaveFilePicker && window.parent === window) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Forge CAD project', accept: { 'application/json': ['.json'] } }] });
        const w = await handle.createWritable();
        await w.write(text);
        await w.close();
        this.toast('Project saved');
        return;
      } catch (e) {
        if (e?.name === 'AbortError') return;
      }
    }
    try {
      if (await download(text, name, 'application/json')) this.toast('Project saved');
    } catch (e) {
      this.toast(e.message, 'error');
    }
  }

  async openProjectDialog() {
    const [file] = await pickFiles('.json,.forge.json,application/json');
    if (file) await this.openFile(file);
  }

  async openFile(file) {
    const ext = file.name.toLowerCase().split('.').pop();
    try {
      if (ext === 'json') {
        const { doc, blobs } = parseProject(await file.text());
        this.setDocument(doc, blobs);
        this.toast(`Opened ${file.name}`);
      } else if (MESH_EXTENSIONS.includes(ext)) {
        await this.importMesh(file);
      } else {
        throw new Error(`Unsupported file: ${file.name}`);
      }
    } catch (e) {
      console.error(e);
      this.toast(e.message || String(e), 'error');
    }
  }

  async importDialog() {
    const files = await pickFiles(MESH_EXTENSIONS.map((x) => `.${x}`).join(','), true);
    for (const f of files) await this.openFile(f);
  }

  async importMesh(file) {
    this.toast(`Importing ${file.name}…`);
    await new Promise((r) => setTimeout(r, 30));
    const buffer = await file.arrayBuffer();
    const { mesh, report } = prepareMesh(file.name, buffer);
    const blobId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.blobs.set(blobId, mesh);
    // Guess units: tiny models were probably exported in metres or inches.
    let units = '1';
    if (report.size < 2) units = '1000';
    const name = file.name.replace(/\.[^.]+$/, '');
    this.startFeature('import', { blob: blobId, fileName: file.name, name, units });
    this.okEdit();
    const imported = [...this.state.bodies.values()].filter((b) => b.featureId === this.doc.features.at((this.doc.rollback ?? this.doc.features.length) - 1)?.id);
    this.select(imported.map((b) => b.id));
    this.viewport.fit(this.viewport.modelBox());
    const bits = [`Imported ${name}: ${report.triangles.toLocaleString()} triangles as a solid part`];
    if (report.repaired) bits.push(describeRepair(report.repaired));
    if (units !== '1') bits.push('Scaled from metres (double-click the import feature to change units)');
    this.toast(bits.join(' · '));
  }

  async exportSelection(format) {
    let bodies = [...this.selection].map((id) => this.state.bodies.get(id)).filter(Boolean);
    if (!bodies.length) bodies = [...this.state.bodies.values()].filter((b) => !this.doc.bodyProps[b.id]?.hidden);
    bodies = bodies.map((b) => ({ ...b, name: this.bodyName(b.id), color: this.bodyColor(b.id) }));
    try {
      if (await exportBodies(bodies, format, bodies.length === 1 ? bodies[0].name : this.doc.name)) this.toast(`Exported ${bodies.length} part${bodies.length > 1 ? 's' : ''}`);
    } catch (e) {
      this.toast(e.message, 'error');
    }
  }

  scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      if (this.editing) return this.scheduleAutosave();
      saveLocal('autosave', serializeProject(this.doc, this.blobs));
    }, 1200);
  }

  async restoreAutosave() {
    const text = await loadLocal('autosave');
    if (!text) return false;
    try {
      const { doc, blobs } = parseProject(text);
      if (!doc.features?.length) return false;
      this.setDocument(doc, blobs);
      return true;
    } catch {
      return false;
    }
  }

  // --- global events ---------------------------------------------------------------------------------

  bindGlobalEvents() {
    document.addEventListener('click', (e) => { if (!e.target.closest('.menu, .dropdown')) this.closeMenus(); });
    window.addEventListener('keydown', (e) => this.onKey(e));
    const vpEl = this.$('#viewport');
    ['dragenter', 'dragover'].forEach((t) => vpEl.addEventListener(t, (e) => { e.preventDefault(); vpEl.classList.add('drop'); }));
    ['dragleave', 'drop'].forEach((t) => vpEl.addEventListener(t, () => vpEl.classList.remove('drop')));
    vpEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      for (const file of e.dataTransfer.files) await this.openFile(file);
    });
    window.addEventListener('beforeunload', () => saveLocal('autosave', serializeProject(this.doc, this.blobs)));
  }

  onKey(e) {
    const tag = e.target.tagName;
    const typing = (tag === 'INPUT' && !['checkbox', 'range', 'color'].includes(e.target.type)) || tag === 'SELECT' || tag === 'TEXTAREA';
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); this.redo(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.saveProject(); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); this.openProjectDialog(); return; }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); this.importDialog(); return; }
    if (typing) return;
    if (this.sketcher.active && this.sketcher.onKey(e)) { e.preventDefault(); return; }
    if (e.key === 'Escape') {
      if (this.mode) { this.setMode(null); if (this.editing) this.renderDialog(); return; }
      if (this.editing) { this.cancelEdit(); return; }
      this.select([]);
      return;
    }
    if (e.key === 'Enter' && this.editing) { e.preventDefault(); this.okEdit(); return; }
    if (mod || e.altKey) return;
    const k = e.key;
    if ((k === 'Delete' || k === 'Backspace') && !this.editing) {
      if (this.selection.size) this.deleteSelectedParts();
      else if (this.selectedFeature) this.deleteFeature(this.selectedFeature);
      return;
    }
    if (this.sketcher.active) return;
    const views = { 0: 'iso', 1: 'front', 3: 'right', 7: 'top', 9: 'bottom', 4: 'left', 6: 'back' };
    if (views[k]) { this.viewport.setView(views[k]); return; }
    if (k === 'f' || k === 'F') { this.viewport.fit(this.selection.size ? this.viewport.modelBox(this.selection) : undefined); return; }
    if (e.shiftKey) {
      const map = { S: 'sketch', E: 'extrude', W: 'revolve', H: 'hole' };
      if (map[k]) { this.startFeature(map[k]); return; }
      if (k === 'M') { this.setMode(this.mode === 'measure' ? null : 'measure'); return; }
    }
    if (k === 'm') { this.startFeature('transform'); return; }
    if (k === 'o') { this.toggleProjection(); return; }
    if (this.editing && this.feature(this.editing.id)?.type === 'transform') {
      if (k === 'w' || k === 'e') {
        this.gizmoMode = k === 'w' ? 'translate' : 'rotate';
        this.updateGizmo(this.feature(this.editing.id));
        this.toast(`Gizmo: ${this.gizmoMode}`);
      }
    }
  }
}
