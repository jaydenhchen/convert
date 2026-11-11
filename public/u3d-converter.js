// U3D range decoding follows ECMA-363 and Intel's Apache-2.0 reference decoder algorithms.
// This JavaScript implementation does not bundle Intel's reference source.
const FILE_HEADER = 0x00443355;
const MODIFIER_CHAIN = 0xffffff14;
const CLOD_DECLARATION = 0xffffff31;
const CLOD_BASE_MESH = 0xffffff3b;
const NO_COMPRESSION = 0x00000004;
const STATIC_FULL = 0x00000400;
const MAX_RANGE = STATIC_FULL + 0x00003fff;
const SWAP8 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
const READ_COUNT = [4, 3, 2, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0];
const FAST_NOT_MASK = [0xffffffff, 0x7fff7fff, 0x3fff3fff, 0x1fff1fff, 0x0fff0fff];
const HALF_MASK = 0x80008000;
const NOT_HALF_MASK = 0x7fff7fff;
const QUARTER_MASK = 0x40004000;
const NOT_THREE_QUARTER_MASK = 0x3fff3fff;
const textDecoder = new TextDecoder('utf-8', { fatal: false });
const textEncoder = new TextEncoder();

function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function parseBlocks(bytes, start = 0, end = bytes.length) {
  const view = dataView(bytes);
  const blocks = [];
  let offset = start;
  while (offset + 12 <= end) {
    const type = view.getUint32(offset, true);
    const dataSize = view.getUint32(offset + 4, true);
    const metaSize = view.getUint32(offset + 8, true);
    const dataStart = offset + 12;
    const metaStart = dataStart + dataSize + ((-dataSize) & 3);
    const next = metaStart + metaSize + ((-metaSize) & 3);
    if (metaStart > end || next > end || next <= offset) throw new Error('The embedded U3D model contains a truncated block.');
    blocks.push({ type, data: bytes.subarray(dataStart, dataStart + dataSize), meta: bytes.subarray(metaStart, metaStart + metaSize) });
    offset = next;
  }
  return blocks;
}

function parseModifierChain(bytes) {
  const view = dataView(bytes);
  if (bytes.length < 14) throw new Error('Invalid U3D modifier chain.');
  const nameLength = view.getUint16(0, true);
  let offset = 2 + nameLength + 4;
  if (offset + 4 > bytes.length) throw new Error('Invalid U3D modifier chain header.');
  const attributes = view.getUint32(offset, true);
  offset += 4;
  if (attributes & 1) offset += 16;
  if (attributes & 2) offset += 24;
  offset += (4 - ((2 + nameLength) & 3)) & 3;
  offset += 4;
  if (offset > bytes.length) throw new Error('Invalid U3D modifier chain payload.');
  return parseBlocks(bytes, offset);
}

function blockName(bytes) {
  if (bytes.length < 2) return null;
  const length = dataView(bytes).getUint16(0, true);
  if (length + 2 > bytes.length) return null;
  return textDecoder.decode(bytes.subarray(2, 2 + length));
}

function collectClodPairs(blocks) {
  const declarations = new Map();
  const bases = new Map();
  const order = [];
  const remember = (name) => {
    if (name !== null && !order.includes(name)) order.push(name);
  };
  const walk = (items) => {
    for (const block of items) {
      if (block.type === CLOD_DECLARATION) {
        const name = blockName(block.data);
        if (name !== null && !declarations.has(name)) declarations.set(name, block.data);
        remember(name);
      } else if (block.type === CLOD_BASE_MESH) {
        const name = blockName(block.data);
        if (name !== null && !bases.has(name)) bases.set(name, block.data);
        remember(name);
      }
      if (block.type === MODIFIER_CHAIN) {
        try {
          walk(parseModifierChain(block.data));
        } catch {
          // Non-geometry modifier chains do not affect mesh extraction.
        }
      }
    }
  };
  walk(blocks);
  return order.filter((name) => declarations.has(name) && bases.has(name)).map((name) => ({
    name,
    declaration: declarations.get(name),
    base: bases.get(name)
  }));
}

class Histogram {
  constructor(elephant) {
    this.elephant = elephant;
    this.count = [1];
    this.total = 1;
  }

  frequency(symbol) { return this.count[symbol] ?? 0; }

  cumulative(symbol) {
    let total = 0;
    for (let index = 0; index < symbol && index < this.count.length; index += 1) total += this.count[index];
    return total;
  }

  symbolFromFrequency(frequency) {
    let sum = 0;
    for (let index = 0; index < this.count.length; index += 1) {
      if (sum + this.count[index] > frequency) return index;
      sum += this.count[index];
    }
    return 0;
  }

