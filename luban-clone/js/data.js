/* Built-in data: machines, printing profiles, materials, laser presets, CNC tools, preferences. */
(function () {
  'use strict';
  const App = window.App;

  const machines = [
    { id: 'compact', name: 'Compact 160', size: { x: 160, y: 160, z: 145 }, heads: ['print', 'laser', 'cnc'], laserSize: { x: 160, y: 160 }, cncSize: { x: 145, y: 145 } },
    { id: 'medium', name: 'Medium 250', size: { x: 230, y: 250, z: 235 }, heads: ['print', 'laser', 'cnc'], laserSize: { x: 252, y: 260 }, cncSize: { x: 230, y: 250 } },
    { id: 'large', name: 'Large 350', size: { x: 320, y: 350, z: 330 }, heads: ['print', 'dual', 'laser', 'cnc'], laserSize: { x: 345, y: 357 }, cncSize: { x: 320, y: 350 } },
    { id: 'xl', name: 'XL 400', size: { x: 400, y: 400, z: 400 }, heads: ['print', 'dual', 'laser', 'cnc'], laserSize: { x: 400, y: 400 }, cncSize: { x: 400, y: 400 } },
    { id: 'idex', name: 'IDEX 300', size: { x: 300, y: 200, z: 200 }, heads: ['dual'], laserSize: null, cncSize: null },
    { id: 'diode', name: 'Desktop Laser 600', size: { x: 600, y: 400, z: 0 }, heads: ['laser'], laserSize: { x: 600, y: 400 }, cncSize: null },
    { id: 'custom', name: 'Custom machine', size: { x: 220, y: 220, z: 250 }, heads: ['print', 'dual', 'laser', 'cnc'], laserSize: { x: 220, y: 220 }, cncSize: { x: 220, y: 220 } },
  ];
  const toolheads = {
    print: 'Single extruder',
    dual: 'Dual extruder',
    laser: 'Laser module',
    cnc: 'CNC module',
  };

  const baseProfile = {
    layerHeight: 0.2, firstLayerHeight: 0.24, lineWidth: 0.4,
    wallCount: 2, topLayers: 4, bottomLayers: 4,
    infillDensity: 15, infillPattern: 'lines',
    printSpeed: 60, wallSpeed: 40, infillSpeed: 70, travelSpeed: 150, firstLayerSpeed: 20,
    retraction: true, retractDistance: 1.5, retractSpeed: 40, zHop: false, zHopHeight: 0.4,
    fanSpeed: 100, fanFirstLayers: 1,
    support: false, supportType: 'normal', supportAngle: 50, supportDensity: 15, supportBuildplateOnly: true,
    adhesion: 'skirt', skirtLines: 2, brimWidth: 6, raftLayers: 3,
  };
  const printProfiles = [
    { id: 'fast', name: 'Fast Print', builtin: true, ...baseProfile, layerHeight: 0.28, firstLayerHeight: 0.3, infillDensity: 10, printSpeed: 80, wallSpeed: 50, infillSpeed: 90, topLayers: 3, bottomLayers: 3 },
    { id: 'normal', name: 'Normal Quality', builtin: true, ...baseProfile },
    { id: 'high', name: 'High Quality', builtin: true, ...baseProfile, layerHeight: 0.1, firstLayerHeight: 0.2, wallCount: 3, infillDensity: 20, printSpeed: 40, wallSpeed: 25, infillSpeed: 50, topLayers: 6, bottomLayers: 6 },
  ];
  const profileSchema = [
    { type: 'section', label: 'Quality' },
    { key: 'layerHeight', label: 'Layer height', type: 'number', unit: 'mm', min: 0.05, max: 0.6, step: 0.02 },
    { key: 'firstLayerHeight', label: 'Initial layer height', type: 'number', unit: 'mm', min: 0.05, max: 0.8, step: 0.02 },
    { key: 'lineWidth', label: 'Line width', type: 'number', unit: 'mm', min: 0.1, max: 1.2, step: 0.05 },
    { type: 'section', label: 'Shell' },
    { key: 'wallCount', label: 'Wall line count', type: 'number', min: 1, max: 10, step: 1 },
    { key: 'topLayers', label: 'Top layers', type: 'number', min: 0, max: 20, step: 1 },
    { key: 'bottomLayers', label: 'Bottom layers', type: 'number', min: 0, max: 20, step: 1 },
    { type: 'section', label: 'Infill' },
    { key: 'infillDensity', label: 'Infill density', type: 'number', unit: '%', min: 0, max: 100, step: 1 },
    { key: 'infillPattern', label: 'Infill pattern', type: 'select', options: [['lines', 'Lines'], ['grid', 'Grid'], ['zigzag', 'Zig-zag']] },
    { type: 'section', label: 'Speed' },
    { key: 'printSpeed', label: 'Print speed', type: 'number', unit: 'mm/s', min: 1, max: 500 },
    { key: 'wallSpeed', label: 'Wall speed', type: 'number', unit: 'mm/s', min: 1, max: 500 },
    { key: 'infillSpeed', label: 'Infill speed', type: 'number', unit: 'mm/s', min: 1, max: 500 },
    { key: 'firstLayerSpeed', label: 'Initial layer speed', type: 'number', unit: 'mm/s', min: 1, max: 200 },
    { key: 'travelSpeed', label: 'Travel speed', type: 'number', unit: 'mm/s', min: 1, max: 600 },
    { type: 'section', label: 'Travel' },
    { key: 'retraction', label: 'Enable retraction', type: 'checkbox' },
    { key: 'retractDistance', label: 'Retraction distance', type: 'number', unit: 'mm', min: 0, max: 20, show: (v) => v.retraction },
    { key: 'retractSpeed', label: 'Retraction speed', type: 'number', unit: 'mm/s', min: 1, max: 120, show: (v) => v.retraction },
    { key: 'zHop', label: 'Z hop when retracted', type: 'checkbox' },
    { key: 'zHopHeight', label: 'Z hop height', type: 'number', unit: 'mm', min: 0, max: 5, show: (v) => v.zHop },
    { type: 'section', label: 'Cooling' },
    { key: 'fanSpeed', label: 'Fan speed', type: 'number', unit: '%', min: 0, max: 100 },
    { key: 'fanFirstLayers', label: 'Fan off for first', type: 'number', unit: 'layers', min: 0, max: 10, step: 1 },
    { type: 'section', label: 'Support' },
    { key: 'support', label: 'Generate support', type: 'checkbox' },
    { key: 'supportType', label: 'Support type', type: 'select', options: [['normal', 'Normal'], ['tree', 'Tree (columns)']], show: (v) => v.support },
    { key: 'supportAngle', label: 'Overhang angle', type: 'number', unit: '°', min: 0, max: 89, show: (v) => v.support },
    { key: 'supportDensity', label: 'Support density', type: 'number', unit: '%', min: 1, max: 100, show: (v) => v.support },
    { key: 'supportBuildplateOnly', label: 'Touching build plate only', type: 'checkbox', show: (v) => v.support },
    { type: 'section', label: 'Build plate adhesion' },
    { key: 'adhesion', label: 'Adhesion type', type: 'select', options: [['none', 'None'], ['skirt', 'Skirt'], ['brim', 'Brim'], ['raft', 'Raft']] },
    { key: 'skirtLines', label: 'Skirt line count', type: 'number', min: 1, max: 10, step: 1, show: (v) => v.adhesion === 'skirt' },
    { key: 'brimWidth', label: 'Brim width', type: 'number', unit: 'mm', min: 1, max: 30, show: (v) => v.adhesion === 'brim' },
    { key: 'raftLayers', label: 'Raft layers', type: 'number', min: 1, max: 6, step: 1, show: (v) => v.adhesion === 'raft' },
  ];

  const materials = [
    { id: 'pla', name: 'PLA', builtin: true, color: '#3d8ee8', diameter: 1.75, density: 1.24, nozzleTemp: 205, bedTemp: 60, fan: 100, flow: 100, cost: 20 },
    { id: 'abs', name: 'ABS', builtin: true, color: '#e8553d', diameter: 1.75, density: 1.04, nozzleTemp: 240, bedTemp: 95, fan: 20, flow: 100, cost: 22 },
    { id: 'petg', name: 'PETG', builtin: true, color: '#2fb08a', diameter: 1.75, density: 1.27, nozzleTemp: 235, bedTemp: 80, fan: 50, flow: 100, cost: 24 },
    { id: 'tpu', name: 'TPU', builtin: true, color: '#9a5ae0', diameter: 1.75, density: 1.21, nozzleTemp: 225, bedTemp: 50, fan: 60, flow: 105, cost: 32 },
    { id: 'pla-wood', name: 'PLA Wood', builtin: true, color: '#a0703c', diameter: 1.75, density: 1.15, nozzleTemp: 210, bedTemp: 60, fan: 100, flow: 100, cost: 30 },
  ];
  const materialSchema = [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'color', label: 'Color', type: 'color' },
    { key: 'diameter', label: 'Filament diameter', type: 'number', unit: 'mm', min: 1, max: 3 },
    { key: 'density', label: 'Density', type: 'number', unit: 'g/cm³', min: 0.5, max: 3 },
    { key: 'nozzleTemp', label: 'Nozzle temperature', type: 'number', unit: '°C', min: 150, max: 320 },
    { key: 'bedTemp', label: 'Bed temperature', type: 'number', unit: '°C', min: 0, max: 120 },
    { key: 'fan', label: 'Cooling fan', type: 'number', unit: '%', min: 0, max: 100 },
    { key: 'flow', label: 'Flow', type: 'number', unit: '%', min: 50, max: 150 },
    { key: 'cost', label: 'Cost per kg', type: 'number', unit: '$', min: 0 },
  ];

  const laserPresets = [
    { id: 'wood3-cut', name: 'Basswood 3 mm – Cut', builtin: true, material: 'Basswood', thickness: 3, mode: 'vector', power: 100, workSpeed: 6, passes: 2, passDepth: 0.6, fill: false, density: 10 },
    { id: 'wood-engrave', name: 'Wood – Engrave', builtin: true, material: 'Basswood', thickness: 3, mode: 'bitmap', power: 60, workSpeed: 60, passes: 1, passDepth: 0, fill: true, density: 10 },
    { id: 'acrylic-cut', name: 'Black acrylic 3 mm – Cut', builtin: true, material: 'Acrylic', thickness: 3, mode: 'vector', power: 100, workSpeed: 4, passes: 3, passDepth: 0.5, fill: false, density: 10 },
    { id: 'leather', name: 'Leather – Engrave', builtin: true, material: 'Leather', thickness: 2, mode: 'greyscale', power: 40, workSpeed: 80, passes: 1, passDepth: 0, fill: true, density: 8 },
    { id: 'paper-cut', name: 'Cardboard – Cut', builtin: true, material: 'Cardboard', thickness: 2, mode: 'vector', power: 70, workSpeed: 15, passes: 1, passDepth: 0, fill: false, density: 10 },
  ];
  const laserSchema = [
    { key: 'name', label: 'Preset name', type: 'text' },
    { key: 'material', label: 'Material', type: 'text' },
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'mm', min: 0 },
    { key: 'mode', label: 'Method', type: 'select', options: [['vector', 'Vector (line/cut)'], ['bitmap', 'Fill (black & white)'], ['greyscale', 'Greyscale']] },
    { key: 'power', label: 'Laser power', type: 'number', unit: '%', min: 0, max: 100 },
    { key: 'workSpeed', label: 'Work speed', type: 'number', unit: 'mm/s', min: 1, max: 400 },
    { key: 'passes', label: 'Number of passes', type: 'number', min: 1, max: 50, step: 1 },
    { key: 'passDepth', label: 'Z step per pass', type: 'number', unit: 'mm', min: 0, max: 5 },
    { key: 'density', label: 'Line density', type: 'number', unit: 'lines/mm', min: 1, max: 20, step: 1 },
  ];

  const cncTools = [
    { id: 'flat-3175', name: 'Flat end mill Ø3.175', builtin: true, shape: 'flat', diameter: 3.175, angle: 180, shaftDiameter: 3.175, flutes: 2, feedRate: 300, plungeRate: 100, stepDown: 0.8, stepOver: 40, spindle: 12000 },
    { id: 'flat-1', name: 'Flat end mill Ø1.0', builtin: true, shape: 'flat', diameter: 1, angle: 180, shaftDiameter: 3.175, flutes: 2, feedRate: 200, plungeRate: 60, stepDown: 0.3, stepOver: 40, spindle: 12000 },
    { id: 'ball-3175', name: 'Ball end mill Ø3.175', builtin: true, shape: 'ball', diameter: 3.175, angle: 180, shaftDiameter: 3.175, flutes: 2, feedRate: 300, plungeRate: 100, stepDown: 0.5, stepOver: 20, spindle: 12000 },
    { id: 'vbit-30', name: 'V-bit 30° Ø0.2', builtin: true, shape: 'vbit', diameter: 0.2, angle: 30, shaftDiameter: 3.175, flutes: 1, feedRate: 250, plungeRate: 80, stepDown: 0.3, stepOver: 30, spindle: 12000 },
  ];
  const cncToolSchema = [
    { key: 'name', label: 'Tool name', type: 'text' },
    { key: 'shape', label: 'Tool type', type: 'select', options: [['flat', 'Flat end mill'], ['ball', 'Ball end mill'], ['vbit', 'V-bit (carving)']] },
    { key: 'diameter', label: 'Cutting diameter', type: 'number', unit: 'mm', min: 0.05, max: 20 },
    { key: 'angle', label: 'Tip angle', type: 'number', unit: '°', min: 10, max: 180, show: (v) => v.shape === 'vbit' },
    { key: 'shaftDiameter', label: 'Shank diameter', type: 'number', unit: 'mm', min: 1, max: 12 },
    { key: 'flutes', label: 'Flutes', type: 'number', min: 1, max: 6, step: 1 },
    { key: 'feedRate', label: 'Work speed', type: 'number', unit: 'mm/min', min: 10, max: 5000 },
    { key: 'plungeRate', label: 'Plunge speed', type: 'number', unit: 'mm/min', min: 10, max: 2000 },
    { key: 'stepDown', label: 'Step down', type: 'number', unit: 'mm', min: 0.05, max: 10 },
    { key: 'stepOver', label: 'Step over', type: 'number', unit: '%', min: 5, max: 100 },
    { key: 'spindle', label: 'Spindle speed', type: 'number', unit: 'RPM', min: 1000, max: 30000 },
  ];

  const defaultPrefs = {
    language: 'en', units: 'mm', theme: 'system', autoSave: true, showWelcome: true, checkUpdates: true,
    analytics: false, baudRate: 115200, autoReconnect: false, machineId: 'large', toolhead: 'print',
    custom: { x: 220, y: 220, z: 250 }, gcodeFlavor: 'marlin', nozzleDiameter: 0.4,
    laserMaxS: 255, laserPowerWatts: 10,
  };

  App.data = {
    machines, toolheads, printProfiles, profileSchema, materials, materialSchema,
    laserPresets, laserSchema, cncTools, cncToolSchema, defaultPrefs,
    toolheadLabel: (t) => toolheads[t] || t,
  };

  /* ---------- user-editable libraries, persisted ---------- */
  function library(key, builtins) {
    return {
      all() { return builtins.concat(App.store.get(key, [])); },
      get(id) { return this.all().find((x) => x.id === id); },
      saveCustom(list) { App.store.set(key, list.filter((x) => !x.builtin)); App.bus.emit('library', key); },
      upsert(item) {
        const custom = App.store.get(key, []);
        const i = custom.findIndex((x) => x.id === item.id);
        if (i >= 0) custom[i] = item; else custom.push(item);
        App.store.set(key, custom);
        App.bus.emit('library', key);
      },
      remove(id) { App.store.set(key, App.store.get(key, []).filter((x) => x.id !== id)); App.bus.emit('library', key); },
    };
  }
  App.lib = {
    profiles: library('profiles', printProfiles),
    materials: library('materials', materials),
    laser: library('laserPresets', laserPresets),
    tools: library('cncTools', cncTools),
  };

  /* ---------- preferences ---------- */
  App.prefs = Object.assign({}, defaultPrefs, App.store.get('prefs', {}));
  App.setPref = function (k, v) {
    App.prefs[k] = v;
    App.store.set('prefs', App.prefs);
    if (k === 'theme') App.applyTheme();
    if (['machineId', 'toolhead', 'custom'].includes(k)) App.bus.emit('machine');
    App.bus.emit('prefs', k);
  };
  App.applyTheme = function () {
    const t = App.prefs.theme;
    const dark = t === 'dark' || (t === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  };
  App.machine = function () {
    const m = machines.find((x) => x.id === App.prefs.machineId) || machines[2];
    const out = App.deepClone(m);
    if (m.id === 'custom') {
      out.size = Object.assign({}, App.prefs.custom);
      out.laserSize = { x: out.size.x, y: out.size.y };
      out.cncSize = { x: out.size.x, y: out.size.y };
    }
    out.toolhead = m.heads.includes(App.prefs.toolhead) ? App.prefs.toolhead : m.heads[0];
    return out;
  };

  /* ---------- units ---------- */
  App.units = {
    toDisplay: (mm) => (App.prefs.units === 'in' ? mm / 25.4 : mm),
    fromDisplay: (v) => (App.prefs.units === 'in' ? v * 25.4 : v),
    label: () => (App.prefs.units === 'in' ? 'in' : 'mm'),
  };

  /* ---------- recent projects ---------- */
  App.recent = {
    list() { return App.store.get('recent', []); },
    add(project, name) {
      const list = App.recent.list().filter((r) => r.name !== name || r.type !== project.type);
      list.unshift({ id: App.uid('r'), name, type: project.type, time: Date.now() });
      while (list.length > 8) { const old = list.pop(); App.store.del('proj.' + old.id); }
      // store project payload separately (may fail if too large)
      const ok = App.store.set('proj.' + list[0].id, project);
      if (!ok) list[0].tooLarge = true;
      App.store.set('recent', list);
      App.bus.emit('recent');
    },
    load(id) { return App.store.get('proj.' + id, null); },
    clear() { App.recent.list().forEach((r) => App.store.del('proj.' + r.id)); App.store.set('recent', []); App.bus.emit('recent'); },
  };
})();
