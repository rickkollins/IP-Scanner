// Triangle-mesh utilities: welding, repair and mass properties.
// Meshes are { positions: Float32Array (xyz...), indices: Uint32Array }.

/**
 * Merge vertices closer than `tolerance` and drop degenerate triangles.
 * `soup` is a flat Float32Array of triangle corners (9 floats per triangle).
 */
export function weld(soup, tolerance = 1e-5) {
  const inv = 1 / tolerance;
  const map = new Map();
  const positions = [];
  const nCorner = soup.length / 3;
  const remap = new Uint32Array(nCorner);
  for (let i = 0; i < nCorner; i++) {
    const x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2];
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = positions.length / 3;
      positions.push(x, y, z);
      map.set(key, idx);
    }
    remap[i] = idx;
  }
  const indices = [];
  for (let t = 0; t < nCorner; t += 3) {
    const a = remap[t], b = remap[t + 1], c = remap[t + 2];
    if (a === b || b === c || a === c) continue;
    indices.push(a, b, c);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Turn an indexed mesh back into a triangle soup. */
export function toSoup({ positions, indices }) {
  const soup = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3;
    soup[i * 3] = positions[v];
    soup[i * 3 + 1] = positions[v + 1];
    soup[i * 3 + 2] = positions[v + 2];
  }
  return soup;
}

/** Signed volume, surface area and centroid of a closed mesh. */
export function massProperties({ positions, indices }) {
  let vol = 0, area = 0, cx = 0, cy = 0, cz = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const qx = positions[c], qy = positions[c + 1], qz = positions[c + 2];
    const v = (ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)) / 6;
    vol += v;
    cx += v * (ax + bx + qx) / 4;
    cy += v * (ay + by + qy) / 4;
    cz += v * (az + bz + qz) / 4;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = qx - ax, wy = qy - ay, wz = qz - az;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
  }
  const centroid = vol !== 0 ? [cx / vol, cy / vol, cz / vol] : [0, 0, 0];
  return { volume: vol, area, centroid };
}

export function boundingBox({ positions }) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const p = positions[i + k];
      if (p < min[k]) min[k] = p;
      if (p > max[k]) max[k] = p;
    }
  }
  return { min, max };
}

/**
 * Best-effort repair of a triangle mesh so it becomes a closed, consistently
 * oriented solid: removes duplicate faces, makes winding consistent, fills
 * open holes and flips inside-out meshes. Returns a new mesh plus a report.
 */
export function repair(mesh) {
  const report = { duplicates: 0, flipped: 0, holesFilled: 0, nonManifoldEdges: 0, inverted: false };
  const positions = Array.from(mesh.positions);
  let tris = [];
  const seen = new Set();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
    const key = [...tri].sort((a, b) => a - b).join(',');
    if (seen.has(key)) { report.duplicates++; continue; }
    seen.add(key);
    tris.push(tri);
  }

  // Undirected edge -> triangles using it.
  const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const buildEdges = () => {
    const edges = new Map();
    tris.forEach((tri, i) => {
      for (let k = 0; k < 3; k++) {
        const key = edgeKey(tri[k], tri[(k + 1) % 3]);
        let list = edges.get(key);
        if (!list) edges.set(key, (list = []));
        list.push(i);
      }
    });
    return edges;
  };
  let edges = buildEdges();
  const hasDirected = (tri, a, b) => {
    for (let k = 0; k < 3; k++) if (tri[k] === a && tri[(k + 1) % 3] === b) return true;
    return false;
  };

  // Consistent orientation by flood fill across manifold edges.
  const visited = new Uint8Array(tris.length);
  for (let seed = 0; seed < tris.length; seed++) {
    if (visited[seed]) continue;
    visited[seed] = 1;
    const stack = [seed];
    while (stack.length) {
      const i = stack.pop();
      const tri = tris[i];
      for (let k = 0; k < 3; k++) {
        const a = tri[k], b = tri[(k + 1) % 3];
        const list = edges.get(edgeKey(a, b));
        if (list.length !== 2) continue;
        const j = list[0] === i ? list[1] : list[0];
        if (visited[j]) continue;
        visited[j] = 1;
        // A consistent neighbour traverses the shared edge as b -> a.
        if (hasDirected(tris[j], a, b)) {
          tris[j] = [tris[j][0], tris[j][2], tris[j][1]];
          report.flipped++;
        }
        stack.push(j);
      }
    }
  }
  for (const list of edges.values()) if (list.length > 2) report.nonManifoldEdges++;

  // Fill holes: chain boundary edges into loops and fan-triangulate them.
  const next = new Map();
  for (const [, list] of edges) {
    if (list.length !== 1) continue;
    const tri = tris[list[0]];
    for (let k = 0; k < 3; k++) {
      const a = tri[k], b = tri[(k + 1) % 3];
      if (edges.get(edgeKey(a, b)).length === 1) next.set(b, a); // hole runs opposite
    }
  }
  const used = new Set();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop = [];
    let v = start;
    while (v !== undefined && !used.has(v)) {
      used.add(v);
      loop.push(v);
      v = next.get(v);
    }
    if (v !== start || loop.length < 3) continue;
    if (loop.length === 3) {
      tris.push([loop[0], loop[1], loop[2]]);
    } else {
      let cx = 0, cy = 0, cz = 0;
      for (const p of loop) { cx += positions[p * 3]; cy += positions[p * 3 + 1]; cz += positions[p * 3 + 2]; }
      const c = positions.length / 3;
      positions.push(cx / loop.length, cy / loop.length, cz / loop.length);
      for (let i = 0; i < loop.length; i++) tris.push([loop[i], loop[(i + 1) % loop.length], c]);
    }
    report.holesFilled++;
  }

  let out = { positions: new Float32Array(positions), indices: new Uint32Array(tris.flat()) };
  if (massProperties(out).volume < 0) {
    report.inverted = true;
    const idx = out.indices;
    for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
  }
  return { mesh: out, report };
}

/** Apply a 4x4 column-major matrix to a mesh (returns a copy). */
export function transformMesh({ positions, indices }, m) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  let idx = indices;
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (det < 0) {
    idx = new Uint32Array(indices);
    for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
  }
  return { positions: out, indices: idx };
}