  add(symbol) {
    if (symbol > 0xffff) return;
    if (this.total >= this.elephant) {
      this.count = this.count.map((value) => value >> 1);
      this.count[0] += 1;
      this.total = this.count.reduce((sum, value) => sum + value, 0);
    }
    while (symbol >= this.count.length) this.count.push(0);
    this.count[symbol] += 1;
    this.total += 1;
  }
}

class BitStream {
  constructor(bytes, noCompression = false, elephant = 0x1fff) {
    const wordCount = Math.ceil(bytes.length / 4) + 4;
    this.words = new Uint32Array(wordCount);
    const view = dataView(bytes);
    for (let index = 0; index < Math.ceil(bytes.length / 4); index += 1) {
      const offset = index * 4;
      const available = Math.min(4, bytes.length - offset);
      if (available === 4) this.words[index] = view.getUint32(offset, true);
      else {
        let word = 0;
        for (let byte = 0; byte < available; byte += 1) word |= bytes[offset + byte] << (byte * 8);
        this.words[index] = word >>> 0;
      }
    }
    this.position = 0;
    this.bitOffset = 0;
    this.local = this.words[0];
    this.localNext = this.words[1];
    this.high = 0xffff;
    this.low = 0;
    this.code = 0;
    this.underflow = 0;
    this.noCompression = noCompression;
    this.elephant = elephant;
    this.contexts = new Map();
    this.scratch = new DataView(new ArrayBuffer(8));
  }

  incrementWord() {
    this.position += 1;
    this.local = this.localNext;
    this.localNext = this.words[this.position + 1] ?? 0;
  }

  bitCount() { return (this.position * 32) + this.bitOffset; }

  seekReadOnly(position) {
    this.position = Math.floor(position / 32);
    this.bitOffset = position & 31;
    this.local = this.words[this.position] ?? 0;
    this.localNext = this.words[this.position + 1] ?? 0;
  }

  readBit() {
    const value = (this.local >>> this.bitOffset) & 1;
    this.bitOffset += 1;
    if (this.bitOffset >= 32) {
      this.bitOffset -= 32;
      this.incrementWord();
    }
    return value;
  }

  read15() {
    let value = this.local >>> this.bitOffset;
    if (this.bitOffset > 17) value |= this.localNext << (32 - this.bitOffset);
    value = (value + value) >>> 0;
    value = SWAP8[(value >>> 12) & 15]
      | (SWAP8[(value >>> 8) & 15] << 4)
      | (SWAP8[(value >>> 4) & 15] << 8)
      | (SWAP8[value & 15] << 12);
    this.bitOffset += 15;
    if (this.bitOffset >= 32) {
      this.bitOffset -= 32;
      this.incrementWord();
    }
    return value;
  }

  readU8() {
    if (this.high === 0xffff && this.low === 0 && this.underflow === 0) {
      let value = this.local >>> this.bitOffset;
      if (this.bitOffset > 24) value |= this.localNext << (32 - this.bitOffset);
      value &= 0xff;
      this.bitOffset += 8;
      if (this.bitOffset >= 32) {
        this.bitOffset -= 32;
        this.incrementWord();
      }
      return value;
    }
    const value = this.symbolStatic(STATIC_FULL + 256) - 1;
    return (SWAP8[value & 15] << 4) | SWAP8[value >>> 4];
  }

  readU16() { return this.readU8() | (this.readU8() << 8); }
  readU32() { return (this.readU16() | (this.readU16() << 16)) >>> 0; }
  readF32() {
    this.scratch.setUint32(0, this.readU32(), true);
    return this.scratch.getFloat32(0, true);
  }

  readString() {
    const length = this.readU16();
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = this.readU8();
    return textDecoder.decode(bytes);
  }

  renormalize(state, bitCount) {
    let masked = (HALF_MASK & state) >>> 0;
    while (masked === 0 || masked === HALF_MASK) {
      state = (((NOT_HALF_MASK & state) << 1) | 1) >>> 0;
      masked = (HALF_MASK & state) >>> 0;
      bitCount += 1;
    }
    const saved = masked;
    if (bitCount > 0) {
      bitCount += this.underflow;
      this.underflow = 0;
    }
    masked = (QUARTER_MASK & state) >>> 0;
    let underflow = 0;
    while (masked === 0x40000000) {
      state = (state & NOT_THREE_QUARTER_MASK) >>> 0;
      state = (state + state) >>> 0;
      state = (state | 1) >>> 0;
      masked = (QUARTER_MASK & state) >>> 0;
      underflow += 1;
    }
    this.underflow += underflow;
    state = (state | saved) >>> 0;
    this.low = state >>> 16;
    this.high = state & 0xffff;
    this.bitOffset += bitCount;
    while (this.bitOffset >= 32) {
      this.bitOffset -= 32;
      this.incrementWord();
    }
  }

