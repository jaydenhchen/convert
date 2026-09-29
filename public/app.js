import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { buildSectionCapGeometry } from './section-cap.js';
import { MESH_EXTENSIONS, convertMeshToStl, isSupportedMeshFile } from './mesh-converter.js';

const form = document.querySelector('#convert-form');
const input = document.querySelector('#file-input');
const dropZone = document.querySelector('#drop-zone');
const fileName = document.querySelector('#file-name');
const submitButton = document.querySelector('#submit-button');
const status = document.querySelector('#status');
const themeToggle = document.querySelector('#theme-toggle');
let selectedFile = null;
let sceneState = null;

function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  themeToggle.setAttribute('aria-pressed', String(dark));
  themeToggle.textContent = dark ? 'Light theme' : 'Dark theme';
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}

setTheme(localStorage.getItem('theme') === 'dark');
themeToggle.addEventListener('click', () => setTheme(document.documentElement.dataset.theme !== 'dark'));

function setStatus(message, kind = '') {
  status.textContent = message;
  status.className = `status${kind ? ` is-${kind}` : ''}`;
}

function chooseFile(file) {
  if (!file) return;
  const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
  if (!isPdf && !isSupportedMeshFile(file)) {
    selectedFile = null;
    submitButton.disabled = true;
    fileName.textContent = 'Unsupported file format';
    setStatus(`Supported formats: PDF, ${MESH_EXTENSIONS.map((extension) => extension.slice(1).toUpperCase()).join(', ')}.`, 'error');
    return;
  }
  selectedFile = file;
  fileName.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  submitButton.disabled = false;
  setStatus('Ready to convert.');
}

