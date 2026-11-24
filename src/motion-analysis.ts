export type MotionFrameSignature = { timeSeconds: number; signature: Uint8Array };
export type MotionEstimate = {
  timeSeconds: number;
  trackingGap: boolean;
  magnitude: number;
  direction: 'left' | 'right' | 'up' | 'down' | 'mixed' | 'still';
  changedRegionRatio: number;
  trackX: number;
  trackY: number;
  confidence: number;
  cameraMotionX: number;
  cameraMotionY: number;
  subjectMotionX: number;
  subjectMotionY: number;
  subjectMotionRatio: number;
  flowConfidence: number;
  sceneCut: boolean;
  trackId: number | null;
  trackAge: number;
  trackStability: number;
  trackWidth: number;
  trackHeight: number;
  occluded: boolean;
  predictionHorizonSeconds: number;
  predictedTrackX: number;
  predictedTrackY: number;
  predictionConfidence: number;
  trackUncertainty: number;
};

export type SubjectPathPoint = {
  timeSeconds: number;
  centerX: number;
  centerY: number;
  confidence: number;
};

type FlowVector = {
  dx: number;
  dy: number;
  x: number;
  y: number;
  confidence: number;
  cellX: number;
  cellY: number;
};

type MotionCluster = {
  cells: FlowVector[];
  score: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  width: number;
  height: number;
  confidence: number;
};

type TrackState = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  age: number;
  missed: number;
  stability: number;
  lastTime: number;
  ax: number;
  ay: number;
  uncertainty: number;
};

type CameraModel = {
  tx: number;
  ty: number;
  zoom: number;
  rotation: number;
  confidence: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const directionFor = (x: number, y: number, magnitude: number): MotionEstimate['direction'] => {
  if (magnitude < 0.045) return 'still';
  if (Math.abs(x) > Math.abs(y) * 1.25) return x > 0 ? 'right' : 'left';
  if (Math.abs(y) > Math.abs(x) * 1.25) return y > 0 ? 'down' : 'up';
  return 'mixed';
};

function downsample(source: Uint8Array, width: number, height: number) {
  const nextWidth = Math.max(1, Math.floor(width / 2));
  const nextHeight = Math.max(1, Math.floor(height / 2));
  const data = new Uint8Array(nextWidth * nextHeight);

  for (let y = 0; y < nextHeight; y += 1) {
    for (let x = 0; x < nextWidth; x += 1) {
      const offset = y * 2 * width + x * 2;
      data[y * nextWidth + x] = Math.round((
        source[offset] +
        source[offset + 1] +
        source[offset + width] +
        source[offset + width + 1]
      ) / 4);
    }
  }

  return { data, width: nextWidth, height: nextHeight };
}

function histogramDistance(left: Uint8Array, right: Uint8Array) {
  const leftHistogram = new Array<number>(16).fill(0);
  const rightHistogram = new Array<number>(16).fill(0);

  for (let index = 0; index < left.length; index += 1) {
    leftHistogram[left[index] >> 4] += 1;
    rightHistogram[right[index] >> 4] += 1;
  }

  let distance = 0;
  for (let bin = 0; bin < 16; bin += 1) {
    distance += Math.abs(
      leftHistogram[bin] / left.length -
      rightHistogram[bin] / right.length
    );
  }
  return distance / 2;
}

/** Compares local grayscale distributions so cuts with similar global colour
 * histograms are less likely to be mistaken for ordinary camera movement. */
function spatialHistogramDistance(
  left: Uint8Array,
  right: Uint8Array,
  width: number,
  height: number
) {
  const columns = 4;
  const rows = 4;
  let totalDistance = 0;
  let tileCount = 0;

  for (let tileY = 0; tileY < rows; tileY += 1) {
    for (let tileX = 0; tileX < columns; tileX += 1) {
      const leftHistogram = new Array<number>(8).fill(0);
      const rightHistogram = new Array<number>(8).fill(0);
      let count = 0;
      const startX = Math.floor(tileX * width / columns);
      const endX = Math.floor((tileX + 1) * width / columns);
      const startY = Math.floor(tileY * height / rows);
      const endY = Math.floor((tileY + 1) * height / rows);

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const index = y * width + x;
          leftHistogram[left[index] >> 5] += 1;
          rightHistogram[right[index] >> 5] += 1;
          count += 1;
        }
      }

      if (!count) continue;
      for (let bin = 0; bin < 8; bin += 1) {
        totalDistance += Math.abs(
          leftHistogram[bin] / count - rightHistogram[bin] / count
        ) / 2;
      }
      tileCount += 1;
    }
  }

  return tileCount ? totalDistance / tileCount : 0;
}

/**
 * Mean-normalized patch matching is less sensitive to global exposure shifts.
 * A small gradient term preserves edge structure and reduces flat-patch matches.
 */
