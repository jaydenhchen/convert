import {
  BufferGeometry,
  Float32BufferAttribute,
  ShapeUtils,
  Vector2,
  Vector3
} from 'three';

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const intersects = ((currentPoint.y > point.y) !== (previousPoint.y > point.y))
      && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function getPlaneAxes(axisIndex) {
  return axisIndex === 0 ? [1, 2] : axisIndex === 1 ? [0, 2] : [0, 1];
}

function collectLoops(segments, nodes) {
  const adjacency = new Map();
  for (let index = 0; index < segments.length; index += 1) {
    const [first, second] = segments[index];
    if (!adjacency.has(first)) adjacency.set(first, []);
    if (!adjacency.has(second)) adjacency.set(second, []);
    adjacency.get(first).push(index);
    adjacency.get(second).push(index);
  }

  const used = new Set();
  const loops = [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    if (used.has(segmentIndex)) continue;
    const [start, firstNext] = segments[segmentIndex];
    const loop = [start];
    used.add(segmentIndex);
    let current = firstNext;
    let closed = false;
    while (current !== start) {
      loop.push(current);
      const nextSegmentIndex = adjacency.get(current)?.find((candidate) => !used.has(candidate));
      if (nextSegmentIndex === undefined) break;
      used.add(nextSegmentIndex);
      const [first, second] = segments[nextSegmentIndex];
      current = first === current ? second : first;
      if (loop.length > nodes.length) break;
    }
    if (current === start && loop.length >= 3) {
      closed = true;
    }
    if (closed) loops.push(loop);
  }
  return loops;
}

function triangulateLoops(loops, nodes, axisIndex, tolerance, normalSign) {
  const [uAxis, vAxis] = getPlaneAxes(axisIndex);
  const loopData = loops.map((loop) => {
    const contour = loop.map((nodeId) => {
      const point = nodes[nodeId].point;
      return new Vector2(point.getComponent(uAxis), point.getComponent(vAxis));
    });
    return {
      loop,
      contour,
      area: ShapeUtils.area(contour)
    };
  }).filter(({ area }) => Math.abs(area) > tolerance * tolerance);

  const parent = loopData.map(() => -1);
  for (let index = 0; index < loopData.length; index += 1) {
    const point = loopData[index].contour[0];
    let smallestContainingArea = Infinity;
    for (let candidate = 0; candidate < loopData.length; candidate += 1) {
      if (candidate === index || Math.abs(loopData[candidate].area) <= Math.abs(loopData[index].area)) continue;
      if (!pointInPolygon(point, loopData[candidate].contour)) continue;
      const candidateArea = Math.abs(loopData[candidate].area);
      if (candidateArea < smallestContainingArea) {
        smallestContainingArea = candidateArea;
        parent[index] = candidate;
      }
    }
  }

  const depth = loopData.map((_, index) => {
    let value = 0;
    for (let current = parent[index]; current !== -1; current = parent[current]) value += 1;
    return value;
  });
  const positions = [];
  const normals = [];
  const normal = new Vector3().setComponent(axisIndex, normalSign);

  for (let index = 0; index < loopData.length; index += 1) {
    if (depth[index] % 2 !== 0) continue;
    const holes = loopData
      .map((entry, holeIndex) => ({ entry, holeIndex }))
      .filter(({ holeIndex }) => parent[holeIndex] === index && depth[holeIndex] % 2 === 1);
    const contours = [loopData[index].contour, ...holes.map(({ entry }) => entry.contour)];
    const points = [loopData[index].loop, ...holes.map(({ entry }) => entry.loop)]
      .flat()
      .map((nodeId) => nodes[nodeId].point);
    const triangles = ShapeUtils.triangulateShape(contours[0], contours.slice(1));
    for (const triangle of triangles) {
      for (const pointIndex of triangle) {
        const point = points[pointIndex];
        positions.push(point.x, point.y, point.z);
        normals.push(normal.x, normal.y, normal.z);
      }
    }
  }

  const geometry = new BufferGeometry();
  if (positions.length) {
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  }
  return geometry;
}

