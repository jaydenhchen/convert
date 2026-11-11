import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { convertPdfToStl } from './converter.mjs';

const U3D_FILE_HEADER = 0x00443355;
const U3D_MODIFIER_CHAIN = 0xffffff14;
const U3D_CLOD_DECLARATION = 0xffffff31;
const U3D_CLOD_BASE_MESH = 0xffffff3b;

function u16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function string(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u16(bytes.length), bytes]);
}

function block(type, data) {
  const padding = Buffer.alloc((-data.length) & 3);
  return Buffer.concat([u32(type), u32(data.length), u32(0), data, padding]);
}

function makeTrianglePdf() {
  const fileHeader = Buffer.alloc(24);
  fileHeader.writeUInt32LE(4, 4); // U3D profile: uncompressed index data.
  const declaration = Buffer.concat([
    string('triangle'),
    u32(0), // declaration flags
    u32(1), // exclude normals
    ...Array.from({ length: 6 }, () => u32(0)),
    u32(1), // material count
    u32(0), // material flags
    u32(0), // texture layer count
    u32(0) // material attributes
  ]);
  const chainHeader = Buffer.concat([u16(0), u32(0), u32(0), Buffer.alloc(2), u32(1)]);
  const modifierChain = Buffer.concat([chainHeader, block(U3D_CLOD_DECLARATION, declaration)]);
  const positions = [
    [0, 0, 0],
    [2, 0, 0],
    [0, 3, 0]
  ].flatMap((position) => position.map((value) => {
    const bytes = Buffer.alloc(4);
    bytes.writeFloatLE(value);
    return bytes;
  }));
  const baseMesh = Buffer.concat([
    string('triangle'),
    u32(0), // continuation flags
    u32(1), // face count
    u32(3), // position count
    u32(0), // normal count
    u32(0), // diffuse color count
    u32(0), // specular color count
    u32(0), // texture coordinate count
    ...positions,
    u32(0), // material index
    u32(0), u32(1), u32(2) // triangle indices
  ]);
  const raw = Buffer.concat([
    block(U3D_FILE_HEADER, fileHeader),
    block(U3D_MODIFIER_CHAIN, modifierChain),
    block(U3D_CLOD_BASE_MESH, baseMesh),
    Buffer.alloc(4)
  ]);
  const compressed = deflateSync(raw);
  const prefix = Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Subtype /U3D /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`);
  return Buffer.concat([prefix, compressed, Buffer.from('\nendstream\nendobj\n%%EOF\n')]);
}

test('converts a U3D PDF base mesh into binary STL geometry', async () => {
  const { stl, triangleCount } = await convertPdfToStl(makeTrianglePdf());
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);

  assert.equal(triangleCount, 1);
  assert.equal(view.getUint32(80, true), 1);
  assert.deepEqual(
    Array.from({ length: 12 }, (_, index) => view.getFloat32(84 + index * 4, true)),
    [0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0]
  );
});
