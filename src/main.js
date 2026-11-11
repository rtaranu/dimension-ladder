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

// The floor grid fades into fog, and a shell of stars gives the dark some depth.
scene.fog = new THREE.Fog(0x0b0d12, 2.5, 10);
scene.add(new THREE.GridHelper(40, 80, 0x34405a, 0x1c2334));
{
  const count = 1800, pos = new Float32Array(count * 3), p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    p.randomDirection().multiplyScalar(22 + Math.random() * 18);
    pos.set([p.x, p.y, p.z], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xa9bcff, size: 0.11, sizeAttenuation: true, transparent: true, opacity: 0.75, fog: false,
  })));
}

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
  add(p, color, radius = this.radius) {
    _mat.compose(p, _quat.identity(), _scale.setScalar(radius));
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

const GLASS_N = 4; // each pane is drawn as a 4x4 grid so perspective shadows stay exact

/**
 * Edge-lit glass. Each pane glows the colour of the edge it meets along that border and thins
 * to a faint mix in the middle. Blending is additive, so panes stack up without sorting and
 * overlapping glass gets brighter, which is what makes the layers readable.
 */
const glassMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */`
    attribute vec3 colorA;
    attribute vec3 colorB;
    varying vec2 vUv;
    varying vec3 vA;
    varying vec3 vB;
    varying vec3 vN;
    varying vec3 vP;
    void main() {
      vUv = uv; vA = colorA; vB = colorB;
      vN = normalMatrix * normal;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vP = mv.xyz;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    varying vec3 vA;
    varying vec3 vB;
    varying vec3 vN;
    varying vec3 vP;
    void main() {
      float nearU = 1.0 - min(vUv.x, 1.0 - vUv.x) * 2.0; // 1 on the borders that run along axis B
      float nearV = 1.0 - min(vUv.y, 1.0 - vUv.y) * 2.0; // 1 on the borders that run along axis A
      float len = length(vN);
      float facing = len > 1e-6 ? abs(dot(vN / len, normalize(vP))) : 1.0;
      float rim = pow(1.0 - facing, 2.0); // glass seen edge-on catches more light
      vec3 body = (vA + vB) * 0.5;
      vec3 col = body * (0.085 + 0.3 * rim)
               + vA * pow(nearV, 5.0) * 0.42
               + vB * pow(nearU, 5.0) * 0.42;
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
});

class Glass {
  constructor(shape) {
    this.shape = shape;
    const N = GLASS_N, vertsPerFace = N * N * 6, total = shape.faces.length * vertsPerFace;
    this.positions = new Float32Array(total * 3);
    this.normals = new Float32Array(total * 3);
    const uvs = new Float32Array(total * 2);
    const colorA = new Float32Array(total * 3), colorB = new Float32Array(total * 3);
    let k = 0;
    for (const face of shape.faces) {
      const A = AXIS_COLORS[face.axes[0]], B = AXIS_COLORS[face.axes[1]];
      for (let t = 0; t < N; t++) for (let s = 0; s < N; s++) {
        for (const [ds, dt] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]) {
          uvs[k * 2] = (s + ds) / N; uvs[k * 2 + 1] = (t + dt) / N;
          colorA.set([A.r, A.g, A.b], k * 3);
          colorB.set([B.r, B.g, B.b], k * 3);
          k++;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.normAttr = new THREE.BufferAttribute(this.normals, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', this.normAttr);
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('colorA', new THREE.BufferAttribute(colorA, 3));
    geo.setAttribute('colorB', new THREE.BufferAttribute(colorB, 3));
    this.mesh = new THREE.Mesh(geo, glassMaterial);
    this.mesh.frustumCulled = false;
    this.grid = new Float32Array((N + 1) * (N + 1) * 3);
  }

  /**
   * verts: the rotated n-D vertices. coords: how many leading coordinates get drawn
   * (all of them for the real object, one fewer for a shadow). distance: perspective eye
   * distance along the hidden axis, or 0 for a flat shadow.
   */
  update(verts, coords, distance, scale) {
    const N = GLASS_N, W = N + 1, dim = this.shape.dim, g = this.grid;
    const pos = this.positions, nor = this.normals;
    let o = 0;
    for (const face of this.shape.faces) {
      const c0 = verts[face.corners[0]], c1 = verts[face.corners[1]];
      const c2 = verts[face.corners[2]], c3 = verts[face.corners[3]];
      for (let t = 0; t <= N; t++) for (let s = 0; s <= N; s++) {
        const u = s / N, v = t / N;
        const w0 = (1 - u) * (1 - v), w1 = u * (1 - v), w2 = u * v, w3 = (1 - u) * v;
        let k = scale;
        if (coords < dim && distance > 0) {
          const hidden = c0[dim - 1] * w0 + c1[dim - 1] * w1 + c2[dim - 1] * w2 + c3[dim - 1] * w3;
          k *= (distance - 1) / (distance - hidden);
        }
        const gi = (t * W + s) * 3;
        for (let a = 0; a < 3; a++) {
          g[gi + a] = a < coords ? (c0[a] * w0 + c1[a] * w1 + c2[a] * w2 + c3[a] * w3) * k : 0;
        }
      }
      // A projected pane is still flat, so one normal serves the whole face.
      const i0 = 0, i1 = N * 3, i3 = N * W * 3;
      const ax = g[i1] - g[i0], ay = g[i1 + 1] - g[i0 + 1], az = g[i1 + 2] - g[i0 + 2];
      const bx = g[i3] - g[i0], by = g[i3 + 1] - g[i0 + 1], bz = g[i3 + 2] - g[i0 + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const nl = Math.hypot(nx, ny, nz);
      if (nl > 1e-10) { nx /= nl; ny /= nl; nz /= nl; } else { nx = ny = nz = 0; }

      for (let t = 0; t < N; t++) for (let s = 0; s < N; s++) {
        const a = (t * W + s) * 3, b = a + 3, d = a + W * 3, c = d + 3;
        for (const i of [a, b, c, a, c, d]) {
          pos[o] = g[i]; pos[o + 1] = g[i + 1]; pos[o + 2] = g[i + 2];
          nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
          o += 3;
        }
      }
    }
    this.posAttr.needsUpdate = true;
    this.normAttr.needsUpdate = true;
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
const AXIS_WORDS = ['length', 'height', 'depth', '4th'];
const WHITE = new THREE.Color(0xffffff);
const _mix = new THREE.Color();

function v3(arr, scale, target) {
  return target.set(arr[0] * scale, (arr[1] || 0) * scale, (arr[2] || 0) * scale);
}

/**
 * One knob turns the object in one plane: it trades a direction the being can see (the
 * pointer's colour) for the hidden one (the ring's colour). A being in n dimensions gets n
 * knobs, because there are n ways to lean into the next dimension up.
 */
class Knob {
  constructor(station, index, plane, x) {
    this.station = station;
    this.plane = plane;
    this.angle = 0;
    this.speed = SPIN_SPEED * [1, 0.618, 0.382][index];
    this.grabbed = false;
    this.nudged = false;

    this.group = new THREE.Group();
    this.group.position.set(x, 0.93, 0.16);
    this.dial = new THREE.Group();
    this.group.add(this.dial);

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.056, 0.034, 40),
      new THREE.MeshStandardMaterial({ color: 0x2b3345, roughness: 0.45, metalness: 0.3 }));
    body.rotation.x = Math.PI / 2;
    this.dial.add(body);
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.06, 0.0065, 10, 48),
      new THREE.MeshBasicMaterial({ color: AXIS_COLORS[plane[1]] }));
    this.dial.add(this.ring);
    const pointer = new THREE.Mesh(
      new THREE.BoxGeometry(0.013, 0.036, 0.008),
      new THREE.MeshBasicMaterial({ color: AXIS_COLORS[plane[0]] }));
    pointer.position.set(0, 0.028, 0.019);
    this.dial.add(pointer);

    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 12, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hit.userData = { kind: 'knob', knob: this };
    this.group.add(hit);
    interactables.push(hit);

    const label = makeLabel([[
      { text: AXIS_WORDS[plane[0]], color: AXIS_CSS[plane[0]] },
      { text: ' ↔ ', color: '#7f8aa0' },
      { text: AXIS_WORDS[plane[1]], color: AXIS_CSS[plane[1]] },
    ]], { height: 0.02 });
    label.position.set(0, -0.092, 0);
    this.group.add(label);
  }

  setHighlight(on) {
    this.ring.scale.setScalar(on ? 1.14 : 1);
  }
}

class Station {
  /** shape: the real object. Its last axis is the one this being cannot see. */
  constructor({ title, subtitle, shape, objectName, viewCaption, knobsName, scale, viewY }) {
    this.shape = shape;
    this.scale = scale;
    this.group = new THREE.Group();
    const dim = shape.dim;

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
      this.realTubes = new Tubes(shape.edges.length, 0.0045);
      this.realDots = new Dots(shape.vertices.length, 0.007);
      this.realGlass = new Glass(shape);
      this.real.add(this.realGlass.mesh, this.realTubes.mesh, this.realDots.mesh);

      // The being's world, drawn through the real object: a line for 1D, a sheet for 2D.
      if (dim === 2) {
        const line = new THREE.Mesh(
          new THREE.CylinderGeometry(0.0018, 0.0018, 0.46, 6),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
        line.rotation.z = Math.PI / 2;
        this.real.add(line);
      } else {
        const sheet = new THREE.Mesh(
          new THREE.PlaneGeometry(0.42, 0.29),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }));
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
    vcap.position.set(0, dim < 4 ? 1.33 : 1.6, 0);
    this.group.add(vcap);

    this.view = new THREE.Group();
    this.view.position.set(0, viewY, 0);
    this.group.add(this.view);
    if (dim < 4) {
      const backing = new THREE.Mesh(
        new THREE.PlaneGeometry(0.44, dim === 2 ? 0.09 : 0.32),
        new THREE.MeshBasicMaterial({ color: 0x10141c }));
      backing.position.z = -0.012;
      this.view.add(backing);
    }
    this.viewTubes = new Tubes(shape.edges.length, dim === 4 ? 0.0055 : 0.0045);
    this.viewDots = new Dots(shape.edges.length, dim === 4 ? 0.012 : 0.01);
    this.viewFill = new Fill(48);
    this.view.add(this.viewFill.mesh, this.viewTubes.mesh, this.viewDots.mesh);
    if (dim > 2) {
      this.viewGlass = new Glass(shape);
      this.view.add(this.viewGlass.mesh);
    } else {
      // On a line the pane's shadow is just the stretch it covers, so draw that as a band.
      this.band = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        color: _mix.copy(AXIS_COLORS[0]).lerp(AXIS_COLORS[1], 0.5).clone(),
        transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.band.position.z = -0.006;
      this.view.add(this.band);
    }

    // One knob for each visible axis that can be traded for the hidden one.
    const hidden = dim - 1, spacing = 0.165;
    this.knobs = [];
    for (let i = 0; i < hidden; i++) {
      const knob = new Knob(this, i, [i, hidden], (i - (hidden - 1) / 2) * spacing);
      this.knobs.push(knob);
      this.group.add(knob.group);
    }
    const klabel = makeLabel([knobsName], { height: 0.03, color: AXIS_CSS[hidden] });
    klabel.position.set(0, 0.775, 0.16);
    this.group.add(klabel);
  }

  update() {
    const { shape, scale } = this;
    const dim = shape.dim;
    const mode = MODES[state.mode].id;
    let verts = shape.vertices;
    for (const k of this.knobs) {
      verts = rotate(verts, k.plane[0], k.plane[1], k.angle);
      k.dial.rotation.z = -k.angle;
    }

    if (this.real) {
      this.realTubes.begin();
      for (const e of shape.edges) {
        this.realTubes.add(v3(verts[e.a], scale, _a), v3(verts[e.b], scale, _b), AXIS_COLORS[e.axis]);
      }
      this.realTubes.end();
      this.realDots.begin();
      for (const v of verts) this.realDots.add(v3(v, scale, _a), WHITE);
      this.realDots.end();
      this.realGlass.update(verts, dim, 0, scale);
    }

    this.viewTubes.begin();
    this.viewDots.begin();
    this.viewFill.begin();
    const slicing = mode === 'slice';
    if (this.viewGlass) this.viewGlass.mesh.visible = !slicing;
    if (this.band) this.band.visible = !slicing;

    if (slicing) {
      const crossings = sliceCrossings(shape, verts);
      const pts = crossings.map((c) => v3(c.pos, scale, new THREE.Vector3()));
      // Each line of the slice is a glass pane cut through; it joins the two edges it runs between.
      for (const [i, j] of sliceSegments(shape, crossings)) {
        _mix.copy(AXIS_COLORS[crossings[i].axis]).lerp(AXIS_COLORS[crossings[j].axis], 0.5).lerp(WHITE, 0.25);
        this.viewTubes.add(pts[i], pts[j], _mix, this.viewTubes.radius * 0.7);
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
      const shadow = verts.map((v) => v3(project(v, d), scale, new THREE.Vector3()));
      shape.edges.forEach((e, i) => {
        _a.copy(shadow[e.a]);
        _b.copy(shadow[e.b]);
        // On a line every edge lands on top of the others, so fan them out a few millimetres.
        if (dim === 2) { const lane = (i - 1.5) * 0.014; _a.y += lane; _b.y += lane; }
        this.viewTubes.add(_a, _b, AXIS_COLORS[e.axis]);
      });
      if (this.viewGlass) {
        for (const p of shadow) this.viewDots.add(p, WHITE, this.viewDots.radius * 0.62);
        this.viewGlass.update(verts, dim - 1, d, scale);
      } else {
        let lo = Infinity, hi = -Infinity;
        for (const p of shadow) { lo = Math.min(lo, p.x); hi = Math.max(hi, p.x); }
        this.band.position.x = (lo + hi) / 2;
        this.band.scale.set(hi - lo, 0.074, 1);
      }
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
    title: '1D being', subtitle: 'lives on a line', shape: makeBox([1, 0.5]),
    objectName: 'a rectangle', viewCaption: 'What the 1D being sees', knobsName: '2D knob',
    scale: 0.11, viewY: 1.23,
  }),
  new Station({
    title: '2D being', subtitle: 'lives on a sheet', shape: makeBox([1, 1, 1]),
    objectName: 'a cube', viewCaption: 'What the 2D being sees', knobsName: '3D knobs',
    scale: 0.075, viewY: 1.15,
  }),
  new Station({
    title: 'You', subtitle: 'live in a 3D space', shape: makeBox([1, 1, 1, 1]),
    objectName: 'a tesseract (4D cube)', viewCaption: 'What you see', knobsName: '4D knobs',
    scale: 0.115, viewY: 1.29,
  }),
];
const knobs = stations.flatMap((s) => s.knobs);

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
    new THREE.BoxGeometry(0.27, 0.07, 0.02),
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

const modeButton = makeButton(-0.29, () => setMode((state.mode + 1) % MODES.length));
const spinButton = makeButton(0, () => setAutoSpin(!state.autoSpin));
const resetButton = makeButton(0.29, () => resetKnobs());
resetButton.label.setText(['Reset knobs']);
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
/** Square everything up and stop, so one knob can be explored at a time. */
function resetKnobs() {
  for (const k of knobs) k.angle = 0;
  setAutoSpin(false);
}
setMode(0);
setAutoSpin(true);

// ---------------------------------------------------------------- mouse and keyboard

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let drag = null;
let mouseHover = null;

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
  drag = { knob: target.knob, x: event.clientX };
  drag.knob.grabbed = true;
  controls.enabled = false;
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (drag) {
    drag.knob.angle += (event.clientX - drag.x) * 0.012;
    drag.x = event.clientX;
    return;
  }
  const target = pick(event);
  mouseHover = target?.kind === 'knob' ? target.knob : null;
  renderer.domElement.style.cursor = target ? (target.kind === 'knob' ? 'grab' : 'pointer') : '';
});
function endDrag() {
  if (!drag) return;
  drag.knob.grabbed = false;
  drag = null;
  controls.enabled = true;
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyM') setMode((state.mode + 1) % MODES.length);
  if (event.code === 'KeyR') resetKnobs();
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

function pulse(c, strength, ms) {
  try { c.userData.source?.gamepad?.hapticActuators?.[0]?.pulse(strength, ms); } catch { /* no haptics */ }
}

function onPress(c, kind) {
  const hit = c.userData.hover;
  if (!hit) return;
  const target = hit.object.userData;
  if (target.kind === 'button') {
    if (kind === 'select') { target.onClick(); pulse(c, 0.6, 30); }
    return;
  }
  if (c.userData.grab) return;
  c.userData.grab = { knob: target.knob, kind, prev: c.quaternion.clone(), turned: 0 };
  target.knob.grabbed = true;
  pulse(c, 0.5, 40);
}

function onRelease(c, kind) {
  const grab = c.userData.grab;
  if (!grab || grab.kind !== kind) return;
  grab.knob.grabbed = false;
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

const DETENT = Math.PI / 12; // a haptic tick every 15 degrees, like a real dial

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
      const before = Math.floor(data.grab.turned / DETENT);
      data.grab.turned -= twist;
      data.grab.knob.angle -= twist;
      data.grab.prev.copy(c.quaternion);
      if (Math.floor(data.grab.turned / DETENT) !== before) pulse(c, 0.25, 12);
    }

    const pad = data.source?.gamepad;
    if (!pad) continue;
    const stick = pad.axes.length >= 4 ? pad.axes[2] : 0;
    if (Math.abs(stick) > 0.15 && !data.grab) {
      const hovered = data.hover?.object.userData;
      const knob = hovered?.kind === 'knob' ? hovered.knob : gazedStation().knobs[0];
      knob.angle += stick * dt * 1.6;
      knob.nudged = true;
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

  for (const k of knobs) {
    if (state.autoSpin && !k.grabbed && !k.nudged) k.angle += k.speed * dt;
    k.nudged = false;
    const pointedAt = inVR
      ? xrControllers.some((c) => c.userData.hover?.object.userData.knob === k)
      : mouseHover === k;
    k.setHighlight(k.grabbed || pointedAt);
  }
  for (const s of stations) s.update();

  renderer.render(scene, camera);
});

// Handy for poking at things from the browser console.
window.app = { stations, knobs, state, setMode, setAutoSpin, resetKnobs, MODES };