function patchCost(
  previous: Uint8Array,
  current: Uint8Array,
  width: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  block: number
) {
  let previousMean = 0;
  let currentMean = 0;

  for (let row = 0; row < block; row += 1) {
    const previousOffset = (y + row) * width + x;
    const currentOffset = (y + row + dy) * width + x + dx;
    for (let column = 0; column < block; column += 1) {
      previousMean += previous[previousOffset + column];
      currentMean += current[currentOffset + column];
    }
  }

  const count = block * block;
  previousMean /= count;
  currentMean /= count;

  let intensityError = 0;
  let gradientError = 0;
  let variance = 0;

  for (let row = 0; row < block; row += 1) {
    const previousOffset = (y + row) * width + x;
    const currentOffset = (y + row + dy) * width + x + dx;

    for (let column = 0; column < block; column += 1) {
      const a = previous[previousOffset + column] - previousMean;
      const b = current[currentOffset + column] - currentMean;
      intensityError += Math.abs(a - b);
      variance += a * a;

      if (column + 1 < block) {
        const ax = previous[previousOffset + column + 1] - previous[previousOffset + column];
        const bx = current[currentOffset + column + 1] - current[currentOffset + column];
        gradientError += Math.abs(ax - bx);
      }

      if (row + 1 < block) {
        const ay = previous[previousOffset + width + column] - previous[previousOffset + column];
        const by = current[currentOffset + width + column] - current[currentOffset + column];
        gradientError += Math.abs(ay - by);
      }
    }
  }

  const gradientCount = Math.max(1, 2 * block * (block - 1));
  const texture = Math.sqrt(variance / count);
  return {
    cost: intensityError / count * 0.72 + gradientError / gradientCount * 0.28,
    texture,
  };
}

function estimateBlockFlow(
  previous: Uint8Array,
  current: Uint8Array,
  width: number,
  height: number,
  prediction?: FlowVector[]
) {
  const block = 5;
  const stride = 5;
  const radius = prediction?.length ? 2 : 4;
  const vectors: FlowVector[] = [];
  let cellY = 0;

  for (let y = 1; y + block < height; y += stride, cellY += 1) {
    let cellX = 0;

    for (let x = 1; x + block < width; x += stride, cellX += 1) {
      const baseline = patchCost(previous, current, width, x, y, 0, 0, block);
      let centerX = 0;
      let centerY = 0;

      if (prediction?.length) {
        let nearest = prediction[0];
        let nearestDistance = Infinity;

        for (const candidate of prediction) {
          const distance = Math.hypot(
            candidate.x * 2 - (x + block / 2),
            candidate.y * 2 - (y + block / 2)
          );
          if (distance < nearestDistance) {
            nearest = candidate;
            nearestDistance = distance;
          }
        }

        centerX = Math.round(nearest.dx * 2);
        centerY = Math.round(nearest.dy * 2);
      }

      let best = Infinity;
      let second = Infinity;
      let bestX = 0;
      let bestY = 0;
      let bestTexture = baseline.texture;

      for (let dy = centerY - radius; dy <= centerY + radius; dy += 1) {
        for (let dx = centerX - radius; dx <= centerX + radius; dx += 1) {
          if (
            x + dx < 0 ||
            y + dy < 0 ||
            x + dx + block > width ||
            y + dy + block > height
          ) continue;

          const candidate = patchCost(previous, current, width, x, y, dx, dy, block);
          if (candidate.cost < best) {
            second = best;
            best = candidate.cost;
            bestX = dx;
            bestY = dy;
            bestTexture = candidate.texture;
          } else if (candidate.cost < second) {
            second = candidate.cost;
          }
        }
      }

      const improvement = baseline.cost - best;
      const textureConfidence = clamp((bestTexture - 3) / 18, 0, 1);
      const uniqueness = clamp(
        (second - best) / Math.max(3, second),
        0,
        1
      );
      const matchConfidence =
        clamp(improvement / Math.max(5, baseline.cost), 0, 1) *
        (0.3 + uniqueness * 0.7) *
        textureConfidence;

      if (matchConfidence > 0.045) {
        vectors.push({
          dx: bestX,
          dy: bestY,
          x: x + block / 2,
          y: y + block / 2,
          confidence: matchConfidence,
          cellX,
          cellY,
        });
      }
    }
  }

  return vectors;
}

/**
 * Rejects ambiguous matches that do not return close to their starting point.
 * This forward/backward check is applied only to candidate vectors, not every pixel.
 */
