import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { makeBox, makeSimplex, makeCross, makeSphere, rotate, project, shadowRadius, sliceCrossings, sliceSegments, sliceFacets, orderPlanar } from './math4d.js?v=5';

// Shown on the page and in the headset, so it is obvious which version is running.
// Bump this (and the ?v= above when math4d.js changes) with every release.
const BUILD = 'build 5';

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

// A solid floor with a grid drawn on it; both fade into the fog at the horizon.
scene.fog = new THREE.Fog(0x0b0d12, 3, 14);
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(30, 64),
  new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.95, metalness: 0 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(60, 120, 0x6477a6, 0x3b4868);
grid.position.y = 0.003;
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

// How hazy one pane is: the fraction of the way to its full tint that it pushes whatever is
// behind it. Panes combine as 1 - (1 - haze)^n, the way real layers of frosted glass do: two
// panes are nearly twice as hazy as one, and a deep stack approaches the full tint without
// ever blowing out. The result does not depend on the order the panes are drawn in.
const HAZE_PER_PANE = 0.3;
const HAZE_BLEND = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneMinusDstColorFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.ZeroFactor,
  blendDstAlpha: THREE.OneFactor,
};

/**
 * Glass panes. Each pane is one uniform layer of haze; only its tint varies, drifting from a
 * mix in the middle towards the colour of whichever edge is nearest. Colours are written
 * straight to the screen with no colour-space curve, so every pane has exactly the same
 * strength wherever it sits in a stack.
 */
const glassMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */`
    attribute vec3 tint;
    varying vec3 vTint;
    void main() {
      vTint = tint;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vTint;
    void main() {
      gl_FragColor = vec4(vTint * ${HAZE_PER_PANE.toFixed(3)}, 1.0);
    }`,
  ...HAZE_BLEND,
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/** A plain material that hazes by the same amount as one glass pane. `screen` is an on-screen colour. */
function hazeMaterial(screen) {
  return new THREE.MeshBasicMaterial({
    color: screen.clone().multiplyScalar(HAZE_PER_PANE).convertSRGBToLinear(),
    transparent: true, ...HAZE_BLEND, depthWrite: false, side: THREE.DoubleSide,
  });
}
const ROUND_TINT = new THREE.Color().setRGB(0.66, 0.76, 0.95); // on-screen tint of a ball's skin

class Glass {
  /** screenColors: one on-screen colour per edge of the shape. */
  constructor(shape, screenColors) {
    this.shape = shape;
    const triangles = shape.faces.reduce((n, f) => n + f.corners.length, 0);
    this.positions = new Float32Array(triangles * 9);
    const tints = new Float32Array(triangles * 9);
    let k = 0;
    const put = (c) => { tints[k++] = c.r; tints[k++] = c.g; tints[k++] = c.b; };
    const centre = new THREE.Color();
    // Each face is a fan of triangles from its middle; every triangle owns one edge.
    for (const face of shape.faces) {
      centre.setRGB(0, 0, 0);
      for (const e of face.edges) {
        centre.r += screenColors[e].r / face.edges.length;
        centre.g += screenColors[e].g / face.edges.length;
        centre.b += screenColors[e].b / face.edges.length;
      }
      for (const e of face.edges) { put(centre); put(screenColors[e]); put(screenColors[e]); }
    }
    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('tint', new THREE.BufferAttribute(tints, 3));
    this.mesh = new THREE.Mesh(this.geometry, glassMaterial);
    this.mesh.frustumCulled = false;
    this.corner = new Float32Array(8 * 3);
    this.mid = new Array(shape.dim).fill(0);
  }

