// Project files, mesh import/export and autosave.

import * as THREE from 'three';
import { parseMeshFile, writeBinarySTL, writeAsciiSTL, writeOBJ, encodeMesh, decodeMesh } from '../core/formats.js';
import { weld, repair, boundingBox } from '../core/mesh.js';
import { manifoldFromMesh, meshFromManifold } from '../core/kernel.js';

export const MESH_EXTENSIONS = ['stl', 'obj', 'ply'];

export function download(data, filename, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
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
  if (format === 'stl') download(writeBinarySTL(meshes), `${name}.stl`, 'model/stl');
  else if (format === 'stl-ascii') download(writeAsciiSTL(meshes), `${name}.stl`, 'model/stl');
  else if (format === 'obj') download(writeOBJ(meshes), `${name}.obj`, 'text/plain');
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
    download(glb, `${name}.glb`, 'model/gltf-binary');
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