function enforceForwardBackwardConsistency(
  previous: Uint8Array,
  current: Uint8Array,
  width: number,
  height: number,
  vectors: FlowVector[]
) {
  const block = 5;
  const consistent: FlowVector[] = [];

  for (const vector of vectors) {
    const x = Math.round(vector.x - block / 2) + vector.dx;
    const y = Math.round(vector.y - block / 2) + vector.dy;
    let reverseBest = Infinity;
    let reverseX = 0;
    let reverseY = 0;

    for (let dy = -vector.dy - 1; dy <= -vector.dy + 1; dy += 1) {
      for (let dx = -vector.dx - 1; dx <= -vector.dx + 1; dx += 1) {
        if (
          x + dx < 0 ||
          y + dy < 0 ||
          x + dx + block > width ||
          y + dy + block > height
        ) continue;

        const cost = patchCost(current, previous, width, x, y, dx, dy, block).cost;
        if (cost < reverseBest) {
          reverseBest = cost;
          reverseX = dx;
          reverseY = dy;
        }
      }
    }

    const roundTripError = Math.hypot(
      vector.dx + reverseX,
      vector.dy + reverseY
    );
    if (roundTripError <= 2.5) {
      const consistency = clamp(1 - roundTripError / 3, 0.15, 1);
      consistent.push({
        ...vector,
        confidence: vector.confidence * consistency,
      });
    }
  }

  return consistent;
}

function estimateCameraModel(
  vectors: FlowVector[],
  width: number,
  height: number
): CameraModel {
  if (vectors.length < 4) {
    return { tx: 0, ty: 0, zoom: 0, rotation: 0, confidence: 0 };
  }

  let inliers = [...vectors];
  let tx = median(inliers.map(vector => vector.dx));
  let ty = median(inliers.map(vector => vector.dy));
  let zoom = 0;
  let rotation = 0;
  const centerX = width / 2;
  const centerY = height / 2;

  // Iterative trimmed fitting prevents a large independently moving subject
  // from pulling the global camera estimate away from the background motion.
  for (let pass = 0; pass < 3; pass += 1) {
    const zoomSamples: number[] = [];
    const rotationSamples: number[] = [];

    for (const vector of inliers) {
      const rx = vector.x - centerX;
      const ry = vector.y - centerY;
      const dx = vector.dx - tx;
      const dy = vector.dy - ty;
      const radiusSquared = rx * rx + ry * ry;

      if (radiusSquared < 25) continue;
      zoomSamples.push((dx * rx + dy * ry) / radiusSquared);
      rotationSamples.push((rx * dy - ry * dx) / radiusSquared);
    }

    zoom = clamp(median(zoomSamples), -0.08, 0.08);
    rotation = clamp(median(rotationSamples), -0.08, 0.08);

    const residuals = inliers.map(vector => {
      const rx = vector.x - centerX;
      const ry = vector.y - centerY;
      const predictedX = tx + zoom * rx - rotation * ry;
      const predictedY = ty + zoom * ry + rotation * rx;
      return Math.hypot(
        vector.dx - predictedX,
        vector.dy - predictedY
      );
    });

    const cutoff = Math.max(1.25, median(residuals) * 1.8 + 0.35);
    const nextInliers = inliers.filter((vector, index) => residuals[index] <= cutoff);
    if (nextInliers.length < 4 || nextInliers.length === inliers.length) break;
    inliers = nextInliers;
    tx = median(inliers.map(vector => vector.dx));
    ty = median(inliers.map(vector => vector.dy));
  }

  const residuals = vectors.map(vector => {
    const rx = vector.x - centerX;
    const ry = vector.y - centerY;
    const predictedX = tx + zoom * rx - rotation * ry;
    const predictedY = ty + zoom * ry + rotation * rx;
    return Math.hypot(vector.dx - predictedX, vector.dy - predictedY);
  });

  const inlierRatio = residuals.filter(value => value < 2.1).length / residuals.length;
  const fitQuality = clamp(1 - median(residuals) / 5, 0, 1);

  return {
    tx,
    ty,
    zoom,
    rotation,
    confidence: clamp(inlierRatio * fitQuality, 0, 1),
  };
}

