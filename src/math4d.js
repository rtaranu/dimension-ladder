// N-dimensional geometry core. No rendering dependencies, so it can be tested on its own.
// Points are plain arrays of numbers; the *last* coordinate is always the "higher" axis
// that the being cannot see (Y for the 1D being, Z for the 2D being, W for us).
//
// A shape is { dim, vertices, edges, faces, cells }:
//   edges: { a, b, weights, axis }  weights say how much the edge runs along each axis (they
//                                   sum to 1) and decide its colour; axis is the dominant one
//   faces: { corners, edges }       a flat polygon: corners in order, and its boundary edges
//   cells: { edges }                a 3D chunk of the surface, given by the edges it contains
// Round shapes also carry { round: { radius } } and have no faces or cells.

function finish(dim, vertices, edgePairs, faceCorners, cellVertexSets) {
  const edges = edgePairs.map(([a, b]) => {
    const d = vertices[b].map((x, i) => x - vertices[a][i]);
    const len2 = d.reduce((s, x) => s + x * x, 0);
    const weights = d.map((x) => (x * x) / len2);
    return { a, b, weights, axis: weights.indexOf(Math.max(...weights)) };
  });
  const key = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);
  const lookup = new Map(edges.map((e, i) => [key(e.a, e.b), i]));
  const faces = faceCorners.map((corners) => ({
    corners,
    edges: corners.map((c, i) => lookup.get(key(c, corners[(i + 1) % corners.length]))),
  }));
  const cells = cellVertexSets.map((list) => {
    const set = new Set(list);
    const inside = [];
    edges.forEach((e, i) => { if (set.has(e.a) && set.has(e.b)) inside.push(i); });
    return { edges: inside, verts: list.slice() };
  });
  return { dim, vertices, edges, faces, cells };
}

/** Every way of choosing k items from 0..n-1. */
function combinations(n, k, start = 0, prefix = [], out = []) {
  if (prefix.length === k) { out.push(prefix); return out; }
  for (let i = start; i < n; i++) combinations(n, k, i + 1, [...prefix, i], out);
  return out;
}

const range = (n) => Array.from({ length: n }, (_, i) => i);

/** Axis-aligned box in n dimensions: rectangle (n=2), cuboid (n=3), tesseract (n=4). */
export function makeBox(halfExtents) {
  const n = halfExtents.length;
  const count = 1 << n;
  const vertices = [];
  for (let i = 0; i < count; i++) {
    const v = new Array(n);
    for (let a = 0; a < n; a++) v[a] = ((i >> a) & 1 ? 1 : -1) * halfExtents[a];
    vertices.push(v);
  }
  // An edge joins two vertices that differ along exactly one axis.
  const edgePairs = [];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < n; a++) if (!((i >> a) & 1)) edgePairs.push([i, i | (1 << a)]);
  }
  // A 2D face spans two axes. A rectangle has 1, a cube 6, a tesseract 24.
  const faceCorners = [], faceAxes = [];
  for (let p = 0; p < n; p++) {
    for (let q = p + 1; q < n; q++) {
      const P = 1 << p, Q = 1 << q;
      for (let i = 0; i < count; i++) {
        if (i & (P | Q)) continue;
        faceCorners.push([i, i | P, i | P | Q, i | Q]);
        faceAxes.push([p, q]);
      }
    }
  }
  // A tesseract's surface is 8 cubes: hold one coordinate at one end and vary the rest.
  let cellSets = [];
  if (n === 3) cellSets = [range(count)];
  if (n === 4) {
    for (let a = 0; a < n; a++) for (let s = 0; s < 2; s++) {
      cellSets.push(range(count).filter((i) => ((i >> a) & 1) === s));
    }
  }
  const shape = finish(n, vertices, edgePairs, faceCorners, cellSets);
  shape.faces.forEach((f, i) => { f.axes = faceAxes[i]; });
  return shape;
}

/**
 * Regular simplex: triangle (n=2), 3-sided pyramid / tetrahedron (n=3), 5-cell (n=4).
 * Built the way the ladder suggests: take the shape one dimension down and add a single new
 * corner out along the new axis, so the edges up to that corner carry the new axis's colour.
 */
