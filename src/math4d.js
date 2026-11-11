// N-dimensional geometry core. No rendering dependencies, so it can be tested on its own.
// Points are plain arrays of numbers; the *last* coordinate is always the "higher" axis
// that the being cannot see (Y for the 1D being, Z for the 2D being, W for us).

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
  // An edge joins two vertices that differ along exactly one axis; that axis gives its colour.
  const edges = [];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < n; a++) {
      if (!((i >> a) & 1)) edges.push({ a: i, b: i | (1 << a), axis: a });
    }
  }
  return { dim: n, vertices, edges };
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
  const k = distance > 0 ? (distance - 1) / (distance - last) : 1;
  const out = new Array(v.length - 1);
  for (let i = 0; i < out.length; i++) out[i] = v[i] * k;
  return out;
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

function popcount(x) {
  let c = 0;
  while (x) { c += x & 1; x >>= 1; }
  return c;
}

/** Outline of the slice: two crossings are joined when their edges lie on the same 2D face. */
export function sliceSegments(shape, crossings) {
  const out = [];
  for (let i = 0; i < crossings.length; i++) {
    const e1 = shape.edges[crossings[i].edge];
    for (let j = i + 1; j < crossings.length; j++) {
      const e2 = shape.edges[crossings[j].edge];
      const mask = (e1.a ^ e1.b) | (e1.a ^ e2.a) | (e1.a ^ e2.b);
      if (popcount(mask) <= 2) out.push([i, j]);
    }
  }
  return out;
}

/**
 * Faces of the slice: each (n-1)-dimensional cell of the box contributes the crossings on its
 * own edges. Returns arrays of crossing indices (unordered), only for cells cut in 3+ places.
 */
export function sliceFacets(shape, crossings) {
  const out = [];
  for (let axis = 0; axis < shape.dim; axis++) {
    for (let sign = 0; sign < 2; sign++) {
      const idx = [];
      crossings.forEach((c, i) => {
        const e = shape.edges[c.edge];
        if (e.axis !== axis && ((e.a >> axis) & 1) === sign) idx.push(i);
      });
      if (idx.length >= 3) out.push(idx);
    }
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