  fillCode() {
    const position = this.bitCount();
    this.code = this.readBit();
    this.bitOffset += this.underflow;
    while (this.bitOffset >= 32) {
      this.bitOffset -= 32;
      this.incrementWord();
    }
    this.code = ((this.code << 15) | this.read15()) >>> 0;
    this.seekReadOnly(position);
  }

  symbolStatic(context) {
    this.fillCode();
    const symbolCount = context - STATIC_FULL;
    const rangeSize = this.high + 1 - this.low;
    const cumulative = Math.floor((symbolCount * (1 + this.code - this.low) - 1) / rangeSize);
    const value = cumulative + 1;
    const oldLow = this.low;
    const oldHigh = this.high;
    let high = oldLow - 1 + Math.floor(rangeSize * value / symbolCount);
    let low = oldLow + Math.floor(rangeSize * (value - 1) / symbolCount);
    let state = ((low << 16) | high) >>> 0;
    let bits = READ_COUNT[((low >>> 12) ^ (high >>> 12)) & 15];
    state = ((state & FAST_NOT_MASK[bits]) << bits) >>> 0;
    state = (state | ((1 << bits) - 1)) >>> 0;
    const extraBits = READ_COUNT[((state >>> 12) ^ (state >>> 28)) & 15];
    state = ((state & FAST_NOT_MASK[extraBits]) << extraBits) >>> 0;
    bits += extraBits;
    state = (state | ((1 << extraBits) - 1)) >>> 0;
    this.renormalize(state, bits);
    return value;
  }

  symbolDynamic(context) {
    this.fillCode();
    let histogram = this.contexts.get(context);
    if (!histogram) {
      histogram = new Histogram(this.elephant);
      this.contexts.set(context, histogram);
    }
    const rangeSize = this.high + 1 - this.low;
    const cumulative = Math.floor((histogram.total * (1 + this.code - this.low) - 1) / rangeSize);
    const value = histogram.symbolFromFrequency(cumulative);
    const cumulativeFrequency = histogram.cumulative(value);
    const frequency = histogram.frequency(value);
    const oldLow = this.low;
    const oldHigh = this.high;
    let high = oldLow - 1 + Math.floor(rangeSize * (cumulativeFrequency + frequency) / histogram.total);
    let low = oldLow + Math.floor(rangeSize * cumulativeFrequency / histogram.total);
    histogram.add(value);
    let state = ((low << 16) | high) >>> 0;
    let bits = READ_COUNT[((low >>> 12) ^ (high >>> 12)) & 15];
    state = ((state & FAST_NOT_MASK[bits]) << bits) >>> 0;
    state = (state | ((1 << bits) - 1)) >>> 0;
    const extraBits = READ_COUNT[((state >>> 12) ^ (state >>> 28)) & 15];
    state = ((state & FAST_NOT_MASK[extraBits]) << extraBits) >>> 0;
    bits += extraBits;
    state = (state | ((1 << extraBits) - 1)) >>> 0;
    this.renormalize(state, bits);
    return value;
  }

  readSymbol(context) {
    if (context === 0) return this.symbolStatic(STATIC_FULL + 256);
    if (context > STATIC_FULL) return this.symbolStatic(context);
    return this.symbolDynamic(context);
  }

  readCompressedU32(context) {
    if (this.noCompression || !(context && context < MAX_RANGE)) return this.readU32();
    const symbol = this.readSymbol(context);
    if (symbol !== 0) return symbol - 1;
    const value = this.readU32();
    if (context <= STATIC_FULL) {
      let histogram = this.contexts.get(context);
      if (!histogram) {
        histogram = new Histogram(this.elephant);
        this.contexts.set(context, histogram);
      }
      histogram.add(value + 1);
    }
    return value;
  }
}

function checkedCount(value, label, bytesLength) {
  const maximum = Math.min(10000000, bytesLength * 4);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`The embedded U3D model has an invalid ${label} count.`);
  }
  return value;
}

