/* Home page and the case library content. */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;

  const kindColor = { printing: '#1f7ae0', laser: '#e0611f', cnc: '#2f9e5b', workspace: '#7a52d6' };
  const kindIcon = { printing: 'printer', laser: 'laser', cnc: 'cnc' };
  const kindLabel = { printing: '3D Printing', laser: 'Laser', cnc: 'CNC' };

  function gradientImage() {
    const c = h('canvas', { width: 240, height: 160 });
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(120, 80, 5, 120, 80, 120);
    g.addColorStop(0, '#000');
    g.addColorStop(1, '#fff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 240, 160);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 46px Georgia';
    ctx.textAlign = 'center';
    ctx.fillText('MAKE', 120, 96);
    return c.toDataURL('image/png');
  }

  App.cases = [
    { type: 'printing', name: 'Calibration cube', desc: '20 mm cube for checking dimensions', icon: 'cube', apply: (p) => p.addModel({ name: 'Calibration cube', mesh: App.mesh.box(20, 20, 20) }) },
    { type: 'printing', name: 'Spiral vase', desc: 'Thin-walled vase', icon: 'printer', apply: (p) => p.addModel({ name: 'Vase', mesh: App.mesh.vase(22, 70, 1.6) }) },
    { type: 'printing', name: 'Overhang test', desc: 'Sphere that needs support', icon: 'support', apply: (p) => { p.addModel({ name: 'Sphere', mesh: App.mesh.sphere(15) }); p.setQuick('support', true); } },
    { type: 'printing', name: 'Ring set', desc: 'Torus and cylinder, two models', icon: 'arrange', apply: (p) => { p.addModel({ name: 'Ring', mesh: App.mesh.torus(14, 4) }); p.addModel({ name: 'Peg', mesh: App.mesh.cylinder(5, 30) }); p.arrange({ spacing: 8, padding: 5 }); } },
    {
      type: 'laser', name: 'Name tag', desc: 'Engraved text with a cut outline', icon: 'text', color: '#e0611f', apply: (p) => {
        const w = p.job.width / 2, hh = p.job.height / 2;
        p.addObject({ type: 'rect', x: w, y: hh, w: 80, h: 30, radius: 4 }, { mode: 'vector', power: 100, workSpeed: 6, passes: 2, name: 'Cut outline' });
        p.addObject({ type: 'text', x: w, y: hh, text: 'HELLO', fontSize: 40, bold: true }, { mode: 'bitmap', power: 60, workSpeed: 60, name: 'Engrave text' });
      },
    },
    {
      type: 'laser', name: 'Star coaster', desc: 'Round coaster with a star', icon: 'star', color: '#e0611f', apply: (p) => {
        const w = p.job.width / 2, hh = p.job.height / 2;
        p.addObject({ type: 'ellipse', x: w, y: hh, w: 90, h: 90 }, { mode: 'vector', power: 100, workSpeed: 6, passes: 2, name: 'Cut circle' });
        p.addObject({ type: 'star', x: w, y: hh, w: 50, h: 50, sides: 5 }, { mode: 'vector', fillVector: true, power: 50, workSpeed: 60, name: 'Fill star' });
      },
    },
    { type: 'laser', name: 'Photo engraving', desc: 'Greyscale image engraving', icon: 'image', color: '#e0611f', apply: (p) => p.addObject({ type: 'image', x: p.job.width / 2, y: p.job.height / 2, w: 90, h: 60, src: gradientImage() }, { mode: 'greyscale', power: 50, workSpeed: 80, density: 6, name: 'Engrave photo' }) },
    {
      type: 'cnc', name: 'Carved sign', desc: 'Pocketed frame and cut-out board', icon: 'rect', color: '#2f9e5b', apply: (p) => {
        const w = p.job.width / 2, hh = p.job.height / 2;
        p.addObject({ type: 'rect', x: w, y: hh, w: 90, h: 50 }, { mode: 'pocket', targetDepth: 1, name: 'Pocket panel' });
        p.addObject({ type: 'rect', x: w, y: hh, w: 100, h: 60 }, { mode: 'outside', targetDepth: 3, tabs: true, name: 'Cut out board' });
      },
    },
    {
      type: 'cnc', name: 'Hexagon coaster', desc: 'Pocket and outside profile', icon: 'polygon', color: '#2f9e5b', apply: (p) => {
        const w = p.job.width / 2, hh = p.job.height / 2;
        p.addObject({ type: 'polygon', x: w, y: hh, w: 60, h: 60, sides: 6 }, { mode: 'pocket', targetDepth: 1.5, name: 'Pocket hexagon' });
        p.addObject({ type: 'ellipse', x: w, y: hh, w: 85, h: 85 }, { mode: 'outside', targetDepth: 4, name: 'Cut circle' });
      },
    },
  ];

  App.loadCase = async function (c) {
    const page = App.pages[c.type];
    App.go(c.type);
    if (!(await App.dialogs.guardUnsaved(page))) return;
    page.newProject(c.name);
    c.apply(page);
    page.markSaved && page.markSaved(false);
    App.toast(`Loaded case "${c.name}"`, 'ok');
  };

  const Home = {
    title: () => 'Home',
    mount(el) {
      el.classList.add('home');
      const recentBox = h('div');
      const renderRecent = () => {
        recentBox.innerHTML = '';
        const list = App.recent.list();
        if (!list.length) { recentBox.append(h('div.muted', { style: { padding: '8px' } }, 'No recent projects yet. Saved projects appear here.')); return; }
        list.forEach((r) => recentBox.append(h('div.recent-item', {
          title: r.tooLarge ? 'Too large to keep in browser storage; reopen it from the file' : '', on: {
            click: async () => {
              const proj = App.recent.load(r.id);
              if (!proj) { App.toast('This project is no longer stored. Open it from its file.', 'error'); return; }
              try { await App.openProjectData(proj, r.name); } catch (e) { App.toast(e.message, 'error'); }
            },
          },
        },
        h('div.ico', { style: { background: kindColor[r.type] } }, App.icon(kindIcon[r.type])),
        h('div.grow', h('div', r.name), h('div.muted', { style: { fontSize: '11px' } }, `${kindLabel[r.type]} · ${new Date(r.time).toLocaleString()}`)))));
      };
      renderRecent();
      App.bus.on('recent', renderRecent);

      const tile = (kind, title, desc, icon, action) => h('div.start-tile', { role: 'button', tabindex: 0, on: { click: action, keydown: (e) => e.key === 'Enter' && action() } },
        h('div.ico', { style: { background: kindColor[kind] } }, App.icon(icon)), h('div.t', title), h('div.d', desc));

      const caseGrid = h('div.case-grid', App.cases.slice(0, 6).map((c) => App.caseCard(c)));

      el.append(
        App.toolbar([
          h('div.tb-title', App.name), '->',
          App.machineChip(),
          { icon: 'workspace', label: 'Workspace', action: () => App.go('workspace') },
          { icon: 'settings', label: 'Settings', action: () => App.go('settings') },
        ]),
        h('div.home', { style: { flex: 1, overflow: 'auto' } },
          h('div.home-inner',
            h('div.home-hero', h('div', { style: { width: '44px', height: '44px', color: 'var(--accent)' } }, App.icon('logo')),
              h('div', h('h1', 'Get started'), h('div.muted', 'Choose what you want to make today.'))),
            h('div.start-tiles',
              tile('printing', '3D Printing', 'Slice 3D models and print them layer by layer.', 'printer', () => App.go('printing')),
              tile('laser', 'Laser', 'Engrave images and text, or cut shapes.', 'laser', () => App.go('laser')),
              tile('cnc', 'CNC', 'Carve reliefs, pockets and profiles.', 'cnc', () => App.go('cnc')),
              tile('workspace', 'Workspace', 'Connect a machine and run your jobs.', 'workspace', () => App.go('workspace'))),
            h('div.home-cols',
              h('div.panel-box',
                h('div.row', h('h2.grow', { style: { margin: 0 } }, 'Projects'),
                  h('button.btn.small', { on: { click: () => App.dialogs.newProject() } }, App.icon('plus'), 'New'),
                  h('button.btn.small', { on: { click: () => App.dialogs.openProject() } }, App.icon('open'), 'Open…')),
                h('div.muted', { style: { margin: '10px 0 4px', fontSize: '12px' } }, 'Recent'),
                recentBox,
                h('div.row', { style: { marginTop: '8px' } }, h('span.spacer'), h('button.link-btn', { on: { click: async () => { if (await App.confirm('Clear the recent projects list?')) App.recent.clear(); } } }, 'Clear recent'))),
              h('div.panel-box',
                h('h2', 'Learn'),
                ...[
                  ['video', 'Tutorials', 'Step-by-step guides for each mode', () => App.dialogs.tutorials()],
                  ['help', 'Software manual', 'What each page and tool does', () => App.dialogs.manual()],
                  ['keyboard', 'Keyboard shortcuts', 'Work faster with the keyboard', () => App.dialogs.shortcuts()],
                  ['mail', 'Report a problem', 'Tell us what went wrong', () => App.dialogs.feedback()],
                ].map(([ic, t, d, fn]) => h('div.recent-item', { on: { click: fn } }, h('div.ico', { style: { background: 'var(--accent)' } }, App.icon(ic)), h('div', h('div', t), h('div.muted', { style: { fontSize: '11px' } }, d)))))),
            h('div',
              h('div.row', h('h2.grow', 'Case library'), h('button.link-btn', { on: { click: () => App.dialogs.caseLibrary() } }, 'View all ›')),
              caseGrid))));
    },
  };
  App.registerPage('home', Home);
})();