export function makeSimplex(n, radius = 1.35) {
  let vertices = [[-0.5], [0.5]];
  for (let k = 1; k < n; k++) {
    const r2 = vertices[0].reduce((s, x) => s + x * x, 0);
    const h = Math.sqrt(1 - r2), m = vertices.length;
    vertices = vertices.map((v) => [...v, -h / (m + 1)]);
    vertices.push([...new Array(k).fill(0), (h * m) / (m + 1)]);
  }
  const r = Math.hypot(...vertices[0]);
  vertices = vertices.map((v) => v.map((x) => (x / r) * radius));
  const count = n + 1;
  const cells = n === 3 ? [range(count)] : n === 4 ? combinations(count, 4) : [];
  return finish(n, vertices, combinations(count, 2), combinations(count, 3), cells);
}

/**
 * Cross-polytope: one corner out along each direction of each axis.
 * Diamond (n=2), octahedron (n=3), 16-cell (n=4). Vertex 2i is +axis i, vertex 2i+1 is -axis i.
 */
export function makeCross(n, radius = 1.4) {
  const vertices = [];
  for (let a = 0; a < n; a++) for (const s of [1, -1]) {
    const v = new Array(n).fill(0);
    v[a] = s * radius;
    vertices.push(v);
  }
  const opposite = (a, b) => (a >> 1) === (b >> 1);
  const edgePairs = combinations(2 * n, 2).filter(([a, b]) => !opposite(a, b));
  const faces = n === 2
    ? [[0, 2, 1, 3]]
    : combinations(2 * n, 3).filter(([a, b, c]) => !opposite(a, b) && !opposite(a, c) && !opposite(b, c));
  let cells = [];
  if (n === 3) cells = [range(6)];
  if (n === 4) for (let bits = 0; bits < 16; bits++) cells.push(range(4).map((a) => 2 * a + ((bits >> a) & 1)));
  return finish(n, vertices, edgePairs, faces, cells);
}

/**
 * Circle (n=2), sphere (n=3), hypersphere (n=4), drawn as one great circle in every pair of
 * axes: 1, 3 and 6 of them. Each short piece of a circle is an edge, so its colour follows
 * whichever way it happens to be heading at that point.
 */
export function makeSphere(n, radius = 1.2, segments = 48) {
  const vertices = [], edgePairs = [];
  for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
    const base = vertices.length;
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      const v = new Array(n).fill(0);
      v[p] = radius * Math.cos(t);
      v[q] = radius * Math.sin(t);
      vertices.push(v);
      edgePairs.push([base + i, base + ((i + 1) % segments)]);
    }
  }
  const shape = finish(n, vertices, edgePairs, [], []);
  shape.round = { radius, segments };
  return shape;
}

/** Rotate every point by `angle` in the plane spanned by axes p and q (turning p towards q). */
export function rotate(vertices, p, q, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return vertices.map((v) => {
    const out = v.slice();
    out[p] = v[p] * c - v[q] * s;
    out[q] = v[p] * s + v[q] * c;
    return out;
  });
}

/**
 * Shadow of a point one dimension down: drop the last coordinate.
 * distance = 0 gives a flat (orthographic) shadow. A positive distance puts the eye that far
 * along the hidden axis, so nearer parts look bigger; it is normalised so that a point at
 * hidden-coordinate +1 keeps its size.
 */
export function project(v, distance = 0) {
  const last = v[v.length - 1];
  // The floor of 1 stops anything pushed right up to the eye from blowing up to infinity.
  const k = distance > 0 ? (distance - 1) / Math.max(distance - last, 1) : 1;
  const out = new Array(v.length - 1);
  for (let i = 0; i < out.length; i++) out[i] = v[i] * k;
  return out;
}

/**
 * Radius of a ball's shadow under the same projection (its outline, seen from the eye).
 * offset is how far the ball's centre has been pushed along the hidden axis.
 */
export function shadowRadius(radius, distance = 0, offset = 0) {
  if (!(distance > 0)) return radius;
  const away = distance - offset; // eye to the ball's centre
  if (away <= radius) return radius * (distance - 1);
  const h = offset + (radius * radius) / away; // hidden coordinate of the ring the eye sees edge-on
  return radius * Math.sqrt(1 - (radius * radius) / (away * away)) * (distance - 1) / Math.max(distance - h, 1);
}

