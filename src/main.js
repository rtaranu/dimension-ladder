import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import {
  makeBox, makeSimplex, makeCross, makeSphere, makeNet, unfoldVertices, rotate, project, shadowRadius,
  sliceCrossings, sliceSegments, sliceFacets, orderPlanar,
} from './math4d.js?v=6';

// Shown on the page and in the headset, so it is obvious which version is running.
// Bump this (and the ?v= above when math4d.js changes) with every release.
const BUILD = 'build 6';

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
 * strength wherever it sits in a stack. `fade` dims a corner that is far off along the hidden axis.
 */
function makeGlassMaterial(haze) {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      attribute vec3 tint;
      attribute float fade;
      varying vec3 vTint;
      void main() {
        vTint = tint * fade;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vTint;
      void main() {
        gl_FragColor = vec4(vTint * ${haze.toFixed(4)}, 1.0);
      }`,
    ...HAZE_BLEND,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
const glassMaterial = makeGlassMaterial(HAZE_PER_PANE);
// In a 4D net every pane is drawn once for each of the two sides that share it. Two of these
// thinner panes lying together add up to exactly one ordinary pane, so nothing jumps when a
// solid starts to unfold.
const glassHalfMaterial = makeGlassMaterial(1 - Math.sqrt(1 - HAZE_PER_PANE));
const SHARED_MATERIALS = new Set([glassMaterial, glassHalfMaterial]);

/** A plain material that hazes by the same amount as one glass pane. `screen` is an on-screen colour. */
function hazeMaterial(screen) {
  return new THREE.MeshBasicMaterial({
    color: screen.clone().multiplyScalar(HAZE_PER_PANE).convertSRGBToLinear(),
    transparent: true, ...HAZE_BLEND, depthWrite: false, side: THREE.DoubleSide,
  });
}
const ROUND_TINT = new THREE.Color().setRGB(0.66, 0.76, 0.95); // on-screen tint of a ball's skin

// Depth cue: how bright and how thick something is drawn, from far (0) to near (1) along the hidden axis.
const cueBrightness = (near) => 0.28 + 0.72 * near;
const cueThickness = (near) => 0.55 + 0.6 * near;

class Glass {
  /** screenColors: one on-screen colour per edge of the shape. */
  constructor(shape, screenColors, material = glassMaterial) {
    this.shape = shape;
    const triangles = shape.faces.reduce((n, f) => n + f.corners.length, 0);
    this.positions = new Float32Array(triangles * 9);
    this.fades = new Float32Array(triangles * 3).fill(1);
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
    this.fadeAttr = new THREE.BufferAttribute(this.fades, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('fade', this.fadeAttr);
    this.geometry.setAttribute('tint', new THREE.BufferAttribute(tints, 3));
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.corner = new Float32Array(8 * 3);
    this.cornerFade = new Float32Array(8);
    this.mid = new Array(shape.dim).fill(0);
  }

  /**
   * verts: the rotated n-D vertices. coords: how many leading coordinates get drawn
   * (all of them for the real object, one fewer for a shadow). distance: perspective eye
   * distance along the hidden axis, or 0 for a flat shadow. cueRange: if positive, dim
   * whatever is far along the hidden axis, treating -cueRange..+cueRange as far..near.
   */
  update(verts, coords, distance, scale, cueRange = 0) {
    const dim = this.shape.dim, pos = this.positions, fades = this.fades;
    const corner = this.corner, cornerFade = this.cornerFade, mid = this.mid;
    const perspective = coords < dim && distance > 0;
    const zoom = (hidden) => (perspective ? scale * (distance - 1) / Math.max(distance - hidden, 1) : scale);
    const fadeAt = (hidden) => (cueRange > 0
      ? cueBrightness(Math.min(1, Math.max(0, 0.5 + hidden / (2 * cueRange)))) : 1);
    let o = 0, fo = 0;
    for (const face of this.shape.faces) {
      const n = face.corners.length;
      mid.fill(0);
      for (let i = 0; i < n; i++) {
        const v = verts[face.corners[i]];
        const k = zoom(v[dim - 1]);
        for (let a = 0; a < 3; a++) corner[i * 3 + a] = a < coords ? v[a] * k : 0;
        cornerFade[i] = fadeAt(v[dim - 1]);
        for (let a = 0; a < dim; a++) mid[a] += v[a] / n;
      }
      const km = zoom(mid[dim - 1]), fm = fadeAt(mid[dim - 1]);
      const mx = mid[0] * km, my = coords > 1 ? mid[1] * km : 0, mz = coords > 2 ? mid[2] * km : 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, a = i * 3, b = j * 3;
        pos[o++] = mx; pos[o++] = my; pos[o++] = mz;
        pos[o++] = corner[a]; pos[o++] = corner[a + 1]; pos[o++] = corner[a + 2];
        pos[o++] = corner[b]; pos[o++] = corner[b + 1]; pos[o++] = corner[b + 2];
        fades[fo++] = fm; fades[fo++] = cornerFade[i]; fades[fo++] = cornerFade[j];
      }
    }
    this.posAttr.needsUpdate = true;
    this.fadeAttr.needsUpdate = true;
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
const state = {
  mode: 0,
  family: 0,
  autoSpin: true,
  depthCue: true,
  push: 0,          // -1..1: how far the object has been pushed along the hidden axis
  passing: false,   // true while the object is being carried back and forth automatically
  passPhase: 0,
  unfold: 0,        // 0 folded .. 1 laid flat
  unfoldTarget: 0,
};
const AXIS_WORDS = ['length', 'height', 'depth', '4th'];
const WHITE = new THREE.Color(0xffffff);
const _mix = new THREE.Color();
const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

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
      this.realBody = new THREE.Group(); // holds the object itself, apart from the being's world
      this.real.add(this.realBody);

      // The being's world, drawn through the real object: a line for 1D, a sheet for 2D.
      if (dim === 2) {
        const line = new THREE.Mesh(
          new THREE.CylinderGeometry(0.0018, 0.0018, 0.46, 6),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
        line.rotation.z = Math.PI / 2;
        this.real.add(line);
        this.worldLine = line;
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

  /** Everything needed to draw one shape here: edges, corner beads and glass, real and as seen. */
  makeSet(shape, material) {
    const { dim } = this;
    const round = shape.round;
    // An edge's colour is a blend of the axis colours, by how much it runs along each axis.
    const colors = shape.edges.map((e) => {
      const c = new THREE.Color(0, 0, 0);
      e.weights.forEach((w, i) => { c.r += AXIS_COLORS[i].r * w; c.g += AXIS_COLORS[i].g * w; c.b += AXIS_COLORS[i].b * w; });
      return c;
    });
    const screen = colors.map((c) => c.clone().convertLinearToSRGB());
    const thin = round ? 0.72 : 1; // the many short pieces of a circle read better drawn finer
    const set = { shape, colors, meshes: [] };
    const add = (parent, mesh) => { set.meshes.push(this.attach(parent, mesh)); return mesh; };

    if (this.real) {
      if (!round && shape.faces.length) {
        set.realGlass = new Glass(shape, screen, material);
        add(this.realBody, set.realGlass.mesh);
      }
      if (!round) {
        set.realDots = new Dots(shape.vertices.length, 0.007);
        add(this.realBody, set.realDots.mesh);
      }
      set.realTubes = new Tubes(shape.edges.length, 0.0045 * thin);
      add(this.realBody, set.realTubes.mesh);
    }
    set.viewTubes = new Tubes(shape.edges.length + shape.faces.length + 1, (dim === 4 ? 0.0055 : 0.0045) * thin);
    set.viewDots = new Dots(shape.edges.length + shape.vertices.length, dim === 4 ? 0.012 : 0.01);
    add(this.view, set.viewTubes.mesh);
    add(this.view, set.viewDots.mesh);
    if (dim > 2 && !round && shape.faces.length) {
      set.viewGlass = new Glass(shape, screen, material);
      add(this.view, set.viewGlass.mesh);
    }
    return set;
  }

  setShape(shape, objectName) {
    for (const mesh of this.dynamic) {
      mesh.parent.remove(mesh);
      mesh.geometry.dispose();
      if (!SHARED_MATERIALS.has(mesh.material)) mesh.material.dispose();
      if (mesh.isInstancedMesh) mesh.dispose();
    }
    this.dynamic = [];
    this.shape = shape;
    this.radius = Math.max(...shape.vertices.map((v) => Math.hypot(...v)));
    const { dim, scale } = this;
    const round = shape.round;

    this.objectCaption.setText(dim < 4
      ? [`Real object: ${objectName}`]
      : [`Real object: ${objectName}`, 'You can’t see it. This is all a 3D being gets.']);

    this.solid = this.makeSet(shape, glassMaterial);
    this.net = makeNet(shape);
    this.flat = this.net ? this.makeSet(this.net.shape, dim === 4 ? glassHalfMaterial : glassMaterial) : null;

    this.viewFill = new Fill(64);
    this.attach(this.view, this.viewFill.mesh);

    // A ball has no flat panes; its skin is drawn as a ball, and its shadow or slice as a
    // ball one dimension down (a disc for the 2D being, a ball for us).
    this.realRound = this.viewRound = null;
    if (round && this.real) {
      const skin = dim === 2
        ? new THREE.CircleGeometry(round.radius * scale, 64)
        : new THREE.SphereGeometry(round.radius * scale, 40, 24);
      this.realRound = this.attach(this.realBody, new THREE.Mesh(skin, hazeMaterial(ROUND_TINT)));
    }
    if (round && dim > 2) {
      const skin = dim === 3 ? new THREE.CircleGeometry(1, 64) : new THREE.SphereGeometry(1, 40, 24);
      this.viewRound = this.attach(this.view, new THREE.Mesh(skin, hazeMaterial(ROUND_TINT)));
    }
  }

  update() {
    const { dim } = this;
    const hiddenAxis = dim - 1;
    const round = this.shape.round;
    const mode = MODES[state.mode].id;
    const slicing = mode === 'slice';
    const d = mode === 'perspective' ? PERSPECTIVE_DISTANCE : 0;

    // Which version to draw: the solid, or its skin part-way through being laid flat.
    const t = smooth(state.unfold);
    const unfolding = t > 0 && !!this.flat && !slicing;
    const set = unfolding ? this.flat : this.solid;
    const idle = unfolding ? this.solid : this.flat;
    for (const mesh of set.meshes) mesh.visible = true;
    if (idle) for (const mesh of idle.meshes) mesh.visible = false;
    const shape = set.shape;
    const scale = this.scale * (unfolding ? 1 + (this.net.fit - 1) * t : 1);

    let verts = unfolding ? unfoldVertices(this.shape, this.net, t) : shape.vertices;
    for (const k of this.knobs) {
      verts = rotate(verts, k.plane[0], k.plane[1], k.angle);
      k.dial.rotation.z = -k.angle;
    }
    // Pushing slides the whole object along the hidden axis, through the being's world.
    // In a perspective shadow the eye sits not far beyond the object, so it is only nudged
    // there; a full push would bring it right up against the eye.
    const reach = (this.radius + 0.15) * (mode === 'perspective' ? 0.35 : 1);
    const push = unfolding ? 0 : state.push * reach;
    // The 1D being's station has little headroom, so there the object and the line each move
    // half the distance in opposite directions. What matters is only how far apart they are.
    if (this.worldLine) {
      this.worldLine.position.y = -push * scale * 0.5;
      this.realBody.position.y = -push * scale * 0.5;
    }
    if (push !== 0) verts = verts.map((v) => { const o = v.slice(); o[hiddenAxis] += push; return o; });

    if (this.real) {
      set.realTubes.begin();
      shape.edges.forEach((e, i) => {
        set.realTubes.add(v3(verts[e.a], scale, _a), v3(verts[e.b], scale, _b), set.colors[i]);
      });
      set.realTubes.end();
      if (set.realDots) {
        set.realDots.begin();
        for (const v of verts) set.realDots.add(v3(v, scale, _a), WHITE);
        set.realDots.end();
      }
      if (set.realGlass) set.realGlass.update(verts, dim, 0, scale);
      if (this.realRound) this.realRound.position.setComponent(hiddenAxis, push * scale);
    }

    const tubes = set.viewTubes, dots = set.viewDots;
    tubes.begin();
    dots.begin();
    this.viewFill.begin();
    if (set.viewGlass) set.viewGlass.mesh.visible = !slicing;
    if (this.band) this.band.visible = !slicing && !unfolding;

    if (this.viewRound) {
      const r = slicing
        ? Math.sqrt(Math.max(0, round.radius * round.radius - push * push))
        : shadowRadius(round.radius, d, push);
      this.viewRound.visible = r > 1e-4;
      this.viewRound.scale.setScalar(Math.max(r, 1e-4) * scale);
    }

    if (slicing) {
      const crossings = sliceCrossings(shape, verts);
      const pts = crossings.map((c) => v3(c.pos, scale, new THREE.Vector3()));
      // Each line of the slice is a glass pane cut through; it joins the two edges it runs between.
      for (const [i, j] of sliceSegments(shape, crossings)) {
        _mix.copy(set.colors[crossings[i].edge]).lerp(set.colors[crossings[j].edge], 0.5).lerp(WHITE, 0.25);
        tubes.add(pts[i], pts[j], _mix, tubes.radius * 0.7);
      }
      // Each corner of the slice is where a coloured edge pokes through the being's world.
      crossings.forEach((c, i) => dots.add(pts[i], set.colors[c.edge]));
      for (const facet of sliceFacets(shape, crossings)) this.fillPolygon(pts, facet);
      // A circle has no flat panes to cut, so its slice is simply the stretch of line inside it.
      if (round && dim === 2 && Math.abs(push) < round.radius) {
        const half = Math.sqrt(round.radius * round.radius - push * push) * scale;
        tubes.add(_a.set(-half, 0, 0), _b.set(half, 0, 0), NEUTRAL, 0.003);
      }
    } else {
      // Depth cue: things further off along the hidden axis are drawn dimmer and thinner.
      const cue = state.depthCue ? this.radius : 0;
      const nearness = (hidden) => (cue ? clamp01(0.5 + hidden / (2 * cue)) : 1);
      const shadow = verts.map((v) => v3(project(v, d), scale, new THREE.Vector3()));
      const count = shape.edges.length;
      shape.edges.forEach((e, i) => {
        _a.copy(shadow[e.a]);
        _b.copy(shadow[e.b]);
        // On a line every edge lands on top of the others, so fan them out a few millimetres.
        if (dim === 2) {
          let lane = round ? (i < count / 2 ? -0.011 : 0.011) : (i - (count - 1) / 2) * 0.014;
          if (unfolding) lane *= 1 - t; // laid end to end, they no longer overlap
          _a.y += lane; _b.y += lane;
        }
        const near = nearness((verts[e.a][hiddenAxis] + verts[e.b][hiddenAxis]) / 2);
        if (cue) {
          tubes.add(_a, _b, _mix.copy(set.colors[i]).multiplyScalar(cueBrightness(near)), tubes.radius * cueThickness(near));
        } else {
          tubes.add(_a, _b, set.colors[i]);
        }
      });
      if (dim > 2 && !round) {
        shadow.forEach((p, i) => {
          const near = nearness(verts[i][hiddenAxis]);
          dots.add(p, _mix.copy(WHITE).multiplyScalar(cue ? cueBrightness(near) : 1), dots.radius * 0.62 * (cue ? cueThickness(near) : 1));
        });
      }
      if (set.viewGlass) set.viewGlass.update(verts, dim - 1, d, scale, cue);
      if (this.band && this.band.visible) {
        let lo = Infinity, hi = -Infinity;
        for (const p of shadow) { lo = Math.min(lo, p.x); hi = Math.max(hi, p.x); }
        this.band.position.x = (lo + hi) / 2;
        this.band.scale.set(hi - lo, 0.074, 1);
      }
    }

    tubes.end();
    dots.end();
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

// ---------------------------------------------------------------- legend and control panel

const legend = makeLabel([[
  { text: '■ length  ', color: AXIS_CSS[0] },
  { text: '■ height  ', color: AXIS_CSS[1] },
  { text: '■ depth  ', color: AXIS_CSS[2] },
  { text: '■ 4th dimension', color: AXIS_CSS[3] },
]], { height: 0.04, bg: 'rgba(21,26,36,0.9)' });
legend.position.set(0, 2.06, -ARC_RADIUS);
scene.add(legend);

const panel = new THREE.Group();
panel.position.set(0, 0.66, -0.6);
panel.rotation.x = -0.6;
scene.add(panel);

function makeButton(x, y, onClick) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.25, 0.07, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x27304a, roughness: 0.6 }));
  mesh.position.set(x, y, 0);
  mesh.userData = { kind: 'button', onClick };
  const label = makeLabel(['…'], { height: 0.026 });
  label.position.z = 0.0115;
  mesh.add(label);
  mesh.label = label;
  panel.add(mesh);
  interactables.push(mesh);
  return mesh;
}

const blurb = makeLabel(['…'], { height: 0.024, color: '#aab4c5', weight: 500 });
blurb.position.set(0, 0.075, 0);
panel.add(blurb);

const ROW2 = -0.085;
const shapeButton = makeButton(-0.405, 0, () => setFamily((state.family + 1) % FAMILIES.length));
const modeButton = makeButton(-0.135, 0, () => setMode((state.mode + 1) % MODES.length));
const cueButton = makeButton(0.135, 0, () => setDepthCue(!state.depthCue));
const spinButton = makeButton(0.405, 0, () => setAutoSpin(!state.autoSpin));
const unfoldButton = makeButton(-0.27, ROW2, () => setUnfold(state.unfoldTarget ? 0 : 1));
const passButton = makeButton(0, ROW2, () => setPassing(!state.passing));
const resetButton = makeButton(0.27, ROW2, () => resetAll());
resetButton.label.setText(['Reset']);

// A slider that pushes the object along the hidden axis, through the being's world.
const SLIDER_Y = -0.2, SLIDER_HALF = 0.36;
const sliderCaption = makeLabel(['Push through the being’s world'], { height: 0.022, color: '#aab4c5', weight: 500 });
sliderCaption.position.set(0, SLIDER_Y + 0.04, 0);
panel.add(sliderCaption);
const sliderTrack = new THREE.Mesh(
  new THREE.BoxGeometry(SLIDER_HALF * 2 + 0.03, 0.012, 0.008),
  new THREE.MeshStandardMaterial({ color: 0x3a4666, roughness: 0.6 }));
sliderTrack.position.set(0, SLIDER_Y, 0);
panel.add(sliderTrack);
const sliderNotch = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.03, 0.009), new THREE.MeshBasicMaterial({ color: 0x8f9bb3 }));
sliderNotch.position.set(0, SLIDER_Y, 0);
panel.add(sliderNotch);
const sliderHandle = new THREE.Mesh(new THREE.SphereGeometry(0.022, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffffff }));
sliderHandle.position.set(0, SLIDER_Y, 0.012);
panel.add(sliderHandle);
const sliderHit = new THREE.Mesh(
  new THREE.PlaneGeometry(SLIDER_HALF * 2 + 0.14, 0.085),
  new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
sliderHit.position.set(0, SLIDER_Y, 0.006);
sliderHit.userData = { kind: 'slider' };
panel.add(sliderHit);
interactables.push(sliderHit);

const buildTag = makeLabel([BUILD], { height: 0.022, color: '#8f9bb3', weight: 500 });
buildTag.position.set(0, SLIDER_Y - 0.06, 0);
panel.add(buildTag);
document.getElementById('hint')?.append(` · ${BUILD}`);

function refreshBlurb() {
  const sphere = !!stations[0].shape?.round;
  if (state.unfoldTarget && sphere) blurb.setText(['A sphere can’t be laid flat without stretching it']);
  else if (state.unfoldTarget) blurb.setText(['Unfolded: every side laid flat in the being’s own world']);
  else blurb.setText([MODES[state.mode].blurb]);
}
function setMode(i) {
  state.mode = i;
  modeButton.label.setText([`View: ${MODES[i].name}`]);
  if (MODES[i].id === 'slice' && state.unfoldTarget) setUnfold(0); // a flat net has nothing to slice
  refreshBlurb();
}
/** Swap the object at every station for the same kind of shape in that station's dimension. */
function setFamily(i) {
  state.family = i;
  stations.forEach((s, k) => s.setShape(FAMILIES[i].make(s.dim), FAMILIES[i].names[k]));
  shapeButton.label.setText([`Shape: ${FAMILIES[i].label}`]);
  refreshBlurb();
}
function setAutoSpin(on) {
  state.autoSpin = on;
  spinButton.label.setText([`Auto-spin: ${on ? 'on' : 'off'}`]);
}
function setDepthCue(on) {
  state.depthCue = on;
  cueButton.label.setText([`Depth cue: ${on ? 'on' : 'off'}`]);
}
/** Slide the object along the hidden axis by hand. -1 and +1 are just clear of the being's world. */
function setPush(value) {
  state.push = Math.min(1, Math.max(-1, value));
  if (state.passing) setPassing(false);
}
/** Carry the object back and forth through the being's world, shown as slices. */
function setPassing(on) {
  state.passing = on;
  passButton.label.setText([on ? 'Stop passing' : 'Pass through']);
  if (on) {
    state.passPhase = Math.acos(Math.min(1, Math.max(-1, -state.push)));
    if (MODES[state.mode].id !== 'slice') setMode(MODES.findIndex((m) => m.id === 'slice'));
  }
}
/** Lay the object's skin out flat (1) or fold it back up (0). Starts from a squared-up, still object. */
function setUnfold(target) {
  state.unfoldTarget = target;
  unfoldButton.label.setText([target ? 'Fold up' : 'Unfold']);
  if (target) {
    for (const k of knobs) k.angle = 0;
    setAutoSpin(false);
    if (state.passing) setPassing(false);
    state.push = 0;
    if (MODES[state.mode].id === 'slice') setMode(0);
  }
  refreshBlurb();
}
/** Square everything up and stop, so one thing can be explored at a time. */
function resetAll() {
  for (const k of knobs) k.angle = 0;
  setAutoSpin(false);
  setPassing(false);
  state.push = 0;
  setUnfold(0);
}
setFamily(0);
setMode(0);
setAutoSpin(true);
setDepthCue(true);
setPassing(false);
setUnfold(0);

// ---------------------------------------------------------------- mouse and keyboard

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let drag = null;
let mouseHover = null;
const _local = new THREE.Vector3();

function pick(event) {
  pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(interactables, false)[0];
  return hit ? hit.object.userData : null;
}

/** Move the slider to wherever the current ray (mouse or controller) crosses its track. */
function sliderFromRay() {
  const hit = raycaster.intersectObject(sliderHit, false)[0];
  if (hit) setPush(panel.worldToLocal(_local.copy(hit.point)).x / SLIDER_HALF);
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  const target = pick(event);
  if (!target) return;
  if (target.kind === 'button') { target.onClick(); return; }
  if (target.kind === 'slider') {
    drag = { slider: true };
    sliderFromRay();
  } else {
    drag = { knob: target.knob, x: event.clientX };
    drag.knob.grabbed = true;
  }
  controls.enabled = false;
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (drag?.slider) {
    pick(event);
    sliderFromRay();
    return;
  }
  if (drag) {
    drag.knob.angle += (event.clientX - drag.x) * 0.012;
    drag.x = event.clientX;
    return;
  }
  const target = pick(event);
  mouseHover = target?.kind === 'knob' ? target.knob : null;
  renderer.domElement.style.cursor = target ? (target.kind === 'button' ? 'pointer' : 'grab') : '';
});
function endDrag() {
  if (!drag) return;
  if (drag.knob) drag.knob.grabbed = false;
  drag = null;
  controls.enabled = true;
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyM') setMode((state.mode + 1) % MODES.length);
  if (event.code === 'KeyS') setFamily((state.family + 1) % FAMILIES.length);
  if (event.code === 'KeyU') setUnfold(state.unfoldTarget ? 0 : 1);
  if (event.code === 'KeyP') setPassing(!state.passing);
  if (event.code === 'KeyD') setDepthCue(!state.depthCue);
  if (event.code === 'KeyR') resetAll();
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

/** Aim the shared raycaster along this controller and return what it points at. */
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
  if (target.kind === 'slider') {
    c.userData.grab = { slider: true, kind };
  } else {
    c.userData.grab = { knob: target.knob, kind, prev: c.quaternion.clone(), turned: 0 };
    target.knob.grabbed = true;
  }
  pulse(c, 0.5, 40);
}

function onRelease(c, kind) {
  const grab = c.userData.grab;
  if (!grab || grab.kind !== kind) return;
  if (grab.knob) grab.knob.grabbed = false;
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

    if (data.grab?.slider) {
      sliderFromRay(); // the raycaster is still aimed along this controller
    } else if (data.grab) {
      // Twisting the wrist while holding trigger or grip turns the knob by the same amount.
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
    const stickX = pad.axes.length >= 4 ? pad.axes[2] : 0;
    const stickY = pad.axes.length >= 4 ? pad.axes[3] : 0;
    // Stick sideways turns a knob; stick forward and back pushes the object through.
    if (Math.abs(stickX) > 0.25 && Math.abs(stickX) >= Math.abs(stickY) && !data.grab) {
      const hovered = data.hover?.object.userData;
      const knob = hovered?.kind === 'knob' ? hovered.knob : gazedStation().knobs[0];
      knob.angle += stickX * dt * 1.6;
      knob.nudged = true;
    } else if (Math.abs(stickY) > 0.25 && !data.grab) {
      setPush(state.push - stickY * dt * 0.6);
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
const UNFOLD_SECONDS = 3.5, PASS_SECONDS = 9;

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

  if (state.unfold !== state.unfoldTarget) {
    const step = dt / UNFOLD_SECONDS;
    state.unfold = state.unfoldTarget > state.unfold
      ? Math.min(state.unfoldTarget, state.unfold + step)
      : Math.max(state.unfoldTarget, state.unfold - step);
  }
  if (state.passing) {
    state.passPhase += (dt * Math.PI * 2) / PASS_SECONDS;
    state.push = -Math.cos(state.passPhase);
  }
  sliderHandle.position.x = state.push * SLIDER_HALF;

  for (const s of stations) s.update();

  renderer.render(scene, camera);
});

// Handy for poking at things from the browser console.
window.app = {
  stations, knobs, state, MODES, FAMILIES,
  setMode, setFamily, setAutoSpin, setDepthCue, setPush, setPassing, setUnfold, resetAll,
};
