import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const form = document.querySelector('#convert-form');
const input = document.querySelector('#file-input');
const dropZone = document.querySelector('#drop-zone');
const fileName = document.querySelector('#file-name');
const submitButton = document.querySelector('#submit-button');
const status = document.querySelector('#status');
let selectedFile = null;
let sceneState = null;

function setStatus(message, kind = '') {
  status.textContent = message;
  status.className = `status${kind ? ` is-${kind}` : ''}`;
}

function chooseFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    selectedFile = null;
    submitButton.disabled = true;
    fileName.textContent = 'Please choose a PDF file';
    setStatus('This converter accepts PDF files containing an embedded PRC 3D model.', 'error');
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
      <div class="viewport" id="viewport"><div class="viewer-help">Drag to orbit · scroll to zoom · right-drag to pan</div></div>
      <aside class="viewer-controls">
        <div class="control-group"><h3>Camera</h3><div class="view-grid"><button data-view="front">Front <kbd>1</kbd></button><button data-view="back">Back <kbd>2</kbd></button><button data-view="top">Top <kbd>3</kbd></button><button data-view="bottom">Bottom <kbd>4</kbd></button><button data-view="left">Left <kbd>5</kbd></button><button data-view="right">Right <kbd>6</kbd></button></div><button class="control-wide" id="home-button">Home view <kbd>H</kbd></button><button class="control-wide" id="projection-button">Perspective <kbd>O</kbd></button><button class="control-wide" id="fit-button">Fit model <kbd>F</kbd></button></div>
        <div class="control-group"><h3>Section</h3><label class="toggle-row"><input id="section-toggle" type="checkbox"><span>Toggle cross section <kbd>X</kbd></span></label><div class="axis-control"><span class="axis-label">Plane orientation</span><div class="axis-grid" role="group" aria-label="Cross-section plane orientation"><button type="button" data-section-axis="x" aria-pressed="true">YZ <small>normal X</small></button><button type="button" data-section-axis="y" aria-pressed="false">XZ <small>normal Y</small></button><button type="button" data-section-axis="z" aria-pressed="false">XY <small>normal Z</small></button></div></div><label class="range-row" for="section-range">Cut position <output id="section-value">YZ · 50%</output><input id="section-range" type="range" min="0" max="100" value="50" disabled></label></div>
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
  const sectionPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  let sectionAxis = 'x';
  let displayMode = 'shaded';
  const loader = new STLLoader();
  stlBlob.arrayBuffer().then((buffer) => {
    const geometry = loader.parse(buffer);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: 0xc9d6cd, metalness: 0.32, roughness: 0.45, side: THREE.DoubleSide, clippingPlanes: [] });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (let index = 0; index < geometry.attributes.position.count; index += 1) box.expandByPoint(point.fromBufferAttribute(geometry.attributes.position, index));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.01);
    const edgeGeometry = new THREE.EdgesGeometry(geometry, 1);
    const outlineLines = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: 0x14251c }));
    const hiddenLines = new THREE.LineSegments(edgeGeometry, new THREE.LineDashedMaterial({ color: 0xd5f36c, dashSize: radius * 0.035, gapSize: radius * 0.025, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false }));
    hiddenLines.computeLineDistances();
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
    sceneState = { mesh, box, center, size, radius, material, sectionPlane, outlineLines, hiddenLines, centerLineGroup, centerMarkGroup, hatchGroup, projectionGroup, axesHelper, boxHelper };
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
    orthographic.left = -width / height;
    orthographic.right = width / height;
    orthographic.top = 1;
    orthographic.bottom = -1;
    orthographic.updateProjectionMatrix();
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
    activeCamera.position.set(center.x + positions[view][0], center.y + positions[view][1], center.z + positions[view][2]);
    activeCamera.up.set(0, 1, 0);
    if (view === 'top' || view === 'bottom') activeCamera.up.set(0, 0, view === 'top' ? -1 : 1);
    controls.target.copy(center);
    activeCamera.lookAt(center);
    activeCamera.updateProjectionMatrix();
    controls.update();
  }
  function buildDrawingOverlays() {
    const { box, center, size, radius, centerLineGroup, centerMarkGroup, projectionGroup } = sceneState;
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
    const markRadius = Math.max(Math.min(size.x, size.y, size.z) * 0.12, radius * 0.018);
    const addCenterMark = (axisA, axisB, fixedAxis) => {
      const points = [];
      for (let i = 0; i < 32; i += 1) {
        const angle = (i / 32) * Math.PI * 2;
        points.push(center.clone().setComponent(axisA, center.getComponent(axisA) + Math.cos(angle) * markRadius).setComponent(axisB, center.getComponent(axisB) + Math.sin(angle) * markRadius));
      }
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), markMaterial);
      centerMarkGroup.add(ring);
      const cross = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
        center.clone().setComponent(axisA, center.getComponent(axisA) - markRadius * 1.3),
        center.clone().setComponent(axisA, center.getComponent(axisA) + markRadius * 1.3),
        center.clone().setComponent(axisB, center.getComponent(axisB) - markRadius * 1.3),
        center.clone().setComponent(axisB, center.getComponent(axisB) + markRadius * 1.3)
      ]), markMaterial);
      centerMarkGroup.add(cross);
    };
    addCenterMark(0, 1, 2);
    addCenterMark(0, 2, 1);
    addCenterMark(1, 2, 0);
  }

  function updateHatching() {
    if (!sceneState) return;
    sceneState.hatchGroup.clear();
    const { box, center, size, radius } = sceneState;
    const axis = { x: 0, y: 1, z: 2 }[sectionAxis];
    const planeAxes = [0, 1, 2].filter((value) => value !== axis);
    const [u, v] = planeAxes;
    const coordinate = -sectionPlane.constant;
    const points = [];
    for (let i = 0; i <= 20; i += 1) {
      const t = i / 20;
      const first = center.clone().setComponent(axis, coordinate).setComponent(u, box.min.getComponent(u) + t * size.getComponent(u)).setComponent(v, box.min.getComponent(v));
      const second = center.clone().setComponent(axis, coordinate).setComponent(u, box.min.getComponent(u) + Math.max(0, t - 0.35) * size.getComponent(u)).setComponent(v, box.max.getComponent(v));
      points.push(first, second);
    }
    const material = new THREE.LineBasicMaterial({ color: 0xc9d6cd, transparent: true, opacity: 0.42, depthTest: false });
    sceneState.hatchGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), material));
  }

  function applyDisplayMode(mode) {
    displayMode = mode;
    if (!sceneState) return;
    const { mesh, material, outlineLines, hiddenLines } = sceneState;
    material.wireframe = mode === 'wireframe';
    material.transparent = mode === 'hidden';
    material.opacity = mode === 'hidden' ? 0.78 : 1;
    material.depthWrite = true;
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
    sceneState.material.clippingPlanes = enabled ? [sectionPlane] : [];
    section.querySelector('#section-range').disabled = !enabled;
    updateSection();
    updateOverlays();
  }
  function updateSection() {
    if (!sceneState) return;
    const percent = Number(section.querySelector('#section-range').value);
    const axisIndex = { x: 0, y: 1, z: 2 }[sectionAxis];
    const planeLabel = { x: 'YZ', y: 'XZ', z: 'XY' }[sectionAxis];
    const coordinate = sceneState.box.min.getComponent(axisIndex) + sceneState.size.getComponent(axisIndex) * percent / 100;
    sectionPlane.normal.set(0, 0, 0).setComponent(axisIndex, 1);
    sectionPlane.constant = -coordinate;
    section.querySelector('#section-value').value = `${planeLabel} · ${percent}%`;
    updateHatching();
  }
  function setSectionAxis(axis) {
    sectionAxis = axis;
    section.querySelectorAll('[data-section-axis]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.sectionAxis === axis)));
    updateSection();
  }
  section.querySelectorAll('[data-section-axis]').forEach((button) => button.addEventListener('click', () => setSectionAxis(button.dataset.sectionAxis)));
  section.querySelectorAll('input[name="display-mode"]').forEach((input) => input.addEventListener('change', () => applyDisplayMode(input.value)));
  ['overlay-center-lines', 'overlay-center-marks', 'overlay-section-hatching', 'overlay-projection-lines', 'overlay-axes', 'overlay-bounds'].forEach((id) => section.querySelector(`#${id}`).addEventListener('change', updateOverlays));
  section.querySelector('#home-button').addEventListener('click', fitCamera);
  section.querySelector('#projection-button').addEventListener('click', toggleProjection);
  section.querySelector('#section-toggle').addEventListener('change', (event) => toggleSection(event.target.checked));
  section.querySelector('#section-range').addEventListener('input', updateSection);
  section.querySelector('#download-button').addEventListener('click', () => downloadBlob(stlBlob, 'converted-model.stl'));
  window.addEventListener('resize', resize);
  window.addEventListener('keydown', (event) => {
    if (event.target.matches('input[type="range"], textarea, select')) return;
    const views = { '1': 'front', '2': 'back', '3': 'top', '4': 'bottom', '5': 'left', '6': 'right' };
    if (views[event.key]) setView(views[event.key]);
    else if (event.key.toLowerCase() === 'f') fitCamera();
    else if (event.key.toLowerCase() === 'h') fitCamera();
    else if (event.key.toLowerCase() === 'x') { const toggle = section.querySelector('#section-toggle'); toggle.checked = !toggle.checked; toggleSection(toggle.checked); }
  });
  resize();
  const animate = () => { requestAnimationFrame(animate); controls.update(); renderer.render(scene, activeCamera); };
  animate();
}

async function convertSelectedPdf(file) {
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
  setStatus('Extracting the embedded 3D surface…');
  try {
    const { stlBlob, triangleCount } = await convertSelectedPdf(selectedFile);
    setStatus(`Done · ${triangleCount.toLocaleString()} triangles.`, 'success');
    createViewer(stlBlob);
    document.querySelector('#viewer-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    submitButton.disabled = !selectedFile;
  }
});
