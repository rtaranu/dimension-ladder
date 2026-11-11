import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { makeBox, rotate, project, sliceCrossings, sliceSegments, sliceFacets, orderPlanar } from './math4d.js';

// ---------------------------------------------------------------- constants

// One colour per axis; edges keep their colour through every rotation and projection.
const AXIS_COLORS = [0x3d8bff, 0x3ddc5a, 0xff4d4d, 0xffd23d].map((c) => new THREE.Color(c));
const AXIS_CSS = ['#3d8bff', '#3ddc5a', '#ff4d4d', '#ffd23d'];
const NEUTRAL = new THREE.Color(0xcfd8e6);
const PERSPECTIVE_DISTANCE = 3;
const SPIN_SPEED = 0.5; // radians per second

const MODES = [
  { id: 'shadow', name: 'Shadow', blurb: 'The object squashed flat into the being’s world' },
  { id: 'perspective', name: 'Perspective shadow', blurb: 'A shadow where nearer parts look bigger' },
  { id: 'slice', name: 'Slice', blurb: 'Only the part passing through the being’s world' },
];

// ---------------------------------------------------------------- renderer and scene

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 50);
camera.position.set(0, 1.4, 1.0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.25, -0.9);
controls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(1, 3, 2);
scene.add(sun);

const grid = new THREE.GridHelper(12, 24, 0x2a3345, 0x1a2030);
scene.add(grid);

// ---------------------------------------------------------------- drawing helpers

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _dir = new THREE.Vector3();
const _mid = new THREE.Vector3(), _scale = new THREE.Vector3();
const _quat = new THREE.Quaternion(), _mat = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/** A batch of coloured tubes, rebuilt every frame. Thin GL lines are too faint in a headset. */
class Tubes {
  constructor(max, radius) {
    this.radius = radius;
    this.n = 0;
    this.mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10), new THREE.MeshBasicMaterial(), max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, NEUTRAL);
    this.mesh.count = 0;
  }
  begin() { this.n = 0; }
  add(a, b, color, radius = this.radius) {
    _dir.subVectors(b, a);
    const len = _dir.length();
    if (len > 1e-7) _quat.setFromUnitVectors(UP, _dir.divideScalar(len)); else _quat.identity();
    _mid.addVectors(a, b).multiplyScalar(0.5);
    _mat.compose(_mid, _quat, _scale.set(radius, Math.max(len, 1e-7), radius));
    this.mesh.setMatrixAt(this.n, _mat);
    this.mesh.setColorAt(this.n, color);
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }
}

/** A batch of coloured balls. */
class Dots {
  constructor(max, radius) {
    this.radius = radius;
    this.n = 0;
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshBasicMaterial(), max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, NEUTRAL);
    this.mesh.count = 0;
  }
  begin() { this.n = 0; }
  add(p, color) {
    _mat.compose(p, _quat.identity(), _scale.setScalar(this.radius));
    this.mesh.setMatrixAt(this.n, _mat);
    this.mesh.setColorAt(this.n, color);
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }
}

/** Translucent filled polygons for slices, rebuilt every frame. */
class Fill {
  constructor(maxTriangles) {
    this.positions = new Float32Array(maxTriangles * 9);
    this.geometry = new THREE.BufferGeometry();
    this.attr = new THREE.BufferAttribute(this.positions, 3);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.attr);
    this.mesh = new THREE.Mesh(this.geometry, new THREE.MeshStandardMaterial({
      color: 0x9fb0c8, transparent: true, opacity: 0.38, side: THREE.DoubleSide,
      depthWrite: false, flatShading: true, roughness: 0.6,
    }));
    this.mesh.frustumCulled = false;
    this.n = 0;
  }
  begin() { this.n = 0; }
  /** points: THREE.Vector3[] already in order round the polygon. */
  polygon(points) {
    for (let i = 1; i + 1 < points.length; i++) {
      for (const p of [points[0], points[i], points[i + 1]]) {
        if (this.n + 3 > this.positions.length) return;
        this.positions[this.n++] = p.x; this.positions[this.n++] = p.y; this.positions[this.n++] = p.z;
      }
    }
  }
  end() {
    this.geometry.setDrawRange(0, this.n / 3);
    this.attr.needsUpdate = true;
  }
}

/**
 * Text on a floating panel. `lines` is an array; each line is a string or an array of
 * { text, color } spans. `height` is the height of one line of text in metres.
 */