export function buildSectionCapGeometry(sourceGeometry, axisIndex, coordinate, normalSign = 1) {
  const positions = sourceGeometry.attributes.position;
  const capGeometry = new BufferGeometry();
  if (!positions || positions.count < 3) return capGeometry;
  const index = sourceGeometry.index;
  if (!sourceGeometry.boundingBox) sourceGeometry.computeBoundingBox();
  const extent = sourceGeometry.boundingBox.getSize(new Vector3()).length();
  const tolerance = Math.max(extent * 1e-6, 1e-8);
  const nodes = [];
  const nodeByKey = new Map();
  const segments = [];
  const segmentKeys = new Set();
  const vertices = [new Vector3(), new Vector3(), new Vector3()];

  const getNodeId = (point) => {
    const [uAxis, vAxis] = getPlaneAxes(axisIndex);
    const key = `${Math.round(point.getComponent(uAxis) / tolerance)},${Math.round(point.getComponent(vAxis) / tolerance)}`;
    const existing = nodeByKey.get(key);
    if (existing !== undefined) return existing;
    const nodeId = nodes.length;
    nodes.push({ point: point.clone() });
    nodeByKey.set(key, nodeId);
    return nodeId;
  };

  const addIntersection = (points, point) => {
    if (points.some((candidate) => candidate.distanceToSquared(point) <= tolerance * tolerance)) return;
    points.push(point.clone());
  };

  const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(positions.count / 3);
  for (let offset = 0; offset < triangleCount * 3; offset += 3) {
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const sourceIndex = index ? index.getX(offset + vertex) : offset + vertex;
      vertices[vertex].fromBufferAttribute(positions, sourceIndex);
    }
    const distances = vertices.map((point) => point.getComponent(axisIndex) - coordinate);
    if (distances.every((distance) => Math.abs(distance) <= tolerance)) continue;

    const intersections = [];
    for (let edge = 0; edge < 3; edge += 1) {
      const first = vertices[edge];
      const second = vertices[(edge + 1) % 3];
      const firstDistance = distances[edge];
      const secondDistance = distances[(edge + 1) % 3];
      if (Math.abs(firstDistance) <= tolerance && Math.abs(secondDistance) <= tolerance) {
        addIntersection(intersections, first);
        addIntersection(intersections, second);
      } else if (Math.abs(firstDistance) <= tolerance) {
        addIntersection(intersections, first);
      } else if (Math.abs(secondDistance) <= tolerance) {
        addIntersection(intersections, second);
      } else if ((firstDistance < 0) !== (secondDistance < 0)) {
        const amount = firstDistance / (firstDistance - secondDistance);
        addIntersection(intersections, first.clone().lerp(second, amount));
      }
    }
    if (intersections.length < 2) continue;
    let firstPoint = intersections[0];
    let secondPoint = intersections[1];
    if (intersections.length > 2) {
      let longestDistance = -1;
      for (let first = 0; first < intersections.length - 1; first += 1) {
        for (let second = first + 1; second < intersections.length; second += 1) {
          const distance = intersections[first].distanceToSquared(intersections[second]);
          if (distance > longestDistance) {
            longestDistance = distance;
            firstPoint = intersections[first];
            secondPoint = intersections[second];
          }
        }
      }
    }
    const firstNode = getNodeId(firstPoint);
    const secondNode = getNodeId(secondPoint);
    if (firstNode === secondNode) continue;
    const segmentKey = firstNode < secondNode ? `${firstNode}:${secondNode}` : `${secondNode}:${firstNode}`;
    if (segmentKeys.has(segmentKey)) continue;
    segmentKeys.add(segmentKey);
    segments.push([firstNode, secondNode]);
  }
  const loops = collectLoops(segments, nodes);
  return triangulateLoops(loops, nodes, axisIndex, tolerance, normalSign);
}