function findMotionClusters(vectors: FlowVector[]) {
  const cellsByKey = new Map<string, FlowVector>();
  for (const vector of vectors) {
    cellsByKey.set(vector.cellX + ':' + vector.cellY, vector);
  }

  const visited = new Set<string>();
  const clusters: MotionCluster[] = [];

  for (const first of vectors) {
    const firstKey = first.cellX + ':' + first.cellY;
    if (visited.has(firstKey)) continue;

    const queue = [first];
    const cells: FlowVector[] = [];
    visited.add(firstKey);

    while (queue.length) {
      const current = queue.pop()!;
      cells.push(current);

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (!offsetX && !offsetY) continue;
          const key = (current.cellX + offsetX) + ':' + (current.cellY + offsetY);
          const next = cellsByKey.get(key);

          if (
            !next ||
            visited.has(key) ||
            Math.hypot(next.dx - current.dx, next.dy - current.dy) > 2.8
          ) continue;

          visited.add(key);
          queue.push(next);
        }
      }
    }

    if (cells.length < 2) continue;

    const totalWeight = cells.reduce((sum, cell) => sum + cell.confidence, 0);
    const weightedAverage = (read: (cell: FlowVector) => number) =>
      cells.reduce(
        (sum, cell) => sum + read(cell) * cell.confidence,
        0
      ) / Math.max(0.001, totalWeight);

    const dx = weightedAverage(cell => cell.dx);
    const dy = weightedAverage(cell => cell.dy);
    const x = weightedAverage(cell => cell.x);
    const y = weightedAverage(cell => cell.y);
    const coherence = cells.reduce(
      (sum, cell) => sum + Math.hypot(cell.dx - dx, cell.dy - dy),
      0
    ) / cells.length;
    const confidence =
      clamp(totalWeight / cells.length, 0, 1) *
      clamp(1 - coherence / 4, 0, 1);

    clusters.push({
      cells,
      score: cells.length * confidence * Math.hypot(dx, dy),
      x,
      y,
      dx,
      dy,
      width: Math.max(...cells.map(cell => cell.x)) -
        Math.min(...cells.map(cell => cell.x)) + 5,
      height: Math.max(...cells.map(cell => cell.y)) -
        Math.min(...cells.map(cell => cell.y)) + 5,
      confidence,
    });
  }

  return clusters.sort((left, right) => right.score - left.score);
}

function predictedPosition(track: TrackState, deltaSeconds: number) {
  const horizon = clamp(deltaSeconds, 0, 2.5);
  return {
    x: clamp(track.x + track.vx * horizon + 0.5 * track.ax * horizon * horizon, 0.01, 0.99),
    y: clamp(track.y + track.vy * horizon + 0.5 * track.ay * horizon * horizon, 0.01, 0.99),
  };
}

function trackAssociation(
  track: TrackState,
  cluster: MotionCluster,
  deltaSeconds: number,
  width: number,
  height: number
) {
  const predicted = predictedPosition(track, deltaSeconds);
  const distance = Math.hypot(
    (cluster.x / width - predicted.x) * width,
    (cluster.y / height - predicted.y) * height
  );
  const frameDiagonal = Math.hypot(width, height);
  const searchRadius = Math.max(
    16,
    Math.hypot(track.width, track.height) * 0.82,
    frameDiagonal * 0.045,
    track.uncertainty * frameDiagonal * 2
  );
  if (distance > searchRadius * 2.4) return 0.04;

  const positionScore = Math.exp(-distance / searchRadius);
  const predictedWidth = Math.max(2, track.width);
  const predictedHeight = Math.max(2, track.height);
  const leftA = predicted.x * width - predictedWidth / 2;
  const topA = predicted.y * height - predictedHeight / 2;
  const leftB = cluster.x - cluster.width / 2;
  const topB = cluster.y - cluster.height / 2;
  const intersectionWidth = Math.max(0, Math.min(leftA + predictedWidth, leftB + cluster.width) - Math.max(leftA, leftB));
  const intersectionHeight = Math.max(0, Math.min(topA + predictedHeight, topB + cluster.height) - Math.max(topA, topB));
  const intersection = intersectionWidth * intersectionHeight;
  const union = predictedWidth * predictedHeight + cluster.width * cluster.height - intersection;
  const overlapScore = union > 0 ? intersection / union : 0;
  const sizeSimilarity = Math.min(
    cluster.width * cluster.height,
    predictedWidth * predictedHeight
  ) / Math.max(1, cluster.width * cluster.height, predictedWidth * predictedHeight);
  const shapeSimilarity = Math.exp(-Math.abs(
    Math.log(Math.max(0.05, cluster.width / Math.max(1, cluster.height)) /
      Math.max(0.05, predictedWidth / predictedHeight))
  ) / 0.7);
  const expectedDx = (track.vx + track.ax * deltaSeconds) * width * deltaSeconds;
  const expectedDy = (track.vy + track.ay * deltaSeconds) * height * deltaSeconds;
  const motionSimilarity = Math.exp(-Math.hypot(cluster.dx - expectedDx, cluster.dy - expectedDy) / 12);

  return positionScore * 0.38 + overlapScore * 0.24 +
    sizeSimilarity * 0.10 + shapeSimilarity * 0.08 + motionSimilarity * 0.20;
}

