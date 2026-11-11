import { makeBox, rotate, project, sliceCrossings, sliceSegments, sliceFacets, orderPlanar } from '../src/math4d.js';

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

const failed = results.filter((r) => r.startsWith('FAIL')).length;
results.push(`${results.length - failed} passed, ${failed} failed`);
document.getElementById('out').textContent = results.join('\n');
