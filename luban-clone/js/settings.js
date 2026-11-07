/* Settings (preferences) page. */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;

  const S = {
    title: () => 'Settings',
    tab: 'general',
    mount(el) {
      this.nav = h('nav', { 'aria-label': 'Settings sections' });
      this.pane = h('div.pane');
      el.append(App.toolbar([
        { icon: 'home', label: 'Home', action: () => App.go('home') },
        { icon: 'left', label: 'Back', action: () => App.go(this.back || 'home') },
        h('div.tb-title', 'Settings'), '->', App.machineChip(),
      ]), h('div.prefs', this.nav, this.pane));
      this.renderNav();
      App.bus.on('prefs', () => { if (App.current === this) this.render(); });
      App.bus.on('machine', () => { if (App.current === this) this.render(); });
    },
    onShow(opts) {
      if (opts && opts.tab) this.tab = opts.tab;
      const prev = App.$$('.page').find((p) => p.dataset.page !== 'settings' && p.dataset.page && App.pages[p.dataset.page] && App.pages[p.dataset.page].lastActive);
      void prev;
      this.renderNav();
      this.render();
    },
    renderNav() {
      this.nav.innerHTML = '';
      [['general', 'General'], ['machine', 'Machine'], ['connection', 'Connection'], ['libraries', 'Profiles & libraries'], ['update', 'Software update'], ['firmware', 'Firmware'], ['downloads', 'Download manager'], ['shortcuts', 'Keyboard shortcuts'], ['about', 'About']].forEach(([id, l]) => {
        this.nav.append(h('button' + (this.tab === id ? '.active' : ''), { on: { click: () => { this.tab = id; this.renderNav(); this.render(); } } }, l));
      });
    },
    render() {
      const p = this.pane;
      p.innerHTML = '';
      const inner = h('div.pane-inner');
      p.append(inner);
      const pref = (schema) => App.form(schema, Object.assign({}, App.prefs), (k, v) => App.setPref(k, v));
      if (this.tab === 'general') {
        inner.append(h('h2', 'General'), pref([
          { key: 'language', label: 'Language', type: 'select', options: [['en', 'English']] },
          { key: 'units', label: 'Units', type: 'select', options: [['mm', 'Millimeters'], ['in', 'Inches (display only)']] },
          { key: 'theme', label: 'Appearance', type: 'select', options: [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']] },
          { key: 'showWelcome', label: 'Show quick setup on next start', type: 'checkbox' },
          { key: 'autoSave', label: 'Keep a recovery copy of open projects in this browser', type: 'checkbox' },
          { key: 'analytics', label: 'Share anonymous usage statistics (not collected in this version)', type: 'checkbox', disabled: true },
        ]), h('div.row', h('button.btn', { on: { click: async () => { if (await App.confirm('Reset all preferences to their defaults? Your profiles, materials and tools are kept.', { danger: true, okLabel: 'Reset' })) { App.store.set('prefs', {}); App.prefs = Object.assign({}, App.data.defaultPrefs); App.applyTheme(); App.bus.emit('machine'); this.render(); App.toast('Preferences reset', 'ok'); } } } }, 'Reset preferences'),
          h('button.btn.danger', { on: { click: async () => { if (await App.confirm('Delete all custom profiles, materials, presets, tools, macros and recent projects stored in this browser?', { danger: true, okLabel: 'Delete' })) { ['profiles', 'materials', 'laserPresets', 'cncTools', 'macros'].forEach((k) => App.store.del(k)); App.recent.clear(); App.bus.emit('library'); App.toast('Local data cleared', 'ok'); } } } }, 'Clear local data')));
      } else if (this.tab === 'machine') {
        const m = App.machine();
        inner.append(h('h2', 'Machine'),
          h('table.tbl', h('tr', h('td', 'Machine'), h('td', m.name)), h('tr', h('td', 'Tool head'), h('td', App.data.toolheadLabel(m.toolhead))),
            h('tr', h('td', 'Build volume'), h('td', `${m.size.x} × ${m.size.y}${m.size.z ? ' × ' + m.size.z : ''} mm`)),
            h('tr', h('td', 'Laser work area'), h('td', m.laserSize ? `${m.laserSize.x} × ${m.laserSize.y} mm` : '—')),
            h('tr', h('td', 'CNC work area'), h('td', m.cncSize ? `${m.cncSize.x} × ${m.cncSize.y} mm` : '—'))),
          h('button.btn.primary', { style: { alignSelf: 'flex-start' }, on: { click: () => App.dialogs.machineSettings() } }, 'Change machine…'),
          h('h3', 'Advanced'), pref([
            { key: 'gcodeFlavor', label: 'G-code flavor', type: 'select', options: [['marlin', 'Marlin'], ['grbl', 'GRBL']] },
            { key: 'laserMaxS', label: 'Laser max S value (Marlin)', type: 'number', min: 1, max: 10000, step: 1 },
          ]));
      } else if (this.tab === 'connection') {
        inner.append(h('h2', 'Connection'), pref([
          { key: 'baudRate', label: 'Default baud rate', type: 'select', options: [9600, 57600, 115200, 250000] },
          { key: 'autoReconnect', label: 'Reconnect automatically (when supported by the browser)', type: 'checkbox' },
        ]), h('div.row', App.device && App.device.connected ? h('span.badge.green', 'Connected: ' + App.device.label) : h('span.badge', 'Not connected'),
          h('button.btn', { on: { click: () => App.dialogs.connection() } }, 'Open connection…')),
        h('div.hint', 'USB connections use the Web Serial API, available in Chrome and Edge. Network discovery is not available to web pages.'));
      } else if (this.tab === 'libraries') {
        const row = (t, d, fn) => h('div.panel-box.row', h('div.grow', h('b', t), h('div.muted', d)), h('button.btn', { on: { click: fn } }, 'Open'));
        inner.append(h('h2', 'Profiles & libraries'),
          row('Printing profiles', `${App.lib.profiles.all().length} profiles`, () => App.dialogs.printProfiles()),
          row('Materials', `${App.lib.materials.all().length} materials`, () => App.dialogs.materials()),
          row('Laser parameter library', `${App.lib.laser.all().length} presets`, () => App.dialogs.laserLibrary()),
          row('CNC tool library', `${App.lib.tools.all().length} tools`, () => App.dialogs.toolLibrary()));
      } else if (this.tab === 'update') {
        inner.append(h('h2', 'Software update'), h('div.row', h('span.grow', `Current version: ${App.version}`), h('button.btn.primary', { on: { click: () => App.dialogs.checkUpdates() } }, 'Check for updates')),
          pref([{ key: 'checkUpdates', label: 'Check for updates at startup', type: 'checkbox' }]));
      } else if (this.tab === 'firmware') {
        inner.append(h('h2', 'Firmware'), h('p.muted', 'Update the firmware of a connected machine from a file provided by the manufacturer.'),
          h('button.btn.primary', { style: { alignSelf: 'flex-start' }, on: { click: () => App.dialogs.firmwareUpdate() } }, 'Firmware update…'),
          h('button.btn', { style: { alignSelf: 'flex-start' }, disabled: !(App.device && App.device.connected), on: { click: async () => { App.go('workspace'); await App.pages.workspace.sendLines('M115'); } } }, 'Query firmware version (M115)'));
      } else if (this.tab === 'downloads') {
        inner.append(h('h2', 'Download manager'), App.downloads.length ? h('table.tbl', h('tr', h('th', 'File'), h('th', 'Size'), h('th', 'Time')), App.downloads.map((d) => h('tr', h('td', d.name), h('td', App.fmtBytes(d.size)), h('td', new Date(d.time).toLocaleString())))) : h('div.muted', 'Nothing downloaded in this session.'));
      } else if (this.tab === 'shortcuts') {
        inner.append(h('h2', 'Keyboard shortcuts'), h('button.btn', { style: { alignSelf: 'flex-start' }, on: { click: () => App.dialogs.shortcuts() } }, 'Show all shortcuts'));
      } else if (this.tab === 'about') {
        inner.append(h('h2', 'About'), h('p', `${App.name} ${App.version}`), h('button.btn', { style: { alignSelf: 'flex-start' }, on: { click: () => App.dialogs.about() } }, 'About…'),
          h('button.btn', { style: { alignSelf: 'flex-start' }, on: { click: () => App.dialogs.manual() } }, 'Software manual'));
      }
    },
  };
  App.registerPage('settings', S);
})();
