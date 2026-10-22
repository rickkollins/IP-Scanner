// Regenerates a document's feature history into model state.
//
// Every feature's output is cached under a key chained from all the features
// before it, so editing feature N re-runs only features N onwards. Kernel
// objects not reachable from the cache afterwards are freed.

import { FEATURES, setQuality } from './features.js';
import { collect, useRegistry } from './kernel.js';

function hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function emptyState() {
  return { bodies: new Map(), sketches: new Map(), partCounter: 1 };
}

export class Regenerator {
  constructor(blobs) {
    this.blobs = blobs; // Map<blobId, { positions, indices }>
    this.cache = new Map();
    this.persistent = new Map();
    this.registry = new Set();
  }

  /**
   * Evaluate the document. Returns { state, results } where results maps
   * feature id -> { status: ok|warning|error|suppressed|rolledback, message, ms }.
   */
  run(doc) {
    useRegistry(this.registry);
    setQuality(doc.settings?.quality || 'normal');
    let state = emptyState();
    let key = `root:${doc.settings?.quality || 'normal'}`;
    const results = new Map();
    const before = new Map();
    const nextCache = new Map();
    const usedPersistent = new Set();
    const end = doc.rollback ?? doc.features.length;

    doc.features.forEach((f, i) => {
      if (i >= end) { results.set(f.id, { status: 'rolledback' }); return; }
      if (f.suppressed) { results.set(f.id, { status: 'suppressed' }); return; }
      const def = FEATURES[f.type];
      if (!def) { results.set(f.id, { status: 'error', message: `Unknown feature type "${f.type}"` }); return; }
      before.set(f.id, state);
      key = hash(key + JSON.stringify([f.id, f.type, f.params]));
      let entry = this.cache.get(key) || nextCache.get(key);
      if (!entry) {
        const t0 = performance.now();
        const next = { bodies: new Map(state.bodies), sketches: new Map(state.sketches), partCounter: state.partCounter };
        const warnings = [];
        const ctx = {
          state: next,
          blobs: this.blobs,
          warn: (m) => warnings.push(m),
          cached: (k, make) => {
            usedPersistent.add(k);
            if (!this.persistent.has(k)) this.persistent.set(k, make());
            return this.persistent.get(k);
          },
        };
        try {
          def.build(ctx, f.params, f);
          entry = { state: next, result: { status: warnings.length ? 'warning' : 'ok', message: warnings.join('; ') } };
        } catch (err) {
          entry = { state, result: { status: 'error', message: err?.message || String(err) } };
        }
        entry.result.ms = performance.now() - t0;
        entry.persistentKeys = [...usedPersistent];
      } else {
        entry.persistentKeys?.forEach((k) => usedPersistent.add(k));
      }
      nextCache.set(key, entry);
      state = entry.state;
      results.set(f.id, entry.result);
    });

    this.cache = nextCache;
    this.stateBefore = before;
    for (const k of this.persistent.keys()) if (!usedPersistent.has(k)) this.persistent.delete(k);
    const live = new Set(this.persistent.values());
    for (const { state: s } of nextCache.values()) {
      for (const b of s.bodies.values()) live.add(b.manifold);
      for (const sk of s.sketches.values()) if (sk.cs) live.add(sk.cs);
    }
    collect(live);
    return { state, results };
  }
}
