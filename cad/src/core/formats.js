// Mesh file formats: STL (binary + ASCII), OBJ and PLY readers, STL / OBJ writers.
// Readers return a triangle soup (Float32Array, 9 floats per triangle).

const decoder = new TextDecoder();

export function isBinarySTL(buffer) {
  if (buffer.byteLength < 84) return false;
  const view = new DataView(buffer);
  const n = view.getUint32(80, true);
  if (84 + n * 50 === buffer.byteLength) return true;
  // Many exporters write "solid" in binary headers, so only trust the text
  // check when the size test fails.
  const head = decoder.decode(new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength)));
  return !/^\s*solid[\s\S]*facet/.test(head);
}

export function parseSTL(buffer) {
  if (buffer instanceof Uint8Array) buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return isBinarySTL(buffer) ? parseBinarySTL(buffer) : parseAsciiSTL(decoder.decode(buffer));
}

function parseBinarySTL(buffer) {
  const view = new DataView(buffer);
  const n = Math.min(view.getUint32(80, true), Math.floor((buffer.byteLength - 84) / 50));
  const soup = new Float32Array(n * 9);
  let o = 84;
  for (let t = 0; t < n; t++) {
    o += 12; // skip facet normal; we recompute from winding
    for (let k = 0; k < 9; k++) {
      soup[t * 9 + k] = view.getFloat32(o, true);
      o += 4;
    }
    o += 2;
  }
  return soup;
}

function parseAsciiSTL(text) {
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
  const n = out.length - (out.length % 9);
  if (n === 0) throw new Error('No triangles found in STL file');
  return new Float32Array(out.slice(0, n));
}

export function parseOBJ(text) {
  const verts = [];
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      verts.push([+p[1], +p[2], +p[3]]);
    } else if (line.startsWith('f ')) {
      const idx = line.split(/\s+/).slice(1).map((tok) => {
        const i = parseInt(tok.split('/')[0], 10);
        return i < 0 ? verts.length + i : i - 1;
      });
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const i of [idx[0], idx[k], idx[k + 1]]) out.push(...verts[i]);
      }
    }
  }
  if (!out.length) throw new Error('No faces found in OBJ file');
  return new Float32Array(out);
}

/** ASCII and binary little-endian PLY with triangle/polygon faces. */
export function parsePLY(buffer) {
  const bytes = new Uint8Array(buffer);
  const headerEnd = findHeaderEnd(bytes);
  const header = decoder.decode(bytes.subarray(0, headerEnd));
  const format = /format\s+(\w+)/.exec(header)[1];
  const elements = [];
  for (const line of header.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'element') elements.push({ name: p[1], count: +p[2], props: [] });
    else if (p[0] === 'property') elements.at(-1).props.push(p[1] === 'list' ? { list: true, countType: p[2], type: p[3], name: p[4] } : { type: p[1], name: p[2] });
  }
  const verts = [];
  const out = [];
  if (format === 'ascii') {
    const tokens = decoder.decode(bytes.subarray(headerEnd)).trim().split(/\s+/).map(Number);
    let i = 0;
    for (const el of elements) {
      for (let r = 0; r < el.count; r++) {
        const row = {};
        for (const p of el.props) {
          if (p.list) { const n = tokens[i++]; row[p.name] = tokens.slice(i, i + n); i += n; }
          else row[p.name] = tokens[i++];
        }
        handleRow(el, row);
      }
    }
  } else if (format === 'binary_little_endian') {
    const view = new DataView(buffer, headerEnd);
    let o = 0;
    const read = (type) => {
      const t = type.replace(/\d+$/, '');
      let v;
      switch (type) {
        case 'char': case 'int8': v = view.getInt8(o); o += 1; break;
        case 'uchar': case 'uint8': v = view.getUint8(o); o += 1; break;
        case 'short': case 'int16': v = view.getInt16(o, true); o += 2; break;
        case 'ushort': case 'uint16': v = view.getUint16(o, true); o += 2; break;
        case 'int': case 'int32': v = view.getInt32(o, true); o += 4; break;
        case 'uint': case 'uint32': v = view.getUint32(o, true); o += 4; break;
        case 'float': case 'float32': v = view.getFloat32(o, true); o += 4; break;
        case 'double': case 'float64': v = view.getFloat64(o, true); o += 8; break;
        default: throw new Error(`Unsupported PLY type ${t}`);
      }
      return v;
    };
    for (const el of elements) {
      for (let r = 0; r < el.count; r++) {
        const row = {};
        for (const p of el.props) {
          if (p.list) { const n = read(p.countType); row[p.name] = Array.from({ length: n }, () => read(p.type)); }
          else row[p.name] = read(p.type);
        }
        handleRow(el, row);
      }
    }
  } else {
    throw new Error(`Unsupported PLY format: ${format}`);
  }
  function handleRow(el, row) {
    if (el.name === 'vertex') verts.push([row.x, row.y, row.z]);
    else if (el.name === 'face') {
      const idx = row.vertex_indices || row.vertex_index;
      for (let k = 1; k + 1 < idx.length; k++) for (const i of [idx[0], idx[k], idx[k + 1]]) out.push(...verts[i]);
    }
  }
  if (!out.length) throw new Error('No faces found in PLY file');
  return new Float32Array(out);
}

