// Thin wrapper around the Manifold geometry kernel (WASM).
//
// Manifold objects live on the WASM heap and must be freed explicitly. Every
// kernel object created during a regeneration goes through track(); after the
// regeneration, collect() frees everything that is no longer reachable from
// the feature cache.

import Module from 'manifold-3d/manifold.js';

let wasm = null;
let registry = new Set();

/** Kernel objects are tracked per regenerator; this selects the active one. */
export function useRegistry(set) {
  registry = set;
}

export async function initKernel(options = {}) {
  if (wasm) return wasm;
  wasm = await Module(options);
  wasm.setup();
  return wasm;
}

export function kernel() {
  if (!wasm) throw new Error('Geometry kernel not initialised');
  return wasm;
}

/** Register a kernel object (or array of them) for garbage collection. */
export function track(obj) {
  if (Array.isArray(obj)) obj.forEach((o) => registry.add(o));
  else if (obj) registry.add(obj);
  return obj;
}

/** Free every tracked object that is not in `live`. */
export function collect(live) {
  for (const obj of registry) {
    if (!live.has(obj)) {
      try { obj.delete(); } catch { /* already freed */ }
      registry.delete(obj);
    }
  }
}

export function trackedCount() {
  return registry.size;
}

/** Throw a readable error if a manifold is invalid or empty. */
export function checkManifold(man, what = 'Result') {
  const status = man.status();
  if (status !== 'NoError') throw new Error(`${what} is not a valid solid (${status})`);
  return man;
}

/**
 * Build a Manifold from indexed triangle data. Throws if the mesh is not an
 * oriented, closed 2-manifold.
 */
export function manifoldFromMesh(positions, indices) {
  const { Manifold, Mesh } = kernel();
  const mesh = new Mesh({
    numProp: 3,
    vertProperties: positions instanceof Float32Array ? positions : new Float32Array(positions),
    triVerts: indices instanceof Uint32Array ? indices : new Uint32Array(indices),
  });
  mesh.merge();
  const man = track(new Manifold(mesh));
  return checkManifold(man, 'Mesh');
}

/** Extract { positions: Float32Array, indices: Uint32Array } from a Manifold. */
export function meshFromManifold(man) {
  const mesh = man.getMesh();
  const stride = mesh.numProp;
  const nVert = mesh.vertProperties.length / stride;
  let positions;
  if (stride === 3) {
    positions = new Float32Array(mesh.vertProperties);
  } else {
    positions = new Float32Array(nVert * 3);
    for (let i = 0; i < nVert; i++) {
      positions[i * 3] = mesh.vertProperties[i * stride];
      positions[i * 3 + 1] = mesh.vertProperties[i * stride + 1];
      positions[i * 3 + 2] = mesh.vertProperties[i * stride + 2];
    }
  }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}