// ---------------------------------------------------------------- unfolding

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const unit = (a) => { const l = Math.hypot(...a); return l > 1e-12 ? a.map((x) => x / l) : null; };
const centroid = (points) => points[0].map((_, i) => points.reduce((s, p) => s + p[i], 0) / points.length);

/** Turn x in place about the point c, in the plane of e1 and e2, by `angle` (e1 towards e2). */
function turn(x, c, e1, e2, angle) {
  const d = sub(x, c);
  const a = dot(d, e1), b = dot(d, e2);
  const cs = Math.cos(angle), sn = Math.sin(angle);
  const da = a * cs - b * sn - a, db = a * sn + b * cs - b;
  for (let i = 0; i < x.length; i++) x[i] += da * e1[i] + db * e2[i];
}

/**
 * Work out how to unfold a solid's skin flat, the way a cube opens into a cross of six squares.
 * The skin is made of sides one dimension down from the solid (edges of a rectangle, faces of a
 * cube, cubes of a tesseract). One side stays put; each of the others swings about the hinge it
 * shares with a neighbour until it lies in the same flat space, which ends up being the
 * being's own world. Returns null for round shapes, which cannot be flattened.
 *
 * The result holds `shape`, a drawable copy of the solid in which every side has its own
 * corners (so sides can come apart), plus the hinge data unfoldVertices needs.
 */
export function makeNet(shape) {
  if (shape.round) return null;
  const n = shape.dim, V = shape.vertices;
  const sides = n === 2 ? shape.edges.map((e) => [e.a, e.b])
    : n === 3 ? shape.faces.map((f) => f.corners.slice())
      : shape.cells.map((c) => c.verts.slice());
  const centres = sides.map((s) => centroid(s.map((i) => V[i])));

  // The side that stays put is the one facing most directly "down" the hidden axis.
  let root = 0;
  centres.forEach((c, i) => { if (c[n - 1] < centres[root][n - 1] - 1e-9) root = i; });

  // Grow a tree of sides outward from the root; each new side hinges on one already placed.
  const parent = new Array(sides.length).fill(-1);
  const hinges = new Array(sides.length).fill(null);
  const placed = new Set([root]), queue = [root];
  while (queue.length) {
    const f = queue.shift();
    sides.forEach((list, g) => {
      if (placed.has(g)) return;
      const shared = list.filter((v) => sides[f].includes(v));
      if (shared.length < n - 1) return;
      const c = centroid(shared.map((i) => V[i]));
      const u = unit(sub(c, centres[f]));   // out of the parent, across the hinge
      const v = unit(sub(centres[g], c));   // into the child, from the hinge
      const cos = Math.max(-1, Math.min(1, dot(u, v)));
      const e2 = unit(u.map((x, i) => x - cos * v[i]));
      hinges[g] = { c, e1: v, e2: e2 || v, angle: e2 ? Math.acos(cos) : 0 };
      parent[g] = f;
      placed.add(g);
      queue.push(g);
    });
  }

  // Finally tip the whole thing so the root side lies in the being's world, and lift it there.
  const down = new Array(n).fill(0);
  down[n - 1] = -1;
  const normal = unit(centres[root]);
  const cosA = Math.max(-1, Math.min(1, dot(normal, down)));
  const tipTo = unit(down.map((x, i) => x - cosA * normal[i]));
  const align = { e1: normal, e2: tipTo || normal, angle: tipTo ? Math.acos(cosA) : 0 };
  const lift = Math.hypot(...centres[root]);

  // The drawable copy: every side gets its own corners, edges and panes.
  const copies = [], vmap = [];
  sides.forEach((list, f) => {
    vmap.push(new Map(list.map((v) => { copies.push({ side: f, v }); return [v, copies.length - 1]; })));
  });
  const edges = [], emap = [];
  sides.forEach((list, f) => {
    const m = new Map();
    shape.edges.forEach((e, i) => {
      if (!vmap[f].has(e.a) || !vmap[f].has(e.b)) return;
      m.set(i, edges.length);
      edges.push({ a: vmap[f].get(e.a), b: vmap[f].get(e.b), weights: e.weights, axis: e.axis });
    });
    emap.push(m);
  });
  const faces = [];
  if (n >= 3) {
    sides.forEach((list, f) => {
      shape.faces.forEach((face, i) => {
        if (n === 3 ? i !== f : !face.corners.every((v) => vmap[f].has(v))) return;
        faces.push({ corners: face.corners.map((v) => vmap[f].get(v)), edges: face.edges.map((e) => emap[f].get(e)) });
      });
    });
  }
  const net = {
    shape: { dim: n, vertices: copies.map((c) => V[c.v].slice()), edges, faces, cells: [] },
    copies, root, parent, hinges, align, lift, fit: 1,
  };
  // How much the laid-out net must shrink to take up no more room than the solid did.
  const reach = (pts) => Math.max(...pts.map((p) => Math.hypot(...p)));
  net.fit = Math.min(1, (reach(V) * 1.2) / reach(unfoldVertices(shape, net, 1)));
  return net;
}

