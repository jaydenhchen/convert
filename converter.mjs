import { inflateSync } from 'node:zlib';
import { createPrcConverter } from '@needle-tools/prc';

const PDF_HEADER = Buffer.from('%PDF-');
const STREAM_MARKER = Buffer.from('stream');
const ENDSTREAM_MARKER = Buffer.from('endstream');

function indexOfBytes(haystack, needle, from = 0) {
  return haystack.indexOf(needle, from);
}

function decodeAsciiHex(input) {
  const text = Buffer.from(input).toString('latin1').replace(/\s/g, '').replace(/>.*/, '');
  const even = text.length % 2 === 0 ? text : `${text}0`;
  const output = Buffer.alloc(Math.floor(even.length / 2));
  for (let i = 0; i < even.length; i += 2) output[i / 2] = Number.parseInt(even.slice(i, i + 2), 16);
  return output;
}

function decodeAscii85(input) {
  const text = Buffer.from(input).toString('latin1').replace(/\s/g, '').replace(/^<~/, '').replace(/~>$/, '');
  const output = [];
  let group = [];
  for (const char of text) {
    if (char === 'z' && group.length === 0) {
      output.push(0, 0, 0, 0);
      continue;
    }
    const value = char.charCodeAt(0) - 33;
    if (value < 0 || value > 84) continue;
    group.push(value);
    if (group.length === 5) {
      let number = 0;
      for (const digit of group) number = number * 85 + digit;
      output.push((number >>> 24) & 255, (number >>> 16) & 255, (number >>> 8) & 255, number & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const originalLength = group.length;
    while (group.length < 5) group.push(84);
    let number = 0;
    for (const digit of group) number = number * 85 + digit;
    const bytes = [(number >>> 24) & 255, (number >>> 16) & 255, (number >>> 8) & 255, number & 255];
    output.push(...bytes.slice(0, originalLength - 1));
  }
  return Buffer.from(output);
}

function parsePdfNumber(dictionary, key) {
  const direct = dictionary.match(new RegExp(`/${key}\\s+(\\d+)`));
  return direct ? Number(direct[1]) : null;
}

function parseIndirectReference(dictionary, key) {
  const reference = dictionary.match(new RegExp(`/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`));
  return reference ? Number(reference[1]) : null;
}

function parseFilters(dictionary) {
  const filter = dictionary.match(/\/Filter\s*(\[[^\]]+\]|\/\w+)/s)?.[1];
  if (!filter) return [];
  return [...filter.matchAll(/\/(\w+)/g)].map((match) => match[1]);
}

function decodePdfStream(stream, filters) {
  let result = stream;
  for (const filter of filters) {
    if (filter === 'FlateDecode' || filter === 'Fl') result = inflateSync(result);
    else if (filter === 'ASCIIHexDecode' || filter === 'AHx') result = decodeAsciiHex(result);
    else if (filter === 'ASCII85Decode' || filter === 'A85') result = decodeAscii85(result);
    else throw new Error(`Unsupported PDF stream filter: ${filter}`);
  }
  return result;
}

function findObjectHeaders(pdf) {
  const text = pdf.toString('latin1');
  const headers = [];
  const pattern = /(?:^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\b/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    headers.push({ number: Number(match[1]), start: match.index + match[0].lastIndexOf(match[1]) });
  }
  return headers;
}

function extract3dStreams(pdf) {
  if (!pdf.subarray(0, PDF_HEADER.length).equals(PDF_HEADER)) throw new Error('The uploaded file is not a PDF.');
  const headers = findObjectHeaders(pdf);
  const objects = new Map();
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const end = index + 1 < headers.length ? headers[index + 1].start : pdf.length;
    const object = pdf.subarray(header.start, end);
    objects.set(header.number, object);
  }

  const streams = [];
  for (const object of objects.values()) {
    const streamOffset = indexOfBytes(object, STREAM_MARKER);
    if (streamOffset < 0) continue;
    const dictionary = object.subarray(0, streamOffset).toString('latin1');
    if (!/\/Subtype\s*\/PRC\b/.test(dictionary)) continue;

    const length = parsePdfNumber(dictionary, 'Length') ?? (() => {
      const reference = parseIndirectReference(dictionary, 'Length');
      if (reference === null) return null;
      const lengthObject = objects.get(reference)?.toString('latin1');
      const value = lengthObject?.match(/(?:^|\s)(\d+)\s+endobj/);
      return value ? Number(value[1]) : null;
    })();

    let dataStart = streamOffset + STREAM_MARKER.length;
    if (pdf[dataStart] === 13 && pdf[dataStart + 1] === 10) dataStart += 2;
    else if (pdf[dataStart] === 10 || pdf[dataStart] === 13) dataStart += 1;
    const fallbackEnd = indexOfBytes(object, ENDSTREAM_MARKER, dataStart);
    const dataEnd = length === null ? fallbackEnd : dataStart + length;
    if (dataEnd < dataStart || dataEnd > object.length) throw new Error('The embedded PRC stream is truncated.');
    const encoded = object.subarray(dataStart, dataEnd);
    streams.push(decodePdfStream(encoded, parseFilters(dictionary)));
  }

  if (streams.length === 0) throw new Error('No embedded PRC 3D model was found. This converter supports PRC-based 3D PDFs.');
  const combined = Buffer.concat(streams);
  const headerOffset = combined.subarray(0, 16).indexOf(Buffer.from('PRC'));
  return headerOffset > 0 ? combined.subarray(headerOffset) : combined;
}

