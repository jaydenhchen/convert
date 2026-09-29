import test from 'node:test';
import assert from 'node:assert/strict';
import { convertMeshToStl } from './public/mesh-converter.js';

const textFile = (name, text) => ({ name, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
const triangleCount = (stl) => new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true);

test('converts OBJ polygons to binary STL triangles', async () => {
  const file = textFile('square.obj', 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n');
  const result = await convertMeshToStl(file);

  assert.equal(result.triangleCount, 2);
  assert.equal(triangleCount(result.stl), 2);
});

test('converts OFF polygon faces to binary STL triangles', async () => {
  const file = textFile('triangle.off', 'OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n');
  const result = await convertMeshToStl(file);

  assert.equal(result.triangleCount, 1);
  assert.equal(triangleCount(result.stl), 1);
});

test('rejects unsupported mesh extensions', async () => {
  await assert.rejects(() => convertMeshToStl(textFile('model.step', '')), /Unsupported 3D model format/);
});
