/* All application dialogs. */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;
  const D = (App.dialogs = {});

  const kindLabel = { printing: '3D Printing', laser: 'Laser', cnc: 'CNC' };
  const kindIcon = { printing: 'printer', laser: 'laser', cnc: 'cnc' };

  /* ---------- first-run welcome wizard ---------- */
  D.welcome = function () {
    let step = 0;
    const st = { language: App.prefs.language, machineId: App.prefs.machineId, toolhead: App.prefs.toolhead };
    let dlg;
    const render = () => {
      const b = dlg.body;
      b.innerHTML = '';
      b.append(h('div.steps', [0, 1, 2].map((i) => h('span' + (i <= step ? '.on' : '')))));
      if (step === 0) {
        b.append(h('h3', `Welcome to ${App.name}`),
          h('p.muted', 'One workspace for 3D printing, laser engraving and CNC carving. Let\'s set up your machine.'),
          App.form([{ key: 'language', label: 'Language', type: 'select', options: [['en', 'English']] }], st),
          h('div.hint', 'More languages can be added under Settings → General.'));
      } else if (step === 1) {
        b.append(h('h3', 'Select your machine'), machineCards(st, render));
      } else {
        const m = App.data.machines.find((x) => x.id === st.machineId);
        if (!m.heads.includes(st.toolhead)) st.toolhead = m.heads[0];
        b.append(h('h3', 'Select the tool head'), toolheadCards(m, st, render),
          h('div.note', `You can change this later from Settings → Machine or by clicking the machine name in any toolbar.`));
      }
      dlg.button('back').disabled = step === 0;
      dlg.button('next').textContent = step === 2 ? 'Finish' : 'Next';
    };
    dlg = App.dialog({
      title: 'Quick setup', size: 'wide', dismissable: false,
      buttons: [
        { label: 'Skip', left: true, action: () => { App.setPref('showWelcome', false); } },
        { id: 'back', label: 'Back', action: () => { step--; render(); return false; } },
        {
          id: 'next', label: 'Next', primary: true, action: () => {
            if (step < 2) { step++; render(); return false; }
            App.setPref('language', st.language);
            App.setPref('machineId', st.machineId);
            App.setPref('toolhead', st.toolhead);
            App.setPref('showWelcome', false);
            App.toast('Machine set to ' + App.machine().name, 'ok');
          },
        },
      ],
    });
    render();
  };

  function machineCards(st, rerender) {
    return h('div.grid-cards', App.data.machines.map((m) =>
      h('div.pick-card' + (st.machineId === m.id ? '.active' : ''), { on: { click: () => { st.machineId = m.id; rerender(); } } },
        h('div.ico', App.icon(m.heads.includes('print') || m.heads.includes('dual') ? 'printer' : 'laser')),
        h('div.t', m.name),
        h('div.d', m.id === 'custom' ? 'Set your own build volume' : `${m.size.x} × ${m.size.y}${m.size.z ? ' × ' + m.size.z : ''} mm`),
        h('div.d', m.heads.map(App.data.toolheadLabel).join(' · ')))));
  }
  function toolheadCards(m, st, rerender) {
    const ico = { print: 'extruder', dual: 'extruder', laser: 'laser', cnc: 'cnc' };
    return h('div.grid-cards', m.heads.map((t) =>
      h('div.pick-card' + (st.toolhead === t ? '.active' : ''), { on: { click: () => { st.toolhead = t; rerender(); } } },
        h('div.ico', App.icon(ico[t])), h('div.t', App.data.toolheadLabel(t)))));
  }

  /* ---------- machine settings ---------- */
  D.machineSettings = function () {
    const st = { machineId: App.prefs.machineId, toolhead: App.prefs.toolhead, custom: Object.assign({}, App.prefs.custom), nozzleDiameter: App.prefs.nozzleDiameter, laserPowerWatts: App.prefs.laserPowerWatts, gcodeFlavor: App.prefs.gcodeFlavor };
    let dlg;
    const render = () => {
      const b = dlg.body;
      b.innerHTML = '';
      const m = App.data.machines.find((x) => x.id === st.machineId);
      if (!m.heads.includes(st.toolhead)) st.toolhead = m.heads[0];
      b.append(h('h4', 'Machine'), machineCards(st, render), h('h4', 'Tool head'), toolheadCards(m, st, render));
      if (m.id === 'custom') {
        b.append(h('h4', 'Build volume'), App.form([
          { key: 'x', label: 'Width (X)', type: 'number', unit: 'mm', min: 50, max: 2000 },
          { key: 'y', label: 'Depth (Y)', type: 'number', unit: 'mm', min: 50, max: 2000 },
          { key: 'z', label: 'Height (Z)', type: 'number', unit: 'mm', min: 0, max: 2000 },
        ], st.custom));
      }
      b.append(h('h4', 'Options'), App.form([
        { key: 'nozzleDiameter', label: 'Nozzle diameter', type: 'select', options: [[0.2, '0.2 mm'], [0.4, '0.4 mm'], [0.6, '0.6 mm'], [0.8, '0.8 mm']], show: () => ['print', 'dual'].includes(st.toolhead) },
        { key: 'laserPowerWatts', label: 'Laser module power', type: 'select', options: [[1.6, '1.6 W'], [10, '10 W'], [20, '20 W'], [40, '40 W']], show: () => st.toolhead === 'laser' },
        { key: 'gcodeFlavor', label: 'G-code flavor', type: 'select', options: [['marlin', 'Marlin'], ['grbl', 'GRBL']] },
      ], st));
    };
    dlg = App.dialog({
      title: 'Machine Settings', size: 'wide',
      buttons: [{ label: 'Cancel' }, {
        label: 'Save', primary: true, action: () => {
          ['custom', 'nozzleDiameter', 'laserPowerWatts', 'gcodeFlavor', 'machineId', 'toolhead'].forEach((k) => App.setPref(k, k === 'nozzleDiameter' || k === 'laserPowerWatts' ? Number(st[k]) : st[k]));
          App.toast('Machine settings saved', 'ok');
        },
      }],
    });
    render();
  };

  /* ---------- generic library manager (profiles, materials, laser presets, tools) ---------- */
  function libraryManager(o) {
    let items = o.lib.all();
    let sel = o.selected && items.find((x) => x.id === o.selected) ? o.selected : items[0].id;
    let dirty = null; // working copy
    const listEl = h('div.list', { style: { height: '100%' } });
    const formWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'auto', maxHeight: '460px', paddingRight: '4px' } });
    const reload = () => { items = o.lib.all(); };
    const renderList = () => {
      listEl.innerHTML = '';
      const groups = o.groupBy ? [...new Set(items.map(o.groupBy))] : [null];
      groups.forEach((g) => {
        if (g) listEl.append(h('div', { style: { padding: '6px 8px', fontSize: '11px', color: 'var(--muted)', fontWeight: 600 } }, g));
        items.filter((x) => !g || o.groupBy(x) === g).forEach((it) => {
          listEl.append(h('div.li' + (it.id === sel ? '.active' : ''), { on: { click: () => { sel = it.id; renderAll(); } } },
            o.swatch ? h('span', { style: { width: '12px', height: '12px', borderRadius: '50%', background: it.color, flexShrink: 0 } }) : null,
            h('span.name', it.name), it.builtin ? h('span.badge', 'Built-in') : h('span.badge.blue', 'Custom')));
        });
      });
    };
    const renderForm = () => {
      formWrap.innerHTML = '';
      const it = items.find((x) => x.id === sel);
      if (!it) return;
      dirty = App.deepClone(it);
      if (it.builtin) formWrap.append(h('div.note', 'Built-in presets are read-only. Click "Copy" to make an editable version.'));
      const schema = o.schema.map((f) => (it.builtin && f.type !== 'section' ? Object.assign({}, f, { disabled: true }) : f));
      formWrap.append(App.form(schema, dirty, () => {}));
    };
    const renderAll = () => { renderList(); renderForm(); };
    const persist = () => {
      if (!dirty || dirty.builtin) return;
      o.lib.upsert(dirty);
      reload();
    };
    const dlg = App.dialog({
      title: o.title, size: 'wide',
      body: h('div.split', listEl, formWrap),
      buttons: [
        { label: 'Create', left: true, action: async () => { persist(); const name = await App.prompt('Name', 'New ' + o.noun); if (!name) return false; const n = Object.assign(App.deepClone(o.defaults()), { id: App.uid(o.noun), name, builtin: false }); o.lib.upsert(n); reload(); sel = n.id; renderAll(); return false; } },
        { label: 'Copy', left: true, action: () => { persist(); const src = items.find((x) => x.id === sel); const n = Object.assign(App.deepClone(dirty || src), { id: App.uid(o.noun), name: src.name + ' (copy)', builtin: false }); o.lib.upsert(n); reload(); sel = n.id; renderAll(); return false; } },
        { label: 'Rename', left: true, action: async () => { const it = items.find((x) => x.id === sel); if (it.builtin) { App.toast('Built-in presets cannot be renamed'); return false; } const name = await App.prompt('New name', it.name); if (name) { dirty.name = name; persist(); renderAll(); } return false; } },
        { label: 'Delete', left: true, danger: true, action: async () => { const it = items.find((x) => x.id === sel); if (it.builtin) { App.toast('Built-in presets cannot be deleted'); return false; } if (await App.confirm(`Delete "${it.name}"?`, { danger: true, okLabel: 'Delete' })) { o.lib.remove(it.id); dirty = null; reload(); sel = items[0].id; renderAll(); } return false; } },
        { label: 'Import', left: true, action: async () => { const [f] = await App.pickFiles('.json'); if (!f) return false; try { const data = JSON.parse(await App.readFile(f)); [].concat(data).forEach((d) => o.lib.upsert(Object.assign(App.deepClone(o.defaults()), d, { id: App.uid(o.noun), builtin: false }))); reload(); renderAll(); App.toast('Imported', 'ok'); } catch (e) { App.toast('Invalid file: ' + e.message, 'error'); } return false; } },
        { label: 'Export', left: true, action: () => { const it = dirty || items.find((x) => x.id === sel); App.download(`${it.name.replace(/\W+/g, '_')}.json`, JSON.stringify(Object.assign({}, it, { builtin: undefined }), null, 2), 'application/json'); return false; } },
        { label: 'Close', action: () => persist() },
        o.onSelect ? { label: o.selectLabel || 'Use selected', primary: true, action: () => { persist(); o.onSelect(sel); } } : null,
      ].filter(Boolean),
      onClose: () => App.bus.emit('library', o.noun),
    });
    renderAll();
    return dlg;
  }

  D.printProfiles = (selected, onSelect) => libraryManager({
    title: 'Printing Settings', noun: 'profile', lib: App.lib.profiles, schema: App.data.profileSchema, selected, onSelect,
    defaults: () => App.data.printProfiles[1], selectLabel: 'Use this profile',
  });
  D.materials = (selected, onSelect) => libraryManager({
    title: 'Material Settings', noun: 'material', lib: App.lib.materials, schema: App.data.materialSchema, selected, onSelect, swatch: true,
    defaults: () => App.data.materials[0], selectLabel: 'Use this material',
  });
  D.laserLibrary = (selected, onSelect) => libraryManager({
    title: 'Laser Parameter Library', noun: 'preset', lib: App.lib.laser, schema: App.data.laserSchema, selected, onSelect,
    defaults: () => App.data.laserPresets[0], groupBy: (x) => x.material || 'Other', selectLabel: 'Apply preset',
  });
  D.toolLibrary = (selected, onSelect) => libraryManager({
    title: 'CNC Tool Library', noun: 'tool', lib: App.lib.tools, schema: App.data.cncToolSchema, selected, onSelect,
    defaults: () => App.data.cncTools[0], groupBy: (x) => ({ flat: 'Flat end mills', ball: 'Ball end mills', vbit: 'V-bits' }[x.shape]), selectLabel: 'Use this tool',
  });

  /* ---------- new / open project ---------- */
  D.newProject = function (preset) {
    const st = { kind: preset || 'printing', machineId: App.prefs.machineId };
    let dlg;
    const render = () => {
      dlg.body.innerHTML = '';
      dlg.body.append(h('h4', 'Project type'), h('div.grid-cards', ['printing', 'laser', 'cnc'].map((k) =>
        h('div.pick-card' + (st.kind === k ? '.active' : ''), { on: { click: () => { st.kind = k; render(); } } }, h('div.ico', App.icon(kindIcon[k])), h('div.t', kindLabel[k]),
          h('div.d', { printing: 'Slice 3D models into printer G-code', laser: 'Engrave and cut images, text and vectors', cnc: 'Carve and mill with toolpaths' }[k])))));
      const fits = App.data.machines.filter((m) => m.heads.some((hd) => (st.kind === 'printing' ? ['print', 'dual'] : [st.kind === 'laser' ? 'laser' : 'cnc']).includes(hd)));
      if (!fits.find((m) => m.id === st.machineId)) st.machineId = fits[0].id;
      dlg.body.append(h('h4', 'Machine'), App.form([{ key: 'machineId', label: 'Machine', type: 'select', options: fits.map((m) => [m.id, m.name]) }], st));
    };
    dlg = App.dialog({
      title: 'New Project', size: 'wide',
      buttons: [{ label: 'Cancel' }, {
        label: 'Create', primary: true, action: async () => {
          const m = App.data.machines.find((x) => x.id === st.machineId);
          App.setPref('machineId', st.machineId);
          const head = st.kind === 'printing' ? (m.heads.includes(App.prefs.toolhead) && ['print', 'dual'].includes(App.prefs.toolhead) ? App.prefs.toolhead : m.heads.find((x) => x === 'print' || x === 'dual')) : st.kind === 'laser' ? 'laser' : 'cnc';
          App.setPref('toolhead', head);
          const page = App.pages[st.kind];
          App.go(st.kind);
          if (page.isDirty && page.isDirty() && !(await D.guardUnsaved(page))) return;
          page.newProject();
        },
      }],
    });
    render();
  };

  D.guardUnsaved = async function (page) {
    if (!page.isDirty || !page.isDirty()) return true;
    const r = await new Promise((res) => App.dialog({
      title: 'Unsaved changes', size: 'narrow', body: h('p', `Save changes to "${page.projectName}" before continuing?`), onClose: res,
      buttons: [{ label: 'Cancel', value: null }, { label: "Don't Save", danger: true, value: 'discard' }, { label: 'Save', primary: true, value: 'save' }],
    }));
    if (r === 'save') { page.saveProject(); return true; }
    return r === 'discard';
  };

  D.openProject = async function () {
    const [f] = await App.pickFiles('.msproj,.json');
    if (!f) return;
    try {
      const proj = JSON.parse(await App.readFile(f));
      App.openProjectData(proj, f.name.replace(/\.(msproj|json)$/i, ''));
    } catch (e) {
      App.toast('Could not open project: ' + e.message, 'error');
    }
  };
  App.openProjectData = async function (proj, name) {
    if (!proj || !kindLabel[proj.type]) throw new Error('Not a project file');
    const page = App.pages[proj.type];
    App.go(proj.type);
    if (!(await D.guardUnsaved(page))) return;
    page.loadProject(proj, name);
    App.recent.add(proj, name);
    App.toast(`Opened "${name}"`, 'ok');
  };

  /* ---------- export ---------- */
  D.exportModels = function (models, defaultName) {
    if (!models.length) { App.toast('There are no models to export'); return; }
    const st = { name: defaultName || 'models', format: 'stl-bin', which: 'all' };
    App.dialog({
      title: 'Export Models', size: 'narrow',
      body: App.form([
        { key: 'name', label: 'File name', type: 'text' },
        { key: 'format', label: 'Format', type: 'select', options: [['stl-bin', 'STL (binary)'], ['stl-ascii', 'STL (ASCII)'], ['obj', 'OBJ']] },
        { key: 'which', label: 'Models', type: 'select', options: [['all', 'All visible models (merged)'], ['selected', 'Selected models only']] },
      ], st),
      buttons: [{ label: 'Cancel' }, {
        label: 'Export', primary: true, action: () => {
          const list = models.filter((m) => m.visible !== false && (st.which === 'all' || m.selected));
          if (!list.length) { App.toast('Nothing selected'); return false; }
          const total = list.reduce((n, m) => n + m.world.length, 0);
          const merged = new Float32Array(total);
          let o = 0;
          list.forEach((m) => { merged.set(m.world, o); o += m.world.length; });
          if (st.format === 'stl-bin') App.download(st.name + '.stl', new Blob([App.mesh.toSTLBinary(merged)], { type: 'model/stl' }));
          else if (st.format === 'stl-ascii') App.download(st.name + '.stl', App.mesh.toSTLAscii(merged, st.name));
          else App.download(st.name + '.obj', App.mesh.toOBJ(merged));
          App.toast('Exported ' + list.length + ' model(s)', 'ok');
        },
      }],
    });
  };

  D.exportGcode = function (gcode, defaultName, kind) {
    const ext = { printing: '.gcode', laser: '.nc', cnc: '.cnc' }[kind] || '.gcode';
    const st = { name: defaultName, ext, addToWorkspace: true };
    App.dialog({
      title: 'Export G-code', size: 'narrow',
      body: [App.form([
        { key: 'name', label: 'File name', type: 'text' },
        { key: 'ext', label: 'Extension', type: 'select', options: ['.gcode', '.nc', '.cnc', '.txt'] },
        { key: 'addToWorkspace', label: 'Also add to Workspace file list', type: 'checkbox' },
      ], st), h('div.hint', `${gcode.split('\n').length.toLocaleString()} lines · ${App.fmtBytes(gcode.length)}`)],
      buttons: [{ label: 'Cancel' }, {
        label: 'Export', primary: true, action: () => {
          App.download(st.name + st.ext, gcode);
          if (st.addToWorkspace) App.workspaceFiles.add(st.name + st.ext, gcode, kind);
        },
      }],
    });
  };

  D.sendToDevice = function (gcode, name, kind) {
    const connected = App.device && App.device.connected;
    App.dialog({
      title: 'Send to Device', size: 'narrow',
      body: [
        h('p', { style: { margin: 0 } }, `File: ${name}`),
        connected ? h('div.note', `Connected to ${App.device.label}. The file will be loaded in Workspace, ready to start.`)
          : h('div.note.warn', 'No machine is connected. The file will be added to Workspace; connect a machine there to run it.'),
      ],
      buttons: [{ label: 'Cancel' }, connected ? null : { label: 'Connect…', action: () => { D.connection(); return false; } }, {
        label: 'Load in Workspace', primary: true, action: () => {
          const f = App.workspaceFiles.add(name, gcode, kind);
          App.go('workspace');
          App.pages.workspace.loadFile(f.id);
        },
      }].filter(Boolean),
    });
  };

  /* ---------- connection ---------- */
  D.connection = function () {
    const st = { baud: App.prefs.baudRate };
    let tab = 'wifi';
    const pane = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: '220px' } });
    const render = () => {
      pane.innerHTML = '';
      if (tab === 'wifi') {
        const list = h('div.list', { style: { maxHeight: '220px' } },
          h('div.li', { on: { click: () => connect({ type: 'virtual' }) } }, App.icon('chip'), h('span.name', 'Virtual machine (simulator)'), h('span.badge.green', 'Available'), h('button.btn.small.primary', 'Connect')));
        pane.append(
          h('div.row', h('b.grow', 'Machines on your network'), h('button.btn.small', { on: { click: () => App.toast('Scan complete: browsers cannot discover network machines; the simulator is always available.') } }, App.icon('refresh'), 'Refresh')),
          list,
          h('div.hint', 'Web browsers are not allowed to scan the local network, so only the built-in simulator is listed. Use the Serial tab to connect a real machine over USB.'));
      } else {
        const supported = 'serial' in navigator;
        pane.append(
          supported ? h('div.note', 'Connect your machine with a USB cable, then click Choose port.') : h('div.note.warn', 'This browser does not support Web Serial. Use a Chromium-based browser (Chrome, Edge) to connect over USB.'),
          App.form([{ key: 'baud', label: 'Baud rate', type: 'select', options: [9600, 57600, 115200, 250000] }], st),
          h('button.btn.primary', { disabled: !supported, on: { click: () => connect({ type: 'serial', baud: Number(st.baud) }) } }, App.icon('usb'), 'Choose port & connect'));
      }
    };
    const dlg = App.dialog({
      title: 'Connect', size: 'narrow',
      body: [App.tabs([['wifi', 'Wi-Fi'], ['serial', 'Serial port']], (t) => { tab = t; render(); }), pane],
      buttons: [{ label: 'Close' }],
    });
    async function connect(o) {
      try {
        await App.deviceConnect(o);
        App.toast('Connected to ' + App.device.label, 'ok');
        dlg.close();
      } catch (e) {
        if (e && e.name !== 'NotFoundError') App.toast('Connection failed: ' + (e.message || e), 'error');
      }
    }
  };

  /* ---------- model tools ---------- */
  D.modelRepair = function (model, onDone) {
    const before = { tris: model.mesh.length / 9, open: App.mesh.openEdges(model.mesh) };
    const r = App.mesh.repair(model.mesh);
    const tbl = h('table.tbl',
      h('tr', h('th', 'Check'), h('th', 'Result')),
      h('tr', h('td', 'Triangles'), h('td', `${before.tris.toLocaleString()} → ${(r.mesh.length / 9).toLocaleString()}`)),
      h('tr', h('td', 'Degenerate triangles removed'), h('td', String(r.degenerate))),
      h('tr', h('td', 'Duplicate triangles removed'), h('td', String(r.duplicate))),
      h('tr', h('td', 'Normals flipped (inside-out)'), h('td', r.flipped ? 'Yes – fixed' : 'No')),
      h('tr', h('td', 'Open edges (holes)'), h('td', r.openEdges ? h('span.badge.red', `${r.openEdges} – may print incorrectly`) : h('span.badge.green', 'None – watertight'))));
    App.dialog({
      title: 'Repair Model', body: [h('p', { style: { margin: 0 } }, `Model: ${model.name}`), tbl],
      buttons: [{ label: 'Cancel' }, { label: 'Apply repair', primary: true, action: () => onDone(r.mesh) }],
    });
  };
  D.simplify = function (model, onDone) {
    const st = { ratio: 50 };
    const info = h('div.hint');
    const upd = () => { info.textContent = `${(model.mesh.length / 9).toLocaleString()} triangles → about ${Math.round((model.mesh.length / 9) * st.ratio / 100).toLocaleString()}`; };
    upd();
    App.dialog({
      title: 'Simplify Model', size: 'narrow',
      body: [App.form([{ key: 'ratio', label: 'Keep', type: 'range', min: 5, max: 95, step: 5, unit: '%' }], st, upd), info,
        h('div.hint', 'Reduces the triangle count by merging nearby vertices. Fine details may be lost.')],
      buttons: [{ label: 'Cancel' }, { label: 'Simplify', primary: true, action: () => { const m = App.mesh.simplify(model.mesh, st.ratio / 100); onDone(m); App.toast(`Simplified to ${(m.length / 9).toLocaleString()} triangles`, 'ok'); } }],
    });
  };
  D.arrange = function (onDone) {
    const st = App.store.get('arrange', { spacing: 5, padding: 5, rotate: false });
    App.dialog({
      title: 'Auto Arrange', size: 'narrow',
      body: App.form([
        { key: 'spacing', label: 'Spacing between models', type: 'number', unit: 'mm', min: 0, max: 50 },
        { key: 'padding', label: 'Distance to plate edge', type: 'number', unit: 'mm', min: 0, max: 50 },
        { key: 'rotate', label: 'Allow rotating models 90°', type: 'checkbox' },
      ], st),
      buttons: [{ label: 'Cancel' }, { label: 'Arrange', primary: true, action: () => { App.store.set('arrange', st); onDone(st); } }],
    });
  };

  /* ---------- laser / CNC dialogs ---------- */
  D.jobSetup = function (kind, setup, onDone) {
    const st = App.deepClone(setup);
    const schema = [
      { key: 'width', label: kind === 'cnc' ? 'Stock width (X)' : 'Material width (X)', type: 'number', unit: 'mm', min: 1 },
      { key: 'height', label: kind === 'cnc' ? 'Stock height (Y)' : 'Material height (Y)', type: 'number', unit: 'mm', min: 1 },
      { key: 'thickness', label: 'Thickness (Z)', type: 'number', unit: 'mm', min: 0 },
      { key: 'origin', label: 'Work origin', type: 'select', options: [['bottom-left', 'Bottom left'], ['top-left', 'Top left'], ['center', 'Center'], ['top-right', 'Top right'], ['bottom-right', 'Bottom right']] },
    ];
    if (kind === 'cnc') schema.push({ key: 'zOrigin', label: 'Z zero', type: 'select', options: [['top', 'Top of stock'], ['bottom', 'Bottom of stock']] }, { key: 'safeZ', label: 'Safe height', type: 'number', unit: 'mm', min: 0.5, max: 50 });
    if (kind === 'laser') schema.push({ key: 'autoFocus', label: 'Set focus from material thickness', type: 'checkbox' });
    App.dialog({
      title: 'Job Setup', size: 'narrow',
      body: [App.form(schema, st), h('div.hint', 'The work origin is the point the machine treats as X0 Y0. Set it on the machine in Workspace before running the job.')],
      buttons: [{ label: 'Cancel' }, { label: 'Apply', primary: true, action: () => onDone(st) }],
    });
  };
  D.textEdit = function (obj, onDone) {
    const st = { text: obj.text, font: obj.font, size: obj.fontSize, bold: obj.bold, italic: obj.italic, align: obj.align || 'center', lineHeight: obj.lineHeight || 1.2 };
    const preview = h('div', { style: { border: '1px solid var(--border)', borderRadius: '6px', padding: '12px', minHeight: '80px', whiteSpace: 'pre-wrap', background: 'var(--panel-2)' } });
    const upd = () => Object.assign(preview.style, { fontFamily: st.font, fontWeight: st.bold ? 700 : 400, fontStyle: st.italic ? 'italic' : 'normal', textAlign: st.align, fontSize: Math.min(40, st.size) + 'px', lineHeight: st.lineHeight }) && (preview.textContent = st.text);
    upd();
    App.dialog({
      title: 'Edit Text',
      body: [App.form([
        { key: 'text', label: 'Text', type: 'textarea', rows: 3 },
        { key: 'font', label: 'Font', type: 'select', options: ['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS', 'Impact', 'Comic Sans MS'] },
        { key: 'size', label: 'Font size', type: 'number', unit: 'pt', min: 4, max: 400 },
        { key: 'lineHeight', label: 'Line spacing', type: 'number', min: 0.8, max: 3, step: 0.1 },
        { key: 'align', label: 'Alignment', type: 'select', options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] },
        { key: 'bold', label: 'Bold', type: 'checkbox' },
        { key: 'italic', label: 'Italic', type: 'checkbox' },
      ], st, upd), h('b', 'Preview'), preview],
      buttons: [{ label: 'Cancel' }, { label: 'Apply', primary: true, action: () => onDone(st) }],
    });
  };
  D.imageProcess = function (obj, kind, onDone) {
    const st = { threshold: obj.threshold ?? 128, invert: !!obj.invert, brightness: obj.brightness ?? 0, contrast: obj.contrast ?? 0, mode: obj.mode };
    const cv = h('canvas', { width: 280, height: 200, style: { width: '280px', height: '200px', background: '#fff', border: '1px solid var(--border)', borderRadius: '6px', alignSelf: 'center' } });
    const img = new Image();
    img.src = obj.src;
    const draw = () => {
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      if (!img.complete || !img.naturalWidth) return;
      const s = Math.min(cv.width / img.naturalWidth, cv.height / img.naturalHeight);
      const w = img.naturalWidth * s, hh = img.naturalHeight * s;
      ctx.drawImage(img, (cv.width - w) / 2, (cv.height - hh) / 2, w, hh);
      const d = ctx.getImageData(0, 0, cv.width, cv.height);
      App.editor2dUtil.processPixels(d.data, Object.assign({}, obj, st));
      ctx.putImageData(d, 0, 0);
    };
    img.onload = draw;
    const modes = kind === 'laser' ? [['bitmap', 'Black & white'], ['greyscale', 'Greyscale'], ['vector', 'Outline (vector trace)']] : [['relief', 'Relief (greyscale depth)'], ['vector', 'Outline (vector trace)']];
    App.dialog({
      title: 'Image Processing',
      body: [cv, App.form([
        { key: 'mode', label: 'Processing mode', type: 'select', options: modes },
        { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 255, show: (v) => v.mode === 'bitmap' || v.mode === 'vector' },
        { key: 'brightness', label: 'Brightness', type: 'range', min: -100, max: 100 },
        { key: 'contrast', label: 'Contrast', type: 'range', min: -100, max: 100 },
        { key: 'invert', label: 'Invert', type: 'checkbox' },
      ], st, draw)],
      buttons: [{ label: 'Reset', left: true, action: () => { onDone({ threshold: 128, invert: false, brightness: 0, contrast: 0 }); } }, { label: 'Cancel' }, { label: 'Apply', primary: true, action: () => onDone(st) }],
    });
  };
  D.toolpathSettings = function (kind, tp, onDone) {
    const st = App.deepClone(tp);
    const schema = kind === 'laser' ? [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'mode', label: 'Method', type: 'select', options: [['vector', 'Vector (line)'], ['bitmap', 'Fill (black & white)'], ['greyscale', 'Greyscale']] },
      { key: 'fillVector', label: 'Fill vector shapes', type: 'checkbox', show: (v) => v.mode === 'vector' },
      { key: 'power', label: 'Laser power', type: 'number', unit: '%', min: 0, max: 100 },
      { key: 'workSpeed', label: 'Work speed', type: 'number', unit: 'mm/s', min: 1, max: 400 },
      { key: 'travelSpeed', label: 'Jog speed', type: 'number', unit: 'mm/s', min: 1, max: 400 },
      { key: 'density', label: 'Line density', type: 'number', unit: 'lines/mm', min: 1, max: 20, show: (v) => v.mode !== 'vector' || v.fillVector },
      { key: 'direction', label: 'Scan direction', type: 'select', options: [['h', 'Horizontal'], ['v', 'Vertical'], ['d', 'Diagonal']], show: (v) => v.mode !== 'vector' || v.fillVector },
      { key: 'passes', label: 'Number of passes', type: 'number', min: 1, max: 50, step: 1 },
      { key: 'passDepth', label: 'Z step per pass', type: 'number', unit: 'mm', min: 0, max: 5, show: (v) => v.passes > 1 },
      { key: 'airAssist', label: 'Air assist (M8)', type: 'checkbox' },
    ] : [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'mode', label: 'Method', type: 'select', options: [['outline', 'Outline (on path)'], ['outside', 'Outline (outside)'], ['inside', 'Outline (inside)'], ['pocket', 'Pocket (clear area)'], ['relief', 'Relief (greyscale image)']] },
      { key: 'toolId', label: 'Tool', type: 'select', options: () => App.lib.tools.all().map((t) => [t.id, t.name]) },
      { key: 'targetDepth', label: 'Target depth', type: 'number', unit: 'mm', min: 0.05, max: 100 },
      { key: 'stepDown', label: 'Step down', type: 'number', unit: 'mm', min: 0.05, max: 10 },
      { key: 'feedRate', label: 'Work speed', type: 'number', unit: 'mm/min', min: 10, max: 5000 },
      { key: 'plungeRate', label: 'Plunge speed', type: 'number', unit: 'mm/min', min: 10, max: 3000 },
      { key: 'stepOver', label: 'Step over', type: 'number', unit: '%', min: 5, max: 100, show: (v) => v.mode === 'pocket' || v.mode === 'relief' },
      { key: 'spindle', label: 'Spindle speed', type: 'number', unit: 'RPM', min: 1000, max: 30000 },
      { key: 'tabs', label: 'Use holding tabs', type: 'checkbox', show: (v) => ['outline', 'outside', 'inside'].includes(v.mode) },
      { key: 'tabHeight', label: 'Tab height', type: 'number', unit: 'mm', min: 0.1, max: 10, show: (v) => v.tabs && ['outline', 'outside', 'inside'].includes(v.mode) },
    ];
    const form = App.form(schema, st, (k, v) => {
      if (k === 'toolId') { const t = App.lib.tools.get(v); if (t) Object.assign(st, { feedRate: t.feedRate, plungeRate: t.plungeRate, stepDown: t.stepDown, stepOver: t.stepOver, spindle: t.spindle }); refreshForm(); }
    });
    const wrap = h('div', form);
    const refreshForm = () => { wrap.innerHTML = ''; wrap.append(App.form(schema, st)); };
    App.dialog({
      title: 'Toolpath Settings',
      body: [wrap],
      buttons: [
        kind === 'laser' ? { label: 'Parameter library…', left: true, action: () => { D.laserLibrary(null, (id) => { const p = App.lib.laser.get(id); Object.assign(st, { mode: p.mode, power: p.power, workSpeed: p.workSpeed, passes: p.passes, passDepth: p.passDepth, density: p.density }); refreshForm(); }); return false; } }
          : { label: 'Tool library…', left: true, action: () => { D.toolLibrary(st.toolId, (id) => { const t = App.lib.tools.get(id); Object.assign(st, { toolId: id, feedRate: t.feedRate, plungeRate: t.plungeRate, stepDown: t.stepDown, stepOver: t.stepOver, spindle: t.spindle }); refreshForm(); }); return false; } },
        { label: 'Cancel' }, { label: 'Save', primary: true, action: () => onDone(st) }],
    });
  };
  D.cameraCapture = function (onDone) {
    const video = h('video.webcam', { autoplay: true, playsinline: true, muted: true });
    let stream = null;
    const status = h('div.hint', 'Starting camera…');
    const dlg = App.dialog({
      title: 'Camera Capture',
      body: [h('div.note', 'Place your material on the work area, then capture a photo to use as the canvas background for positioning designs.'), video, status],
      buttons: [{ label: 'Cancel' }, {
        label: 'Capture', primary: true, action: () => {
          if (!stream) { App.toast('No camera available'); return false; }
          const c = h('canvas', { width: video.videoWidth, height: video.videoHeight });
          c.getContext('2d').drawImage(video, 0, 0);
          onDone(c.toDataURL('image/jpeg', 0.85));
        },
      }],
      onClose: () => stream && stream.getTracks().forEach((t) => t.stop()),
    });
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status.textContent = 'Camera access is not available in this browser.'; return; }
    navigator.mediaDevices.getUserMedia({ video: true }).then((s) => {
      if (!dlg.el.isConnected) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s; video.srcObject = s; status.textContent = 'Camera ready.';
    }).catch((e) => { status.textContent = 'Could not open the camera: ' + e.message; });
  };

  /* ---------- workspace dialogs ---------- */
  D.macroEdit = function (macro, onDone) {
    const st = Object.assign({ name: 'New macro', gcode: 'G28\n' }, macro || {});
    App.dialog({
      title: macro ? 'Edit Macro' : 'New Macro',
      body: App.form([{ key: 'name', label: 'Name', type: 'text' }, { key: 'gcode', label: 'G-code', type: 'textarea', rows: 8, full: true }], st),
      buttons: [macro ? { label: 'Delete', left: true, danger: true, action: () => onDone(null) } : null, { label: 'Cancel' }, { label: 'Save', primary: true, action: () => onDone(st) }].filter(Boolean),
    });
  };

  /* ---------- help ---------- */
  D.shortcuts = function () {
    const rows = [
      ['General', [['Ctrl+N', 'New project'], ['Ctrl+O', 'Open project'], ['Ctrl+S', 'Save project'], ['Ctrl+Shift+S', 'Save as'], ['Ctrl+I', 'Import'], ['Ctrl+E', 'Export G-code'], ['Ctrl+,', 'Preferences'], ['F1', 'Keyboard shortcuts']]],
      ['Editing', [['Ctrl+Z', 'Undo'], ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'], ['Ctrl+C / Ctrl+X / Ctrl+V', 'Copy / cut / paste'], ['Ctrl+D', 'Duplicate'], ['Ctrl+A', 'Select all'], ['Delete / Backspace', 'Delete selection'], ['Esc', 'Deselect / close dialog'], ['Arrow keys', 'Nudge selection 1 mm (Shift: 10 mm)']]],
      ['3D Printing', [['M / S / R', 'Move / scale / rotate tool'], ['F', 'Lay flat'], ['Mouse left-drag', 'Orbit (or move model)'], ['Right-drag / Shift-drag', 'Pan'], ['Wheel', 'Zoom']]],
      ['Laser & CNC', [['V', 'Select tool'], ['T', 'Text'], ['R', 'Rectangle'], ['E', 'Ellipse'], ['P', 'Pen'], ['Space + drag / middle-drag', 'Pan canvas']]],
      ['Navigation', [['Ctrl+1', 'Home'], ['Ctrl+2', '3D Printing'], ['Ctrl+3', 'Laser'], ['Ctrl+4', 'CNC'], ['Ctrl+5', 'Workspace']]],
    ];
    App.dialog({
      title: 'Keyboard Shortcuts', size: 'wide',
      body: h('div', { style: { columns: '2 320px', columnGap: '24px' } }, rows.map(([g, list]) =>
        h('div', { style: { breakInside: 'avoid', marginBottom: '14px' } }, h('h4', { style: { marginBottom: '6px' } }, g),
          h('table.tbl', list.map(([k, d]) => h('tr', h('td', { style: { width: '50%' } }, k.split(' / ').map((x, i) => [i ? ' / ' : '', h('span.kbd', x)])), h('td', d))))))),
    });
  };
  D.about = function () {
    App.dialog({
      title: 'About', size: 'narrow',
      body: [
        h('div.row', h('div', { style: { color: 'var(--accent)', width: '48px', height: '48px' } }, App.icon('logo')), h('div', h('h3', App.name), h('div.muted', 'Version ' + App.version))),
        h('p', { style: { margin: 0 } }, 'An all-in-one workspace for 3D printing, laser engraving and CNC carving: prepare models, generate G-code and run jobs on a connected machine.'),
        h('table.tbl',
          h('tr', h('td', 'Machine'), h('td', App.machine().name)),
          h('tr', h('td', 'Tool head'), h('td', App.data.toolheadLabel(App.machine().toolhead))),
          h('tr', h('td', 'Browser'), h('td', navigator.userAgent.split(') ').pop())),
          h('tr', h('td', 'Web Serial'), h('td', 'serial' in navigator ? 'Supported' : 'Not supported'))),
      ],
    });
  };
  D.checkUpdates = function () {
    const body = h('div', h('div.row', h('div.progress.grow', h('div', { style: { width: '30%' } })), h('span.muted', 'Checking…')));
    const dlg = App.dialog({ title: 'Software Update', size: 'narrow', body });
    setTimeout(() => {
      if (!dlg.el.isConnected) return;
      body.innerHTML = '';
      body.append(h('p', { style: { margin: 0 } }, `${App.name} ${App.version} is the latest version available.`),
        App.form([{ key: 'checkUpdates', label: 'Automatically check for updates at startup', type: 'checkbox' }], { checkUpdates: App.prefs.checkUpdates }, (k, v) => App.setPref(k, v)));
    }, 900);
  };
  D.firmwareUpdate = function () {
    let file = null;
    const info = h('div.hint', 'No file selected.');
    const bar = h('div.progress', h('div'));
    const dlg = App.dialog({
      title: 'Firmware Update',
      body: [
        h('div.note.warn', 'Updating firmware restarts the machine. Do not disconnect power or the cable during the update.'),
        h('div.row', h('span.grow', App.device && App.device.connected ? `Connected: ${App.device.label}` : 'No machine connected'), App.device && App.device.connected ? null : h('button.btn.small', { on: { click: () => D.connection() } }, 'Connect…')),
        h('div.row', h('button.btn', { on: { click: async () => { const [f] = await App.pickFiles('.bin,.hex,.zip'); if (f) { file = f; info.textContent = `${f.name} (${App.fmtBytes(f.size)})`; } } } }, App.icon('open'), 'Choose firmware file…'), info),
        bar,
      ],
      buttons: [{ label: 'Close' }, {
        label: 'Update', primary: true, action: () => {
          if (!App.device || !App.device.connected) { App.toast('Connect a machine first'); return false; }
          if (!file) { App.toast('Choose a firmware file first'); return false; }
          if (App.device.type !== 'virtual') { App.toast('Firmware upload over Web Serial is not supported for this machine. Use the manufacturer\'s update tool.', 'error'); return false; }
          let p = 0;
          const btn = dlg.button && dlg.foot.querySelector('.primary');
          btn.disabled = true;
          const iv = setInterval(() => {
            p += 7;
            bar.firstChild.style.width = Math.min(100, p) + '%';
            if (p >= 100) { clearInterval(iv); btn.disabled = false; App.toast('Firmware updated on the simulator', 'ok'); info.textContent = 'Update complete.'; }
          }, 120);
          return false;
        },
      }],
    });
  };
  D.caseLibrary = function () {
    let filter = 'all';
    const grid = h('div.case-grid');
    const render = () => {
      grid.innerHTML = '';
      App.cases.filter((c) => filter === 'all' || c.type === filter).forEach((c) => grid.append(caseCard(c, () => dlg.close())));
    };
    const dlg = App.dialog({
      title: 'Case Library', size: 'xwide',
      body: [App.tabs([['all', 'All'], ['printing', '3D Printing'], ['laser', 'Laser'], ['cnc', 'CNC']], (t) => { filter = t; render(); }), grid],
    });
  };
  function caseCard(c, after) {
    return h('div.case-card', { on: { click: async () => { after && after(); await App.loadCase(c); } } },
      h('div.thumb', { style: { color: c.color || 'var(--accent)' } }, App.icon(c.icon || kindIcon[c.type])),
      h('div.meta', h('div.t', c.name), h('div.d', `${kindLabel[c.type]} · ${c.desc}`)));
  }
  App.caseCard = caseCard;

  const tutorials = [
    { type: 'printing', t: 'Your first 3D print', steps: ['Open 3D Printing from Home.', 'Import an STL/OBJ model (or add a shape from the left toolbar).', 'Pick a material and a print profile on the right.', 'Click Generate G-code and check the layer preview.', 'Export the G-code or send it to Workspace and start the print.'] },
    { type: 'printing', t: 'Supports and adhesion', steps: ['Open Settings → Printing profiles (or Customize).', 'Under Support, enable Generate support and set the overhang angle.', 'Under Build plate adhesion choose Skirt, Brim or Raft.', 'Re-generate G-code to see support (orange) in the preview.'] },
    { type: 'printing', t: 'Dual-extruder printing', steps: ['Select a machine with a dual extruder in Machine Settings.', 'Select a model and use the Extruder tool to assign it to the left or right nozzle.', 'Choose a material for each extruder, then generate G-code.'] },
    { type: 'laser', t: 'Engraving a photo', steps: ['Open Laser and set the material size in Job Setup.', 'Upload an image and choose Greyscale or Black & white.', 'Adjust brightness, contrast and threshold in Image Processing.', 'Edit the toolpath (power, speed, density) and generate G-code.'] },
    { type: 'laser', t: 'Cutting shapes', steps: ['Draw shapes or import an SVG.', 'Edit the toolpath: Vector method, full power, low speed and several passes.', 'Use Z step per pass for thick material.', 'Preview, export, and run with air assist on.'] },
    { type: 'cnc', t: 'Carving a sign', steps: ['Open CNC and set the stock size and Z zero in Job Setup.', 'Add text and shapes.', 'Use Pocket for recessed areas and Outline (outside) to cut the board out.', 'Choose a tool from the CNC Tool Library and set the depth.', 'Preview the toolpaths, then export or send to Workspace.'] },
    { type: 'workspace', t: 'Running a job from Workspace', steps: ['Connect over Serial (USB) or use the simulator.', 'Home the machine and jog to your work origin; click Set work origin.', 'Load a G-code file and check it in the visualizer.', 'Click Start. Use Pause and Stop when needed.'] },
  ];
  D.tutorials = function () {
    const detail = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    const list = h('div.list', { style: { maxHeight: '420px' } });
    const show = (t) => {
      App.$$('.li', list).forEach((x) => x.classList.toggle('active', x.dataset.t === t.t));
      detail.innerHTML = '';
      detail.append(h('h3', t.t), h('span.badge.blue', kindLabel[t.type] || 'Workspace'), h('ol', { style: { paddingLeft: '18px', lineHeight: 1.8 } }, t.steps.map((s) => h('li', s))),
        h('button.btn.primary', { style: { alignSelf: 'flex-start' }, on: { click: () => { dlg.close(); App.go(t.type); } } }, 'Open ' + (kindLabel[t.type] || 'Workspace')));
    };
    tutorials.forEach((t) => { const li = h('div.li', { on: { click: () => show(t) } }, App.icon(kindIcon[t.type] || 'workspace'), h('span.name', t.t)); li.dataset.t = t.t; list.append(li); });
    const dlg = App.dialog({ title: 'Tutorials', size: 'wide', body: h('div.split', list, detail) });
    show(tutorials[0]);
  };
  D.manual = function () {
    const sections = [
      ['Home', 'Start a new project, open a saved one, reopen recent projects, browse the case library and tutorials.'],
      ['3D Printing', 'Import STL/OBJ files or add shapes. Move, scale, rotate, mirror and lay models flat; repair and simplify meshes; assign extruders. Choose a material and profile, generate G-code, inspect layers, then export or send to Workspace.'],
      ['Laser', 'Set up the material, add text, shapes, freehand paths, images or SVG files. Each object gets a toolpath (vector line, black & white fill or greyscale). Generate G-code to preview the laser path.'],
      ['CNC', 'Set up the stock and Z zero, add designs, and create outline, pocket or relief toolpaths with tools from the tool library.'],
      ['Workspace', 'Connect a machine (USB serial or simulator), jog and home it, set the work origin, control temperatures, laser or spindle, run macros and G-code jobs, and watch the console.'],
      ['Settings', 'Language, units and theme; machine and tool head; connection defaults; software and firmware updates; download history.'],
      ['Project files', 'Projects are saved as .msproj files (JSON). They store models, objects, toolpaths and settings, so you can reopen and continue later.'],
    ];
    App.dialog({ title: 'Software Manual', size: 'wide', body: sections.map(([t, d]) => h('div', h('h4', t), h('p.muted', { style: { margin: '4px 0 0' } }, d))) });
  };
  D.feedback = function () {
    const st = { category: 'bug', summary: '', details: '', includeSystem: true };
    App.dialog({
      title: 'Report a Problem',
      body: [App.form([
        { key: 'category', label: 'Category', type: 'select', options: [['bug', 'Bug'], ['idea', 'Feature request'], ['question', 'Question']] },
        { key: 'summary', label: 'Summary', type: 'text' },
        { key: 'details', label: 'Details', type: 'textarea', rows: 6, full: true },
        { key: 'includeSystem', label: 'Include machine and browser information', type: 'checkbox' },
      ], st), h('div.hint', 'The report is saved as a text file you can attach to an issue or email.')],
      buttons: [{ label: 'Cancel' }, {
        label: 'Save report', primary: true, action: () => {
          if (!st.summary.trim()) { App.toast('Please add a summary'); return false; }
          const lines = [`Category: ${st.category}`, `Summary: ${st.summary}`, '', st.details];
          if (st.includeSystem) lines.push('', '---', `App: ${App.name} ${App.version}`, `Machine: ${App.machine().name} / ${App.machine().toolhead}`, `Browser: ${navigator.userAgent}`);
          App.download('problem-report.txt', lines.join('\n'));
        },
      }],
    });
  };
  D.downloadManager = function () {
    const body = h('div');
    const render = () => {
      body.innerHTML = '';
      body.append(App.downloads.length ? h('table.tbl', h('tr', h('th', 'File'), h('th', 'Size'), h('th', 'Time')),
        App.downloads.map((d) => h('tr', h('td', d.name), h('td', App.fmtBytes(d.size)), h('td', new Date(d.time).toLocaleTimeString()))))
        : h('div.muted', 'No files downloaded in this session.'));
    };
    render();
    const off = App.bus.on('downloads', render);
    App.dialog({ title: 'Download Manager', body, buttons: [{ label: 'Clear list', left: true, action: () => { App.downloads.length = 0; render(); return false; } }, { label: 'Close', primary: true }], onClose: off });
  };
  D.language = function () {
    const st = { language: App.prefs.language };
    App.dialog({
      title: 'Language', size: 'narrow',
      body: [App.form([{ key: 'language', label: 'Language', type: 'select', options: [['en', 'English']] }], st), h('div.hint', 'English is the only built-in language in this version.')],
      buttons: [{ label: 'Cancel' }, { label: 'Apply', primary: true, action: () => App.setPref('language', st.language) }],
    });
  };
})();
