import { createPrcConverter } from '@needle-tools/prc';

const textDecoder = new TextDecoder('latin1');
const textEncoder = new TextEncoder();
const bytesFor = (value) => value instanceof Uint8Array ? value : new Uint8Array(value);

function findBytes(haystack, needle, from = 0) {
  outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
const marker = (value) => textEncoder.encode(value);

function asciiHex(input) {
  const text = textDecoder.decode(input).replace(/\s/g, '').replace(/>.*/, '');
  const output = new Uint8Array(Math.ceil(text.length / 2));
  for (let i = 0; i < text.length; i += 2) output[i / 2] = Number.parseInt(text.slice(i, i + 2).padEnd(2, '0'), 16);
  return output;
}

function ascii85(input) {
  const text = textDecoder.decode(input).replace(/\s/g, '').replace(/^<~/, '').replace(/~>$/, '');
  const output = [];
  let group = [];
  for (const char of text) {
    if (char === 'z' && group.length === 0) { output.push(0, 0, 0, 0); continue; }
    const value = char.charCodeAt(0) - 33;
    if (value < 0 || value > 84) continue;
    group.push(value);
    if (group.length !== 5) continue;
    let number = 0;
    for (const digit of group) number = number * 85 + digit;
    output.push((number >>> 24) & 255, (number >>> 16) & 255, (number >>> 8) & 255, number & 255);
    group = [];
  }
  if (group.length > 1) {
    const length = group.length;
    while (group.length < 5) group.push(84);
    let number = 0;
    for (const digit of group) number = number * 85 + digit;
    output.push((number >>> 24) & 255, (number >>> 16) & 255, (number >>> 8) & 255, number & 255);
    output.length -= 5 - length;
  }
  return new Uint8Array(output);
}

async function inflate(input) {
  if (!('DecompressionStream' in globalThis)) throw new Error('This browser does not support PDF decompression. Use a current Chrome, Edge, Safari, or Firefox release.');
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeStream(input, filters) {
  let output = input;
  for (const filter of filters) {
    if (filter === 'FlateDecode' || filter === 'Fl') output = await inflate(output);
    else if (filter === 'ASCIIHexDecode' || filter === 'AHx') output = asciiHex(output);
    else if (filter === 'ASCII85Decode' || filter === 'A85') output = ascii85(output);
    else throw new Error(`Unsupported PDF stream filter: ${filter}`);
  }
  return output;
}

function extractPrc(pdf) {
  const text = textDecoder.decode(pdf);
  if (!text.startsWith('%PDF-')) throw new Error('The uploaded file is not a PDF.');
  const headers = [];
  const pattern = /(?:^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\b/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) headers.push({ number: Number(match[1]), start: match.index + match[0].lastIndexOf(match[1]) });
  const objects = new Map();
  headers.forEach((header, index) => objects.set(header.number, pdf.slice(header.start, headers[index + 1]?.start ?? pdf.length)));
  return (async () => {
    const streams = [];
    for (const object of objects.values()) {
      const streamOffset = findBytes(object, marker('stream'));
      if (streamOffset < 0) continue;
      const dictionary = textDecoder.decode(object.slice(0, streamOffset));
      if (!/\/Subtype\s*\/PRC\b/.test(dictionary)) continue;
      const directLength = dictionary.match(/\/Length\s+(\d+)/)?.[1];
      const indirectNumber = dictionary.match(/\/Length\s+(\d+)\s+(\d+)\s+R/)?.[1];
      let length = directLength ? Number(directLength) : null;
      if (length === null && indirectNumber) {
        const lengthObject = textDecoder.decode(objects.get(Number(indirectNumber)) ?? new Uint8Array());
        length = Number(lengthObject.match(/(?:^|\s)(\d+)\s+endobj/)?.[1] ?? 0) || null;
      }
      let start = streamOffset + 6;
      if (object[start] === 13 && object[start + 1] === 10) start += 2;
      else if (object[start] === 10 || object[start] === 13) start += 1;
      const fallbackEnd = findBytes(object, marker('endstream'), start);
      const end = length === null ? fallbackEnd : start + length;
      if (end < start || end > object.length) throw new Error('The embedded PRC stream is truncated.');
      const filtersMatch = dictionary.match(/\/Filter\s*(\[[^\]]+\]|\/\w+)/s)?.[1] ?? '';
      const filters = [...filtersMatch.matchAll(/\/(\w+)/g)].map((match) => match[1]);
      streams.push(await decodeStream(object.slice(start, end), filters));
    }
    if (streams.length === 0) throw new Error('No embedded PRC 3D model was found. This converter supports PRC-based 3D PDFs.');
    const combined = new Uint8Array(streams.reduce((sum, stream) => sum + stream.length, 0));
    let offset = 0;
    streams.forEach((stream) => { combined.set(stream, offset); offset += stream.length; });
    const header = findBytes(combined.slice(0, 16), marker('PRC'));
    return header > 0 ? combined.slice(header) : combined;
  })();
}

function componentSize(type) { return type === 5121 ? 1 : type === 5123 ? 2 : 4; }
function readComponent(view, offset, type) {
  const data = new DataView(view.buffer, view.byteOffset, view.byteLength);
  return type === 5121 ? data.getUint8(offset) : type === 5123 ? data.getUint16(offset, true) : type === 5125 ? data.getUint32(offset, true) : data.getFloat32(offset, true);
}
function parseGlb(glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (textDecoder.decode(glb.slice(0, 4)) !== 'glTF' || view.getUint32(4, true) !== 2) throw new Error('The PRC converter returned an invalid GLB model.');
  let offset = 12;
  let json;
  let binary;
  while (offset + 8 <= glb.length) {
    const length = view.getUint32(offset, true);
    const type = textDecoder.decode(glb.slice(offset + 4, offset + 8));
    const chunk = glb.slice(offset + 8, offset + 8 + length);
    if (type === 'JSON') json = JSON.parse(new TextDecoder().decode(chunk).replace(/\u0000+$/g, '').trim());
    if (type === 'BIN\0') binary = chunk;
    offset += 8 + length;
  }
  if (!json || !binary) throw new Error('The PRC converter returned an incomplete GLB model.');
  return { json, binary };
}

function positionView(model, index) {
  const accessor = model.json.accessors?.[index];
  const bufferView = model.json.bufferViews?.[accessor?.bufferView];
  if (!accessor || !bufferView || accessor.type !== 'VEC3') throw new Error('The converted model has unsupported vertex data.');
  const bytes = componentSize(accessor.componentType);
  return { accessor, start: (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0), stride: bufferView.byteStride ?? bytes * 3, bytes, data: model.binary };
}
function position(view, index) { const offset = view.start + index * view.stride; return [readComponent(view.data, offset, view.accessor.componentType), readComponent(view.data, offset + view.bytes, view.accessor.componentType), readComponent(view.data, offset + view.bytes * 2, view.accessor.componentType)]; }
function indices(model, index) {
  const accessor = model.json.accessors?.[index];
  const bufferView = model.json.bufferViews?.[accessor?.bufferView];
  if (!accessor || !bufferView || accessor.type !== 'SCALAR') throw new Error('The converted model has unsupported index data.');
  const bytes = componentSize(accessor.componentType);
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count }, (_, i) => readComponent(model.binary, start + i * bytes, accessor.componentType));
}
function matrixMultiply(a, b) { const out = new Array(16).fill(0); for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) for (let k = 0; k < 4; k += 1) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return out; }
function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]; const [sx, sy, sz] = node.scale ?? [1, 1, 1]; const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  return [(1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0, (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0, (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
}
function point(matrix, [x, y, z]) { const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15]; return [(matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w, (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w, (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w]; }
function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function triangles(model) {
  const result = []; const nodes = model.json.nodes ?? []; const meshes = model.json.meshes ?? []; const roots = model.json.scenes?.[model.json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);
  const visit = (nodeIndex, parent) => { const node = nodes[nodeIndex]; if (!node) return; const matrix = matrixMultiply(parent, nodeMatrix(node)); const mesh = node.mesh === undefined ? null : meshes[node.mesh]; for (const primitive of mesh?.primitives ?? []) { if (primitive.mode !== undefined && primitive.mode !== 4) continue; const view = positionView(model, primitive.attributes?.POSITION); const ids = primitive.indices === undefined ? Array.from({ length: view.accessor.count }, (_, i) => i) : indices(model, primitive.indices); for (let i = 0; i + 2 < ids.length; i += 3) { const a = point(matrix, position(view, ids[i])); const b = point(matrix, position(view, ids[i + 1])); const c = point(matrix, position(view, ids[i + 2])); const normal = cross(subtract(b, a), subtract(c, a)); const size = Math.hypot(...normal); if (size > 1e-12) result.push({ a, b, c, normal: normal.map((value) => value / size) }); } } for (const child of node.children ?? []) visit(child, matrix); };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; roots.forEach((root) => visit(root, identity));
  if (!result.length) throw new Error('The converted model contains no triangular surface geometry.');
  return result;
}
function writeStl(facets) {
  const output = new ArrayBuffer(84 + facets.length * 50); const bytes = new Uint8Array(output); const view = new DataView(output); bytes.set(textEncoder.encode('Converted from a PRC 3D PDF')); view.setUint32(80, facets.length, true); facets.forEach(({ normal, a, b, c }, i) => { const vectors = [normal, a, b, c]; vectors.forEach((vector, v) => vector.forEach((value, component) => view.setFloat32(84 + i * 50 + v * 12 + component * 4, value, true))); }); return new Uint8Array(output);
}

let converterPromise;
export async function convertPdfToStl(pdf) {
  const prc = await extractPrc(bytesFor(pdf));
  converterPromise ??= createPrcConverter();
  const converter = await converterPromise;
  const { output } = converter.convert({ input: prc, inputFileName: 'model.prc', outputFileName: 'model.glb' });
  const facets = triangles(parseGlb(bytesFor(output)));
  return { stl: writeStl(facets), triangleCount: facets.length };
}
