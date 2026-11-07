/* Core helpers: DOM builder, store, event bus, dialogs, menus, router, history. */
(function () {
  'use strict';
  const App = (window.App = {});
  App.version = '1.0.0';
  App.name = 'Maker Studio';

  /* ---------- DOM ---------- */
  // Let append() take nested arrays and skip null/false, like the h() builder does.
  (function () {
    const fix = (proto) => {
      const orig = proto.append;
      proto.append = function (...kids) {
        return orig.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false));
      };
    };
    fix(Element.prototype);
    fix(DocumentFragment.prototype);
  })();
  App.$ = (s, r = document) => r.querySelector(s);
  App.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // h('div.cls#id', {attrs, on:{click}}, ...children)
  App.h = function h(spec, attrs, ...kids) {
    if (attrs instanceof Node || typeof attrs === 'string' || Array.isArray(attrs)) { kids.unshift(attrs); attrs = null; }
    const m = spec.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
    const el = document.createElement((m && m[1]) || 'div');
    if (m && m[2]) m[2].replace(/([.#])([\w-]+)/g, (_, t, n) => { if (t === '.') el.classList.add(n); else el.id = n; });
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
  };
  const h = App.h;

  App.svg = function (markup, cls) {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    const el = t.content.firstElementChild;
    if (cls) el.classList.add(cls);
    return el;
  };

  /* ---------- icons (simple original line icons) ---------- */
  const P = (d, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  App.icons = {
    logo: P('<path d="M4 18 12 4l8 14z"/><path d="M8 18l4-7 4 7"/>'),
    home: P('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'),
    printer: P('<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M4 7h16"/><path d="M9 7v4h6V7"/><path d="M7 18h10"/><path d="M8 15h8"/>'),
    laser: P('<path d="M12 2v7"/><path d="m9 9 3 4 3-4"/><path d="M12 13v3"/><path d="M5 20h14"/><path d="m8 17-2 2m10-2 2 2m-6-1v2"/>'),
    cnc: P('<path d="M10 2h4v6h-4z"/><path d="M11 8v6l1 3 1-3V8"/><path d="M4 20h16"/><path d="M7 17h10"/>'),
    workspace: P('<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8"/><path d="M12 16v4"/><path d="m8 10 2 2 4-4"/>'),
    settings: P('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>'),
    open: P('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    save: P('<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3"/><rect x="7" y="13" width="10" height="6"/>'),
    undo: P('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
    redo: P('<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>'),
    import: P('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
    export: P('<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>'),
    plus: P('<path d="M12 5v14M5 12h14"/>'),
    trash: P('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
    copy: P('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
    move: P('<path d="M12 2v20M2 12h20"/><path d="m9 5 3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"/>'),
    scale: P('<path d="M4 20V10h10v10z"/><path d="M14 10 21 3"/><path d="M15 3h6v6"/>'),
    rotate: P('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>'),
    mirror: P('<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 6 3 18h6z"/><path d="m15 6 6 12h-6z"/>'),
    support: P('<rect x="5" y="3" width="14" height="5"/><path d="M7 8v13M12 8v13M17 8v13"/><path d="M4 21h16"/>'),
    extruder: P('<path d="M7 3h10v7H7z"/><path d="m10 10 2 5 2-5"/><path d="M12 15v3"/><circle cx="12" cy="20" r="1"/>'),
    select: P('<path d="m5 3 14 8-6 2-2 6z"/>'),
    text: P('<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>'),
    rect: P('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
    ellipse: P('<ellipse cx="12" cy="12" rx="9" ry="6"/>'),
    polygon: P('<path d="m12 3 9 7-3.5 10h-11L3 10z"/>'),
    star: P('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
    line: P('<path d="M5 19 19 5"/>'),
    pen: P('<path d="M3 21c3-1 4-4 7-7s6-4 8-6-1-5-3-3-3 5-6 8-6 4-6 8z"/>'),
    image: P('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>'),
    camera: P('<path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/>'),
    shapes: P('<circle cx="7" cy="7" r="4"/><rect x="13" y="13" width="8" height="8"/><path d="m17 3 4 7h-8z"/>'),
    cube: P('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>'),
    eye: P('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: P('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
    play: P('<path d="M7 4v16l13-8z"/>'),
    pause: P('<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>'),
    stop: P('<rect x="5" y="5" width="14" height="14" rx="1"/>'),
    wifi: P('<path d="M2 9a15 15 0 0 1 20 0"/><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>'),
    usb: P('<path d="M12 2v16"/><circle cx="12" cy="20" r="2"/><path d="m8 6 4-4 4 4"/><path d="M7 11v2l5 3M17 9v3l-5 3"/>'),
    zoomIn: P('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6M11 8v6"/>'),
    zoomOut: P('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6"/>'),
    fit: P('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    gcode: P('<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="m10 12-2 2 2 2M14 12l2 2-2 2"/>'),
    send: P('<path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4z"/>'),
    help: P('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7v.5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
    library: P('<path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="m16 5 3.8-1 3 15.5-3.8 1z"/>'),
    video: P('<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>'),
    repair: P('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>'),
    layers: P('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
    home3: P('<path d="M3 12h3l3-8 6 16 3-8h3"/>'),
    flipH: P('<path d="M12 3v18"/><path d="M8 7 3 12l5 5zM16 7l5 5-5 5z"/>'),
    flipV: P('<path d="M3 12h18"/><path d="M7 8l5-5 5 5zM7 16l5 5 5-5z"/>'),
    lock: P('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
    unlock: P('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1"/>'),
    up: P('<path d="m6 15 6-6 6 6"/>'),
    down: P('<path d="m6 9 6 6 6-6"/>'),
    left: P('<path d="m15 6-6 6 6 6"/>'),
    right: P('<path d="m9 6 6 6-6 6"/>'),
    edit: P('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>'),
    refresh: P('<path d="M20 11a8 8 0 0 0-14-5l-2 2"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14 5l2-2"/><path d="M20 20v-4h-4"/>'),
    info: P('<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="8" r=".6" fill="currentColor"/>'),
    chip: P('<rect x="6" y="6" width="12" height="12" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'),
    download: P('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
    keyboard: P('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
    mail: P('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
    arrange: P('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'),
    target: P('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
    simplify: P('<path d="m3 17 6-6 4 4 8-8"/><circle cx="9" cy="11" r="1"/><circle cx="13" cy="15" r="1"/>'),
    flat: P('<path d="M3 19h18"/><path d="M6 15h12l-3-9H9z"/>'),
    temp: P('<path d="M14 14.8V4a2 2 0 1 0-4 0v10.8a4 4 0 1 0 4 0z"/>'),
    terminal: P('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>'),
    macro: P('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
    close: P('<path d="M6 6l12 12M18 6 6 18"/>'),
  };
  App.icon = (name, cls) => App.svg(App.icons[name] || App.icons.info, cls);

  /* ---------- utilities ---------- */
  let _uid = 0;
  App.uid = (p = 'id') => p + '_' + Date.now().toString(36) + '_' + (++_uid).toString(36);
  App.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  App.round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  App.deepClone = (o) => JSON.parse(JSON.stringify(o));
  App.fmtTime = function (sec) {
    sec = Math.max(0, Math.round(sec));
    const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
    return hh ? `${hh}h ${mm}m` : mm ? `${mm}m ${ss}s` : `${ss}s`;
  };
  App.fmtBytes = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
  App.escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  App.download = function (name, data, type = 'text/plain') {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    App.downloads.unshift({ name, size: blob.size, time: Date.now() });
    App.bus.emit('downloads');
  };
  App.downloads = [];

  App.pickFiles = function (accept, multiple = false) {
    return new Promise((resolve) => {
      const inp = App.$('#file-picker');
      inp.value = '';
      inp.accept = accept || '';
      inp.multiple = multiple;
      inp.onchange = () => resolve(Array.from(inp.files || []));
      inp.click();
    });
  };
  App.readFile = (file, as = 'text') =>
    new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      if (as === 'buffer') r.readAsArrayBuffer(file);
      else if (as === 'dataurl') r.readAsDataURL(file);
      else r.readAsText(file);
    });

  /* ---------- store ---------- */
  App.store = {
    get(k, def) {
      try {
        const v = localStorage.getItem('ms.' + k);
        return v == null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set(k, v) {
      try { localStorage.setItem('ms.' + k, JSON.stringify(v)); return true; } catch (e) { return false; }
    },
    del(k) { try { localStorage.removeItem('ms.' + k); } catch (e) { /* ignore */ } },
  };

  /* ---------- event bus ---------- */
  const handlers = {};
  App.bus = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return () => App.bus.off(ev, fn); },
    off(ev, fn) { handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn); },
    emit(ev, ...a) { (handlers[ev] || []).slice().forEach((f) => f(...a)); },
  };

  /* ---------- toasts ---------- */
  App.toast = function (msg, type = '') {
    const t = h('div.toast' + (type ? '.' + type : ''), msg);
    App.$('#toasts').append(t);
    setTimeout(() => t.remove(), type === 'error' ? 5000 : 2800);
  };

  /* ---------- dialogs ---------- */
  App.openDialogs = [];
  App.dialog = function (opts) {
    const close = (result) => {
      if (!back.isConnected) return;
      back.remove();
      App.openDialogs = App.openDialogs.filter((d) => d !== api);
      document.removeEventListener('keydown', onKey, true);
      opts.onClose && opts.onClose(result);
    };
    const body = h('div.dlg-body');
    const content = typeof opts.body === 'function' ? opts.body(body) : opts.body;
    if (content != null) body.append(...[].concat(content));
    const foot = h('div.dlg-foot');
    const left = h('div.left');
    (opts.buttons || [{ label: 'Close', primary: true }]).forEach((b) => {
      const btn = h('button.btn' + (b.primary ? '.primary' : '') + (b.danger ? '.danger' : ''), { type: 'button' }, b.label);
      btn.onclick = async () => {
        let r = b.action ? await b.action(api) : b.value;
        if (r === false) return;
        if (b.close !== false) close(r === undefined ? b.value : r);
      };
      if (b.id) btn.dataset.id = b.id;
      (b.left ? left : foot).append(btn);
    });
    if (left.children.length) foot.prepend(left);
    const dlg = h('div.dlg' + (opts.size ? '.' + opts.size : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
      h('div.dlg-head', h('h3', opts.title), h('button.x', { type: 'button', title: 'Close', 'aria-label': 'Close', on: { click: () => close(null) } }, '×')),
      body,
      opts.buttons === null ? null : foot);
    const back = h('div.dlg-backdrop', dlg);
    back.addEventListener('mousedown', (e) => { if (e.target === back && opts.dismissable !== false) close(null); });
    const onKey = (e) => {
      if (App.openDialogs[App.openDialogs.length - 1] !== api) return;
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    };
    document.addEventListener('keydown', onKey, true);
    App.$('#dialogs').append(back);
    const api = { el: dlg, body, foot, close, button: (id) => foot.querySelector(`[data-id="${id}"]`) };
    App.openDialogs.push(api);
    const f = body.querySelector('input:not([type=checkbox]):not([type=range]),select,textarea');
    if (f && opts.autofocus !== false) setTimeout(() => f.focus(), 30);
    return api;
  };
  App.confirm = (msg, o = {}) =>
    new Promise((res) =>
      App.dialog({
        title: o.title || 'Confirm', size: 'narrow', body: h('p', { style: { margin: 0 } }, msg), onClose: (r) => res(!!r),
        buttons: [{ label: o.cancelLabel || 'Cancel', value: false }, { label: o.okLabel || 'OK', primary: true, danger: o.danger, value: true }],
      }));
  App.alert = (msg, title = 'Notice') =>
    new Promise((res) => App.dialog({ title, size: 'narrow', body: h('p', { style: { margin: 0 } }, msg), onClose: () => res() }));
  App.prompt = (msg, def = '', title = 'Input') =>
    new Promise((res) => {
      const inp = h('input', { type: 'text', value: def });
      const d = App.dialog({
        title, size: 'narrow', body: [h('label', msg), inp], onClose: (r) => res(r == null ? null : r),
        buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, action: () => inp.value }],
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { d.close(inp.value); } });
    });

  /* ---------- schema forms ---------- */
  // schema: [{key,label,type,options,min,max,step,unit,hint,show(values)}]
  App.form = function (schema, values, onChange) {
    const root = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    const inputs = {};
    const rows = [];
    const read = (f, el) => {
      if (f.type === 'checkbox') return el.checked;
      if (f.type === 'number' || f.type === 'range') return el.value === '' ? 0 : Number(el.value);
      return el.value;
    };
    const refresh = () => rows.forEach(([f, row]) => { if (f.show) row.classList.toggle('hidden', !f.show(values)); });
    for (const f of schema) {
      if (f.type === 'section') { const r = h('div.form-section', f.label); rows.push([f, r]); root.append(r); continue; }
      if (f.type === 'note') { const r = h('div.hint', f.label); rows.push([f, r]); root.append(r); continue; }
      let el;
      const v = values[f.key];
      if (f.type === 'select') {
        el = h('select', {}, (typeof f.options === 'function' ? f.options() : f.options).map((o) => {
          const [val, lab] = Array.isArray(o) ? o : [o, o];
          return h('option', { value: val, selected: String(val) === String(v) }, lab);
        }));
      } else if (f.type === 'checkbox') {
        el = h('input', { type: 'checkbox', checked: !!v });
      } else if (f.type === 'textarea') {
        el = h('textarea', { rows: f.rows || 3 });
        el.value = v ?? '';
      } else if (f.type === 'range') {
        el = h('input', { type: 'range', min: f.min ?? 0, max: f.max ?? 100, step: f.step ?? 1, value: v ?? 0 });
      } else {
        el = h('input', { type: f.type || 'text', value: v ?? '', min: f.min, max: f.max, step: f.step ?? (f.type === 'number' ? 'any' : null), placeholder: f.placeholder });
      }
      if (f.disabled) el.disabled = true;
      inputs[f.key] = el;
      const valLbl = f.type === 'range' ? h('span.unit', String(v ?? 0) + (f.unit || '')) : null;
      const handler = () => {
        let val = read(f, el);
        if (f.type === 'number' && !Number.isFinite(val)) return;
        if (f.type === 'number' && f.min != null && val < f.min) val = f.min;
        if (f.type === 'number' && f.max != null && val > f.max) val = f.max;
        values[f.key] = val;
        if (valLbl) valLbl.textContent = val + (f.unit || '');
        refresh();
        onChange && onChange(f.key, val, values);
      };
      el.addEventListener(f.type === 'text' || f.type === 'textarea' || f.type === 'range' ? 'input' : 'change', handler);
      let row;
      if (f.type === 'checkbox') {
        row = h('label.field.check', el, h('span', f.label));
      } else {
        const wrap = h('div.unit-wrap', el, f.unit && f.type !== 'range' ? h('span.unit', f.unit) : null, valLbl);
        row = h('div.field' + (f.full ? '.full' : ''), h('label', f.label), wrap);
      }
      if (f.hint) row.title = f.hint;
      rows.push([f, row]);
      root.append(row);
    }
    refresh();
    root.values = values;
    root.inputs = inputs;
    root.refresh = refresh;
    return root;
  };

  App.section = function (title, body, opts = {}) {
    const sec = h('div.section' + (opts.collapsed ? '.collapsed' : ''));
    const head = h('div.sec-head', h('span.chev', '▾'), h('span.grow', title), opts.extra || null);
    head.addEventListener('click', (e) => { if (e.target.closest('button,select,input')) return; sec.classList.toggle('collapsed'); });
    const b = h('div.sec-body');
    if (body) b.append(...[].concat(body));
    sec.append(head, b);
    sec.body = b;
    return sec;
  };

  App.tabs = function (items, onSelect, active) {
    const bar = h('div.tabs', { role: 'tablist' });
    items.forEach(([id, label]) => {
      const b = h('button', { type: 'button', role: 'tab' }, label);
      b.dataset.id = id;
      b.onclick = () => { App.$$('button', bar).forEach((x) => x.classList.toggle('active', x === b)); onSelect(id); };
      bar.append(b);
    });
    const first = App.$(`button[data-id="${active || items[0][0]}"]`, bar);
    setTimeout(() => first && first.click());
    return bar;
  };

  /* ---------- undo history ---------- */
  App.History = class {
    constructor(limit = 80) { this.stack = []; this.redoStack = []; this.limit = limit; }
    push(snapshot) {
      const s = JSON.stringify(snapshot);
      if (this.stack[this.stack.length - 1] === s) return;
      this.stack.push(s);
      if (this.stack.length > this.limit) this.stack.shift();
      this.redoStack = [];
    }
    canUndo() { return this.stack.length > 1; }
    canRedo() { return this.redoStack.length > 0; }
    undo() { if (!this.canUndo()) return null; this.redoStack.push(this.stack.pop()); return JSON.parse(this.stack[this.stack.length - 1]); }
    redo() { if (!this.canRedo()) return null; const s = this.redoStack.pop(); this.stack.push(s); return JSON.parse(s); }
    reset(snapshot) { this.stack = [JSON.stringify(snapshot)]; this.redoStack = []; }
  };

  /* ---------- router ---------- */
  App.pages = {};
  App.current = null;
  App.registerPage = function (name, page) { App.pages[name] = page; };
  App.go = function (name, opts) {
    const page = App.pages[name];
    if (!page) return;
    if (!page.el) { page.el = h('section.page'); page.el.dataset.page = name; App.$('#pages').append(page.el); page.mount(page.el); }
    if (App.current && App.current !== page) { App.current.el.classList.remove('active'); App.current.onHide && App.current.onHide(); }
    App.current = page;
    App.currentName = name;
    page.el.classList.add('active');
    page.onShow && page.onShow(opts);
    if (location.hash !== '#/' + name) history.replaceState(null, '', '#/' + name);
    App.bus.emit('route', name);
    App.updateTitle();
  };
  App.updateTitle = function () {
    const p = App.current;
    const t = p && p.title ? p.title() : '';
    document.title = t ? `${t} — ${App.name}` : App.name;
    const tt = App.$('#menubar .title');
    if (tt) tt.textContent = t;
  };

  /* ---------- page toolbar builder ---------- */
  App.toolbar = function (items) {
    const bar = h('div.toolbar');
    for (const it of items) {
      if (it === '|') { bar.append(h('div.tb-sep')); continue; }
      if (it === '->') { bar.append(h('div.spacer')); continue; }
      if (it instanceof Node) { bar.append(it); continue; }
      const b = h('button.tb-btn', { type: 'button', title: it.title || it.label }, App.icon(it.icon), h('span', it.label));
      b.onclick = it.action;
      if (it.id) b.dataset.id = it.id;
      bar.append(b);
    }
    return bar;
  };

  App.machineChip = function () {
    const dot = h('span.dot');
    const lbl = h('span');
    const chip = h('div.machine-chip', { title: 'Machine settings', on: { click: () => App.dialogs.machineSettings() } }, dot, lbl);
    const upd = () => {
      const m = App.machine();
      lbl.textContent = `${m.name} · ${App.data.toolheadLabel(m.toolhead)}`;
      dot.classList.toggle('on', !!(App.device && App.device.connected));
      dot.title = App.device && App.device.connected ? 'Connected' : 'Not connected';
    };
    upd();
    App.bus.on('machine', upd);
    App.bus.on('device', upd);
    return chip;
  };
})();