input.addEventListener('change', () => chooseFile(input.files[0]));
['dragenter', 'dragover'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropZone.classList.add('is-dragging');
}));
['dragleave', 'drop'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropZone.classList.remove('is-dragging');
}));
dropZone.addEventListener('drop', (event) => chooseFile(event.dataTransfer.files[0]));

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createViewer(stlBlob) {
  document.querySelector('#viewer-section')?.remove();
  const section = document.createElement('section');
  section.id = 'viewer-section';
  section.className = 'viewer-section';
  section.innerHTML = `
    <div class="viewer-heading">
      <div><p class="eyebrow">MODEL CHECK</p><h2>Inspect before printing</h2></div>
      <button class="button button-small" id="download-button" type="button">Download STL <span aria-hidden="true">↓</span></button>
    </div>
    <div class="viewer-layout">
      <div class="viewport" id="viewport"><div class="viewer-help">Click a flat face to align the view · drag to orbit · scroll to zoom · right-drag to pan</div></div>
      <aside class="viewer-controls">
        <div class="control-group"><h3>Camera</h3><div class="view-grid"><button type="button" data-view="front" aria-pressed="false">Front <kbd>1</kbd></button><button type="button" data-view="back" aria-pressed="false">Back <kbd>2</kbd></button><button type="button" data-view="top" aria-pressed="false">Top <kbd>3</kbd></button><button type="button" data-view="bottom" aria-pressed="false">Bottom <kbd>4</kbd></button><button type="button" data-view="left" aria-pressed="false">Left <kbd>5</kbd></button><button type="button" data-view="right" aria-pressed="false">Right <kbd>6</kbd></button></div><button type="button" class="control-wide" id="home-button">Home view <kbd>H</kbd></button><div class="rotation-grid"><button type="button" id="rotate-left">Rotate left <kbd>[</kbd></button><button type="button" id="rotate-right">Rotate right <kbd>]</kbd></button><button type="button" id="flip-view">Flip 180° <kbd>R</kbd></button></div><button type="button" class="control-wide" id="projection-button">Perspective <kbd>O</kbd></button><button type="button" class="control-wide" id="fit-button">Fit model <kbd>F</kbd></button></div>
        <div class="control-group"><h3>Section</h3><label class="toggle-row"><input id="section-toggle" type="checkbox"><span>Toggle cross section <kbd>X</kbd></span></label><div class="axis-control"><span class="axis-label">Plane orientation</span><div class="axis-grid" role="group" aria-label="Cross-section plane orientation"><button type="button" data-section-axis="x" aria-pressed="true">YZ <small>normal X</small></button><button type="button" data-section-axis="y" aria-pressed="false">XZ <small>normal Y</small></button><button type="button" data-section-axis="z" aria-pressed="false">XY <small>normal Z</small></button></div></div><label class="range-row" for="section-range">Cut position <output id="section-value">YZ · 50%</output><input id="section-range" type="range" min="0" max="100" value="50" disabled></label><button class="control-wide" id="section-side" type="button">Showing high side</button></div>
        <div class="control-group"><h3>Mechanical drawing</h3><fieldset class="mode-options"><legend>Display style</legend><label><input type="radio" name="display-mode" value="shaded" checked><span>Shaded</span></label><label><input type="radio" name="display-mode" value="outlined"><span>Shaded + outlines</span></label><label><input type="radio" name="display-mode" value="wireframe"><span>Wireframe</span></label><label><input type="radio" name="display-mode" value="hidden"><span>Hidden lines</span></label></fieldset><fieldset class="check-options"><legend>Drawing overlays</legend><label><input id="overlay-center-lines" type="checkbox"><span>Center lines</span></label><label><input id="overlay-center-marks" type="checkbox"><span>Center marks</span></label><label><input id="overlay-section-hatching" type="checkbox"><span>Section hatching</span></label><label><input id="overlay-projection-lines" type="checkbox"><span>Projection lines</span></label><label><input id="overlay-axes" type="checkbox"><span>Origin axes</span></label><label><input id="overlay-bounds" type="checkbox"><span>Bounding box</span></label></fieldset><p class="settings-note">Display style is one choice. Drawing overlays can be combined.</p></div>
        <p class="shortcut-note">Fusion-style shortcuts: number keys set standard views, <kbd>H</kbd> returns home, <kbd>O</kbd> switches projection, <kbd>F</kbd> fits, and <kbd>X</kbd> toggles the section plane.</p>
      </aside>
    </div>`;
  document.querySelector('.shell').append(section);

  const viewport = section.querySelector('#viewport');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x17211c, 1);
  renderer.localClippingEnabled = true;
  viewport.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x17211c);
  scene.add(new THREE.HemisphereLight(0xf4fff5, 0x3c4d42, 2.2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
  keyLight.position.set(3, 5, 4);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xb9d9ff, 1.5);
  fillLight.position.set(-4, 1, -3);
  scene.add(fillLight);
  const grid = new THREE.GridHelper(200, 40, 0x51675a, 0x2c3c33);
  grid.position.y = -0.5;
  scene.add(grid);

  const perspective = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
  const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100000);
  let activeCamera = orthographic;
  const controls = new OrbitControls(activeCamera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  const faceRaycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerStart = null;
  const sectionPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  let sectionAxis = 'x';
  let displayMode = 'shaded';
  let sectionSide = 1;
  const loader = new STLLoader();
  stlBlob.arrayBuffer().then((buffer) => {
    const geometry = loader.parse(buffer);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: 0xc9d6cd, metalness: 0.32, roughness: 0.45, side: THREE.DoubleSide, clippingPlanes: [] });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    const capMaterial = new THREE.MeshStandardMaterial({ color: 0x4f9fe8, metalness: 0.12, roughness: 0.5, side: THREE.DoubleSide });
    const capMesh = new THREE.Mesh(new THREE.BufferGeometry(), capMaterial);
    capMesh.frustumCulled = false;
    capMesh.visible = false;
    scene.add(mesh, capMesh);
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (let index = 0; index < geometry.attributes.position.count; index += 1) box.expandByPoint(point.fromBufferAttribute(geometry.attributes.position, index));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.01);
    const edgeGeometry = new THREE.EdgesGeometry(geometry, 15);
    const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x14251c, clippingPlanes: [] });
    const hiddenLineMaterial = new THREE.LineDashedMaterial({ color: 0xd5f36c, dashSize: radius * 0.035, gapSize: radius * 0.025, transparent: true, opacity: 0.85, depthTest: true, depthFunc: THREE.GreaterDepth, depthWrite: false, clippingPlanes: [] });
    const outlineLines = new THREE.LineSegments(edgeGeometry, outlineMaterial);
    const hiddenLines = new THREE.LineSegments(edgeGeometry, hiddenLineMaterial);
    const centerLineGroup = new THREE.Group();
    const centerMarkGroup = new THREE.Group();
    const hatchGroup = new THREE.Group();
    const projectionGroup = new THREE.Group();
    const axesHelper = new THREE.AxesHelper(radius * 1.35);
    axesHelper.position.copy(center);
    const boxHelper = new THREE.Box3Helper(box, 0x93aa9a);
    scene.add(outlineLines, hiddenLines, centerLineGroup, centerMarkGroup, hatchGroup, projectionGroup, axesHelper, boxHelper);
    grid.scale.setScalar(Math.max(radius / 20, 0.01));
    grid.position.y = box.min.y;
    sceneState = { mesh, geometry, box, center, size, radius, material, capMesh, capMaterial, outlineMaterial, hiddenLineMaterial, sectionPlane, outlineLines, hiddenLines, centerLineGroup, centerMarkGroup, hatchGroup, projectionGroup, axesHelper, boxHelper };
    buildDrawingOverlays();
    applyDisplayMode(displayMode);
    updateOverlays();
    fitCamera();
    setView('front');
  }).catch((error) => setStatus(`The STL was created, but the preview could not be loaded${error?.message ? `: ${error.message}` : '.'}`, 'error'));
  function resize() {
    const width = viewport.clientWidth;
    const height = Math.max(viewport.clientHeight, 360);
    renderer.setSize(width, height, false);
    perspective.aspect = width / height;
    perspective.updateProjectionMatrix();
    const viewHeight = sceneState ? sceneState.radius * 1.35 : 1;
    orthographic.left = -viewHeight * width / height;
    orthographic.right = viewHeight * width / height;
    orthographic.top = viewHeight;
    orthographic.bottom = -viewHeight;
  }
  function fitCamera() {
    if (!sceneState) return;
    const { center, radius } = sceneState;
    const distance = radius * 2.5;
    activeCamera.position.set(center.x + distance, center.y + distance * 0.8, center.z + distance);
    activeCamera.near = Math.max(radius / 1000, 0.001);
    activeCamera.far = Math.max(radius * 100, 100);
    if (activeCamera.isOrthographicCamera) {
      const aspect = viewport.clientWidth / Math.max(viewport.clientHeight, 1);
      activeCamera.top = radius * 1.35;
      activeCamera.bottom = -radius * 1.35;
      activeCamera.left = -radius * 1.35 * aspect;
      activeCamera.right = radius * 1.35 * aspect;
      activeCamera.zoom = 1;
    } else activeCamera.fov = 45;
    activeCamera.lookAt(center);
    activeCamera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  }
  function setView(view) {
    if (!sceneState) return;
    const { center, radius } = sceneState;
    const d = radius * 2.4;
    const positions = { front: [0, 0, d], back: [0, 0, -d], top: [0, d, 0], bottom: [0, -d, 0], left: [-d, 0, 0], right: [d, 0, 0] };
    const position = positions[view];
    if (!position) return;
    activeCamera.position.set(center.x + position[0], center.y + position[1], center.z + position[2]);
    activeCamera.up.set(0, 1, 0);
    if (view === 'top' || view === 'bottom') activeCamera.up.set(0, 0, view === 'top' ? -1 : 1);
    controls.target.copy(center);
    activeCamera.lookAt(center);
    activeCamera.updateProjectionMatrix();
    controls.update();
    section.querySelectorAll('[data-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  }
  function rotateView(degrees) {
    if (!sceneState) return;
    const direction = controls.target.clone().sub(activeCamera.position).normalize();
    activeCamera.up.applyAxisAngle(direction, THREE.MathUtils.degToRad(degrees)).normalize();
    activeCamera.lookAt(controls.target);
    activeCamera.updateProjectionMatrix();
    controls.update();
  }
  function alignToFace(intersection) {
    if (!sceneState || !intersection.face) return;
    const { center, radius, mesh } = sceneState;
    const normal = intersection.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
    if (normal.dot(activeCamera.position.clone().sub(intersection.point)) < 0) normal.negate();
    activeCamera.position.copy(center).addScaledVector(normal, radius * 2.4);
    const up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(up.dot(normal)) > 0.9) up.set(0, 0, 1);
    activeCamera.up.copy(up);
    controls.target.copy(center);
    activeCamera.lookAt(center);
    activeCamera.updateProjectionMatrix();
    controls.update();
    section.querySelectorAll('[data-view]').forEach((button) => button.setAttribute('aria-pressed', 'false'));
  }
  function detectCircularFeatures(geometry, size) {
    const positions = geometry.attributes.position;
    const extent = Math.max(size.x, size.y, size.z);
    const quantization = Math.max(extent * 0.0005, 1e-7);
    const unique = new Map();
    const point = new THREE.Vector3();
    for (let index = 0; index < positions.count; index += 1) {
      point.fromBufferAttribute(positions, index);
      const key = `${Math.round(point.x / quantization)},${Math.round(point.y / quantization)},${Math.round(point.z / quantization)}`;
      if (!unique.has(key)) unique.set(key, point.clone());
    }
    const axes = [[0, 1, 2], [0, 2, 1], [1, 2, 0]];
    const features = [];
    for (const [u, v, axis] of axes) {
      const projected = [...unique.values()].map((value) => ({ u: value.getComponent(u), v: value.getComponent(v), normal: value.getComponent(axis) }));
      const stride = Math.max(1, Math.ceil(projected.length / 64));
      const sample = projected.filter((_, index) => index % stride === 0);
      const tolerance = Math.max(extent * 0.012, 1e-5);
      const minimumRadius = Math.max(Math.min(size.getComponent(u), size.getComponent(v)) * 0.025, tolerance * 2);
      const maximumRadius = Math.max(size.getComponent(u), size.getComponent(v)) * 0.48;
      const minimumSupport = Math.max(10, Math.ceil(projected.length * 0.06));
      const candidates = [];
      for (let first = 0; first < sample.length - 2; first += 1) {
        for (let second = first + 1; second < sample.length - 1; second += 1) {
          for (let third = second + 1; third < sample.length; third += 1) {
            const a = sample[first];
            const b = sample[second];
            const c = sample[third];
            const denominator = 2 * (a.u * (b.v - c.v) + b.u * (c.v - a.v) + c.u * (a.v - b.v));
            if (Math.abs(denominator) < 1e-8) continue;
            const aa = a.u * a.u + a.v * a.v;
            const bb = b.u * b.u + b.v * b.v;
            const cc = c.u * c.u + c.v * c.v;
            const centerU = (aa * (b.v - c.v) + bb * (c.v - a.v) + cc * (a.v - b.v)) / denominator;
            const centerV = (aa * (c.u - b.u) + bb * (a.u - c.u) + cc * (b.u - a.u)) / denominator;
            const candidateRadius = Math.hypot(a.u - centerU, a.v - centerV);
            if (candidateRadius < minimumRadius || candidateRadius > maximumRadius) continue;
            const bins = new Set();
            let support = 0;
            let error = 0;
            let normalTotal = 0;
            for (const candidate of projected) {
              const distance = Math.hypot(candidate.u - centerU, candidate.v - centerV);
              const radialError = Math.abs(distance - candidateRadius);
              if (radialError > tolerance) continue;
              support += 1;
              error += radialError;
              normalTotal += candidate.normal;
              bins.add(Math.floor((Math.atan2(candidate.v - centerV, candidate.u - centerU) + Math.PI) * 12 / Math.PI) % 24);
            }
            const coverage = bins.size / 24;
            if (support < minimumSupport || coverage < 0.45) continue;
            candidates.push({ axis, u, v, centerU, centerV, normal: normalTotal / support, radius: candidateRadius, score: support * coverage / (1 + error / support / tolerance) });
          }
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const candidate of candidates) {
        if (features.some((feature) => feature.axis === candidate.axis && Math.hypot(feature.centerU - candidate.centerU, feature.centerV - candidate.centerV) < tolerance * 2 && Math.abs(feature.radius - candidate.radius) < tolerance * 3)) continue;
        features.push(candidate);
        if (features.filter((feature) => feature.axis === axis).length >= 3) break;
      }
    }
    return features;
  }

  function buildDrawingOverlays() {
    const { box, center, size, radius, geometry, centerLineGroup, centerMarkGroup, projectionGroup } = sceneState;
    const centerLineMaterial = new THREE.LineDashedMaterial({ color: 0xd5f36c, dashSize: radius * 0.08, gapSize: radius * 0.035, transparent: true, opacity: 0.9, depthTest: false });
    for (let axis = 0; axis < 3; axis += 1) {
      const start = center.clone().setComponent(axis, box.min.getComponent(axis));
      const end = center.clone().setComponent(axis, box.max.getComponent(axis));
      const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([start, end]), centerLineMaterial);
      line.computeLineDistances();
      centerLineGroup.add(line);
      const projectionEnd = center.clone().setComponent(axis, center.getComponent(axis) + size.getComponent(axis) * 0.75);
      const projection = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([center, projectionEnd]), centerLineMaterial);
      projection.computeLineDistances();
      projectionGroup.add(projection);
    }
    const markMaterial = new THREE.LineBasicMaterial({ color: 0xd5f36c, transparent: true, opacity: 0.95, depthTest: false });
    const circleFeatures = detectCircularFeatures(geometry, size);
    for (const feature of circleFeatures) {
      const makePoint = (uOffset, vOffset) => center.clone().setComponent(feature.u, feature.centerU + uOffset).setComponent(feature.v, feature.centerV + vOffset).setComponent(feature.axis, feature.normal);
      const circlePoints = [];
      for (let i = 0; i < 32; i += 1) {
        const angle = (i / 32) * Math.PI * 2;
        circlePoints.push(makePoint(Math.cos(angle) * feature.radius, Math.sin(angle) * feature.radius));
      }
      centerMarkGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(circlePoints), markMaterial));
      const crossRadius = feature.radius * 1.35;
      const cross = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
        makePoint(-crossRadius, 0), makePoint(crossRadius, 0),
        makePoint(0, -crossRadius), makePoint(0, crossRadius)
      ]), centerLineMaterial);
      cross.computeLineDistances();
      centerLineGroup.add(cross);
    }
    if (!circleFeatures.length) {
      const markRadius = Math.max(Math.min(size.x, size.y, size.z) * 0.12, radius * 0.018);
      for (const [axisA, axisB] of [[0, 1], [0, 2], [1, 2]]) {
        const points = [];
        for (let i = 0; i < 32; i += 1) {
          const angle = (i / 32) * Math.PI * 2;
          points.push(center.clone().setComponent(axisA, center.getComponent(axisA) + Math.cos(angle) * markRadius).setComponent(axisB, center.getComponent(axisB) + Math.sin(angle) * markRadius));
        }
        centerMarkGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), markMaterial));
      }
    }
  }
  function updateHatching() {
    if (!sceneState) return;
    sceneState.hatchGroup.clear();
    const { box, center, size } = sceneState;
    const axis = { x: 0, y: 1, z: 2 }[sectionAxis];
    const planeAxes = [0, 1, 2].filter((value) => value !== axis);
    const [u, v] = planeAxes;
    const percent = Number(section.querySelector('#section-range').value);
    const coordinate = box.min.getComponent(axis) + size.getComponent(axis) * percent / 100;
    const uSize = size.getComponent(u);
    const vSize = size.getComponent(v);
    const spacing = Math.max(Math.min(uSize, vSize) * 0.14, 1e-4);
    const points = [];
    for (let offset = -vSize; offset <= uSize; offset += spacing) {
      const startU = box.min.getComponent(u) + Math.max(0, offset);
      const startV = box.min.getComponent(v) + Math.max(0, -offset);
      const endU = box.min.getComponent(u) + Math.min(uSize, offset + vSize);
      const endV = box.min.getComponent(v) + Math.min(vSize, uSize - offset);
      if (endU <= startU || endV <= startV) continue;
      points.push(
        center.clone().setComponent(axis, coordinate).setComponent(u, startU).setComponent(v, startV),
        center.clone().setComponent(axis, coordinate).setComponent(u, endU).setComponent(v, endV)
      );
    }
    const material = new THREE.LineBasicMaterial({ color: 0xc9d6cd, transparent: true, opacity: 0.42, depthTest: false });
    sceneState.hatchGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), material));
  }

  function applyDisplayMode(mode) {
    displayMode = mode;
    if (!sceneState) return;
    const { material, capMaterial, outlineLines, hiddenLines } = sceneState;
    material.wireframe = mode === 'wireframe';
    material.transparent = mode === 'hidden';
    material.opacity = mode === 'hidden' ? 0.78 : 1;
    material.depthWrite = true;
    capMaterial.wireframe = mode === 'wireframe';
    capMaterial.transparent = mode === 'hidden';
    capMaterial.opacity = mode === 'hidden' ? 0.78 : 1;
    capMaterial.depthWrite = true;
    outlineLines.visible = mode === 'outlined' || mode === 'hidden';
    hiddenLines.visible = mode === 'hidden';
  }

  function updateOverlays() {
    if (!sceneState) return;
    const checked = (id) => section.querySelector(`#${id}`).checked;
    sceneState.centerLineGroup.visible = checked('overlay-center-lines');
    sceneState.centerMarkGroup.visible = checked('overlay-center-marks');
    sceneState.projectionGroup.visible = checked('overlay-projection-lines');
    sceneState.axesHelper.visible = checked('overlay-axes');
    sceneState.boxHelper.visible = checked('overlay-bounds');
    sceneState.hatchGroup.visible = checked('overlay-section-hatching') && section.querySelector('#section-toggle').checked;
  }

  function toggleProjection() {
    const old = activeCamera;
    activeCamera = activeCamera.isOrthographicCamera ? perspective : orthographic;
    activeCamera.position.copy(old.position);
    activeCamera.up.copy(old.up);
    activeCamera.lookAt(controls.target);
    controls.object = activeCamera;
    section.querySelector('#projection-button').firstChild.textContent = `${activeCamera.isOrthographicCamera ? 'Orthographic' : 'Perspective'} `;
    resize();
    fitCamera();
  }

  function toggleSection(enabled) {
    if (!sceneState) return;
    const { material, outlineMaterial, hiddenLineMaterial, capMesh } = sceneState;
    const clippingPlanes = enabled ? [sectionPlane] : [];
    material.clippingPlanes = clippingPlanes;
    outlineMaterial.clippingPlanes = clippingPlanes;
    hiddenLineMaterial.clippingPlanes = clippingPlanes;
    capMesh.visible = enabled;
    section.querySelector('#section-range').disabled = !enabled;
    updateSection();
    updateOverlays();
  }

  function toggleSectionSide() {
    sectionSide *= -1;
    section.querySelector('#section-side').textContent = sectionSide > 0 ? 'Showing high side' : 'Showing low side';
    updateSection();
  }

  function updateSection() {
    if (!sceneState) return;
    const percent = Number(section.querySelector('#section-range').value);
    const axisIndex = { x: 0, y: 1, z: 2 }[sectionAxis];
    const planeLabel = { x: 'YZ', y: 'XZ', z: 'XY' }[sectionAxis];
    const coordinate = sceneState.box.min.getComponent(axisIndex) + sceneState.size.getComponent(axisIndex) * percent / 100;
    sectionPlane.normal.set(0, 0, 0).setComponent(axisIndex, sectionSide);
    sectionPlane.constant = -sectionSide * coordinate;
    const nextCapGeometry = buildSectionCapGeometry(sceneState.geometry, axisIndex, coordinate, sectionSide);
    sceneState.capMesh.geometry.dispose();
    sceneState.capMesh.geometry = nextCapGeometry;
    section.querySelector('#section-value').value = `${planeLabel} · ${percent}%`;
    updateHatching();
  }
  function setSectionAxis(axis) {
    sectionAxis = axis;
    section.querySelectorAll('[data-section-axis]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.sectionAxis === axis)));
    updateSection();
  }
  section.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    setView(button.dataset.view);
  }));
  renderer.domElement.addEventListener('pointerdown', (event) => {
    pointerStart = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
  });
  renderer.domElement.addEventListener('pointerup', (event) => {
    if (!pointerStart || event.button !== 0) return;
    const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
    pointerStart = null;
    if (moved > 5 || !sceneState) return;
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    faceRaycaster.setFromCamera(pointer, activeCamera);
    const intersection = faceRaycaster.intersectObject(sceneState.mesh, false)[0];
    if (intersection) alignToFace(intersection);
  });
  section.querySelector('#section-side').addEventListener('click', toggleSectionSide);
  section.querySelectorAll('[data-section-axis]').forEach((button) => button.addEventListener('click', () => setSectionAxis(button.dataset.sectionAxis)));
  section.querySelectorAll('input[name="display-mode"]').forEach((input) => input.addEventListener('change', () => applyDisplayMode(input.value)));
  ['overlay-center-lines', 'overlay-center-marks', 'overlay-section-hatching', 'overlay-projection-lines', 'overlay-axes', 'overlay-bounds'].forEach((id) => section.querySelector(`#${id}`).addEventListener('change', updateOverlays));
  section.querySelector('#home-button').addEventListener('click', fitCamera);
  section.querySelector('#rotate-left').addEventListener('click', () => rotateView(-90));
  section.querySelector('#rotate-right').addEventListener('click', () => rotateView(90));
  section.querySelector('#flip-view').addEventListener('click', () => rotateView(180));
  section.querySelector('#projection-button').addEventListener('click', toggleProjection);
  section.querySelector('#fit-button').addEventListener('click', fitCamera);
  section.querySelector('#section-toggle').addEventListener('change', (event) => toggleSection(event.target.checked));
  section.querySelector('#section-range').addEventListener('input', updateSection);
  section.querySelector('#download-button').addEventListener('click', () => downloadBlob(stlBlob, 'converted-model.stl'));
  window.addEventListener('resize', resize);
  window.addEventListener('keydown', (event) => {
    if (event.target.matches('input[type="range"], textarea, select')) return;
    const views = { '1': 'front', '2': 'back', '3': 'top', '4': 'bottom', '5': 'left', '6': 'right' };
    if (views[event.key]) setView(views[event.key]);
    else if (event.key === '[') rotateView(-90);
    else if (event.key === ']') rotateView(90);
    else if (event.key.toLowerCase() === 'r') rotateView(180);
    else if (event.key.toLowerCase() === 'f') fitCamera();
    else if (event.key.toLowerCase() === 'h') fitCamera();
    else if (event.key.toLowerCase() === 'x') { const toggle = section.querySelector('#section-toggle'); toggle.checked = !toggle.checked; toggleSection(toggle.checked); }
  });
  resize();
  const animate = () => { requestAnimationFrame(animate); controls.update(); renderer.render(scene, activeCamera); };
  animate();
}