function optimalTrackAssociations(
  tracks: TrackState[],
  clusters: MotionCluster[],
  deltaSeconds: number,
  width: number,
  height: number
) {
  const candidates = [...clusters].sort((a, b) => b.score - a.score).slice(0, 16);
  const memo = new Map<string, { score: number; picks: number[] }>();
  const solve = (trackIndex: number, mask: number): { score: number; picks: number[] } => {
    if (trackIndex >= tracks.length) return { score: 0, picks: [] };
    const key = trackIndex + ':' + mask;
    const cached = memo.get(key);
    if (cached) return cached;
    const skipped = solve(trackIndex + 1, mask);
    let best = { score: skipped.score, picks: [-1, ...skipped.picks] };
    for (let clusterIndex = 0; clusterIndex < candidates.length; clusterIndex += 1) {
      const bit = 1 << clusterIndex;
      if (mask & bit) continue;
      const score = trackAssociation(tracks[trackIndex], candidates[clusterIndex], deltaSeconds, width, height);
      if (score < 0.24) continue;
      const rest = solve(trackIndex + 1, mask | bit);
      const total = score + rest.score;
      if (total > best.score) best = { score: total, picks: [clusterIndex, ...rest.picks] };
    }
    memo.set(key, best);
    return best;
  };
  const plan = solve(0, 0);
  return plan.picks.flatMap((clusterIndex, trackIndex) => clusterIndex < 0 ? [] : [{
    track: tracks[trackIndex],
    cluster: candidates[clusterIndex],
    clusterIndex: clusters.indexOf(candidates[clusterIndex]),
    score: trackAssociation(tracks[trackIndex], candidates[clusterIndex], deltaSeconds, width, height),
  }]);
}

function updateTrack(
  track: TrackState,
  cluster: MotionCluster,
  confidence: number,
  timeSeconds: number,
  width: number,
  height: number
) {
  const deltaSeconds = Math.max(0.05, timeSeconds - track.lastTime);
  const observedX = clamp(cluster.x / width, 0.01, 0.99);
  const observedY = clamp(cluster.y / height, 0.01, 0.99);
  const previousX = track.x;
  const previousY = track.y;
  const previousVelocityX = track.vx;
  const previousVelocityY = track.vy;
  const predicted = predictedPosition(track, deltaSeconds);
  const positionGain = clamp(0.24 + confidence * 0.52, 0.24, 0.78);

  track.x = predicted.x * (1 - positionGain) + observedX * positionGain;
  track.y = predicted.y * (1 - positionGain) + observedY * positionGain;

  const observedVelocityX = (observedX - previousX) / deltaSeconds;
  const observedVelocityY = (observedY - previousY) / deltaSeconds;
  const velocityGain = clamp(0.16 + confidence * 0.34, 0.16, 0.5);
  track.vx = clamp(track.vx * (1 - velocityGain) + observedVelocityX * velocityGain, -2.8, 2.8);
  track.vy = clamp(track.vy * (1 - velocityGain) + observedVelocityY * velocityGain, -2.8, 2.8);
  track.ax = clamp(track.ax * 0.58 + ((track.vx - previousVelocityX) / deltaSeconds) * 0.42, -4, 4);
  track.ay = clamp(track.ay * 0.58 + ((track.vy - previousVelocityY) / deltaSeconds) * 0.42, -4, 4);

  track.width = track.width * 0.62 + cluster.width * 0.38;
  track.height = track.height * 0.62 + cluster.height * 0.38;
  track.uncertainty = clamp(track.uncertainty * (1 - confidence * 0.55) + (1 - confidence) * 0.018, 0.008, 0.45);
  track.age += 1;
  track.missed = 0;
  track.stability = clamp(track.stability * 0.68 + confidence * 0.32, 0, 1);
  track.lastTime = timeSeconds;
}

function makeTrack(
  id: number,
  cluster: MotionCluster,
  confidence: number,
  timeSeconds: number,
  width: number,
  height: number
): TrackState {
  return {
    id,
    x: clamp(cluster.x / width, 0.01, 0.99),
    y: clamp(cluster.y / height, 0.01, 0.99),
    vx: 0,
    vy: 0,
    width: cluster.width,
    height: cluster.height,
    age: 1,
    missed: 0,
    stability: confidence,
    lastTime: timeSeconds,
    ax: 0,
    ay: 0,
    uncertainty: 0.035,
  };
}

function makeEmptyEstimate(
  frame: MotionFrameSignature,
  tracks: TrackState[],
  width: number,
  height: number,
  sceneCut = false,
  trackingGap = false
): MotionEstimate {
  const primary = [...tracks].sort(
    (left, right) => right.stability * Math.min(1, right.age / 8) -
      left.stability * Math.min(1, left.age / 8)
  )[0];

  const predicted = primary ? predictedPosition(primary, 0.75) : { x: 0.5, y: 0.5 };
  return {
    timeSeconds: frame.timeSeconds,
    trackingGap,
    magnitude: 0,
    direction: 'still',
    changedRegionRatio: 0,
    trackX: primary?.x ?? 0.5,
    trackY: primary?.y ?? 0.5,
    confidence: primary ? primary.stability * 0.55 : 0,
    cameraMotionX: 0,
    cameraMotionY: 0,
    subjectMotionX: 0,
    subjectMotionY: 0,
    subjectMotionRatio: 0,
    flowConfidence: 0,
    sceneCut,
    trackId: primary?.id ?? null,
    trackAge: primary?.age ?? 0,
    trackStability: primary?.stability ?? 0,
    trackWidth: primary ? clamp(primary.width / width, 0, 1) : 0,
    trackHeight: primary ? clamp(primary.height / height, 0, 1) : 0,
    occluded: !!primary && primary.missed > 0,
    predictionHorizonSeconds: 0.75,
    predictedTrackX: predicted.x,
    predictedTrackY: predicted.y,
    predictionConfidence: primary ? clamp(primary.stability * Math.exp(-primary.uncertainty * 4) * (primary.missed ? 0.7 : 1), 0, 1) : 0,
    trackUncertainty: primary?.uncertainty ?? 1,
  };
}