function decodeClod(declaration, base, noCompression) {
  const declarationBits = new BitStream(declaration, noCompression);
  declarationBits.readString();
  declarationBits.readU32();
  const excludeNormals = (declarationBits.readU32() & 1) !== 0;
  for (let index = 0; index < 6; index += 1) declarationBits.readU32();
  const materialCount = checkedCount(declarationBits.readU32(), 'material', declaration.length);
  const materials = [];
  for (let index = 0; index < materialCount; index += 1) {
    const flags = declarationBits.readU32();
    const layerCount = checkedCount(declarationBits.readU32(), 'texture layer', declaration.length);
    for (let layer = 0; layer < layerCount; layer += 1) declarationBits.readU32();
    declarationBits.readU32();
    materials.push({ diffuse: (flags & 1) !== 0, specular: (flags & 2) !== 0, layers: layerCount });
  }

  const bits = new BitStream(base, noCompression);
  const meshName = bits.readString();
  bits.readU32();
  const faceCount = checkedCount(bits.readU32(), 'face', base.length);
  const positionCount = checkedCount(bits.readU32(), 'position', base.length);
  const normalCount = checkedCount(bits.readU32(), 'normal', base.length);
  const diffuseCount = checkedCount(bits.readU32(), 'diffuse color', base.length);
  const specularCount = checkedCount(bits.readU32(), 'specular color', base.length);
  const textureCount = checkedCount(bits.readU32(), 'texture coordinate', base.length);
  const payloadOffset = Math.ceil(bits.bitCount() / 8);
  const attributeBytes = (positionCount + normalCount) * 12 + (diffuseCount + specularCount + textureCount) * 16;
  if (attributeBytes > base.length - payloadOffset) throw new Error('The embedded U3D model has truncated geometry data.');
  const positions = Array.from({ length: positionCount }, () => [bits.readF32(), bits.readF32(), bits.readF32()]);
  for (let index = 0; index < normalCount * 3 + diffuseCount * 4 + specularCount * 4 + textureCount * 4; index += 1) bits.readF32();
  const faces = [];
  for (let face = 0; face < faceCount; face += 1) {
    const materialIndex = bits.readCompressedU32(1);
    const material = materials[materialIndex] ?? { diffuse: false, specular: false, layers: 0 };
    const vertices = [];
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const positionIndex = bits.readCompressedU32(STATIC_FULL + positionCount);
      if (positionIndex >= positionCount) throw new Error('The embedded U3D model contains an invalid face index.');
      vertices.push(positionIndex);
      if (!excludeNormals) bits.readCompressedU32(STATIC_FULL + normalCount);
      if (material.diffuse) bits.readCompressedU32(STATIC_FULL + diffuseCount);
      if (material.specular) bits.readCompressedU32(STATIC_FULL + specularCount);
      for (let layer = 0; layer < material.layers; layer += 1) bits.readCompressedU32(STATIC_FULL + textureCount);
    }
    faces.push(vertices);
  }
  return { name: meshName, positions, faces };
}

function decodeMeshes(u3d) {
  if (!(u3d instanceof Uint8Array)) u3d = new Uint8Array(u3d);
  const blocks = parseBlocks(u3d);
  const header = blocks.find((block) => block.type === FILE_HEADER);
  if (!header || header.data.length < 8) throw new Error('The embedded U3D model has no valid file header.');
  const profile = dataView(header.data).getUint32(4, true);
  const pairs = collectClodPairs(blocks);
  if (pairs.length === 0) throw new Error('No base-mesh geometry was found in the embedded U3D model. Progressive-only meshes, point/line sets, or PRC content are not supported.');
  return pairs.map(({ declaration, base }) => decodeClod(declaration, base, (profile & NO_COMPRESSION) !== 0));
}

function triangleNormal(a, b, c) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const normal = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const size = Math.hypot(normal[0], normal[1], normal[2]);
  return size > 1e-12 ? normal.map((value) => value / size) : null;
}

function writeVector(view, offset, vector) {
  for (let component = 0; component < 3; component += 1) view.setFloat32(offset + component * 4, vector[component], true);
}

export function convertU3dToStl(u3d) {
  const streams = Array.isArray(u3d) ? u3d : [u3d];
  const meshes = [];
  for (const stream of streams) {
    for (const mesh of decodeMeshes(stream)) meshes.push(mesh);
  }
  let triangleCount = 0;
  for (const mesh of meshes) {
    for (const [a, b, c] of mesh.faces) if (triangleNormal(mesh.positions[a], mesh.positions[b], mesh.positions[c])) triangleCount += 1;
  }
  if (triangleCount === 0) throw new Error('The embedded U3D model contains no triangular surface geometry.');
  const outputSize = 84 + triangleCount * 50;
  if (!Number.isSafeInteger(outputSize) || outputSize > 0xffffffff) throw new Error('The embedded U3D model is too large for binary STL output.');
  const output = new Uint8Array(outputSize);
  output.set(textEncoder.encode('Converted from a U3D 3D PDF'));
  const view = dataView(output);
  view.setUint32(80, triangleCount, true);
  let outputIndex = 0;
  for (const mesh of meshes) {
    for (const [a, b, c] of mesh.faces) {
      const first = mesh.positions[a];
      const second = mesh.positions[b];
      const third = mesh.positions[c];
      const normal = triangleNormal(first, second, third);
      if (!normal) continue;
      const offset = 84 + outputIndex * 50;
      writeVector(view, offset, normal);
      writeVector(view, offset + 12, first);
      writeVector(view, offset + 24, second);
      writeVector(view, offset + 36, third);
      outputIndex += 1;
    }
  }
  return { stl: output, triangleCount };
}
