// Project files, mesh import/export and autosave.

import * as THREE from 'three';
import { parseMeshFile, writeBinarySTL, writeAsciiSTL, writeOBJ, encodeMesh, decodeMesh } from '../core/formats.js';
import { weld, repair, boundingBox } from '../core/mesh.js';
import { manifoldFromMesh, meshFromManifold } from '../core/kernel.js';

export const MESH_EXTENSIONS = ['stl', 'obj', 'ply'];

// Formats the claude.ai artifact viewer can save directly; anything else is
// delivered inside a .zip there.
const VIEWER_SAVE_EXTENSIONS = ['json', 'txt', 'zip'];

/**
 * Save a file. Inside the claude.ai artifact viewer this goes through its
 * download prompt; in a normal browser it is a plain download.
 * Resolves true when the file was handed over.
 */
export async function download(data, filename, type = 'application/octet-stream') {
  let downloads = null;
  try { downloads = window.parent !== window ? await window.claude?.use?.('downloads') : null; } catch { downloads = null; }
  if (downloads) {
    let name = filename;
    let payload = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    if (!VIEWER_SAVE_EXTENSIONS.includes(filename.split('.').pop().toLowerCase())) {
      const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : new Uint8Array(payload instanceof ArrayBuffer ? payload : payload.buffer);
      payload = zipStore([{ name: filename, data: bytes }]);
      name = `${filename}.zip`;
    }
    try {
      await downloads.save({ filename: name, data: payload });
      return true;
    } catch (e) {
      if (e?.code === 'declined') return false;
      throw new Error(`Could not save ${name}${e?.message ? `: ${e.message}` : ''}`);
    }
  }
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal uncompressed ("stored") zip archive. */
export function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cenSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

export function pickFiles(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}

/**
 * Read a mesh file into a closed, welded mesh ready for the kernel.
 * Returns { mesh, report } or throws with a readable message.
 */
export function prepareMesh(name, buffer) {
  const soup = parseMeshFile(name, buffer);
  const nTri = soup.length / 9;
  if (!nTri) throw new Error('The file contains no triangles');
  const bb = boundingBox({ positions: soup });
  const size = Math.max(...bb.max.map((x, i) => x - bb.min[i])) || 1;
  // Weld tolerance scales with the model so float noise in exports is absorbed.
  let mesh = weld(soup, Math.max(1e-6, size * 1e-6));
  const report = { triangles: nTri, vertices: mesh.positions.length / 3, repaired: null, size };
  const tryKernel = (m) => {
    try {
      const man = manifoldFromMesh(m.positions, m.indices);
      const out = meshFromManifold(man);
      man.delete();
      return out;
    } catch {
      return null;
    }
  };
  let clean = tryKernel(mesh);
  if (!clean) {
    // Weld more aggressively and repair orientation / holes.
    mesh = weld(soup, Math.max(1e-5, size * 1e-5));
    const fixed = repair(mesh);
    report.repaired = fixed.report;
    clean = tryKernel(fixed.mesh);
  }
  if (!clean) {
    throw new Error('This mesh is not a closed solid and could not be repaired automatically (it may have self-intersections or non-manifold edges).');
  }
  return { mesh: clean, report };
}

export function describeRepair(r) {
  if (!r) return '';
  const bits = [];
  if (r.holesFilled) bits.push(`filled ${r.holesFilled} hole${r.holesFilled > 1 ? 's' : ''}`);
  if (r.flipped) bits.push(`fixed ${r.flipped} flipped triangle${r.flipped > 1 ? 's' : ''}`);
  if (r.duplicates) bits.push(`removed ${r.duplicates} duplicate${r.duplicates > 1 ? 's' : ''}`);
  if (r.inverted) bits.push('turned right side out');
  return bits.length ? `Repaired: ${bits.join(', ')}` : 'Repaired';
}

// --- project files --------------------------------------------------------------------

export function serializeProject(doc, blobs) {
  const used = new Set(doc.features.filter((f) => f.type === 'import').map((f) => f.params.blob));
  const outBlobs = {};
  for (const id of used) if (blobs.has(id)) outBlobs[id] = encodeMesh(blobs.get(id));
  return JSON.stringify({ format: 'forge-cad', version: 1, doc, blobs: outBlobs });
}

export function parseProject(text) {
  const data = JSON.parse(text);
  if (data.format !== 'forge-cad') throw new Error('Not a Forge CAD project file');
  const blobs = new Map();
  for (const [id, m] of Object.entries(data.blobs || {})) blobs.set(id, decodeMesh(m));
  return { doc: data.doc, blobs };
}

// --- export ------------------------------------------------------------------------------

export function bodyMeshes(bodies) {
  return bodies.map((b) => ({ name: b.name, ...meshFromManifold(b.manifold) }));
}

export async function exportBodies(bodies, format, baseName) {
  if (!bodies.length) throw new Error('There is nothing to export');
  const meshes = bodyMeshes(bodies);
  const name = (baseName || 'model').replace(/[^\w\- ]+/g, '').trim() || 'model';
  if (format === 'stl') return download(writeBinarySTL(meshes), `${name}.stl`, 'model/stl');
  else if (format === 'stl-ascii') return download(writeAsciiSTL(meshes), `${name}.stl`, 'model/stl');
  else if (format === 'obj') return download(writeOBJ(meshes), `${name}.obj`, 'text/plain');
  else if (format === 'glb') {
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
    const scene = new THREE.Scene();
    meshes.forEach((m, i) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.positions.map((x) => x / 1000), 3)); // glTF is in metres
      g.setIndex(new THREE.BufferAttribute(m.indices, 1));
      g.rotateX(-Math.PI / 2); // Z-up to glTF's Y-up
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: bodies[i].color || '#9fb4d0' }));
      mesh.name = m.name;
      scene.add(mesh);
    });
    const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
    return download(glb, `${name}.glb`, 'model/gltf-binary');
  }
}

// --- autosave (IndexedDB: localStorage is too small for meshes) -----------------------------------

const DB = 'forge-cad';
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveLocal(key, value) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* storage unavailable (private mode etc.) */ }
}

export async function loadLocal(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

