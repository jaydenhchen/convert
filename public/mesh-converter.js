import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';

export const MESH_EXTENSIONS = ['.stl', '.obj', '.ply', '.off', '.glb', '.gltf', '.3mf'];

function extensionOf(file) {
  const name = file.name.toLowerCase();
  return name.slice(name.lastIndexOf('.'));
}

function parseOff(text) {
  const lines = text.split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
  const header = lines.shift();
  if (header !== 'OFF' && header !== 'COFF') throw new Error('The OFF file has an unsupported header.');
  const counts = lines.shift()?.split(/\s+/).map(Number);
  if (!counts || counts.length < 2 || !Number.isInteger(counts[0]) || !Number.isInteger(counts[1])) throw new Error('The OFF file has invalid vertex or face counts.');
  const [vertexCount, faceCount] = counts;
  const vertices = lines.splice(0, vertexCount).map((line) => line.split(/\s+/).slice(0, 3).map(Number));
  if (vertices.length !== vertexCount || vertices.some((vertex) => vertex.length !== 3 || vertex.some((value) => !Number.isFinite(value)))) throw new Error('The OFF file contains invalid vertices.');
  const positions = [];
  for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
    const values = lines[faceIndex]?.split(/\s+/).map(Number) ?? [];
    const size = values[0];
    if (!Number.isInteger(size) || size < 3 || values.length < size + 1) continue;
    for (let vertex = 1; vertex < size - 1; vertex += 1) {
      for (const index of [values[1], values[vertex + 1], values[vertex + 2]]) {
        const point = vertices[index];
        if (!point) throw new Error('The OFF file references a missing vertex.');
        positions.push(...point);
      }
    }
  }
  if (!positions.length) throw new Error('The OFF file contains no triangular faces.');
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
}

async function parseModel(extension, buffer) {
  if (extension === '.stl') return new THREE.Mesh(new STLLoader().parse(buffer));
  if (extension === '.obj') return new OBJLoader().parse(new TextDecoder().decode(buffer));
  if (extension === '.ply') return new THREE.Mesh(new PLYLoader().parse(buffer));
  if (extension === '.off') return new THREE.Mesh(parseOff(new TextDecoder().decode(buffer)));
  if (extension === '.3mf') return new ThreeMFLoader().parse(buffer);
  if (extension === '.glb' || extension === '.gltf') {
    const loader = new GLTFLoader();
    return (await new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject))).scene;
  }
  throw new Error(`Unsupported 3D model format: ${extension || 'unknown'}.`);
}

function collectTriangles(root) {
  root.updateMatrixWorld(true);
  const triangles = [];
  const first = new THREE.Vector3();
  const second = new THREE.Vector3();
  const third = new THREE.Vector3();
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const normal = new THREE.Vector3();
  root.traverse((object) => {
    const geometry = object.isMesh ? object.geometry : null;
    const positions = geometry?.attributes?.position;
    if (!positions) return;
    const index = geometry.index;
    const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(positions.count / 3);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const getIndex = (vertex) => index ? index.getX(triangle * 3 + vertex) : triangle * 3 + vertex;
      first.fromBufferAttribute(positions, getIndex(0)).applyMatrix4(object.matrixWorld);
      second.fromBufferAttribute(positions, getIndex(1)).applyMatrix4(object.matrixWorld);
      third.fromBufferAttribute(positions, getIndex(2)).applyMatrix4(object.matrixWorld);
      edgeA.subVectors(second, first);
      edgeB.subVectors(third, first);
      normal.crossVectors(edgeA, edgeB);
      if (normal.lengthSq() <= 1e-20) continue;
      normal.normalize();
      triangles.push({ normal: normal.toArray(), a: first.toArray(), b: second.toArray(), c: third.toArray() });
    }
  });
  if (!triangles.length) throw new Error('The model contains no triangular surface geometry.');
  return triangles;
}

function writeStl(triangles) {
  const output = new ArrayBuffer(84 + triangles.length * 50);
  const bytes = new Uint8Array(output);
  const view = new DataView(output);
  bytes.set(new TextEncoder().encode('Converted from a 3D mesh file'));
  view.setUint32(80, triangles.length, true);
  triangles.forEach(({ normal, a, b, c }, triangle) => {
    for (const [vectorIndex, vector] of [normal, a, b, c].entries()) {
      for (let component = 0; component < 3; component += 1) view.setFloat32(84 + triangle * 50 + vectorIndex * 12 + component * 4, vector[component], true);
    }
  });
  return new Uint8Array(output);
}

export function isSupportedMeshFile(file) {
  return MESH_EXTENSIONS.includes(extensionOf(file));
}

export async function convertMeshToStl(file) {
  const extension = extensionOf(file);
  if (!MESH_EXTENSIONS.includes(extension)) throw new Error(`Unsupported 3D model format: ${extension || 'unknown'}.`);
  const root = await parseModel(extension, await file.arrayBuffer());
  const triangles = collectTriangles(root);
  return { stl: writeStl(triangles), triangleCount: triangles.length };
}