/**
 * Smooths a normalized subject path without erasing genuine direction changes.
 * Isolated low-confidence jumps are rejected; the velocity limiter prevents
 * sudden crop snaps while still allowing fast subjects to cross the frame.
 */
export function smoothSubjectPath(points: SubjectPathPoint[]): SubjectPathPoint[] {
  const ordered = points
    .filter(point =>
      Number.isFinite(point.timeSeconds) &&
      Number.isFinite(point.centerX) &&
      Number.isFinite(point.centerY) &&
      Number.isFinite(point.confidence) &&
      point.confidence > 0.05
    )
    .map(point => ({
      timeSeconds: point.timeSeconds,
      centerX: clamp(point.centerX, 0.02, 0.98),
      centerY: clamp(point.centerY, 0.02, 0.98),
      confidence: clamp(point.confidence, 0, 1),
    }))
    .sort((left, right) => left.timeSeconds - right.timeSeconds);

  if (ordered.length <= 2) return ordered;

  const filtered = ordered.map((point, index) => {
    const neighborhood = ordered.slice(Math.max(0, index - 2), Math.min(ordered.length, index + 3));
    const medianX = median(neighborhood.map(item => item.centerX));
    const medianY = median(neighborhood.map(item => item.centerY));
    const deviation = Math.hypot(point.centerX - medianX, point.centerY - medianY);
    const confidenceWeight = clamp(point.confidence, 0.12, 1);
    const outlierWeight = deviation > 0.16
      ? clamp(0.18 + confidenceWeight * 0.35, 0.18, 0.5)
      : clamp(0.48 + confidenceWeight * 0.4, 0.48, 0.88);

    return {
      ...point,
      centerX: point.centerX * outlierWeight + medianX * (1 - outlierWeight),
      centerY: point.centerY * outlierWeight + medianY * (1 - outlierWeight),
    };
  });

  const smoothed: SubjectPathPoint[] = [];
  for (const point of filtered) {
    const previous = smoothed[smoothed.length - 1];
    if (!previous) {
      smoothed.push(point);
      continue;
    }

    const deltaSeconds = Math.max(0.04, point.timeSeconds - previous.timeSeconds);
    const maximumStep = Math.max(0.035, deltaSeconds * 1.8);
    const deltaX = point.centerX - previous.centerX;
    const deltaY = point.centerY - previous.centerY;
    const distance = Math.hypot(deltaX, deltaY);
    const limitedRatio = distance > maximumStep ? maximumStep / distance : 1;
    const smoothingGain = clamp(0.38 + point.confidence * 0.42, 0.38, 0.8);

    smoothed.push({
      ...point,
      centerX: clamp(
        previous.centerX + deltaX * limitedRatio * smoothingGain,
        0.02,
        0.98
      ),
      centerY: clamp(
        previous.centerY + deltaY * limitedRatio * smoothingGain,
        0.02,
        0.98
      ),
    });
  }

  return smoothed;
}

/**
 * Multi-hypothesis motion-region tracking. Several candidate regions are
 * maintained independently; the exported primary track is selected using
 * persistence and confidence rather than whichever patch moves fastest.
 */