function findHeaderEnd(bytes) {
  const marker = 'end_header';
  for (let i = 0; i < Math.min(bytes.length, 65536); i++) {
    let ok = true;
    for (let k = 0; k < marker.length; k++) if (bytes[i + k] !== marker.charCodeAt(k)) { ok = false; break; }
    if (ok) {
      let j = i + marker.length;
      if (bytes[j] === 13) j++;
      if (bytes[j] === 10) j++;
      return j;
    }
  }
  throw new Error('Invalid PLY header');
}

/** Parse any supported mesh file by extension. */
export function parseMeshFile(name, buffer) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'stl') return parseSTL(buffer);
  if (ext === 'obj') return parseOBJ(decoder.decode(buffer));
  if (ext === 'ply') return parsePLY(buffer);
  throw new Error(`Unsupported file type: .${ext}`);
}

/** Meshes: [{ name, positions, indices }] -> binary STL ArrayBuffer. */
export function writeBinarySTL(meshes) {
  const nTri = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  const buffer = new ArrayBuffer(84 + nTri * 50);
  const view = new DataView(buffer);
  const header = 'Binary STL exported by Forge CAD (units: mm)';
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, nTri, true);
  let o = 84;
  for (const { positions: p, indices: idx } of meshes) {
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (const v of [nx, ny, nz]) { view.setFloat32(o, v, true); o += 4; }
      for (const i of [a, b, c]) {
        view.setFloat32(o, p[i], true); view.setFloat32(o + 4, p[i + 1], true); view.setFloat32(o + 8, p[i + 2], true);
        o += 12;
      }
      o += 2;
    }
  }
  return buffer;
}

export function writeAsciiSTL(meshes) {
  const lines = [];
  for (const { name, positions: p, indices: idx } of meshes) {
    const solid = (name || 'part').replace(/\s+/g, '_');
    lines.push(`solid ${solid}`);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const len = Math.hypot(...n) || 1;
      lines.push(`  facet normal ${n.map((x) => (x / len).toExponential(6)).join(' ')}`, '    outer loop');
      for (const i of [a, b, c]) lines.push(`      vertex ${p[i].toExponential(6)} ${p[i + 1].toExponential(6)} ${p[i + 2].toExponential(6)}`);
      lines.push('    endloop', '  endfacet');
    }
    lines.push(`endsolid ${solid}`);
  }
  return lines.join('\n') + '\n';
}

export function writeOBJ(meshes) {
  const lines = ['# Exported by Forge CAD (units: mm)'];
  let base = 1;
  for (const { name, positions: p, indices: idx } of meshes) {
    lines.push(`o ${(name || 'part').replace(/\s+/g, '_')}`);
    for (let i = 0; i < p.length; i += 3) lines.push(`v ${+p[i].toFixed(6)} ${+p[i + 1].toFixed(6)} ${+p[i + 2].toFixed(6)}`);
    for (let t = 0; t < idx.length; t += 3) lines.push(`f ${idx[t] + base} ${idx[t + 1] + base} ${idx[t + 2] + base}`);
    base += p.length / 3;
  }
  return lines.join('\n') + '\n';
}

// --- base64 helpers for storing typed arrays in project files -------------

export function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

export function encodeMesh({ positions, indices }) {
  return {
    positions: bytesToBase64(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength)),
    indices: bytesToBase64(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength)),
  };
}

export function decodeMesh({ positions, indices }) {
  return {
    positions: new Float32Array(base64ToBytes(positions).buffer),
    indices: new Uint32Array(base64ToBytes(indices).buffer),
  };
}
