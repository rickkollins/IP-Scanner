/* 3D Printing page: models, transforms, printing settings, slicing and layer preview. */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;
  const M = App.mesh;

  const meshes = new Map(); // meshId -> Float32Array (shared by history snapshots)
  const putMesh = (t) => { const id = App.uid('mesh'); meshes.set(id, t); return id; };

  const lineColors = { outer: '#e25c5c', inner: '#e6a23c', skin: '#d6c34a', infill: '#c98d4a', support: '#3fb3d6', skirt: '#a05ad6', travel: 'rgba(31,122,224,.45)' };
  const lineNames = { outer: 'Outer wall', inner: 'Inner wall', skin: 'Top / bottom', infill: 'Infill', support: 'Support', skirt: 'Skirt / brim', travel: 'Travel' };

  const P = {
    projectName: 'Untitled',
    models: [],
    profileId: 'normal',
    materialIds: ['pla', 'pla'],
    quick: {},
    mode: 'edit',
    sliced: null,
    layer: 0,
    show: { outer: true, inner: true, skin: true, infill: true, support: true, skirt: true, travel: false },
    colorBy: 'type',
    tool: null,
    history: new App.History(),
    savedState: null,
    title() { return `3D Printing — ${this.projectName}${this.isDirty() ? ' *' : ''}`; },

    /* ---------- state ---------- */
    snapshot() {
      return {
        models: this.models.map((m) => ({ id: m.id, name: m.name, meshId: m.meshId, pos: m.pos, rot: m.rot, scale: m.scale, mirror: m.mirror, extruder: m.extruder, visible: m.visible })),
        profileId: this.profileId, materialIds: this.materialIds, quick: this.quick,
      };
    },
    restore(s, keepSelection) {
      const sel = new Set(this.models.filter((m) => m.selected).map((m) => m.id));
      this.models = s.models.map((m) => this.makeModel(Object.assign({}, App.deepClone(m), { mesh: meshes.get(m.meshId) })));
      if (keepSelection) this.models.forEach((m) => (m.selected = sel.has(m.id)));
      this.profileId = s.profileId; this.materialIds = s.materialIds.slice(); this.quick = Object.assign({}, s.quick);
      this.invalidate();
      this.refresh();
    },
    commit() {
      this.history.push(this.snapshot());
      this.invalidate();
      this.refresh();
    },
    isDirty() { return this.savedState !== null && JSON.stringify(this.snapshot()) !== this.savedState; },
    markSaved(clean = true) { this.savedState = clean ? JSON.stringify(this.snapshot()) : ''; App.updateTitle(); },

    makeModel(o) {
      const m = Object.assign({
        id: App.uid('m'), name: 'Model', pos: { x: 0, y: 0 }, rot: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
        mirror: { x: false, y: false, z: false }, extruder: 0, visible: true, selected: false,
      }, o);
      if (!m.meshId) m.meshId = putMesh(m.mesh);
      m.mesh = meshes.get(m.meshId);
      this.updateWorld(m);
      return m;
    },
    updateWorld(m) {
      m.world = M.world(m);
      const b = M.bounds(m.world);
      const v = this.volume();
      m.bounds = b;
      m.outOfBounds = b.min[0] < -0.01 || b.min[1] < -0.01 || b.max[0] > v.x + 0.01 || b.max[1] > v.y + 0.01 || b.max[2] > v.z + 0.01;
      const mat = App.lib.materials.get(this.materialIds[m.extruder] || this.materialIds[0]) || App.data.materials[0];
      m.color = mat.color;
    },
    volume() { const mc = App.machine(); return mc.size.z ? mc.size : { x: mc.size.x, y: mc.size.y, z: 200 }; },
    selected() { return this.models.filter((m) => m.selected); },
    profile() {
      const base = App.lib.profiles.get(this.profileId) || App.data.printProfiles[1];
      return Object.assign({}, base, this.quick);
    },
    materials() { return this.materialIds.map((id) => App.lib.materials.get(id) || App.data.materials[0]); },

    addModel({ name, mesh, pos, extruder = 0 }) {
      const v = this.volume();
      const m = this.makeModel({ name, mesh: M.center(mesh), pos: pos || { x: v.x / 2, y: v.y / 2 }, extruder });
      const b = m.bounds;
      if (b.size[0] > v.x || b.size[1] > v.y || b.size[2] > v.z) {
        const s = Math.min(v.x / b.size[0], v.y / b.size[1], v.z / b.size[2]) * 0.9;
        m.scale = { x: s, y: s, z: s };
        App.toast(`"${name}" was scaled to ${Math.round(s * 100)}% to fit the build volume`);
        this.updateWorld(m);
      }
      if (!pos) this.placeFree(m);
      this.models.forEach((x) => (x.selected = false));
      m.selected = true;
      this.models.push(m);
      this.commit();
      return m;
    },
    placeFree(m) {
      // find a spot that doesn't overlap other models, spiralling out from the center
      const v = this.volume();
      const overlaps = () => this.models.some((o) => o !== m && o.bounds && !(m.bounds.max[0] + 3 < o.bounds.min[0] || m.bounds.min[0] - 3 > o.bounds.max[0] || m.bounds.max[1] + 3 < o.bounds.min[1] || m.bounds.min[1] - 3 > o.bounds.max[1]));
      for (let r = 0; r < Math.max(v.x, v.y); r += 10) {
        for (let a = 0; a < 360; a += r ? 30 : 360) {
          m.pos = { x: v.x / 2 + r * Math.cos((a * Math.PI) / 180), y: v.y / 2 + r * Math.sin((a * Math.PI) / 180) };
          this.updateWorld(m);
          if (!overlaps() && !m.outOfBounds) return;
        }
      }
      m.pos = { x: v.x / 2, y: v.y / 2 };
      this.updateWorld(m);
    },
    arrange(opts) {
      const v = this.volume();
      const list = this.models.filter((m) => m.visible);
      list.forEach((m) => { if (opts.rotate && m.bounds.size[1] > m.bounds.size[0]) { m.rot.z = (m.rot.z + 90) % 360; this.updateWorld(m); } });
      list.sort((a, b) => b.bounds.size[1] - a.bounds.size[1]);
      let x = opts.padding, y = opts.padding, rowH = 0;
      for (const m of list) {
        const [w, d] = m.bounds.size;
        if (x + w > v.x - opts.padding && x > opts.padding) { x = opts.padding; y += rowH + opts.spacing; rowH = 0; }
        m.pos = { x: x + w / 2, y: y + d / 2 };
        x += w + opts.spacing;
        rowH = Math.max(rowH, d);
        this.updateWorld(m);
      }
      // centre the whole arrangement
      const all = list.map((m) => m.bounds);
      if (all.length) {
        const minX = Math.min(...all.map((b) => b.min[0])), maxX = Math.max(...all.map((b) => b.max[0]));
        const minY = Math.min(...all.map((b) => b.min[1])), maxY = Math.max(...all.map((b) => b.max[1]));
        const dx = v.x / 2 - (minX + maxX) / 2, dy = v.y / 2 - (minY + maxY) / 2;
        list.forEach((m) => { m.pos = { x: m.pos.x + dx, y: m.pos.y + dy }; this.updateWorld(m); });
      }
      if (list.some((m) => m.outOfBounds)) App.toast('Not all models fit on the build plate', 'error');
      this.commit();
    },
    setQuick(k, v) { this.quick[k] = v; this.commit(); },

    /* ---------- project ---------- */
    newProject(name = 'Untitled') {
      this.projectName = name;
      this.models = [];
      this.quick = {};
      this.mode = 'edit';
      this.sliced = null;
      this.history.reset(this.snapshot());
      this.vp.setVolume(this.volume());
      this.markSaved();
      this.refresh();
    },
    serialize() {
      const s = this.snapshot();
      return {
        app: 'maker-studio', version: 1, type: 'printing', machine: { id: App.prefs.machineId, toolhead: App.machine().toolhead },
        data: Object.assign(s, { models: s.models.map((m) => Object.assign({}, m, { mesh: M.encode(meshes.get(m.meshId)) })) }),
      };
    },
    loadProject(proj, name) {
      const d = proj.data;
      d.models.forEach((m) => { m.meshId = putMesh(M.decode(m.mesh)); delete m.mesh; });
      this.projectName = name;
      this.mode = 'edit';
      this.restore(d);
      this.history.reset(this.snapshot());
      this.markSaved();
    },
    saveProject(asNew) {
      const doSave = (name) => {
        this.projectName = name;
        const proj = this.serialize();
        App.download(name + '.msproj', JSON.stringify(proj), 'application/json');
        App.recent.add(proj, name);
        this.markSaved();
        App.toast('Project saved', 'ok');
      };
      if (asNew || this.projectName === 'Untitled') App.prompt('Project name', this.projectName, 'Save Project').then((n) => n && doSave(n));
      else doSave(this.projectName);
    },
    async importFiles() {
      const files = await App.pickFiles('.stl,.obj', true);
      for (const f of files) {
        try {
          const mesh = /\.obj$/i.test(f.name) ? M.parseOBJ(await App.readFile(f)) : M.parseSTL(await App.readFile(f, 'buffer'));
          if (!mesh.length) throw new Error('no triangles found');
          this.addModel({ name: f.name.replace(/\.\w+$/, ''), mesh });
        } catch (e) {
          App.toast(`Could not import ${f.name}: ${e.message}`, 'error');
        }
      }
    },

    /* ---------- commands (menus & shortcuts) ---------- */
    cmd(name) {
      const sel = this.selected();
      switch (name) {
        case 'undo': { const s = this.history.undo(); if (s) this.restore(s, true); return true; }
        case 'redo': { const s = this.history.redo(); if (s) this.restore(s, true); return true; }
        case 'selectAll': this.models.forEach((m) => (m.selected = m.visible)); this.refresh(); return true;
        case 'unselect': this.models.forEach((m) => (m.selected = false)); this.setTool(null); this.refresh(); return true;
        case 'delete': if (!sel.length) return true; this.models = this.models.filter((m) => !m.selected); this.commit(); return true;
        case 'clearAll': if (!this.models.length) return true; App.confirm('Remove all models from the plate?', { danger: true, okLabel: 'Clear' }).then((ok) => { if (ok) { this.models = []; this.commit(); } }); return true;
        case 'copy': case 'cut':
          if (!sel.length) return true;
          App.clipboard = { kind: 'printing', data: sel.map((m) => ({ name: m.name, meshId: m.meshId, rot: m.rot, scale: m.scale, mirror: m.mirror, extruder: m.extruder, pos: m.pos })) };
          if (name === 'cut') { this.models = this.models.filter((m) => !m.selected); this.commit(); }
          return true;
        case 'paste': case 'duplicate': {
          const src = name === 'paste' ? (App.clipboard && App.clipboard.kind === 'printing' ? App.clipboard.data : []) : sel.map((m) => ({ name: m.name, meshId: m.meshId, rot: m.rot, scale: m.scale, mirror: m.mirror, extruder: m.extruder, pos: m.pos }));
          if (!src.length) return true;
          this.models.forEach((m) => (m.selected = false));
          src.forEach((s) => { const m = this.makeModel(App.deepClone(Object.assign({}, s, { mesh: undefined }))); m.mesh = meshes.get(s.meshId); this.placeFree(m); m.selected = true; this.models.push(m); });
          this.commit();
          return true;
        }
        case 'import': this.importFiles(); return true;
        case 'exportModels': App.dialogs.exportModels(this.models, this.projectName); return true;
        case 'exportGcode': if (this.sliced) App.dialogs.exportGcode(this.sliced.gcode, this.projectName, 'printing'); else App.toast('Generate G-code first'); return true;
        case 'save': this.saveProject(); return true;
        case 'saveAs': this.saveProject(true); return true;
        case 'nudge-left': case 'nudge-right': case 'nudge-up': case 'nudge-down': return false;
        default: return false;
      }
    },
    nudge(dx, dy) {
      const sel = this.selected();
      if (!sel.length) return;
      sel.forEach((m) => { m.pos = { x: m.pos.x + dx, y: m.pos.y + dy }; this.updateWorld(m); });
      this.commit();
    },
    onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      const k = e.key.toLowerCase();
      const step = e.shiftKey ? 10 : 1;
      if (k === 'arrowleft') { this.nudge(-step, 0); return true; }
      if (k === 'arrowright') { this.nudge(step, 0); return true; }
      if (k === 'arrowup') { this.nudge(0, step); return true; }
      if (k === 'arrowdown') { this.nudge(0, -step); return true; }
      if (k === 'm') { this.setTool('move'); return true; }
      if (k === 's') { this.setTool('scale'); return true; }
      if (k === 'r') { this.setTool('rotate'); return true; }
      if (k === 'f') { this.layFlat(); return true; }
      return false;
    },

    /* ---------- slicing ---------- */
    invalidate() {
      if (this.mode !== 'edit' || this.sliced) { this.sliced = null; this.mode = 'edit'; }
      if (this.slicing) this.slicing.cancel = true;
    },
    async generate() {
      const models = this.models.filter((m) => m.visible);
      if (!models.length) { App.toast('Add a model first'); return; }
      if (models.some((m) => m.outOfBounds)) { App.toast('Some models are outside the build volume', 'error'); return; }
      const job = { cancel: false, progress: 0 };
      this.slicing = job;
      this.refresh();
      try {
        const res = await App.slice(models.map((m) => ({ world: m.world, extruder: App.machine().toolhead === 'dual' ? m.extruder : 0, name: m.name })), this.profile(), this.materials(), App.machine(),
          (p) => { job.progress = p; this.renderFooter(); }, () => job.cancel);
        this.sliced = res;
        this.mode = 'preview';
        this.layer = res.layers.length - 1;
        App.toast('G-code generated', 'ok');
      } catch (e) {
        if (e.message !== 'cancelled') App.toast('Slicing failed: ' + e.message, 'error');
      }
      this.slicing = null;
      this.refresh();
    },

    /* ---------- tools ---------- */
    setTool(t) {
      this.tool = this.tool === t ? null : t;
      this.renderToolPop();
      App.$$('.tool-btn', this.leftEl).forEach((b) => b.classList.toggle('active', b.dataset.tool === this.tool));
    },
    layFlat() {
      const sel = this.selected();
      if (!sel.length) { App.toast('Select a model first'); return; }
      sel.forEach((m) => { m.rot = M.layFlat(m); this.updateWorld(m); });
      this.commit();
    },
    renderToolPop() {
      const pop = this.popEl;
      pop.innerHTML = '';
      const sel = this.selected();
      if (!this.tool) { pop.classList.add('hidden'); return; }
      pop.classList.remove('hidden');
      const title = { move: 'Move', scale: 'Scale', rotate: 'Rotate', mirror: 'Mirror', support: 'Support', extruder: 'Extruder', shapes: 'Add shape' }[this.tool];
      pop.append(h('h4', title, h('button.x', { on: { click: () => this.setTool(null) } }, '×')));
      if (this.tool === 'shapes') {
        const shapes = [['Cube', () => M.box(20, 20, 20)], ['Cylinder', () => M.cylinder(10, 20)], ['Sphere', () => M.sphere(10)], ['Cone', () => M.cone(10, 20)], ['Torus', () => M.torus(12, 4)], ['Vase', () => M.vase(20, 60)]];
        pop.append(h('div.cards', shapes.map(([n, fn]) => h('div.card-opt', { on: { click: () => this.addModel({ name: n, mesh: fn() }) } }, n))));
        return;
      }
      if (!sel.length) { pop.append(h('div.muted', 'Select a model in the viewport.')); return; }
      const m = sel[0];
      const num = (val, fn, step = 1) => { const i = h('input', { type: 'number', step, value: App.round(val, 2) }); i.addEventListener('change', () => { const v = parseFloat(i.value); if (Number.isFinite(v)) fn(v); }); return i; };
      const apply = (fn) => { sel.forEach((x) => { fn(x); this.updateWorld(x); }); this.commit(); };
      if (this.tool === 'move') {
        pop.append(h('div.xyz', h('b.x', 'X'), num(m.pos.x, (v) => apply((x) => (x.pos = { x: v, y: x.pos.y }))), h('b.y', 'Y'), num(m.pos.y, (v) => apply((x) => (x.pos = { x: x.pos.x, y: v }))), h('b.z', 'Z'), h('input', { type: 'number', value: 0, disabled: true, title: 'Models always sit on the plate' })),
          h('div.row', h('button.btn.small.grow', { on: { click: () => { const v = this.volume(); apply((x) => (x.pos = { x: v.x / 2, y: v.y / 2 })); } } }, 'Center on plate'), h('button.btn.small.grow', { on: { click: () => App.dialogs.arrange((o) => this.arrange(o)) } }, 'Auto arrange')));
      } else if (this.tool === 'scale') {
        const size = m.bounds.size;
        const lock = this.scaleLock !== false;
        const setDim = (k, mm) => {
          const idx = { x: 0, y: 1, z: 2 }[k];
          const f = mm / size[idx];
          if (!(f > 0)) return;
          apply((x) => { if (lock) x.scale = { x: x.scale.x * f, y: x.scale.y * f, z: x.scale.z * f }; else x.scale = Object.assign({}, x.scale, { [k]: x.scale[k] * f }); });
        };
        pop.append(h('div.hint', 'Size (mm)'),
          h('div.xyz', h('b.x', 'X'), num(size[0], (v) => setDim('x', v)), h('b.y', 'Y'), num(size[1], (v) => setDim('y', v)), h('b.z', 'Z'), num(size[2], (v) => setDim('z', v))),
          h('div.hint', 'Scale (%)'),
          h('div.xyz', h('b.x', 'X'), num(m.scale.x * 100, (v) => apply((x) => (lock ? (x.scale = { x: v / 100, y: v / 100, z: v / 100 }) : (x.scale.x = v / 100)))), h('b.y', 'Y'), num(m.scale.y * 100, (v) => apply((x) => (lock ? (x.scale = { x: v / 100, y: v / 100, z: v / 100 }) : (x.scale.y = v / 100)))), h('b.z', 'Z'), num(m.scale.z * 100, (v) => apply((x) => (lock ? (x.scale = { x: v / 100, y: v / 100, z: v / 100 }) : (x.scale.z = v / 100))))),
          h('label.row', h('input', { type: 'checkbox', checked: lock, on: { change: (e) => { this.scaleLock = e.target.checked; } } }), 'Uniform scaling'),
          h('div.row', h('button.btn.small.grow', { on: { click: () => { const v = this.volume(); apply((x) => { const s = Math.min(v.x / x.bounds.size[0], v.y / x.bounds.size[1], v.z / x.bounds.size[2]) * 0.98; x.scale = { x: x.scale.x * s, y: x.scale.y * s, z: x.scale.z * s }; }); } } }, 'Scale to fit'),
            h('button.btn.small.grow', { on: { click: () => apply((x) => (x.scale = { x: 1, y: 1, z: 1 })) } }, 'Reset')));
      } else if (this.tool === 'rotate') {
        pop.append(h('div.xyz', h('b.x', 'X'), num(m.rot.x, (v) => apply((x) => (x.rot.x = v)), 5), h('b.y', 'Y'), num(m.rot.y, (v) => apply((x) => (x.rot.y = v)), 5), h('b.z', 'Z'), num(m.rot.z, (v) => apply((x) => (x.rot.z = v)), 5)),
          h('div.row.wrap', ['x', 'y', 'z'].map((ax) => h('button.btn.small', { on: { click: () => apply((x) => (x.rot[ax] = (x.rot[ax] + 90) % 360)) } }, `${ax.toUpperCase()} +90°`))),
          h('div.row', h('button.btn.small.grow', { on: { click: () => this.layFlat() } }, 'Lay flat (auto)'), h('button.btn.small.grow', { on: { click: () => apply((x) => (x.rot = { x: 0, y: 0, z: 0 })) } }, 'Reset')));
      } else if (this.tool === 'mirror') {
        pop.append(h('div.row', ['x', 'y', 'z'].map((ax) => h('button.btn.grow', { on: { click: () => apply((x) => (x.mirror = Object.assign({}, x.mirror, { [ax]: !x.mirror[ax] }))) } }, ax.toUpperCase()))),
          h('button.btn.small', { on: { click: () => apply((x) => (x.mirror = { x: false, y: false, z: false })) } }, 'Reset'));
      } else if (this.tool === 'support') {
        const pr = this.profile();
        pop.append(
          h('label.row', h('input', { type: 'checkbox', checked: pr.support, on: { change: (e) => this.setQuick('support', e.target.checked) } }), 'Generate support'),
          App.form([{ key: 'supportAngle', label: 'Overhang angle', type: 'number', unit: '°', min: 0, max: 89 }, { key: 'supportDensity', label: 'Density', type: 'number', unit: '%', min: 5, max: 100 }], { supportAngle: pr.supportAngle, supportDensity: pr.supportDensity }, (k, v) => this.setQuick(k, v)),
          h('div.hint', 'Support is added under faces steeper than the overhang angle when you generate G-code.'));
      } else if (this.tool === 'extruder') {
        if (App.machine().toolhead !== 'dual') { pop.append(h('div.muted', 'Available with a dual-extruder tool head (Settings → Machine).')); return; }
        pop.append(h('div.cards', { style: { gridTemplateColumns: '1fr 1fr' } }, ['Left (T0)', 'Right (T1)'].map((l, i) => h('div.card-opt' + (m.extruder === i ? '.active' : ''), { on: { click: () => apply((x) => (x.extruder = i)) } }, l))));
      }
    },

    /* ---------- UI ---------- */
    mount(el) {
      this.history.reset(this.snapshot());
      this.savedState = JSON.stringify(this.snapshot());
      const tb = App.toolbar([
        { icon: 'home', label: 'Home', action: () => App.go('home') },
        { icon: 'workspace', label: 'Workspace', action: () => App.go('workspace') }, '|',
        { icon: 'plus', label: 'New', action: () => App.dialogs.newProject('printing') },
        { icon: 'open', label: 'Open', action: () => App.dialogs.openProject() },
        { icon: 'save', label: 'Save', action: () => this.saveProject() }, '|',
        { icon: 'undo', label: 'Undo', id: 'undo', action: () => this.cmd('undo') },
        { icon: 'redo', label: 'Redo', id: 'redo', action: () => this.cmd('redo') }, '|',
        { icon: 'import', label: 'Import', action: () => this.importFiles() },
        { icon: 'export', label: 'Export', action: () => this.cmd('exportModels') }, '|',
        { icon: 'arrange', label: 'Arrange', action: () => App.dialogs.arrange((o) => this.arrange(o)) },
        { icon: 'repair', label: 'Repair', action: () => { const m = this.selected()[0]; if (!m) return App.toast('Select a model first'); App.dialogs.modelRepair(m, (mesh) => { m.meshId = putMesh(mesh); m.mesh = mesh; this.updateWorld(m); this.commit(); }); } },
        { icon: 'simplify', label: 'Simplify', action: () => { const m = this.selected()[0]; if (!m) return App.toast('Select a model first'); App.dialogs.simplify(m, (mesh) => { m.meshId = putMesh(mesh); m.mesh = mesh; this.updateWorld(m); this.commit(); }); } },
        { icon: 'copy', label: 'Duplicate', action: () => this.cmd('duplicate') },
        { icon: 'trash', label: 'Delete', action: () => this.cmd('delete') },
        '->', App.machineChip(),
      ]);
      this.toolbarEl = tb;
      const left = h('div.left-tools');
      const tools = [['move', 'move', 'Move (M)'], ['scale', 'scale', 'Scale (S)'], ['rotate', 'rotate', 'Rotate (R)'], ['mirror', 'mirror', 'Mirror'], ['support', 'support', 'Support'], ['extruder', 'extruder', 'Extruder']];
      tools.forEach(([id, ic, t]) => { const b = h('button.tool-btn', { title: t, 'aria-label': t, on: { click: () => this.setTool(id) } }, App.icon(ic)); b.dataset.tool = id; left.append(b); });
      left.append(h('div.tool-sep'));
      const sb = h('button.tool-btn', { title: 'Add shape', 'aria-label': 'Add shape', on: { click: () => this.setTool('shapes') } }, App.icon('shapes'));
      sb.dataset.tool = 'shapes';
      left.append(sb, h('button.tool-btn', { title: 'Lay flat (F)', 'aria-label': 'Lay flat', on: { click: () => this.layFlat() } }, App.icon('flat')));
      this.leftEl = left;

      const vpEl = h('div.viewport.has-slider');
      this.vp = new App.Viewport3D(vpEl, { volume: this.volume() });
      this.vp.onPick = (m) => {
        if (this.mode === 'preview') return;
        const multi = this.vp.lastShift;
        if (!multi) this.models.forEach((x) => (x.selected = false));
        if (m) m.selected = !multi || !m.selected;
        this.refresh();
      };
      this.vp.onDragModel = (m, dx, dy) => {
        if (this.mode === 'preview') return;
        if (!m.selected) { this.models.forEach((x) => (x.selected = false)); m.selected = true; }
        this.selected().forEach((x) => { x.pos = { x: x.pos.x + dx, y: x.pos.y + dy }; this.updateWorld(x); });
        this.vp.models = this.models;
        this.vp.render();
      };
      this.vp.onDragEnd = () => this.commit();
      this.vp.canvas.addEventListener('pointerdown', (e) => { this.vp.lastShift = e.ctrlKey || e.metaKey; });
      this.vp.overlay = (ctx, B, vp) => this.drawPreview(ctx, B, vp);
      this.popEl = h('div.tool-pop.hidden');
      this.infoEl = h('div.vp-info');
      this.legendEl = h('div.vp-info.legend.hidden');
      this.sliderEl = h('div.layer-slider.hidden');
      vpEl.append(this.popEl,
        h('div.vp-overlay.tl', this.infoEl),
        h('div.vp-overlay.tr', this.legendEl),
        this.sliderEl,
        h('div.vp-overlay.bl', [['iso', '3D'], ['front', 'Front'], ['top', 'Top'], ['left', 'Left'], ['right', 'Right']].map(([v, l]) => h('button.btn.small', { on: { click: () => this.vp.setView(v) } }, l)),
          h('button.btn.small.icon', { title: 'Zoom in', on: { click: () => this.vp.zoom(0.8) } }, App.icon('zoomIn')),
          h('button.btn.small.icon', { title: 'Zoom out', on: { click: () => this.vp.zoom(1.25) } }, App.icon('zoomOut')),
          h('button.btn.small.icon', { title: 'Reset view', on: { click: () => this.vp.fit() } }, App.icon('fit'))));
      // drop files
      vpEl.addEventListener('dragover', (e) => e.preventDefault());
      vpEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        for (const f of Array.from(e.dataTransfer.files)) {
          if (!/\.(stl|obj)$/i.test(f.name)) { App.toast(`${f.name}: only STL and OBJ files are supported`, 'error'); continue; }
          try { const mesh = /\.obj$/i.test(f.name) ? M.parseOBJ(await App.readFile(f)) : M.parseSTL(await App.readFile(f, 'buffer')); this.addModel({ name: f.name.replace(/\.\w+$/, ''), mesh }); } catch (err) { App.toast(err.message, 'error'); }
        }
      });

      const right = h('div.right-panel');
      this.panelScroll = h('div.scroll');
      this.footerEl = h('div.footer');
      right.append(this.panelScroll, this.footerEl);
      this.status = h('div.statusbar');
      el.append(tb, h('div.editor', left, vpEl, right), this.status);
      App.bus.on('machine', () => { this.vp.setVolume(this.volume()); this.models.forEach((m) => this.updateWorld(m)); this.invalidate(); this.refresh(); });
      App.bus.on('library', () => { this.models.forEach((m) => this.updateWorld(m)); this.refresh(); });
      this.refresh();
    },
    onShow() { this.vp.setVolume(this.volume()); this.refresh(); },

    refresh() {
      if (!this.vp) return;
      this.vp.models = this.models;
      this.vp.hideModels = this.mode === 'preview';
      this.vp.render();
      this.renderPanel();
      this.renderFooter();
      this.renderToolPop();
      const vis = this.models.filter((m) => m.visible);
      const tris = vis.reduce((n, m) => n + m.mesh.length / 9, 0);
      this.infoEl.textContent = this.mode === 'preview' ? `Preview · ${this.sliced.stats.layers} layers` : `${vis.length} model${vis.length === 1 ? '' : 's'} · ${tris.toLocaleString()} triangles`;
      const sel = this.selected()[0];
      this.status.innerHTML = '';
      this.status.append(h('span', App.machine().name + ' · ' + App.data.toolheadLabel(App.machine().toolhead)),
        sel ? h('span', `Selected: ${sel.name} · ${sel.bounds.size.map((v) => App.round(v, 1)).join(' × ')} mm`) : null,
        this.models.some((m) => m.outOfBounds) ? h('span', { style: { color: 'var(--danger)' } }, 'Some models are outside the build volume') : null);
      App.$('[data-id=undo]', this.toolbarEl).disabled = !this.history.canUndo();
      App.$('[data-id=redo]', this.toolbarEl).disabled = !this.history.canRedo();
      this.renderPreviewControls();
      App.updateTitle();
    },
    renderPanel() {
      const s = this.panelScroll;
      const scrollTop = s.scrollTop;
      s.innerHTML = '';
      const mc = App.machine();
      const dual = mc.toolhead === 'dual';
      const pr = this.profile();
      // materials
      const mats = App.lib.materials.all();
      const matRow = (i) => {
        const sel = h('select', { on: { change: (e) => { this.materialIds[i] = e.target.value; this.models.forEach((m) => this.updateWorld(m)); this.commit(); } } }, mats.map((m) => h('option', { value: m.id, selected: m.id === this.materialIds[i] }, m.name)));
        const cur = App.lib.materials.get(this.materialIds[i]) || mats[0];
        return h('div.field', h('label', dual ? (i ? 'Right extruder' : 'Left extruder') : 'Material'),
          h('div.unit-wrap', h('span', { style: { width: '14px', height: '14px', borderRadius: '50%', background: cur.color, flexShrink: 0 } }), sel,
            h('button.btn.small.icon', { title: 'Material settings', on: { click: () => App.dialogs.materials(this.materialIds[i], (id) => { this.materialIds[i] = id; this.models.forEach((m) => this.updateWorld(m)); this.commit(); }) } }, App.icon('edit'))));
      };
      const matSec = App.section('Material', [matRow(0), dual ? matRow(1) : null,
        h('div.hint', (() => { const m = App.lib.materials.get(this.materialIds[0]) || mats[0]; return `Nozzle ${m.nozzleTemp}°C · Bed ${m.bedTemp}°C`; })())]);
      // profiles
      const profiles = App.lib.profiles.all();
      const builtin = profiles.filter((p) => p.builtin);
      const custom = profiles.filter((p) => !p.builtin);
      const cards = h('div.cards', builtin.map((p) => h('div.card-opt' + (p.id === this.profileId ? '.active' : ''), { on: { click: () => { this.profileId = p.id; this.quick = {}; this.commit(); } } },
        h('span.big', { fast: '»', normal: '◆', high: '✦' }[p.id] || '•'), p.name)));
      const customSel = custom.length ? h('div.field', h('label', 'Custom profile'), h('select', { on: { change: (e) => { if (e.target.value) { this.profileId = e.target.value; this.quick = {}; this.commit(); } } } },
        h('option', { value: '' }, '—'), custom.map((p) => h('option', { value: p.id, selected: p.id === this.profileId }, p.name)))) : null;
      const quick = App.form([
        { key: 'layerHeight', label: 'Layer height', type: 'select', options: [[0.08, '0.08 mm'], [0.1, '0.10 mm'], [0.12, '0.12 mm'], [0.16, '0.16 mm'], [0.2, '0.20 mm'], [0.24, '0.24 mm'], [0.28, '0.28 mm'], [0.32, '0.32 mm']] },
        { key: 'infillDensity', label: 'Infill density', type: 'range', min: 0, max: 100, step: 5, unit: '%' },
        { key: 'wallCount', label: 'Wall line count', type: 'number', min: 1, max: 10, step: 1 },
        { key: 'support', label: 'Generate support', type: 'checkbox' },
        { key: 'adhesion', label: 'Adhesion', type: 'select', options: [['none', 'None'], ['skirt', 'Skirt'], ['brim', 'Brim'], ['raft', 'Raft']] },
      ], { layerHeight: pr.layerHeight, infillDensity: pr.infillDensity, wallCount: pr.wallCount, support: pr.support, adhesion: pr.adhesion }, (k, v) => this.setQuick(k, k === 'layerHeight' ? Number(v) : v));
      const profSec = App.section('Printing Settings', [cards, customSel, quick,
        h('div.row', Object.keys(this.quick).length ? h('button.link-btn', { on: { click: () => { this.quick = {}; this.commit(); } } }, 'Reset changes') : h('span.hint', `Profile: ${(App.lib.profiles.get(this.profileId) || {}).name}`), h('span.spacer'),
          h('button.btn.small', { on: { click: () => App.dialogs.printProfiles(this.profileId, (id) => { this.profileId = id; this.quick = {}; this.commit(); }) } }, App.icon('settings'), 'Customize'))]);
      // model list
      const list = h('div.list', { style: { maxHeight: '220px' } });
      if (!this.models.length) list.append(h('div.empty', 'No models. Import STL/OBJ files or add a shape.'));
      this.models.forEach((m) => {
        list.append(h('div.li' + (m.selected ? '.active' : ''), { on: { click: (e) => { if (e.target.closest('button')) return; if (!(e.ctrlKey || e.metaKey)) this.models.forEach((x) => (x.selected = false)); m.selected = !m.selected || !(e.ctrlKey || e.metaKey); this.refresh(); } } },
          h('span', { style: { width: '10px', height: '10px', borderRadius: '2px', background: m.color } }),
          h('span.name', { title: m.name }, m.name),
          m.outOfBounds ? h('span.badge.red', 'Out of range') : null,
          dual ? h('span.badge.blue', m.extruder ? 'R' : 'L') : null,
          h('button.btn.small.icon', { title: m.visible ? 'Hide' : 'Show', on: { click: () => { m.visible = !m.visible; m.selected = false; this.commit(); } } }, App.icon(m.visible ? 'eye' : 'eyeOff')),
          h('button.btn.small.icon', { title: 'Rename', on: { click: async () => { const n = await App.prompt('Model name', m.name); if (n) { m.name = n; this.commit(); } } } }, App.icon('edit')),
          h('button.btn.small.icon', { title: 'Delete', on: { click: () => { this.models = this.models.filter((x) => x !== m); this.commit(); } } }, App.icon('trash'))));
      });
      const objSec = App.section(`Models (${this.models.length})`, [list]);
      s.append(objSec, matSec, profSec);
      s.scrollTop = scrollTop;
    },
    renderFooter() {
      const f = this.footerEl;
      f.innerHTML = '';
      if (this.slicing) {
        f.append(h('div.row', h('span.grow', 'Generating G-code…'), h('span', Math.round(this.slicing.progress * 100) + '%')),
          h('div.progress', h('div', { style: { width: this.slicing.progress * 100 + '%' } })),
          h('button.btn', { on: { click: () => { this.slicing.cancel = true; } } }, 'Cancel'));
        return;
      }
      if (this.mode === 'preview' && this.sliced) {
        const st = this.sliced.stats;
        const dual = App.machine().toolhead === 'dual';
        f.append(h('div.stats',
          h('div.stat', h('div.k', 'Estimated time'), h('div.v', App.fmtTime(st.time))),
          h('div.stat', h('div.k', 'Filament'), h('div.v', dual ? `${st.filament[0].toFixed(2)} m / ${st.filament[1].toFixed(2)} m` : `${st.filament[0].toFixed(2)} m`)),
          h('div.stat', h('div.k', 'Weight'), h('div.v', `${(st.weight[0] + st.weight[1]).toFixed(1)} g`)),
          h('div.stat', h('div.k', 'Material cost'), h('div.v', `$${st.cost.toFixed(2)}`))),
        h('div.row', h('button.btn.grow', { on: { click: () => { this.mode = 'edit'; this.refresh(); } } }, App.icon('edit'), 'Back to edit'),
          h('button.btn.grow', { on: { click: () => this.cmd('exportGcode') } }, App.icon('export'), 'Export')),
        h('button.btn.primary.block', { on: { click: () => App.dialogs.sendToDevice(this.sliced.gcode, this.projectName + '.gcode', 'printing') } }, App.icon('send'), 'Send to Workspace'));
        return;
      }
      const ok = this.models.some((m) => m.visible) && !this.models.some((m) => m.visible && m.outOfBounds);
      f.append(h('button.btn.primary.block', { disabled: !ok, style: { height: '38px' }, on: { click: () => this.generate() } }, App.icon('layers'), 'Generate G-code'));
    },
    renderPreviewControls() {
      const on = this.mode === 'preview' && this.sliced;
      this.legendEl.classList.toggle('hidden', !on);
      this.sliderEl.classList.toggle('hidden', !on);
      if (!on) return;
      this.legendEl.innerHTML = '';
      this.legendEl.append(h('b', 'Line types'), Object.keys(lineColors).map((k) => h('label', h('input', { type: 'checkbox', checked: this.show[k], on: { change: (e) => { this.show[k] = e.target.checked; this.vp.render(); } } }), h('span.sw', { style: { background: lineColors[k] } }), lineNames[k])),
        App.machine().toolhead === 'dual' ? h('label', 'Color by', h('select', { style: { width: 'auto' }, on: { change: (e) => { this.colorBy = e.target.value; this.vp.render(); } } }, h('option', { value: 'type', selected: this.colorBy === 'type' }, 'Line type'), h('option', { value: 'ext', selected: this.colorBy === 'ext' }, 'Extruder'))) : null);
      const n = this.sliced.layers.length;
      const lbl = h('div.lbl');
      const rng = h('input', { type: 'range', min: 0, max: n - 1, step: 1, value: this.layer, 'aria-label': 'Layer' });
      const upd = () => { lbl.innerHTML = `${this.layer + 1}<br><span class="muted">${this.sliced.layers[this.layer].z.toFixed(2)}</span>`; };
      rng.addEventListener('input', () => { this.layer = Number(rng.value); upd(); this.vp.render(); });
      upd();
      this.sliderEl.innerHTML = '';
      this.sliderEl.append(h('button.btn.small.icon', { title: 'Layer up', on: { click: () => { this.layer = Math.min(n - 1, this.layer + 1); rng.value = this.layer; upd(); this.vp.render(); } } }, App.icon('up')), rng,
        h('button.btn.small.icon', { title: 'Layer down', on: { click: () => { this.layer = Math.max(0, this.layer - 1); rng.value = this.layer; upd(); this.vp.render(); } } }, App.icon('down')), lbl);
    },
    drawPreview(ctx, B, vp) {
      if (this.mode !== 'preview' || !this.sliced) return;
      const layers = this.sliced.layers;
      const mats = this.materials();
      const n = Math.min(this.layer, layers.length - 1);
      const total = layers.reduce((s, l) => s + l.paths.length, 0);
      const skip = total > 40000 ? 2 : 1;
      for (let li = 0; li <= n; li++) {
        if (li !== n && (n - li) % skip) continue;
        const L = layers[li];
        const z = L.z;
        const cur = li === n;
        const byType = {};
        for (const p of L.paths) {
          if (!this.show[p.type]) continue;
          const key = this.colorBy === 'ext' && p.type !== 'travel' ? 'ext' + (p.ext || 0) : p.type;
          (byType[key] = byType[key] || []).push(p.pts);
        }
        for (const [key, list] of Object.entries(byType)) {
          ctx.beginPath();
          for (const pts of list) {
            let first = true;
            for (let i = 0; i < pts.length; i += 2) {
              const q = vp.project([pts[i], pts[i + 1], z], B);
              if (!q) { first = true; continue; }
              if (first) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
              first = false;
            }
          }
          ctx.strokeStyle = key.startsWith('ext') ? mats[Number(key.slice(3))].color : lineColors[key];
          ctx.globalAlpha = cur ? 1 : 0.75;
          ctx.lineWidth = cur ? 1.6 : 1;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    },
  };
  App.registerPage('printing', P);
})();