function makeLabel(lines, { height = 0.04, color = '#e8ecf4', bg = null, weight = 600 } = {}) {
  const canvas = document.createElement('canvas');
  const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  const px = 56, lineH = px * 1.35, pad = px * 0.55;
  const font = `${weight} ${px}px system-ui, "Segoe UI", sans-serif`;

  mesh.setText = (newLines) => {
    const rows = newLines.map((l) => (typeof l === 'string' ? [{ text: l, color }] : l));
    let ctx = canvas.getContext('2d');
    ctx.font = font;
    const widths = rows.map((r) => r.reduce((w, s) => w + ctx.measureText(s.text).width, 0));
    canvas.width = Math.ceil(Math.max(...widths) + pad * 2);
    canvas.height = Math.ceil(rows.length * lineH + pad);
    ctx = canvas.getContext('2d');
    ctx.font = font;
    ctx.textBaseline = 'middle';
    if (bg) {
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect(0, 0, canvas.width, canvas.height, px * 0.4);
      ctx.fill();
    }
    rows.forEach((r, i) => {
      let x = (canvas.width - widths[i]) / 2;
      const y = pad / 2 + lineH * (i + 0.5);
      for (const s of r) {
        ctx.fillStyle = s.color || color;
        ctx.fillText(s.text, x, y);
        x += ctx.measureText(s.text).width;
      }
    });
    if (material.map) material.map.dispose();
    material.map = new THREE.CanvasTexture(canvas);
    material.map.colorSpace = THREE.SRGBColorSpace;
    material.map.anisotropy = 4;
    material.needsUpdate = true;
    const worldH = (canvas.height / lineH) * height;
    mesh.scale.set(worldH * canvas.width / canvas.height, worldH, 1);
  };
  mesh.setText(lines);
  return mesh;
}

// ---------------------------------------------------------------- stations

const interactables = []; // meshes the mouse or a controller ray can hit
const state = { mode: 0, autoSpin: true };

function v3(arr, scale, target) {
  return target.set(arr[0] * scale, (arr[1] || 0) * scale, (arr[2] || 0) * scale);
}