  /**
   * verts: the rotated n-D vertices. coords: how many leading coordinates get drawn
   * (all of them for the real object, one fewer for a shadow). distance: perspective eye
   * distance along the hidden axis, or 0 for a flat shadow.
   */
  update(verts, coords, distance, scale) {
    const dim = this.shape.dim, pos = this.positions, corner = this.corner, mid = this.mid;
    const perspective = coords < dim && distance > 0;
    let o = 0;
    for (const face of this.shape.faces) {
      const n = face.corners.length;
      mid.fill(0);
      for (let i = 0; i < n; i++) {
        const v = verts[face.corners[i]];
        const k = perspective ? scale * (distance - 1) / (distance - v[dim - 1]) : scale;
        for (let a = 0; a < 3; a++) corner[i * 3 + a] = a < coords ? v[a] * k : 0;
        for (let a = 0; a < dim; a++) mid[a] += v[a] / n;
      }
      const km = perspective ? scale * (distance - 1) / (distance - mid[dim - 1]) : scale;
      const mx = mid[0] * km, my = coords > 1 ? mid[1] * km : 0, mz = coords > 2 ? mid[2] * km : 0;
      for (let i = 0; i < n; i++) {
        const a = i * 3, b = ((i + 1) % n) * 3;
        pos[o++] = mx; pos[o++] = my; pos[o++] = mz;
        pos[o++] = corner[a]; pos[o++] = corner[a + 1]; pos[o++] = corner[a + 2];
        pos[o++] = corner[b]; pos[o++] = corner[b + 1]; pos[o++] = corner[b + 2];
      }
    }
    this.posAttr.needsUpdate = true;
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
const state = { mode: 0, autoSpin: true, family: 0 };
const AXIS_WORDS = ['length', 'height', 'depth', '4th'];
const WHITE = new THREE.Color(0xffffff);
const _mix = new THREE.Color();

// Each family is the "same" object at every rung of the ladder.
const FAMILIES = [
  {
    label: 'Box',
    make: (dim) => makeBox(dim === 2 ? [1, 0.5] : new Array(dim).fill(1)),
    names: ['a rectangle', 'a cube', 'a tesseract (4D cube)'],
  },
  {
    label: 'Pyramid',
    make: (dim) => makeSimplex(dim),
    names: ['a triangle', 'a regular tetrahedron', 'a 5-cell (4D tetrahedron)'],
  },
  {
    label: 'Diamond',
    make: (dim) => makeCross(dim),
    names: ['a diamond', 'an octahedron', 'a 16-cell (4D octahedron)'],
  },
  {
    label: 'Sphere',
    make: (dim) => makeSphere(dim),
    names: ['a circle', 'a sphere', 'a hypersphere (4D sphere)'],
  },
];

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
  /** dim: the dimension of the real object. Its last axis is the one this being cannot see. */
  constructor({ dim, title, subtitle, viewCaption, knobsName, scale, viewY }) {
    this.dim = dim;
    this.scale = scale;
    this.shape = null;
    this.dynamic = []; // per-shape drawables, rebuilt whenever the shape changes
    this.group = new THREE.Group();

    const head = makeLabel([title], { height: 0.07 });
    head.position.set(0, 1.86, 0);
    this.group.add(head);
    const sub = makeLabel([subtitle], { height: 0.03, color: '#aab4c5', weight: 500 });
    sub.position.set(0, 1.78, 0);
    this.group.add(sub);

    this.objectCaption = makeLabel(['…'], { height: 0.028, color: '#aab4c5', weight: 500 });
    this.objectCaption.position.set(0, dim < 4 ? 1.7 : 1.69, 0);
    this.group.add(this.objectCaption);

    // The real object, shown only where we (3D beings) are able to see it.
    if (dim < 4) {
      this.real = new THREE.Group();
      this.real.position.set(0, 1.53, 0);
      this.group.add(this.real);

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
    if (dim === 2) {
      // On a line a pane's shadow is just the stretch it covers, so draw that as a band.
      const tint = AXIS_COLORS[0].clone().convertLinearToSRGB().lerp(AXIS_COLORS[1].clone().convertLinearToSRGB(), 0.5);
      this.band = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), hazeMaterial(tint));
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

  /** Add a per-shape drawable, remembered so it can be thrown away on the next shape change. */
  attach(parent, mesh) {
    parent.add(mesh);
    this.dynamic.push(mesh);
    return mesh;
  }

  setShape(shape, objectName) {
    for (const mesh of this.dynamic) {
      mesh.parent.remove(mesh);
      mesh.geometry.dispose();
      if (mesh.material !== glassMaterial) mesh.material.dispose();
      if (mesh.isInstancedMesh) mesh.dispose();
    }
    this.dynamic = [];
    this.shape = shape;
    const { dim, scale } = this;
    const round = shape.round;

    this.objectCaption.setText(dim < 4
      ? [`Real object: ${objectName}`]
      : [`Real object: ${objectName}`, 'You can’t see it. This is all a 3D being gets.']);

    // An edge's colour is a blend of the axis colours, by how much it runs along each axis.
    this.edgeColors = shape.edges.map((e) => {
      const c = new THREE.Color(0, 0, 0);
      e.weights.forEach((w, i) => { c.r += AXIS_COLORS[i].r * w; c.g += AXIS_COLORS[i].g * w; c.b += AXIS_COLORS[i].b * w; });
      return c;
    });
    const screenColors = this.edgeColors.map((c) => c.clone().convertLinearToSRGB());
    const thin = round ? 0.72 : 1; // the many short pieces of a circle read better drawn finer

    this.realTubes = this.realDots = this.realGlass = null;
    if (this.real) {
      if (round) {
        const skin = dim === 2
          ? new THREE.CircleGeometry(round.radius * scale, 64)
          : new THREE.SphereGeometry(round.radius * scale, 40, 24);
        this.attach(this.real, new THREE.Mesh(skin, hazeMaterial(ROUND_TINT)));
      } else {
        this.realGlass = new Glass(shape, screenColors);
        this.attach(this.real, this.realGlass.mesh);
        this.realDots = new Dots(shape.vertices.length, 0.007);
        this.attach(this.real, this.realDots.mesh);
      }
      this.realTubes = new Tubes(shape.edges.length, 0.0045 * thin);
      this.attach(this.real, this.realTubes.mesh);
    }

    this.viewTubes = new Tubes(shape.edges.length + 1, (dim === 4 ? 0.0055 : 0.0045) * thin);
    this.viewDots = new Dots(shape.edges.length + shape.vertices.length, dim === 4 ? 0.012 : 0.01);
    this.viewFill = new Fill(64);
    this.attach(this.view, this.viewFill.mesh);
    this.attach(this.view, this.viewTubes.mesh);
    this.attach(this.view, this.viewDots.mesh);

    this.viewGlass = this.viewRound = null;
    if (dim > 2 && round) {
      // A ball's shadow, and its slice, is a smaller-dimensional ball: a disc for the 2D being, a ball for us.
      const skin = dim === 3 ? new THREE.CircleGeometry(1, 64) : new THREE.SphereGeometry(1, 40, 24);
      this.viewRound = this.attach(this.view, new THREE.Mesh(skin, hazeMaterial(ROUND_TINT)));
    } else if (dim > 2) {
      this.viewGlass = new Glass(shape, screenColors);
      this.attach(this.view, this.viewGlass.mesh);
    }
  }

  update() {
    const { shape, scale, dim } = this;
    const round = shape.round;
    const mode = MODES[state.mode].id;
    let verts = shape.vertices;
    for (const k of this.knobs) {
      verts = rotate(verts, k.plane[0], k.plane[1], k.angle);
      k.dial.rotation.z = -k.angle;
    }

    if (this.real) {
      this.realTubes.begin();
      shape.edges.forEach((e, i) => {
        this.realTubes.add(v3(verts[e.a], scale, _a), v3(verts[e.b], scale, _b), this.edgeColors[i]);
      });
      this.realTubes.end();
      if (this.realDots) {
        this.realDots.begin();
        for (const v of verts) this.realDots.add(v3(v, scale, _a), WHITE);
        this.realDots.end();
      }
      if (this.realGlass) this.realGlass.update(verts, dim, 0, scale);
    }

    this.viewTubes.begin();
    this.viewDots.begin();
    this.viewFill.begin();
    const slicing = mode === 'slice';
    const d = mode === 'perspective' ? PERSPECTIVE_DISTANCE : 0;
    if (this.viewGlass) this.viewGlass.mesh.visible = !slicing;
    if (this.band) this.band.visible = !slicing;
    if (this.viewRound) this.viewRound.scale.setScalar(scale * (slicing ? round.radius : shadowRadius(round.radius, d)));

    if (slicing) {
      const crossings = sliceCrossings(shape, verts);
      const pts = crossings.map((c) => v3(c.pos, scale, new THREE.Vector3()));
      // Each line of the slice is a glass pane cut through; it joins the two edges it runs between.
      for (const [i, j] of sliceSegments(shape, crossings)) {
        _mix.copy(this.edgeColors[crossings[i].edge]).lerp(this.edgeColors[crossings[j].edge], 0.5).lerp(WHITE, 0.25);
        this.viewTubes.add(pts[i], pts[j], _mix, this.viewTubes.radius * 0.7);
      }
      // Each corner of the slice is where a coloured edge pokes through the being's world.
      crossings.forEach((c, i) => this.viewDots.add(pts[i], this.edgeColors[c.edge]));
      for (const facet of sliceFacets(shape, crossings)) this.fillPolygon(pts, facet);
      // A circle has no flat panes to cut, so its slice is simply the stretch of line inside it.
      if (round && dim === 2) {
        this.viewTubes.add(_a.set(-round.radius * scale, 0, 0), _b.set(round.radius * scale, 0, 0), NEUTRAL, 0.003);
      }
    } else {
      const shadow = verts.map((v) => v3(project(v, d), scale, new THREE.Vector3()));
      const count = shape.edges.length;
      shape.edges.forEach((e, i) => {
        _a.copy(shadow[e.a]);
        _b.copy(shadow[e.b]);
        // On a line every edge lands on top of the others, so fan them out a few millimetres.
        if (dim === 2) {
          const lane = round ? (i < count / 2 ? -0.011 : 0.011) : (i - (count - 1) / 2) * 0.014;
          _a.y += lane; _b.y += lane;
        }
        this.viewTubes.add(_a, _b, this.edgeColors[i]);
      });
      if (dim > 2 && !round) {
        for (const p of shadow) this.viewDots.add(p, WHITE, this.viewDots.radius * 0.62);
      }
      if (this.viewGlass) this.viewGlass.update(verts, dim - 1, d, scale);
      if (this.band) {
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
    dim: 2, title: '1D being', subtitle: 'lives on a line',
    viewCaption: 'What the 1D being sees', knobsName: '2D knob', scale: 0.11, viewY: 1.23,
  }),
  new Station({
    dim: 3, title: '2D being', subtitle: 'lives on a sheet',
    viewCaption: 'What the 2D being sees', knobsName: '3D knobs', scale: 0.075, viewY: 1.15,
  }),
  new Station({
    dim: 4, title: 'You', subtitle: 'live in a 3D space',
    viewCaption: 'What you see', knobsName: '4D knobs', scale: 0.115, viewY: 1.29,
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
    new THREE.BoxGeometry(0.25, 0.07, 0.02),
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

const shapeButton = makeButton(-0.405, () => setFamily((state.family + 1) % FAMILIES.length));
const modeButton = makeButton(-0.135, () => setMode((state.mode + 1) % MODES.length));
const spinButton = makeButton(0.135, () => setAutoSpin(!state.autoSpin));
const resetButton = makeButton(0.405, () => resetKnobs());
resetButton.label.setText(['Reset knobs']);
const blurb = makeLabel(['…'], { height: 0.024, color: '#aab4c5', weight: 500 });
blurb.position.set(0, 0.075, 0);
panel.add(blurb);

function setMode(i) {
  state.mode = i;
  modeButton.label.setText([`View: ${MODES[i].name}`]);
  blurb.setText([MODES[i].blurb]);
}
/** Swap the object at every station for the same kind of shape in that station's dimension. */
function setFamily(i) {
  state.family = i;
  stations.forEach((s, k) => s.setShape(FAMILIES[i].make(s.dim), FAMILIES[i].names[k]));
  shapeButton.label.setText([`Shape: ${FAMILIES[i].label}`]);
}
function setAutoSpin(on) {
  state.autoSpin = on;
  spinButton.label.setText([`Auto-spin: ${on ? 'on' : 'off'}`]);
}
const buildTag = makeLabel([BUILD], { height: 0.026, color: '#8f9bb3', weight: 500 });
buildTag.position.set(0, -0.075, 0);
panel.add(buildTag);
document.getElementById('hint')?.append(` · ${BUILD}`);

/** Square everything up and stop, so one knob can be explored at a time. */
function resetKnobs() {
  for (const k of knobs) k.angle = 0;
  setAutoSpin(false);
}
setFamily(0);
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
  if (event.code === 'KeyS') setFamily((state.family + 1) % FAMILIES.length);
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
    // A / X cycles the view, B / Y cycles the shape.
    const pressed = (n) => !!pad.buttons[n]?.pressed;
    if (pressed(4) && !data.buttons[4]) setMode((state.mode + 1) % MODES.length);
    if (pressed(5) && !data.buttons[5]) setFamily((state.family + 1) % FAMILIES.length);
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
window.app = { stations, knobs, state, setMode, setFamily, setAutoSpin, resetKnobs, MODES, FAMILIES };