async function convertSelectedFile(file) {
  if (isSupportedMeshFile(file)) {
    const result = await convertMeshToStl(file);
    return { stlBlob: new Blob([result.stl], { type: 'model/stl' }), triangleCount: result.triangleCount };
  }
  if (typeof __STATIC_SITE__ !== 'undefined' && __STATIC_SITE__) {
    const { convertPdfToStl } = await import('./browser-converter.js');
    const result = await convertPdfToStl(await file.arrayBuffer());
    return { stlBlob: new Blob([result.stl], { type: 'model/stl' }), triangleCount: result.triangleCount };
  }
  const response = await fetch('/api/convert', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? 'Conversion failed.');
  }
  return { stlBlob: await response.blob(), triangleCount: Number(response.headers.get('X-Triangle-Count')) };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectedFile) return;
  submitButton.disabled = true;
  setStatus(isSupportedMeshFile(selectedFile) ? 'Reading the 3D mesh…' : 'Extracting the embedded 3D surface…');
  try {
    const { stlBlob, triangleCount } = await convertSelectedFile(selectedFile);
    setStatus(`Done · ${triangleCount.toLocaleString()} triangles.`, 'success');
    createViewer(stlBlob);
    document.querySelector('#viewer-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    submitButton.disabled = !selectedFile;
  }
});