class Station {
  /**
   * shape: the real object. plane: [p, q] axes the knob rotates in (q is the hidden axis).
   */
  constructor({ title, subtitle, shape, plane, objectName, viewCaption, knobName, scale, viewY }) {
    this.shape = shape;
    this.plane = plane;
    this.scale = scale;
    this.angle = 0;
    this.grabbed = false;
    this.group = new THREE.Group();
    const dim = shape.dim;
    const hiddenColor = AXIS_CSS[dim - 1];

    const head = makeLabel([title], { height: 0.07 });
    head.position.set(0, 1.86, 0);
    this.group.add(head);
    const sub = makeLabel([subtitle], { height: 0.03, color: '#aab4c5', weight: 500 });
    sub.position.set(0, 1.78, 0);
    this.group.add(sub);

    // The real object, shown only where we (3D beings) are able to see it.
    if (dim < 4) {
      const cap = makeLabel([`Real object: ${objectName}`], { height: 0.028, color: '#aab4c5', weight: 500 });
      cap.position.set(0, 1.7, 0);
      this.group.add(cap);

      this.real = new THREE.Group();
      this.real.position.set(0, 1.53, 0);
      this.group.add(this.real);
      this.realTubes = new Tubes(shape.edges.length, 0.005);
      this.real.add(this.realTubes.mesh);

      // The being's world, drawn through the real object: a line for 1D, a sheet for 2D.
      if (dim === 2) {
        const line = new THREE.Mesh(
          new THREE.CylinderGeometry(0.0018, 0.0018, 0.46, 6),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
        line.rotation.z = Math.PI / 2;
        this.real.add(line);
      } else {
        const sheet = new THREE.Mesh(
          new THREE.PlaneGeometry(0.4, 0.3),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false }));
        this.real.add(sheet);
        this.real.add(new THREE.LineSegments(
          new THREE.EdgesGeometry(sheet.geometry),
          new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 })));
      }
    } else {
      const cap = makeLabel([
        `Real object: ${objectName}`,
        'You can’t see it. This is all a 3D being gets.',
      ], { height: 0.028, color: '#aab4c5', weight: 500 });
      cap.position.set(0, 1.69, 0);
      this.group.add(cap);
    }

    // What the being sees.
    const vcap = makeLabel([viewCaption], { height: 0.028, color: '#aab4c5', weight: 500 });
    vcap.position.set(0, dim < 4 ? 1.35 : 1.58, 0);
    this.group.add(vcap);

    this.view = new THREE.Group();
    this.view.position.set(0, viewY, 0);
    this.group.add(this.view);
    if (dim < 4) {
      const backing = new THREE.Mesh(
        new THREE.PlaneGeometry(0.44, dim === 2 ? 0.09 : 0.3),
        new THREE.MeshBasicMaterial({ color: 0x151a24 }));
      backing.position.z = -0.012;
      this.view.add(backing);
    }
    this.viewTubes = new Tubes(shape.edges.length, dim === 4 ? 0.006 : 0.005);
    this.viewDots = new Dots(shape.edges.length, dim === 4 ? 0.013 : 0.011);
    this.viewFill = new Fill(48);
    this.view.add(this.viewFill.mesh, this.viewTubes.mesh, this.viewDots.mesh);

    // The knob. Its ring is the colour of the axis it turns the object into.
    this.knob = new THREE.Group();
    this.knob.position.set(0, 0.92, 0.16);
    this.group.add(this.knob);
    this.dial = new THREE.Group();
    this.knob.add(this.dial);
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.058, 0.064, 0.034, 40),
      new THREE.MeshStandardMaterial({ color: 0x2b3345, roughness: 0.45, metalness: 0.3 }));
    body.rotation.x = Math.PI / 2;
    this.dial.add(body);
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.068, 0.007, 10, 48),
      new THREE.MeshBasicMaterial({ color: AXIS_COLORS[dim - 1] }));
    this.dial.add(this.ring);
    const pointer = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, 0.04, 0.008),
      new THREE.MeshBasicMaterial({ color: 0xffffff }));
    pointer.position.set(0, 0.032, 0.019);
    this.dial.add(pointer);

    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 12, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hit.userData = { kind: 'knob', station: this };
    this.knob.add(hit);
    interactables.push(hit);

    const klabel = makeLabel([[{ text: knobName, color: hiddenColor }]], { height: 0.034 });
    klabel.position.set(0, 0.8, 0.16);
    this.group.add(klabel);
  }

  setHighlight(on) {
    this.ring.scale.setScalar(on ? 1.12 : 1);
  }

  update() {
    const { shape, scale } = this;
    const dim = shape.dim;
    const mode = MODES[state.mode].id;
    const verts = rotate(shape.vertices, this.plane[0], this.plane[1], this.angle);
    this.dial.rotation.z = -this.angle;

    if (this.real) {
      this.realTubes.begin();
      for (const e of shape.edges) {
        this.realTubes.add(v3(verts[e.a], scale, _a), v3(verts[e.b], scale, _b), AXIS_COLORS[e.axis]);
      }
      this.realTubes.end();
    }

    this.viewTubes.begin();
    this.viewDots.begin();
    this.viewFill.begin();

    if (mode === 'slice') {
      const crossings = sliceCrossings(shape, verts);
      const pts = crossings.map((c) => v3(c.pos, scale, new THREE.Vector3()));
      for (const [i, j] of sliceSegments(shape, crossings)) {
        this.viewTubes.add(pts[i], pts[j], NEUTRAL, this.viewTubes.radius * 0.7);
      }
      // Each corner of the slice is where a coloured edge pokes through the being's world.
      crossings.forEach((c, i) => this.viewDots.add(pts[i], AXIS_COLORS[c.axis]));

      if (dim === 3) {
        this.fillPolygon(pts, pts.map((_, i) => i));
      } else if (dim === 4) {
        for (const facet of sliceFacets(shape, crossings)) this.fillPolygon(pts, facet);
      }
    } else {
      const d = mode === 'perspective' ? PERSPECTIVE_DISTANCE : 0;
      shape.edges.forEach((e, i) => {
        v3(project(verts[e.a], d), scale, _a);
        v3(project(verts[e.b], d), scale, _b);
        // On a line every edge lands on top of the others, so fan them out a few millimetres.
        if (dim === 2) { const lane = (i - 1.5) * 0.014; _a.y += lane; _b.y += lane; }
        this.viewTubes.add(_a, _b, AXIS_COLORS[e.axis]);
      });
    }

    this.viewTubes.end();
    this.viewDots.end();
    this.viewFill.end();
  }

  fillPolygon(pts, indices) {
    const order = orderPlanar(indices.map((i) => [pts[i].x, pts[i].y, pts[i].z]));
    if (order) this.viewFill.polygon(order.map((k) => pts[indices[k]]));
  }
}