function readComponent(data, offset, componentType) {
  if (componentType === 5121) return data.readUInt8(offset);
  if (componentType === 5123) return data.readUInt16LE(offset);
  if (componentType === 5125) return data.readUInt32LE(offset);
  if (componentType === 5126) return data.readFloatLE(offset);
  throw new Error(`Unsupported glTF component type: ${componentType}`);
}

function componentSize(componentType) {
  if (componentType === 5121) return 1;
  if (componentType === 5123) return 2;
  if (componentType === 5125 || componentType === 5126) return 4;
  throw new Error(`Unsupported glTF component type: ${componentType}`);
}

function typeWidth(type) {
  return { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }[type] ?? 0;
}

function parseGlb(glb) {
  if (glb.toString('ascii', 0, 4) !== 'glTF' || glb.readUInt32LE(4) !== 2) throw new Error('The PRC converter returned an invalid GLB model.');
  let offset = 12;
  let json;
  let binary;
  while (offset + 8 <= glb.length) {
    const length = glb.readUInt32LE(offset);
    const type = glb.toString('ascii', offset + 4, offset + 8);
    const chunk = glb.subarray(offset + 8, offset + 8 + length);
    if (type === 'JSON') json = JSON.parse(chunk.toString('utf8').replace(/\u0000+$/g, '').trim());
    if (type === 'BIN\0') binary = chunk;
    offset += 8 + length;
  }
  if (!json || !binary) throw new Error('The PRC converter returned an incomplete GLB model.');
  return { json, binary };
}

function accessorView(model, accessorIndex) {
  const accessor = model.json.accessors?.[accessorIndex];
  const bufferView = model.json.bufferViews?.[accessor?.bufferView];
  if (!accessor || !bufferView || accessor.type !== 'VEC3') throw new Error('The converted model has unsupported vertex data.');
  const componentBytes = componentSize(accessor.componentType);
  const width = typeWidth(accessor.type);
  const stride = bufferView.byteStride ?? componentBytes * width;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return { accessor, data: model.binary, start, stride, componentBytes };
}

function readPosition(view, index) {
  const offset = view.start + index * view.stride;
  return [
    readComponent(view.data, offset, view.accessor.componentType),
    readComponent(view.data, offset + view.componentBytes, view.accessor.componentType),
    readComponent(view.data, offset + view.componentBytes * 2, view.accessor.componentType)
  ];
}

function readIndices(model, accessorIndex) {
  const accessor = model.json.accessors?.[accessorIndex];
  const bufferView = model.json.bufferViews?.[accessor?.bufferView];
  if (!accessor || !bufferView || accessor.type !== 'SCALAR') throw new Error('The converted model has unsupported index data.');
  const bytes = componentSize(accessor.componentType);
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count }, (_, index) => readComponent(model.binary, start + index * bytes, accessor.componentType));
}

function multiplyMatrix(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) {
    for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  }
  return out;
}

function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1
  ];
}

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  return [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w
  ];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function length(vector) { return Math.hypot(...vector); }

function collectTriangles(model) {
  const triangles = [];
  const nodes = model.json.nodes ?? [];
  const meshes = model.json.meshes ?? [];
  const roots = model.json.scenes?.[model.json.scene ?? 0]?.nodes ?? nodes.map((_, index) => index);
  const visit = (nodeIndex, parentMatrix) => {
    const node = nodes[nodeIndex];
    if (!node) return;
    const matrix = multiplyMatrix(parentMatrix, nodeMatrix(node));
    const mesh = node.mesh === undefined ? null : meshes[node.mesh];
    for (const primitive of mesh?.primitives ?? []) {
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;
      const position = accessorView(model, primitive.attributes?.POSITION);
      const indices = primitive.indices === undefined
        ? Array.from({ length: position.accessor.count }, (_, index) => index)
        : readIndices(model, primitive.indices);
      for (let index = 0; index + 2 < indices.length; index += 3) {
        const a = transformPoint(matrix, readPosition(position, indices[index]));
        const b = transformPoint(matrix, readPosition(position, indices[index + 1]));
        const c = transformPoint(matrix, readPosition(position, indices[index + 2]));
        const normalVector = cross(subtract(b, a), subtract(c, a));
        const normalLength = length(normalVector);
        if (normalLength > 1e-12) triangles.push({ a, b, c, normal: normalVector.map((value) => value / normalLength) });
      }
    }
    for (const child of node.children ?? []) visit(child, matrix);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const root of roots) visit(root, identity);
  if (triangles.length === 0) throw new Error('The converted model contains no triangular surface geometry.');
  return triangles;
}

function trianglesToStl(triangles) {
  const output = Buffer.alloc(84 + triangles.length * 50);
  output.write('Converted from a PRC 3D PDF', 0, 'ascii');
  output.writeUInt32LE(triangles.length, 80);
  triangles.forEach(({ normal, a, b, c }, index) => {
    const offset = 84 + index * 50;
    [normal, a, b, c].forEach((vector, vectorIndex) => {
      vector.forEach((value, componentIndex) => output.writeFloatLE(value, offset + vectorIndex * 12 + componentIndex * 4));
    });
  });
  return output;
}

let converterPromise;
async function getConverter() {
  converterPromise ??= createPrcConverter();
  return converterPromise;
}

export function extractPrcFromPdf(pdf) {
  return extract3dStreams(pdf);
}

export async function convertPdfToStl(pdf) {
  const prc = extract3dStreams(pdf);
  const converter = await getConverter();
  const { output: glb } = converter.convert({ input: prc, inputFileName: 'model.prc', outputFileName: 'model.glb' });
  const model = parseGlb(Buffer.from(glb));
  const triangles = collectTriangles(model);
  return { stl: trianglesToStl(triangles), triangleCount: triangles.length };
}
