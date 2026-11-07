/* Workspace page: connect a machine (Web Serial or simulator), jog, console, G-code files, job runner. */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;

  /* ---------- G-code files available to Workspace ---------- */
  App.workspaceFiles = {
    list: [],
    add(name, gcode, kind) {
      const f = { id: App.uid('f'), name, gcode, kind: kind || guessKind(gcode), size: gcode.length, time: Date.now() };
      this.list.unshift(f);
      App.bus.emit('wsfiles');
      return f;
    },
    remove(id) { this.list = this.list.filter((f) => f.id !== id); App.bus.emit('wsfiles'); },
    get(id) { return this.list.find((f) => f.id === id); },
  };
  function guessKind(g) {
    if (/;Mode: Laser|M4 S0|M3 I/.test(g)) return 'laser';
    if (/;Mode: CNC|M3 S\d{4,}/.test(g)) return 'cnc';
    return 'printing';
  }

  /* ---------- devices ---------- */
  class VirtualDevice {
    constructor() {
      this.type = 'virtual';
      this.label = 'Virtual machine';
      this.connected = false;
      this.pos = { x: 0, y: 0, z: 0 };
      this.abs = true;
      this.temps = { nozzle: 22, nozzleT: 0, bed: 22, bedT: 0 };
      this.listeners = [];
    }
    onLine(fn) { this.listeners.push(fn); }
    emit(l) { this.listeners.forEach((f) => f(l)); }
    async connect() { this.connected = true; this.timer = setInterval(() => this.tick(), 500); setTimeout(() => this.emit('start'), 50); setTimeout(() => this.emit('echo: Virtual machine firmware 1.0 ready'), 100); }
    async disconnect() { this.connected = false; clearInterval(this.timer); }
    tick() {
      const t = this.temps;
      t.nozzle += (Math.max(22, t.nozzleT) - t.nozzle) * 0.25;
      t.bed += (Math.max(22, t.bedT) - t.bed) * 0.15;
    }
    async send(line) {
      const l = line.replace(/;.*$/, '').trim().toUpperCase();
      if (!l) return 'ok';
      const word = (c) => { const m = l.match(new RegExp(c + '(-?[\\d.]+)')); return m ? parseFloat(m[1]) : null; };
      const cmd = l.split(/\s+/)[0];
      let delay = 4;
      if (cmd === 'G0' || cmd === 'G1') {
        const n = {};
        ['X', 'Y', 'Z'].forEach((a) => { const v = word(a); if (v != null) n[a.toLowerCase()] = this.abs ? v : this.pos[a.toLowerCase()] + v; });
        const d = Math.hypot((n.x ?? this.pos.x) - this.pos.x, (n.y ?? this.pos.y) - this.pos.y);
        Object.assign(this.pos, n);
        const f = word('F');
        if (f) this.feed = f;
        delay = Math.min(40, 2 + d / ((this.feed || 3000) / 60) * 4);
      } else if (cmd === 'G28') { this.pos = { x: 0, y: 0, z: 0 }; delay = 300; }
      else if (cmd === 'G90') this.abs = true;
      else if (cmd === 'G91') this.abs = false;
      else if (cmd === 'G92') ['X', 'Y', 'Z'].forEach((a) => { const v = word(a); if (v != null) this.pos[a.toLowerCase()] = v; });
      else if (cmd === 'M104' || cmd === 'M109') { this.temps.nozzleT = word('S') || 0; if (cmd === 'M109') { delay = 400; this.temps.nozzle = this.temps.nozzleT; } }
      else if (cmd === 'M140' || cmd === 'M190') { this.temps.bedT = word('S') || 0; if (cmd === 'M190') { delay = 400; this.temps.bed = this.temps.bedT; } }
      else if (cmd === 'M105') { await sleep(5); return `ok T:${this.temps.nozzle.toFixed(1)} /${this.temps.nozzleT.toFixed(1)} B:${this.temps.bed.toFixed(1)} /${this.temps.bedT.toFixed(1)}`; }
      else if (cmd === 'M114') { await sleep(5); return `X:${this.pos.x.toFixed(2)} Y:${this.pos.y.toFixed(2)} Z:${this.pos.z.toFixed(2)} E:0.00\nok`; }
      else if (cmd === 'M115') return 'FIRMWARE_NAME:VirtualMachine 1.0 MACHINE_TYPE:Simulator\nok';
      await sleep(delay);
      return 'ok';
    }
  }
  class SerialDevice {
    constructor(baud) { this.type = 'serial'; this.baud = baud; this.label = 'USB serial'; this.connected = false; this.listeners = []; this.pending = []; this.buf = ''; this.pos = { x: 0, y: 0, z: 0 }; this.temps = null; }
    onLine(fn) { this.listeners.push(fn); }
    emit(l) { this.listeners.forEach((f) => f(l)); }
    async connect() {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: this.baud });
      const info = this.port.getInfo ? this.port.getInfo() : {};
      this.label = `USB serial${info.usbVendorId ? ` (${info.usbVendorId.toString(16)}:${(info.usbProductId || 0).toString(16)})` : ''}`;
      this.writer = this.port.writable.getWriter();
      this.connected = true;
      this.readLoop();
    }
    async readLoop() {
      const dec = new TextDecoder();
      try {
        while (this.port.readable && this.connected) {
          this.reader = this.port.readable.getReader();
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            this.buf += dec.decode(value);
            let i;
            while ((i = this.buf.indexOf('\n')) >= 0) {
              const line = this.buf.slice(0, i).trim();
              this.buf = this.buf.slice(i + 1);
              if (!line) continue;
              this.emit(line);
              const m = line.match(/X:(-?[\d.]+)\s*Y:(-?[\d.]+)\s*Z:(-?[\d.]+)/);
              if (m) this.pos = { x: +m[1], y: +m[2], z: +m[3] };
              const t = line.match(/T:([\d.]+)\s*\/([\d.]+).*B:([\d.]+)\s*\/([\d.]+)/);
              if (t) this.temps = { nozzle: +t[1], nozzleT: +t[2], bed: +t[3], bedT: +t[4] };
              if (/^ok\b/i.test(line) || /^error/i.test(line)) { const p = this.pending.shift(); if (p) p(line); }
            }
          }
          this.reader.releaseLock();
        }
      } catch (e) {
        this.emit('error: ' + e.message);
        this.connected = false;
        App.bus.emit('device');
      }
    }
    send(line) {
      const l = line.replace(/;.*$/, '').trim();
      if (!l) return Promise.resolve('ok');
      return new Promise((res) => {
        this.pending.push(res);
        this.writer.write(new TextEncoder().encode(l + '\n'));
        setTimeout(() => { const i = this.pending.indexOf(res); if (i >= 0) { this.pending.splice(i, 1); res('timeout'); } }, 120000);
      });
    }
    async disconnect() {
      this.connected = false;
      try { if (this.reader) await this.reader.cancel(); } catch (e) { /* ignore */ }
      try { this.writer.releaseLock(); await this.port.close(); } catch (e) { /* ignore */ }
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  App.device = null;
  App.deviceConnect = async function (o) {
    if (App.device && App.device.connected) await App.deviceDisconnect();
    const d = o.type === 'serial' ? new SerialDevice(o.baud || 115200) : new VirtualDevice();
    d.onLine((l) => App.bus.emit('device-line', l));
    await d.connect();
    App.device = d;
    App.setPref('baudRate', o.baud || App.prefs.baudRate);
    App.bus.emit('device');
  };
  App.deviceDisconnect = async function () {
    if (!App.device) return;
    const ws = App.pages.workspace;
    if (ws.job && ws.job.running) ws.stopJob();
    await App.device.disconnect();
    App.bus.emit('device');
  };

  /* ---------- page ---------- */
  const W = {
    title: () => 'Workspace',
    job: null,
    current: null,
    macros: App.store.get('macros', [
      { name: 'Home all axes', gcode: 'G28' },
      { name: 'Go to work origin', gcode: 'G90\nG0 X0 Y0' },
      { name: 'Set work origin here', gcode: 'G92 X0 Y0 Z0' },
      { name: 'Turn off laser / spindle', gcode: 'M5' },
      { name: 'Cool down', gcode: 'M104 S0\nM140 S0' },
      { name: 'Disable motors', gcode: 'M84' },
    ]),
    step: 10,
    feed: 3000,
    queue: Promise.resolve(),

    log(text, cls) {
      if (!this.consoleEl) return;
      const atBottom = this.consoleEl.scrollHeight - this.consoleEl.scrollTop - this.consoleEl.clientHeight < 20;
      this.consoleEl.append(h('div' + (cls ? '.' + cls : ''), text));
      while (this.consoleEl.childNodes.length > 500) this.consoleEl.firstChild.remove();
      if (atBottom) this.consoleEl.scrollTop = this.consoleEl.scrollHeight;
    },
    async sendLines(text, echo = true) {
      const d = App.device;
      if (!d || !d.connected) { App.toast('Connect a machine first'); return; }
      if (this.job && this.job.running && !this.job.paused) { App.toast('A job is running'); return; }
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      this.queue = this.queue.then(async () => {
        for (const l of lines) {
          if (echo) this.log('> ' + l, 'tx');
          const r = await d.send(l);
          if (echo && d.type === 'virtual') r.split('\n').forEach((x) => this.log(x, /^error/i.test(x) ? 'err' : ''));
        }
        this.updateDRO();
      });
      return this.queue;
    },
    jog(axis, dir) { this.sendLines(`G91\nG0 ${axis}${(dir * this.step).toFixed(3)} F${this.feed}\nG90`); },

    loadFile(id) {
      this.current = App.workspaceFiles.get(id) || null;
      this.parsed = this.current ? parseToolpath(this.current.gcode) : null;
      this.job = null;
      this.render();
      this.drawVis();
    },
    async startJob() {
      const d = App.device;
      if (!d || !d.connected) { App.toast('Connect a machine first'); App.dialogs.connection(); return; }
      if (!this.current) { App.toast('Load a G-code file first'); return; }
      const lines = this.current.gcode.split('\n').map((l) => l.replace(/;.*$/, '').trim());
      const job = (this.job = { running: true, paused: false, stopped: false, line: 0, total: lines.length, start: Date.now(), pausedFor: 0 });
      this.render();
      this.log(`Job started: ${this.current.name}`, 'sys');
      for (let i = 0; i < lines.length; i++) {
        if (job.stopped) break;
        while (job.paused && !job.stopped) await sleep(100);
        if (job.stopped) break;
        job.line = i + 1;
        if (lines[i]) await d.send(lines[i]);
        if (i % 25 === 0) { this.updateJob(); this.drawVis(); }
      }
      job.running = false;
      job.end = Date.now();
      this.log(job.stopped ? 'Job stopped.' : 'Job finished.', 'sys');
      if (!job.stopped) App.toast('Job finished', 'ok');
      this.render();
      this.drawVis();
    },
    pauseJob() { if (!this.job) return; this.job.paused = !this.job.paused; if (this.job.paused) this.job.pauseAt = Date.now(); else this.job.pausedFor += Date.now() - this.job.pauseAt; this.log(this.job.paused ? 'Job paused.' : 'Job resumed.', 'sys'); this.render(); },
    async stopJob() {
      if (!this.job) return;
      this.job.stopped = true;
      this.job.paused = false;
      const kind = this.current && this.current.kind;
      await sleep(50);
      const off = kind === 'printing' ? 'M104 S0\nM140 S0\nM107' : 'M5';
      if (App.device && App.device.connected) this.sendLines(off, true);
    },

    mount(el) {
      const tb = App.toolbar([
        { icon: 'home', label: 'Home', action: () => App.go('home') }, '|',
        { icon: 'printer', label: '3D Printing', action: () => App.go('printing') },
        { icon: 'laser', label: 'Laser', action: () => App.go('laser') },
        { icon: 'cnc', label: 'CNC', action: () => App.go('cnc') }, '|',
        { icon: 'wifi', label: 'Connect', action: () => App.dialogs.connection() },
        { icon: 'open', label: 'Open G-code', action: () => this.uploadFile() },
        { icon: 'chip', label: 'Firmware', action: () => App.dialogs.firmwareUpdate() },
        '->', App.machineChip(),
        { icon: 'settings', label: 'Settings', action: () => App.go('settings') },
      ]);
      this.leftCol = h('div.ws-col');
      this.rightCol = h('div.ws-col');
      const vp = h('div.viewport');
      this.visCanvas = h('canvas');
      vp.append(this.visCanvas);
      this.visInfo = h('div.vp-info');
      vp.append(h('div.vp-overlay.tl', this.visInfo));
      new ResizeObserver(() => this.drawVis()).observe(vp);
      this.jobBar = h('div.jobbar');
      el.append(tb, h('div.ws', this.leftCol, h('div.ws-center', vp, this.jobBar), this.rightCol));
      App.bus.on('device', () => this.render());
      App.bus.on('wsfiles', () => this.renderFiles());
      App.bus.on('device-line', (l) => { if (App.device && App.device.type === 'serial') this.log(l, /^error/i.test(l) ? 'err' : ''); });
      setInterval(() => { if (App.current === this) { this.updateDRO(); this.updateTemps(); this.updateJob(); } }, 1000);
      this.render();
    },
    onShow() { this.render(); this.drawVis(); },
    async uploadFile() {
      const files = await App.pickFiles('.gcode,.nc,.cnc,.txt,.gco,.g', true);
      for (const f of files) { const g = await App.readFile(f); const wf = App.workspaceFiles.add(f.name, g); this.loadFile(wf.id); }
    },

    render() {
      if (!this.leftCol) return;
      const d = App.device;
      const conn = d && d.connected;
      const running = this.job && this.job.running;
      // ---------- left column ----------
      const L = this.leftCol;
      L.innerHTML = '';
      L.append(App.section('Connection', [
        h('div.row', h('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: conn ? 'var(--ok)' : 'var(--muted)' } }), h('b.grow', conn ? d.label : 'Not connected'),
          conn ? h('button.btn.small', { on: { click: () => App.deviceDisconnect() } }, 'Disconnect') : h('button.btn.small.primary', { on: { click: () => App.dialogs.connection() } }, 'Connect…')),
        conn ? h('div.hint', `${App.machine().name} · ${d.type === 'virtual' ? 'simulated' : 'serial ' + d.baud + ' baud'}`) : h('div.hint', 'Connect over USB (Web Serial) or try the built-in simulator.'),
      ]));
      this.droEl = h('div.dro', ['x', 'y', 'z'].map((a) => h('div', h('b', a.toUpperCase()), h('span', { 'data-axis': a }, '—'))));
      const stepSel = h('div.cards', { style: { gridTemplateColumns: 'repeat(5,1fr)' } }, [0.1, 1, 5, 10, 50].map((s) => h('div.card-opt' + (this.step === s ? '.active' : ''), { on: { click: () => { this.step = s; this.render(); } } }, String(s))));
      const jb = (label, fn, title) => h('button.btn', { disabled: !conn || running, title, on: { click: fn } }, label);
      L.append(App.section('Control', [
        this.droEl,
        h('div.jog',
          jb('Y+', () => this.jog('Y', 1)), jb('Z+', () => this.jog('Z', 1)), jb('⌂ All', () => this.sendLines('G28'), 'Home all axes'), jb('X0Y0', () => this.sendLines('G90\nG0 X0 Y0 F3000'), 'Go to work origin'),
          jb('X−', () => this.jog('X', -1)), jb('X+', () => this.jog('X', 1)), jb('⌂ X', () => this.sendLines('G28 X')), jb('⌂ Y', () => this.sendLines('G28 Y')),
          jb('Y−', () => this.jog('Y', -1)), jb('Z−', () => this.jog('Z', -1)), jb('⌂ Z', () => this.sendLines('G28 Z')), jb('Set 0', () => this.sendLines('G92 X0 Y0 Z0'), 'Set work origin here')),
        h('div.hint', 'Step (mm)'), stepSel,
        App.form([{ key: 'feed', label: 'Jog speed', type: 'number', unit: 'mm/min', min: 10, max: 12000 }], { feed: this.feed }, (k, v) => { this.feed = v; }),
      ]));
      this.consoleEl = this.consoleEl || h('div.console');
      const inp = h('input', { type: 'text', placeholder: conn ? 'Send G-code, e.g. M115' : 'Connect to send commands', disabled: !conn, class: 'mono' });
      const hist = [];
      let hi = 0;
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && inp.value.trim()) { hist.push(inp.value); hi = hist.length; this.sendLines(inp.value); inp.value = ''; }
        if (e.key === 'ArrowUp' && hi > 0) { hi--; inp.value = hist[hi]; }
        if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); inp.value = hist[hi] || ''; }
      });
      L.append(App.section('Console', [this.consoleEl, h('div.row', inp, h('button.btn.small', { on: { click: () => { this.consoleEl.innerHTML = ''; } } }, 'Clear'))]));
      // ---------- right column ----------
      const R = this.rightCol;
      R.innerHTML = '';
      this.filesEl = h('div');
      R.append(App.section('G-code Files', [this.filesEl, h('button.btn.small', { on: { click: () => this.uploadFile() } }, App.icon('open'), 'Open G-code file…')]));
      this.renderFiles();
      const kind = (this.current && this.current.kind) || ({ laser: 'laser', cnc: 'cnc' }[App.machine().toolhead] || 'printing');
      if (kind === 'printing') {
        this.tempEl = h('div.stats', h('div.stat', h('div.k', 'Nozzle'), h('div.v', { 'data-t': 'nozzle' }, '—')), h('div.stat', h('div.k', 'Bed'), h('div.v', { 'data-t': 'bed' }, '—')));
        const st = { nozzle: 200, bed: 60, extrude: 10 };
        R.append(App.section('Printing', [this.tempEl,
          App.form([{ key: 'nozzle', label: 'Nozzle target', type: 'number', unit: '°C', min: 0, max: 300 }, { key: 'bed', label: 'Bed target', type: 'number', unit: '°C', min: 0, max: 120 }], st),
          h('div.row.wrap', h('button.btn.small', { disabled: !conn, on: { click: () => this.sendLines(`M104 S${st.nozzle}\nM140 S${st.bed}`) } }, App.icon('temp'), 'Heat'),
            h('button.btn.small', { disabled: !conn, on: { click: () => this.sendLines('M104 S0\nM140 S0') } }, 'Cool down'),
            h('button.btn.small', { disabled: !conn, on: { click: () => this.sendLines('M83\nG1 E10 F200') } }, 'Load 10 mm'),
            h('button.btn.small', { disabled: !conn, on: { click: () => this.sendLines('M83\nG1 E-10 F600') } }, 'Unload 10 mm'),
            h('button.btn.small', { disabled: !conn, on: { click: () => this.sendLines('M106 S255') } }, 'Fan on'),
            h('button.btn.small', { disabled: !conn, on: { click: () => this.sendLines('M107') } }, 'Fan off'))]));
        this.updateTemps();
      } else if (kind === 'laser') {
        const st = { power: 1 };
        R.append(App.section('Laser', [
          h('div.note.warn', 'Wear laser safety glasses. Never leave a running laser unattended.'),
          App.form([{ key: 'power', label: 'Test power', type: 'range', min: 0, max: 10, unit: '%' }], st),
          h('div.row.wrap', h('button.btn.small', { disabled: !conn || running, on: { click: () => this.sendLines(`M3 S${Math.round((st.power / 100) * (App.prefs.gcodeFlavor === 'grbl' ? 1000 : 255))}`) } }, 'Laser on (low power)'),
            h('button.btn.small.danger', { disabled: !conn, on: { click: () => this.sendLines('M5') } }, 'Laser off'),
            h('button.btn.small', { disabled: !conn || running, on: { click: () => this.sendLines('M8') } }, 'Air assist on'),
            h('button.btn.small', { disabled: !conn || running, on: { click: () => this.sendLines('M9') } }, 'Air assist off')),
          h('div.hint', 'Use low power to find focus and check the position of the work origin.')]));
      } else {
        const st = { rpm: 12000 };
        R.append(App.section('Spindle', [
          App.form([{ key: 'rpm', label: 'Speed', type: 'number', unit: 'RPM', min: 1000, max: 30000 }], st),
          h('div.row', h('button.btn.small', { disabled: !conn || running, on: { click: () => this.sendLines(`M3 S${st.rpm}`) } }, 'Spindle on'), h('button.btn.small.danger', { disabled: !conn, on: { click: () => this.sendLines('M5') } }, 'Spindle off')),
          h('div.hint', 'Zero Z on top of the stock with the probe or a sheet of paper, then click Set 0.')]));
      }
      R.append(App.section('Macros', [
        h('div.list', this.macros.map((m, i) => h('div.li', h('span.name', m.name),
          h('button.btn.small', { disabled: !conn || running, on: { click: () => this.sendLines(m.gcode) } }, App.icon('macro'), 'Run'),
          h('button.btn.small.icon', { title: 'Edit', on: { click: () => App.dialogs.macroEdit(m, (r) => { if (r) this.macros[i] = r; else this.macros.splice(i, 1); App.store.set('macros', this.macros); this.render(); }) } }, App.icon('edit'))))),
        h('button.btn.small', { on: { click: () => App.dialogs.macroEdit(null, (r) => { if (r) { this.macros.push(r); App.store.set('macros', this.macros); this.render(); } }) } }, App.icon('plus'), 'New macro'),
      ], { collapsed: false }));
      const camWrap = h('div');
      R.append(App.section('Camera', [camWrap, h('button.btn.small', { on: { click: () => this.toggleCam(camWrap) } }, App.icon('camera'), this.camStream ? 'Stop camera' : 'Start camera')], { collapsed: !this.camStream }));
      if (this.camStream) { const v = h('video.webcam', { autoplay: true, muted: true, playsinline: true }); v.srcObject = this.camStream; camWrap.append(v); }
      this.renderJobBar();
      this.updateDRO();
    },
    async toggleCam() {
      if (this.camStream) { this.camStream.getTracks().forEach((t) => t.stop()); this.camStream = null; this.render(); return; }
      try { this.camStream = await navigator.mediaDevices.getUserMedia({ video: true }); this.render(); } catch (e) { App.toast('Camera unavailable: ' + e.message, 'error'); }
    },
    renderFiles() {
      if (!this.filesEl) return;
      this.filesEl.innerHTML = '';
      const list = h('div.list', { style: { maxHeight: '200px' } });
      if (!App.workspaceFiles.list.length) list.append(h('div.empty', 'No files. Generate G-code in an editor and choose Send to Workspace, or open a file.'));
      App.workspaceFiles.list.forEach((f) => list.append(h('div.li' + (this.current && this.current.id === f.id ? '.active' : ''), { on: { click: (e) => { if (!e.target.closest('button')) this.loadFile(f.id); } } },
        App.icon({ printing: 'printer', laser: 'laser', cnc: 'cnc' }[f.kind] || 'gcode'), h('span.name', { title: f.name }, f.name), h('span.badge', App.fmtBytes(f.size)),
        h('button.btn.small.icon', { title: 'Download', on: { click: () => App.download(f.name, f.gcode) } }, App.icon('download')),
        h('button.btn.small.icon', { title: 'Remove', on: { click: () => { if (this.current && this.current.id === f.id) { if (this.job && this.job.running) { App.toast('Stop the job first'); return; } this.current = null; this.parsed = null; } App.workspaceFiles.remove(f.id); this.render(); this.drawVis(); } } }, App.icon('trash')))));
      this.filesEl.append(list);
    },
    renderJobBar() {
      const b = this.jobBar;
      b.innerHTML = '';
      const conn = App.device && App.device.connected;
      const j = this.job;
      const running = j && j.running;
      this.progEl = h('div', { style: { width: '0%' } });
      this.jobText = h('span.muted');
      b.append(h('div.row',
        h('b.grow', this.current ? this.current.name : 'No file loaded'),
        h('button.btn' + (running ? '' : '.primary'), { disabled: !this.current || running, on: { click: () => this.startJob() } }, App.icon('play'), 'Start'),
        h('button.btn', { disabled: !running, on: { click: () => this.pauseJob() } }, App.icon(j && j.paused ? 'play' : 'pause'), j && j.paused ? 'Resume' : 'Pause'),
        h('button.btn.danger', { disabled: !running, on: { click: () => this.stopJob() } }, App.icon('stop'), 'Stop')),
      h('div.progress', this.progEl), h('div.row', this.jobText, h('span.spacer'), h('span.muted', conn ? '' : 'Connect a machine to run jobs')));
      this.updateJob();
    },
    updateJob() {
      if (!this.jobText) return;
      const j = this.job;
      if (!j) { this.jobText.textContent = this.parsed ? `${this.parsed.lines.toLocaleString()} lines · estimated ${App.fmtTime(this.parsed.time)}` : ''; this.progEl.style.width = '0%'; return; }
      const p = j.total ? j.line / j.total : 0;
      this.progEl.style.width = (p * 100).toFixed(1) + '%';
      const elapsed = ((j.end || (j.paused ? j.pauseAt : Date.now())) - j.start - j.pausedFor) / 1000;
      const remain = p > 0.01 ? (elapsed / p) * (1 - p) : 0;
      this.jobText.textContent = `${(p * 100).toFixed(1)}% · line ${j.line.toLocaleString()} / ${j.total.toLocaleString()} · elapsed ${App.fmtTime(elapsed)}${j.running ? ` · remaining ~${App.fmtTime(remain)}` : ''}${j.paused ? ' · paused' : ''}`;
    },
    updateDRO() {
      if (!this.droEl) return;
      const d = App.device;
      ['x', 'y', 'z'].forEach((a) => { const el = App.$(`[data-axis=${a}]`, this.droEl); if (el) el.textContent = d && d.connected ? d.pos[a].toFixed(2) : '—'; });
      if (d && d.connected && d.type === 'serial' && !(this.job && this.job.running) && App.current === this) d.send('M114');
      if (this.visCanvas && d && d.connected) this.drawVis();
    },
    updateTemps() {
      if (!this.tempEl) return;
      const d = App.device;
      const t = d && d.connected && d.temps;
      App.$('[data-t=nozzle]', this.tempEl).textContent = t ? `${t.nozzle.toFixed(0)} / ${t.nozzleT.toFixed(0)} °C` : '—';
      App.$('[data-t=bed]', this.tempEl).textContent = t ? `${t.bed.toFixed(0)} / ${t.bedT.toFixed(0)} °C` : '—';
      if (d && d.connected && d.type === 'serial' && !(this.job && this.job.running) && App.current === this) d.send('M105');
    },
    drawVis() {
      const c = this.visCanvas;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, hh = c.clientHeight;
      if (!w || !hh) return;
      c.width = w * dpr; c.height = hh * dpr;
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const dark = document.documentElement.dataset.theme === 'dark';
      const mc = App.machine();
      const P = this.parsed;
      let bx0 = 0, by0 = 0, bx1 = mc.size.x, by1 = mc.size.y;
      if (P && P.bounds) { bx0 = Math.min(bx0, P.bounds[0]); by0 = Math.min(by0, P.bounds[1]); bx1 = Math.max(bx1, P.bounds[2]); by1 = Math.max(by1, P.bounds[3]); }
      const s = Math.min((w - 60) / (bx1 - bx0), (hh - 60) / (by1 - by0));
      const ox = (w - (bx1 - bx0) * s) / 2 - bx0 * s, oy = (hh + (by1 - by0) * s) / 2 + by0 * s;
      const X = (x) => ox + x * s, Y = (y) => oy - y * s;
      ctx.fillStyle = dark ? '#262d36' : '#fff';
      ctx.fillRect(X(0), Y(mc.size.y), mc.size.x * s, mc.size.y * s);
      ctx.strokeStyle = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.07)';
      ctx.beginPath();
      for (let x = 0; x <= mc.size.x; x += 10) { ctx.moveTo(X(x), Y(0)); ctx.lineTo(X(x), Y(mc.size.y)); }
      for (let y = 0; y <= mc.size.y; y += 10) { ctx.moveTo(X(0), Y(y)); ctx.lineTo(X(mc.size.x), Y(y)); }
      ctx.stroke();
      if (P) {
        const done = this.job ? this.job.line : 0;
        ctx.lineWidth = 1;
        for (const pass of [0, 1]) {
          ctx.beginPath();
          for (const sgm of P.segs) {
            if ((sgm[4] <= done) !== (pass === 1)) continue;
            ctx.moveTo(X(sgm[0]), Y(sgm[1]));
            ctx.lineTo(X(sgm[2]), Y(sgm[3]));
          }
          ctx.strokeStyle = pass ? '#2f9e5b' : (dark ? '#6aa7ee' : '#1f7ae0');
          ctx.globalAlpha = pass ? 1 : 0.55;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      const d = App.device;
      if (d && d.connected) {
        ctx.beginPath();
        ctx.arc(X(d.pos.x), Y(d.pos.y), 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(214,69,69,.85)';
        ctx.fill();
      }
      this.visInfo.textContent = P && P.bounds ? `${this.current.name} · X ${P.bounds[0].toFixed(0)}…${P.bounds[2].toFixed(0)} · Y ${P.bounds[1].toFixed(0)}…${P.bounds[3].toFixed(0)} mm` : P ? `${this.current.name} · no moves to show` : 'Visualizer – load a G-code file';
    },
  };

  // parse G-code into XY segments (with line numbers) for the visualizer
  function parseToolpath(g) {
    const segs = [];
    let x = 0, y = 0, abs = true, f = 3000, time = 0;
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    const lines = g.split('\n');
    lines.forEach((raw, i) => {
      const l = raw.replace(/;.*$/, '').trim().toUpperCase();
      if (!l) return;
      if (/^G90/.test(l)) abs = true;
      else if (/^G91/.test(l)) abs = false;
      else if (/^G28/.test(l)) { x = 0; y = 0; }
      const m = l.match(/^G([01])\b/);
      if (!m) return;
      const gx = l.match(/X(-?[\d.]+)/), gy = l.match(/Y(-?[\d.]+)/), gf = l.match(/F([\d.]+)/), ge = l.match(/E(-?[\d.]+)/), gs = l.match(/S([\d.]+)/);
      if (gf) f = +gf[1];
      const nx = gx ? (abs ? +gx[1] : x + +gx[1]) : x, ny = gy ? (abs ? +gy[1] : y + +gy[1]) : y;
      const work = m[1] === '1' && (ge ? +ge[1] > 0 : gs ? +gs[1] > 0 : true);
      const d = Math.hypot(nx - x, ny - y);
      time += d / (f / 60 || 50);
      if (work && d > 0) {
        segs.push([x, y, nx, ny, i + 1]);
        b = [Math.min(b[0], x, nx), Math.min(b[1], y, ny), Math.max(b[2], x, nx), Math.max(b[3], y, ny)];
      }
      x = nx; y = ny;
    });
    return { segs, time, lines: lines.length, bounds: segs.length ? b : null };
  }

  App.registerPage('workspace', W);
})();