export function estimateMotionTimeline(
  frames: MotionFrameSignature[],
  width: number,
  height: number
): MotionEstimate[] {
  if (
    !frames.length ||
    width < 12 ||
    height < 12 ||
    width * height !== frames[0].signature.length ||
    frames.some((frame, index) =>
      !Number.isFinite(frame.timeSeconds) ||
      frame.signature.length !== width * height ||
      (index > 0 && frame.timeSeconds <= frames[index - 1].timeSeconds)
    )
  ) return [];

  const tracks: TrackState[] = [];
  const maximumTracks = 5;
  let nextTrackId = 1;

  return frames.map((frame, index) => {
    if (index === 0) return makeEmptyEstimate(frame, tracks, width, height);

    const previous = frames[index - 1].signature;
    const current = frame.signature;
    if (
      previous.length !== current.length ||
      current.length !== width * height
    ) {
      tracks.length = 0;
      return makeEmptyEstimate(frame, tracks, width, height, true);
    }

    let totalDifference = 0;
    for (let pixel = 0; pixel < current.length; pixel += 1) {
      totalDifference += Math.abs(previous[pixel] - current[pixel]);
    }

    const averageDifference = totalDifference / current.length;
    const cutDistance = histogramDistance(previous, current);
    const spatialCutDistance = spatialHistogramDistance(previous, current, width, height);
    if (
      averageDifference > 42 ||
      (averageDifference > 27 && (cutDistance > 0.46 || spatialCutDistance > 0.54))
    ) {
      tracks.length = 0;
      return makeEmptyEstimate(frame, tracks, width, height, true);
    }

    const deltaSeconds = frame.timeSeconds - frames[index - 1].timeSeconds;
    // A sparse sampling gap is not an occlusion. Reset identity hypotheses rather
    // than extrapolating a visual region across unrelated footage.
    if (deltaSeconds > 2.5) {
      tracks.length = 0;
      return makeEmptyEstimate(frame, tracks, width, height, false, true);
    }

    const coarsePrevious = downsample(previous, width, height);
    const coarseCurrent = downsample(current, width, height);
    const coarseVectors = estimateBlockFlow(
      coarsePrevious.data,
      coarseCurrent.data,
      coarsePrevious.width,
      coarsePrevious.height
    );
    const initialVectors = estimateBlockFlow(
      previous,
      current,
      width,
      height,
      coarseVectors.length >= 3 ? coarseVectors : undefined
    );
    const vectors = enforceForwardBackwardConsistency(
      previous,
      current,
      width,
      height,
      initialVectors
    );
    if (vectors.length < 3) {
      for (let trackIndex = tracks.length - 1; trackIndex >= 0; trackIndex -= 1) {
        const track = tracks[trackIndex];
        track.x = predictedPosition(track, deltaSeconds).x;
        track.y = predictedPosition(track, deltaSeconds).y;
        track.missed += 1;
        track.stability *= 0.82;
        track.uncertainty = clamp(track.uncertainty + deltaSeconds * 0.045, 0.01, 0.5);
        track.vx *= 0.96;
        track.vy *= 0.96;
        track.ax *= 0.65;
        track.ay *= 0.65;
        track.lastTime = frame.timeSeconds;
        if (track.missed > 8 || track.stability < 0.06) tracks.splice(trackIndex, 1);
      }
      return makeEmptyEstimate(frame, tracks, width, height);
    }

    const camera = estimateCameraModel(vectors, width, height);
    const residual = vectors.map(vector => {
      const rx = vector.x - width / 2;
      const ry = vector.y - height / 2;
      const cameraX = camera.tx + camera.zoom * rx - camera.rotation * ry;
      const cameraY = camera.ty + camera.zoom * ry + camera.rotation * rx;
      return {
        ...vector,
        dx: vector.dx - cameraX,
        dy: vector.dy - cameraY,
      };
    }).filter(vector =>
      Math.hypot(vector.dx, vector.dy) >= 0.8 &&
      vector.confidence > 0.09
    );

    const clusters = findMotionClusters(residual);
    const matchedClusterIndexes = new Set<number>();
    const matchedTrackIds = new Set<number>();
    const matched: Array<{
      track: TrackState;
      cluster: MotionCluster;
      confidence: number;
    }> = [];

    // Solve the small multi-target assignment globally instead of greedily.
    // This reduces identity swaps when two moving regions cross or overlap.
    const associations = optimalTrackAssociations(tracks, clusters, deltaSeconds, width, height);

    for (const association of associations) {
      if (
        association.score < 0.16 ||
        matchedTrackIds.has(association.track.id) ||
        matchedClusterIndexes.has(association.clusterIndex)
      ) continue;

      matchedTrackIds.add(association.track.id);
      matchedClusterIndexes.add(association.clusterIndex);
      const confidence = association.cluster.confidence *
        clamp(association.cluster.cells.length / 7, 0, 1) *
        association.score;
      updateTrack(
        association.track,
        association.cluster,
        confidence,
        frame.timeSeconds,
        width,
        height
      );
      matched.push({
        track: association.track,
        cluster: association.cluster,
        confidence,
      });
    }

    for (let trackIndex = tracks.length - 1; trackIndex >= 0; trackIndex -= 1) {
      const track = tracks[trackIndex];
      if (matchedTrackIds.has(track.id)) continue;

      const predicted = predictedPosition(track, deltaSeconds);
      track.x = predicted.x;
      track.y = predicted.y;
      track.missed += 1;
      track.stability *= 0.78;
      track.uncertainty = clamp(track.uncertainty + deltaSeconds * 0.045, 0.01, 0.5);
      track.vx *= 0.96;
      track.vy *= 0.96;
      track.ax *= 0.65;
      track.ay *= 0.65;
      track.lastTime = frame.timeSeconds;
      if (track.missed > 8 || track.stability < 0.06) {
        tracks.splice(trackIndex, 1);
      }
    }

    for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex += 1) {
      if (matchedClusterIndexes.has(clusterIndex)) continue;
      const cluster = clusters[clusterIndex];
      if (
        tracks.length >= maximumTracks ||
        cluster.cells.length < 3 ||
        cluster.confidence < 0.2
      ) continue;

      const confidence = cluster.confidence *
        clamp(cluster.cells.length / 8, 0, 1);
      const track = makeTrack(
        nextTrackId++,
        cluster,
        confidence,
        frame.timeSeconds,
        width,
        height
      );
      tracks.push(track);
      matched.push({ track, cluster, confidence });
      matchedClusterIndexes.add(clusterIndex);
    }

    const primary = [...tracks].sort((left, right) => {
      const leftScore = left.stability *
        (0.35 + Math.min(1, left.age / 10) * 0.65) *
        Math.exp(-left.uncertainty * 3) *
        Math.pow(0.72, left.missed);
      const rightScore = right.stability *
        (0.35 + Math.min(1, right.age / 10) * 0.65) *
        Math.exp(-right.uncertainty * 3) *
        Math.pow(0.72, right.missed);
      return rightScore - leftScore;
    })[0];

    const primaryMatch = primary
      ? matched.find(item => item.track.id === primary.id)
      : undefined;
    const subjectX = primaryMatch?.cluster.dx ?? 0;
    const subjectY = primaryMatch?.cluster.dy ?? 0;
    const subjectMagnitude = Math.min(1, Math.hypot(subjectX, subjectY) / 5);
    const cameraMagnitude = Math.min(1, Math.hypot(camera.tx, camera.ty) / 8);
    const flowConfidence = clamp(
      vectors.reduce((sum, vector) => sum + vector.confidence, 0) /
        vectors.length,
      0,
      1
    );
    const subjectConfidence = primaryMatch?.confidence ?? 0;
    const confidence = Math.max(
      camera.confidence * 0.55,
      subjectConfidence * (primary ? primary.stability : 1)
    );

    const predictionHorizon = clamp(deltaSeconds * 0.75, 0.15, 0.75);
    const predictedPrimary = primary
      ? predictedPosition(primary, predictionHorizon)
      : { x: 0.5, y: 0.5 };

    return {
      timeSeconds: frame.timeSeconds,
      trackingGap: false,
      magnitude: Number(Math.max(
        subjectMagnitude,
        cameraMagnitude * camera.confidence * 0.55
      ).toFixed(3)),
      direction: directionFor(subjectX, subjectY, subjectMagnitude),
      changedRegionRatio: Number(clamp(
        vectors.length / Math.max(1, Math.floor(width / 5) * Math.floor(height / 5)),
        0,
        1
      ).toFixed(3)),
      trackX: Number(clamp(primary?.x ?? 0.5, 0.02, 0.98).toFixed(3)),
      trackY: Number(clamp(primary?.y ?? 0.5, 0.02, 0.98).toFixed(3)),
      confidence: Number(clamp(confidence, 0, 1).toFixed(3)),
      cameraMotionX: Number(clamp(camera.tx / (8 * deltaSeconds), -1, 1).toFixed(3)),
      cameraMotionY: Number(clamp(camera.ty / (8 * deltaSeconds), -1, 1).toFixed(3)),
      subjectMotionX: Number(clamp(subjectX / (5 * deltaSeconds), -1, 1).toFixed(3)),
      subjectMotionY: Number(clamp(subjectY / (5 * deltaSeconds), -1, 1).toFixed(3)),
      subjectMotionRatio: Number(clamp(
        residual.length / Math.max(1, vectors.length),
        0,
        1
      ).toFixed(3)),
      flowConfidence: Number(flowConfidence.toFixed(3)),
      sceneCut: false,
      trackId: primary?.id ?? null,
      trackAge: primary?.age ?? 0,
      trackStability: Number((primary?.stability ?? 0).toFixed(3)),
      trackWidth: Number(clamp((primary?.width ?? 0) / width, 0, 1).toFixed(3)),
      trackHeight: Number(clamp((primary?.height ?? 0) / height, 0, 1).toFixed(3)),
      occluded: !!primary && primary.missed > 0,
      predictionHorizonSeconds: predictionHorizon,
      predictedTrackX: predictedPrimary.x,
      predictedTrackY: predictedPrimary.y,
      predictionConfidence: primary ? clamp(primary.stability * Math.exp(-primary.uncertainty * 4) * (primary.missed ? 0.7 : 1), 0, 1) : 0,
      trackUncertainty: primary?.uncertainty ?? 1,
    };
  });
}
