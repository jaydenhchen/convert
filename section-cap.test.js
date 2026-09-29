import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildSectionCapGeometry } from './public/section-cap.js';

function projectedArea(geometry, axisIndex) {
  const axes = [0, 1, 2].filter((axis) => axis !== axisIndex);
  const positions = geometry.getAttribute('position');
  let area = 0;
  for (let index = 0; index < positions.count; index += 3) {
    const first = new THREE.Vector3().fromBufferAttribute(positions, index);
    const second = new THREE.Vector3().fromBufferAttribute(positions, index + 1);
    const third = new THREE.Vector3().fromBufferAttribute(positions, index + 2);
    area += Math.abs(
      (second.getComponent(axes[0]) - first.getComponent(axes[0])) * (third.getComponent(axes[1]) - first.getComponent(axes[1]))
        - (second.getComponent(axes[1]) - first.getComponent(axes[1])) * (third.getComponent(axes[0]) - first.getComponent(axes[0]))
    ) / 2;
  }
  return area;
}

test('caps an axis-aligned solid section with filled triangles', () => {
  const cap = buildSectionCapGeometry(new THREE.BoxGeometry(2, 2, 2), 0, 0, -1);
  const positions = cap.getAttribute('position');
  const normals = cap.getAttribute('normal');

  assert.ok(positions.count > 0);
  assert.equal(positions.count % 3, 0);
  assert.equal(projectedArea(cap, 0), 4);
  assert.equal(normals.getX(0), -1);
  for (let index = 0; index < positions.count; index += 1) assert.equal(positions.getX(index), 0);
});

test('returns an empty cap when the plane misses the model', () => {
  const cap = buildSectionCapGeometry(new THREE.BoxGeometry(2, 2, 2), 2, 2);
  assert.equal(cap.getAttribute('position'), undefined);
});