const stations = [
  new Station({
    title: '1D being', subtitle: 'lives on a line', shape: makeBox([1, 0.5]), plane: [0, 1],
    objectName: 'a rectangle', viewCaption: 'What the 1D being sees', knobName: '2D knob',
    scale: 0.11, viewY: 1.24,
  }),
  new Station({
    title: '2D being', subtitle: 'lives on a sheet', shape: makeBox([1, 1, 1]), plane: [0, 2],
    objectName: 'a cube', viewCaption: 'What the 2D being sees', knobName: '3D knob',
    scale: 0.085, viewY: 1.16,
  }),
  new Station({
    title: 'You', subtitle: 'live in a 3D space', shape: makeBox([1, 1, 1, 1]), plane: [0, 3],
    objectName: 'a tesseract (4D cube)', viewCaption: 'What you see', knobName: '4D knob',
    scale: 0.13, viewY: 1.28,
  }),
];

// Stand the stations on an arc so each one faces the viewer at the origin.
const ARC_RADIUS = 1.05;
stations.forEach((s, i) => {
  const a = THREE.MathUtils.degToRad((i - 1) * 48);
  s.group.position.set(Math.sin(a) * ARC_RADIUS, 0, -Math.cos(a) * ARC_RADIUS);
  s.group.rotation.y = -a;
  scene.add(s.group);
});

// ---------------------------------------------------------------- legend and buttons

const legend = makeLabel([[
  { text: '■ length  ', color: AXIS_CSS[0] },
  { text: '■ height  ', color: AXIS_CSS[1] },
  { text: '■ depth  ', color: AXIS_CSS[2] },
  { text: '■ 4th dimension', color: AXIS_CSS[3] },
]], { height: 0.04, bg: 'rgba(21,26,36,0.9)' });
legend.position.set(0, 2.06, -ARC_RADIUS);
scene.add(legend);

const panel = new THREE.Group();
panel.position.set(0, 0.62, -0.62);
panel.rotation.x = -0.6;
scene.add(panel);

function makeButton(x, onClick) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.07, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x27304a, roughness: 0.6 }));
  mesh.position.set(x, 0, 0);
  mesh.userData = { kind: 'button', onClick };
  const label = makeLabel(['…'], { height: 0.026 });
  label.position.z = 0.0115;
  mesh.add(label);
  mesh.label = label;
  panel.add(mesh);
  interactables.push(mesh);
  return mesh;
}

const modeButton = makeButton(-0.17, () => setMode((state.mode + 1) % MODES.length));
const spinButton = makeButton(0.17, () => setAutoSpin(!state.autoSpin));
const blurb = makeLabel(['…'], { height: 0.024, color: '#aab4c5', weight: 500 });
blurb.position.set(0, 0.075, 0);
panel.add(blurb);

function setMode(i) {
  state.mode = i;
  modeButton.label.setText([`View: ${MODES[i].name}`]);
  blurb.setText([MODES[i].blurb]);
}
function setAutoSpin(on) {
  state.autoSpin = on;
  spinButton.label.setText([`Auto-spin: ${on ? 'on' : 'off'}`]);
}
setMode(0);
setAutoSpin(true);

// ---------------------------------------------------------------- mouse and keyboard

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let drag = null;

