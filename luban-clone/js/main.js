/* App start-up: menu bar, keyboard shortcuts, routing, recovery. */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;
  const D = App.dialogs;

  const editor = () => (['printing', 'laser', 'cnc'].includes(App.currentName) ? App.current : null);
  const run = (cmd) => () => { const e = editor(); if (e) e.cmd(cmd); else App.toast('Open 3D Printing, Laser or CNC first'); };
  const isMac = /Mac/.test(navigator.platform);
  const key = (k) => (isMac ? k.replace('Ctrl+', '⌘').replace('Shift+', '⇧') : k);

  function menus() {
    const recent = App.recent.list();
    return [
      ['File', [
        { label: 'New Project', sub: [{ label: '3D Printing', action: () => D.newProject('printing') }, { label: 'Laser', action: () => D.newProject('laser') }, { label: 'CNC', action: () => D.newProject('cnc') }], key: 'Ctrl+N' },
        { label: 'Open Project…', action: () => D.openProject(), key: 'Ctrl+O' },
        { label: 'Recent Projects', sub: recent.length ? recent.map((r) => ({ label: `${r.name} (${{ printing: '3D', laser: 'Laser', cnc: 'CNC' }[r.type]})`, action: async () => { const p = App.recent.load(r.id); if (!p) return App.toast('This project is no longer stored', 'error'); App.openProjectData(p, r.name); } })).concat(['-', { label: 'Clear recent', action: () => App.recent.clear() }]) : [{ label: 'No recent projects', disabled: true }] },
        '-',
        { label: 'Save Project', action: run('save'), key: 'Ctrl+S', disabled: !editor() },
        { label: 'Save Project As…', action: run('saveAs'), key: 'Ctrl+Shift+S', disabled: !editor() },
        '-',
        { label: 'Import…', action: run('import'), key: 'Ctrl+I', disabled: !editor() },
        { label: 'Export Models…', action: run('exportModels'), disabled: App.currentName !== 'printing' },
        { label: 'Export G-code…', action: run('exportGcode'), key: 'Ctrl+E', disabled: !editor() },
        '-',
        { label: 'Case Library', action: () => D.caseLibrary() },
        { label: 'Back to Home', action: () => App.go('home') },
      ]],
      ['Edit', [
        { label: 'Undo', action: run('undo'), key: 'Ctrl+Z', disabled: !editor() },
        { label: 'Redo', action: run('redo'), key: 'Ctrl+Shift+Z', disabled: !editor() },
        '-',
        { label: 'Cut', action: run('cut'), key: 'Ctrl+X', disabled: !editor() },
        { label: 'Copy', action: run('copy'), key: 'Ctrl+C', disabled: !editor() },
        { label: 'Paste', action: run('paste'), key: 'Ctrl+V', disabled: !editor() },
        { label: 'Duplicate', action: run('duplicate'), key: 'Ctrl+D', disabled: !editor() },
        '-',
        { label: 'Select All', action: run('selectAll'), key: 'Ctrl+A', disabled: !editor() },
        { label: 'Unselect', action: run('unselect'), key: 'Esc', disabled: !editor() },
        { label: 'Delete', action: run('delete'), key: 'Del', disabled: !editor() },
        { label: 'Clear All', action: run('clearAll'), disabled: !editor() },
      ]],
      ['Window', [
        { label: 'Home', action: () => App.go('home'), key: 'Ctrl+1', checked: App.currentName === 'home' },
        { label: '3D Printing', action: () => App.go('printing'), key: 'Ctrl+2', checked: App.currentName === 'printing' },
        { label: 'Laser', action: () => App.go('laser'), key: 'Ctrl+3', checked: App.currentName === 'laser' },
        { label: 'CNC', action: () => App.go('cnc'), key: 'Ctrl+4', checked: App.currentName === 'cnc' },
        { label: 'Workspace', action: () => App.go('workspace'), key: 'Ctrl+5', checked: App.currentName === 'workspace' },
        '-',
        { label: 'Toggle Full Screen', action: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen && document.documentElement.requestFullscreen()), key: 'F11' },
        { label: 'Reload', action: () => location.reload() },
      ]],
      ['Settings', [
        { label: 'Preferences…', action: () => App.go('settings', { tab: 'general' }), key: 'Ctrl+,' },
        { label: 'Machine Settings…', action: () => D.machineSettings() },
        { label: 'Connection…', action: () => D.connection() },
        '-',
        { label: 'Printing Profiles…', action: () => D.printProfiles() },
        { label: 'Materials…', action: () => D.materials() },
        { label: 'Laser Parameter Library…', action: () => D.laserLibrary() },
        { label: 'CNC Tool Library…', action: () => D.toolLibrary() },
        '-',
        { label: 'Language', sub: [{ label: 'English', checked: true, action: () => D.language() }] },
        { label: 'Appearance', sub: [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => ({ label: l, checked: App.prefs.theme === v, action: () => App.setPref('theme', v) })) },
        { label: 'Units', sub: [['mm', 'Millimeters'], ['in', 'Inches']].map(([v, l]) => ({ label: l, checked: App.prefs.units === v, action: () => App.setPref('units', v) })) },
      ]],
      ['Help', [
        { label: 'Quick Setup…', action: () => D.welcome() },
        { label: 'Tutorials', action: () => D.tutorials() },
        { label: 'Software Manual', action: () => D.manual() },
        { label: 'Keyboard Shortcuts', action: () => D.shortcuts(), key: 'F1' },
        { label: 'Case Library', action: () => D.caseLibrary() },
        '-',
        { label: 'Firmware Update…', action: () => D.firmwareUpdate() },
        { label: 'Check for Updates…', action: () => D.checkUpdates() },
        { label: 'Download Manager', action: () => D.downloadManager() },
        { label: 'Report a Problem…', action: () => D.feedback() },
        '-',
        { label: `About ${App.name}`, action: () => D.about() },
      ]],
    ];
  }

  function buildMenu(items, close) {
    const m = h('div.menu', { role: 'menu' });
    for (const it of items) {
      if (it === '-') { m.append(h('div.sep')); continue; }
      const row = h('div.item' + (it.disabled ? '.disabled' : '') + (it.sub ? '.sub' : ''), { role: 'menuitem' },
        h('span.check', it.checked ? '✓' : ''), h('span', it.label), it.key ? h('span.key', key(it.key)) : null);
      if (it.sub) row.append(buildMenu(it.sub, close));
      else row.addEventListener('click', (e) => { e.stopPropagation(); close(); it.action && it.action(); });
      m.append(row);
    }
    return m;
  }
  function renderMenubar() {
    const bar = App.$('#menubar');
    bar.innerHTML = '';
    bar.append(h('div.brand', App.icon('logo'), App.name));
    let open = null;
    const close = () => { if (open) { open.classList.remove('open'); App.$('.menu', open) && App.$('.menu', open).remove(); open = null; } };
    const show = (root, items) => { close(); open = root; root.classList.add('open'); root.append(buildMenu(items(), close)); };
    menus().forEach(([name], idx) => {
      const root = h('div.menu-root');
      const btn = h('button', { type: 'button', 'aria-haspopup': 'true' }, name);
      const items = () => menus()[idx][1];
      btn.addEventListener('click', (e) => { e.stopPropagation(); if (open === root) close(); else show(root, items); });
      btn.addEventListener('mouseenter', () => { if (open && open !== root) show(root, items); });
      root.append(btn);
      bar.append(root);
    });
    bar.append(h('div.title'));
    document.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  function onKey(e) {
    if (App.openDialogs.length) return;
    const t = e.target;
    const typing = /input|textarea|select/i.test(t.tagName) || t.isContentEditable;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl) {
      const map = {
        n: () => D.newProject(editor() ? App.currentName : 'printing'), o: () => D.openProject(), s: () => run(e.shiftKey ? 'saveAs' : 'save')(), i: () => run('import')(), e: () => run('exportGcode')(),
        ',': () => App.go('settings'), 1: () => App.go('home'), 2: () => App.go('printing'), 3: () => App.go('laser'), 4: () => App.go('cnc'), 5: () => App.go('workspace'),
      };
      if (!typing) Object.assign(map, { z: () => run(e.shiftKey ? 'redo' : 'undo')(), y: () => run('redo')(), c: () => run('copy')(), x: () => run('cut')(), v: () => run('paste')(), d: () => run('duplicate')(), a: () => run('selectAll')() });
      if (map[k]) { e.preventDefault(); map[k](); }
      return;
    }
    if (e.key === 'F1') { e.preventDefault(); D.shortcuts(); return; }
    if (typing) return;
    const ed = editor();
    if (!ed) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); ed.cmd('delete'); return; }
    if (e.key === 'Escape') { ed.cmd('unselect'); return; }
    if (ed.onKey && ed.onKey(e)) e.preventDefault();
  }

  function start() {
    App.applyTheme();
    if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => App.applyTheme());
    renderMenubar();
    App.bus.on('prefs', (k) => { if (k === 'theme') ['printing'].forEach((p) => App.pages[p].vp && App.pages[p].vp.render()); });
    document.addEventListener('keydown', onKey);
    const fromHash = () => {
      const name = (location.hash.match(/^#\/(\w+)/) || [])[1];
      App.go(App.pages[name] ? name : 'home');
    };
    window.addEventListener('hashchange', fromHash);
    window.addEventListener('beforeunload', (e) => {
      const dirty = ['printing', 'laser', 'cnc'].some((n) => App.pages[n].el && App.pages[n].isDirty());
      if (dirty) { e.preventDefault(); e.returnValue = ''; }
    });
    // keep a recovery copy of edited projects
    setInterval(() => {
      if (!App.prefs.autoSave) return;
      ['printing', 'laser', 'cnc'].forEach((n) => {
        const p = App.pages[n];
        if (p.el && p.isDirty()) App.store.set('recovery.' + n, { name: p.projectName, proj: p.serialize(), time: Date.now() });
        else App.store.del('recovery.' + n);
      });
    }, 15000);
    fromHash();
    const recovery = ['printing', 'laser', 'cnc'].map((n) => App.store.get('recovery.' + n, null)).filter(Boolean);
    if (recovery.length) {
      App.dialog({
        title: 'Recover unsaved work', size: 'narrow',
        body: [h('p', { style: { margin: 0 } }, 'These projects had unsaved changes when the app was closed:'), h('ul', recovery.map((r) => h('li', `${r.name} (${r.proj.type}) – ${new Date(r.time).toLocaleString()}`)))],
        buttons: [
          { label: 'Discard', danger: true, action: () => ['printing', 'laser', 'cnc'].forEach((n) => App.store.del('recovery.' + n)) },
          { label: 'Recover', primary: true, action: async () => { for (const r of recovery) { App.go(r.proj.type); App.pages[r.proj.type].loadProject(r.proj, r.name); App.pages[r.proj.type].markSaved(false); } } },
        ],
      });
    } else if (App.prefs.showWelcome) {
      D.welcome();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
