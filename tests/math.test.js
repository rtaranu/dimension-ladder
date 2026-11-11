import { makeBox, makeSimplex, makeCross, makeSphere, makeNet, unfoldVertices, rotate, project, shadowRadius, sliceCrossings, sliceSegments, sliceFacets, orderPlanar } from '../src/math4d.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') { if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`); }
function near(a, b, msg = '') { if (Math.abs(a - b) > 1e-4) throw new Error(`${msg} expected ~${b}, got ${a}`); }

const rect = makeBox([1, 0.5]);
const cube = makeBox([1, 1, 1]);
const tess = makeBox([1, 1, 1, 1]);

test('vertex and edge counts', () => {
  eq(rect.vertices.length, 4); eq(rect.edges.length, 4);
  eq(cube.vertices.length, 8); eq(cube.edges.length, 12);
  eq(tess.vertices.length, 16); eq(tess.edges.length, 32);
});

test('face counts: 1, 6, 24, with 4 tesseract faces per axis pair', () => {
  eq(rect.faces.length, 1); eq(cube.faces.length, 6); eq(tess.faces.length, 24);
  for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
    eq(tess.faces.filter((f) => f.axes[0] === p && f.axes[1] === q).length, 4, `pair ${p}${q}`);
  }
});

test('face corners go round the face along its two axes', () => {
  for (const f of tess.faces) {
    const c = f.corners.map((i) => tess.vertices[i]);
    const diff = (a, b) => a.map((x, k) => x - b[k]).findIndex((d) => d !== 0);
    eq(diff(c[1], c[0]), f.axes[0]); eq(diff(c[3], c[0]), f.axes[1]);
    eq(diff(c[2], c[1]), f.axes[1]); eq(diff(c[2], c[3]), f.axes[0]);
  }
});

test('tesseract has 8 edges along each axis', () => {
  for (let a = 0; a < 4; a++) eq(tess.edges.filter((e) => e.axis === a).length, 8, `axis ${a}`);
});

test('rotation keeps lengths and turns X into W', () => {
  const r = rotate(tess.vertices, 0, 3, 0.7);
  r.forEach((v) => near(Math.hypot(...v), 2));
  const q = rotate([[1, 0, 0, 0]], 0, 3, Math.PI / 2)[0];
  near(q[0], 0); near(q[3], 1);
});

test('flat shadow drops the last coordinate', () => {
  const p = project([0.3, -0.2, 0.9, 5]);
  eq(p.length, 3); eq(p[0], 0.3); eq(p[2], 0.9);
});

test('perspective shadow: near keeps size, far shrinks to half at distance 3', () => {
  near(project([1, 1, 1, 1], 3)[0], 1);
  near(project([1, 1, 1, -1], 3)[0], 0.5);
});

test('1D being, flat shadow: line length follows the knob', () => {
  const width = (angle) => {
    const xs = rotate(rect.vertices, 0, 1, angle).map((v) => project(v)[0]);
    return Math.max(...xs) - Math.min(...xs);
  };
  near(width(0), 2);
  near(width(Math.PI / 2), 1);
});

test('1D being, slice: segment goes from long side to short side', () => {
  const len = (angle) => {
    const c = sliceCrossings(rect, rotate(rect.vertices, 0, 1, angle));
    eq(c.length, 2, 'crossings');
    return Math.abs(c[0].pos[0] - c[1].pos[0]);
  };
  near(len(0), 2);
  near(len(Math.PI / 2), 1);
});

test('slice endpoints carry the colour of the edge they cut', () => {
  const at0 = sliceCrossings(rect, rect.vertices);
  at0.forEach((c) => eq(c.axis, 1));
  const at90 = sliceCrossings(rect, rotate(rect.vertices, 0, 1, Math.PI / 2));
  at90.forEach((c) => eq(c.axis, 0));
});

test('cube slice is a square at rest, a closed polygon when turned', () => {
  let c = sliceCrossings(cube, cube.vertices);
  eq(c.length, 4); eq(sliceSegments(cube, c).length, 4);
  c = sliceCrossings(cube, rotate(cube.vertices, 0, 2, 0.6));
  eq(sliceSegments(cube, c).length, c.length, 'closed loop');
});

test('tesseract slice is a cube at rest', () => {
  const c = sliceCrossings(tess, tess.vertices);
  eq(c.length, 8);
  c.forEach((x) => eq(x.axis, 3));
  eq(sliceSegments(tess, c).length, 12);
  const f = sliceFacets(tess, c);
  eq(f.length, 6);
  f.forEach((face) => eq(face.length, 4));
});

test('turned tesseract slice is always a closed solid (V - E + F = 2)', () => {
  for (const angle of [0.2, 0.6, Math.PI / 4, 1.1, 2.5, 4.0]) {
    let v = rotate(tess.vertices, 0, 3, angle);
    v = rotate(v, 1, 3, angle * 0.37); // also tilt a second plane to hit general positions
    const c = sliceCrossings(tess, v);
    const euler = c.length - sliceSegments(tess, c).length + sliceFacets(tess, c).length;
    eq(euler, 2, `angle ${angle}`);
  }
});

test('orderPlanar walks round a square', () => {
  const pts = [[1, 1, 0], [-1, -1, 0], [1, -1, 0], [-1, 1, 0]];
  const o = orderPlanar(pts);
  for (let i = 0; i < 4; i++) {
    const a = pts[o[i]], b = pts[o[(i + 1) % 4]];
    near(Math.hypot(a[0] - b[0], a[1] - b[1]), 2, 'neighbours');
  }
  eq(orderPlanar([[0, 0, 0], [1, 0, 0], [2, 0, 0]]), null);
});

test('pyramid family: triangle, tetrahedron, 5-cell', () => {
  const count = (s) => [s.vertices.length, s.edges.length, s.faces.length, s.cells.length].join(',');
  eq(count(makeSimplex(2)), '3,3,1,0');
  eq(count(makeSimplex(3)), '4,6,4,1');
  eq(count(makeSimplex(4)), '5,10,10,5');
  const s = makeSimplex(4);
  const len = (e) => Math.hypot(...s.vertices[e.a].map((x, i) => x - s.vertices[e.b][i]));
  s.edges.forEach((e) => near(len(e), len(s.edges[0]), 'all edges equal'));
  s.vertices.forEach((v) => near(Math.hypot(...v), 1.35, 'centred'));
});

test('diamond family: diamond, octahedron, 16-cell', () => {
  const count = (s) => [s.vertices.length, s.edges.length, s.faces.length, s.cells.length].join(',');
  eq(count(makeCross(2)), '4,4,1,0');
  eq(count(makeCross(3)), '6,12,8,1');
  eq(count(makeCross(4)), '8,24,32,16');
  makeCross(4).cells.forEach((c) => eq(c.edges.length, 6, 'each cell is a tetrahedron'));
});

test('edge colour weights sum to 1 and box edges are pure', () => {
  for (const s of [tess, makeSimplex(4), makeCross(4), makeSphere(4)]) {
    s.edges.forEach((e) => near(e.weights.reduce((a, b) => a + b, 0), 1));
  }
  tess.edges.forEach((e) => near(e.weights[e.axis], 1));
});

test('sphere family: 1, 3 and 6 great circles, all on the surface', () => {
  eq(makeSphere(2).edges.length, 48); eq(makeSphere(3).edges.length, 144); eq(makeSphere(4).edges.length, 288);
  rotate(makeSphere(4).vertices, 0, 3, 0.8).forEach((v) => near(Math.hypot(...v), 1.2));
});

test('ball shadow radius: unchanged when flat, matches a projected edge-on point', () => {
  near(shadowRadius(1.2, 0), 1.2);
  const D = 3, R = 1.2, h = R * R / D, rho = Math.sqrt(R * R - h * h);
  near(shadowRadius(R, D), project([rho, 0, 0, h], D)[0]);
});

test('every 4D solid slices to a closed solid, at rest and turned', () => {
  for (const [name, s] of [['5-cell', makeSimplex(4)], ['16-cell', makeCross(4)], ['tesseract', tess]]) {
    for (const angle of [0, 0.3, 0.9, 1.7, 2.6, 4.1]) {
      let v = rotate(s.vertices, 0, 3, angle);
      v = rotate(v, 1, 3, angle * 0.37);
      v = rotate(v, 2, 3, angle * 0.61);
      const c = sliceCrossings(s, v);
      const euler = c.length - sliceSegments(s, c).length + sliceFacets(s, c).length;
      eq(euler, 2, `${name} at ${angle}`);
    }
  }
});

test('every 3D solid slices to a closed loop', () => {
  for (const s of [makeSimplex(3), makeCross(3), cube]) {
    for (const angle of [0, 0.4, 1.3, 2.9]) {
      const v = rotate(rotate(s.vertices, 0, 2, angle), 1, 2, angle * 0.5);
      const c = sliceCrossings(s, v);
      eq(sliceSegments(s, c).length, c.length, 'loop');
      eq(sliceFacets(s, c).length, 1, 'one filled polygon');
    }
  }
});

const solids = () => [
  ['rectangle', makeBox([1, 0.5])], ['cube', cube], ['tesseract', tess],
  ['triangle', makeSimplex(2)], ['tetrahedron', makeSimplex(3)], ['5-cell', makeSimplex(4)],
  ['diamond', makeCross(2)], ['octahedron', makeCross(3)], ['16-cell', makeCross(4)],
];

test('nets: side counts (cube 6 squares, tesseract 8 cubes)', () => {
  const sides = (s) => new Set(makeNet(s).copies.map((c) => c.side)).size;
  eq(sides(makeBox([1, 0.5])), 4); eq(sides(cube), 6); eq(sides(tess), 8);
  eq(sides(makeSimplex(4)), 5); eq(sides(makeCross(4)), 16);
  eq(makeNet(tess).shape.edges.length, 96); eq(makeNet(tess).shape.faces.length, 48);
  eq(makeNet(cube).shape.faces.length, 6);
  eq(makeNet(makeSphere(3)), null);
});

test('nets: folded up, every corner is where the solid has it', () => {
  for (const [name, s] of solids()) {
    const net = makeNet(s);
    unfoldVertices(s, net, 0).forEach((p, i) => {
      p.forEach((x, k) => near(x, s.vertices[net.copies[i].v][k], name));
    });
  }
});

test('nets: laid out, everything lies flat in the being\'s world', () => {
  for (const [name, s] of solids()) {
    const net = makeNet(s);
    unfoldVertices(s, net, 1).forEach((p) => near(p[s.dim - 1], 0, name));
  }
});

test('nets: sides stay rigid while unfolding (edge lengths never change)', () => {
  for (const [name, s] of solids()) {
    const net = makeNet(s);
    const len = (pts, e) => Math.hypot(...pts[e.a].map((x, i) => x - pts[e.b][i]));
    const start = unfoldVertices(s, net, 0);
    for (const t of [0.3, 0.7, 1]) {
      const pts = unfoldVertices(s, net, t);
      net.shape.edges.forEach((e) => near(len(pts, e), len(start, e), `${name} t=${t}`));
    }
  }
});

test('nets: hinged sides stay joined along their hinge', () => {
  const net = makeNet(tess), pts = unfoldVertices(tess, net, 0.6);
  let joined = 0;
  net.copies.forEach((a, i) => net.copies.forEach((b, j) => {
    if (i < j && a.v === b.v && (net.parent[a.side] === b.side || net.parent[b.side] === a.side)) {
      pts[i].forEach((x, k) => near(x, pts[j][k], 'hinge corner'));
      joined++;
    }
  }));
  eq(joined, 7 * 4, 'seven hinges of four corners each');
});

test('pushed ball: shadow radius matches a projected edge-on point', () => {
  const D = 3, R = 1.2, o = -0.9, L = D - o, h = o + R * R / L, rho = R * Math.sqrt(1 - R * R / (L * L));
  near(shadowRadius(R, D, o), project([rho, 0, 0, h], D)[0]);
});

const failed = results.filter((r) => r.startsWith('FAIL')).length;
results.push(`${results.length - failed} passed, ${failed} failed`);
document.getElementById('out').textContent = results.join('\n');