function pick(event) {
  pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(interactables, false)[0];
  return hit ? hit.object.userData : null;
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  const target = pick(event);
  if (!target) return;
  if (target.kind === 'button') { target.onClick(); return; }
  drag = { station: target.station, x: event.clientX };
  drag.station.grabbed = true;
  controls.enabled = false;
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!drag) return;
  drag.station.angle += (event.clientX - drag.x) * 0.012;
  drag.x = event.clientX;
});
function endDrag() {
  if (!drag) return;
  drag.station.grabbed = false;
  drag = null;
  controls.enabled = true;
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyM') setMode((state.mode + 1) % MODES.length);
  if (event.code === 'Space') { setAutoSpin(!state.autoSpin); event.preventDefault(); }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- VR controllers

const xrControllers = [];
const modelFactory = new XRControllerModelFactory();
const _rot = new THREE.Matrix4();
const _dq = new THREE.Quaternion();

function controllerTarget(c) {
  _rot.identity().extractRotation(c.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_rot);
  const hit = raycaster.intersectObjects(interactables, false)[0];
  return hit || null;
}

function onPress(c, kind) {
  const hit = c.userData.hover;
  if (!hit) return;
  const target = hit.object.userData;
  if (target.kind === 'button') {
    if (kind === 'select') target.onClick();
    return;
  }
  if (c.userData.grab) return;
  c.userData.grab = { station: target.station, kind, prev: c.quaternion.clone() };
  target.station.grabbed = true;
  try { c.userData.source?.gamepad?.hapticActuators?.[0]?.pulse(0.5, 40); } catch { /* no haptics */ }
}

function onRelease(c, kind) {
  const grab = c.userData.grab;
  if (!grab || grab.kind !== kind) return;
  grab.station.grabbed = false;
  c.userData.grab = null;
}

for (let i = 0; i < 2; i++) {
  const c = renderer.xr.getController(i);
  c.userData = { source: null, hover: null, grab: null, buttons: [] };
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x8899bb, transparent: true, opacity: 0.6 }));
  ray.scale.z = 2;
  c.add(ray);
  c.userData.ray = ray;
  c.addEventListener('connected', (e) => { c.userData.source = e.data; });
  c.addEventListener('disconnected', () => { onRelease(c, c.userData.grab?.kind); c.userData.source = null; });
  c.addEventListener('selectstart', () => onPress(c, 'select'));
  c.addEventListener('selectend', () => onRelease(c, 'select'));
  c.addEventListener('squeezestart', () => onPress(c, 'squeeze'));
  c.addEventListener('squeezeend', () => onRelease(c, 'squeeze'));
  scene.add(c);
  xrControllers.push(c);

  const grip = renderer.xr.getControllerGrip(i);
  grip.add(modelFactory.createControllerModel(grip));
  scene.add(grip);
}

const _gaze = new THREE.Vector3(), _head = new THREE.Vector3(), _to = new THREE.Vector3();

/** The station the viewer is looking at, used when a thumbstick is pushed without pointing. */
function gazedStation() {
  camera.getWorldDirection(_gaze);
  camera.getWorldPosition(_head);
  let best = stations[1], bestDot = -Infinity;
  for (const s of stations) {
    _to.copy(s.group.position).setY(_head.y).sub(_head).normalize();
    const d = _to.dot(_gaze);
    if (d > bestDot) { bestDot = d; best = s; }
  }
  return best;
}

function updateControllers(dt) {
  for (const c of xrControllers) {
    if (!c.visible) continue;
    const data = c.userData;
    data.hover = controllerTarget(c);
    data.ray.scale.z = data.hover ? data.hover.distance : 2;

    // Twisting the wrist while holding trigger or grip turns the knob by the same amount.
    if (data.grab) {
      _dq.copy(data.grab.prev).invert().multiply(c.quaternion);
      let twist = 2 * Math.atan2(_dq.z, _dq.w);
      if (twist > Math.PI) twist -= 2 * Math.PI;
      if (twist < -Math.PI) twist += 2 * Math.PI;
      data.grab.station.angle -= twist;
      data.grab.prev.copy(c.quaternion);
    }

    const pad = data.source?.gamepad;
    if (!pad) continue;
    const stick = pad.axes.length >= 4 ? pad.axes[2] : 0;
    if (Math.abs(stick) > 0.15 && !data.grab) {
      const hovered = data.hover?.object.userData;
      const station = hovered?.kind === 'knob' ? hovered.station : gazedStation();
      station.angle += stick * dt * 1.6;
      station.nudged = true;
    }
    // A / X cycles the view, B / Y toggles auto-spin.
    const pressed = (n) => !!pad.buttons[n]?.pressed;
    if (pressed(4) && !data.buttons[4]) setMode((state.mode + 1) % MODES.length);
    if (pressed(5) && !data.buttons[5]) setAutoSpin(!state.autoSpin);
    data.buttons[4] = pressed(4);
    data.buttons[5] = pressed(5);
  }
}

// ---------------------------------------------------------------- main loop

const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const inVR = renderer.xr.isPresenting;

  if (inVR) updateControllers(dt);
  else controls.update();

  for (const s of stations) {
    if (state.autoSpin && !s.grabbed && !s.nudged) s.angle += SPIN_SPEED * dt;
    s.nudged = false;
    const hovered = xrControllers.some((c) => c.userData.hover?.object.userData.station === s);
    s.setHighlight(s.grabbed || (inVR && hovered));
    s.update();
  }

  renderer.render(scene, camera);
});

// Handy for poking at things from the browser console.
window.app = { stations, state, setMode, setAutoSpin, MODES };