/** Corner positions of the net's drawable shape, t = 0 (folded) to 1 (laid flat). */
export function unfoldVertices(shape, net, t) {
  const n = shape.dim, origin = new Array(n).fill(0);
  return net.copies.map(({ side, v }) => {
    const x = shape.vertices[v].slice();
    for (let f = side; f !== net.root; f = net.parent[f]) {
      const h = net.hinges[f];
      turn(x, h.c, h.e1, h.e2, h.angle * t);
    }
    turn(x, origin, net.align.e1, net.align.e2, net.align.angle * t);
    x[n - 1] += net.lift * t;
    return x;
  });
}

/**
 * Slice: where does each edge pierce the being's world (hidden coordinate = offset)?
 * The tiny default offset keeps the cut from landing exactly on a vertex.
 */
export function sliceCrossings(shape, verts, offset = 1e-5) {
  const last = shape.dim - 1;
  const out = [];
  shape.edges.forEach((e, index) => {
    const va = verts[e.a], vb = verts[e.b];
    const d0 = va[last] - offset, d1 = vb[last] - offset;
    if ((d0 < 0) === (d1 < 0)) return;
    const t = d0 / (d0 - d1);
    const pos = new Array(last);
    for (let i = 0; i < last; i++) pos[i] = va[i] + (vb[i] - va[i]) * t;
    out.push({ pos, axis: e.axis, edge: index });
  });
  return out;
}

function crossingByEdge(crossings) {
  const map = new Map();
  crossings.forEach((c, i) => map.set(c.edge, i));
  return map;
}

/** Outline of the slice: a flat face that is cut gets cut along one line, joining two crossings. */
export function sliceSegments(shape, crossings) {
  const at = crossingByEdge(crossings);
  const out = [];
  for (const face of shape.faces) {
    const hit = face.edges.filter((e) => at.has(e)).map((e) => at.get(e));
    if (hit.length === 2) out.push(hit);
  }
  return out;
}

/**
 * Faces of the slice: each cell contributes the crossings on its own edges.
 * Returns arrays of crossing indices (unordered), only for cells cut in 3+ places.
 */
export function sliceFacets(shape, crossings) {
  const at = crossingByEdge(crossings);
  const out = [];
  for (const cell of shape.cells) {
    const hit = cell.edges.filter((e) => at.has(e)).map((e) => at.get(e));
    if (hit.length >= 3) out.push(hit);
  }
  return out;
}

/**
 * Order coplanar 3D points ([x,y,z] arrays) around their centroid so they form a convex polygon.
 * Returns an array of indices into `points`, or null if the points are collinear.
 */
export function orderPlanar(points) {
  const n = points.length;
  const c = [0, 0, 0];
  for (const p of points) { c[0] += p[0] / n; c[1] += p[1] / n; c[2] += p[2] / n; }
  const rel = points.map((p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);

  let best = 0, normal = null, u = null;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = rel[i], b = rel[j];
      const x = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const m = Math.hypot(x[0], x[1], x[2]);
      if (m > best) { best = m; normal = x.map((k) => k / m); u = a; }
    }
  }
  if (!normal || best < 1e-12) return null;
  const ul = Math.hypot(u[0], u[1], u[2]);
  u = u.map((k) => k / ul);
  const v = [normal[1] * u[2] - normal[2] * u[1], normal[2] * u[0] - normal[0] * u[2], normal[0] * u[1] - normal[1] * u[0]];
  const ang = rel.map((r) => Math.atan2(r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[0] * u[0] + r[1] * u[1] + r[2] * u[2]));
  return points.map((_, i) => i).sort((i, j) => ang[i] - ang[j]);
}
