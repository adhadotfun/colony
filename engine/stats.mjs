/** Small stats kit. No dependencies, so the back-test is auditable line by line. */

export function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export function spearman(xs, ys) {
  if (xs.length < 3) return null;
  return pearson(ranks(xs), ranks(ys));
}

/** Two-sided p-value for a correlation via a permutation test. Deterministic. */
export function permutationP(xs, ys, iters = 5000, seed = 12345) {
  const obs = spearman(xs, ys);
  if (obs === null) return null;
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const y = [...ys];
  let hits = 0;
  for (let it = 0; it < iters; it++) {
    for (let i = y.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [y[i], y[j]] = [y[j], y[i]];
    }
    const r = spearman(xs, y);
    if (r !== null && Math.abs(r) >= Math.abs(obs)) hits++;
  }
  return (hits + 1) / (iters + 1);
}

/** Bootstrap CI over observations, resampled by CLUSTER to respect grouping. */
export function bootstrapCI(clusters, statFn, iters = 2000, seed = 999) {
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const out = [];
  for (let it = 0; it < iters; it++) {
    const pick = [];
    for (let i = 0; i < clusters.length; i++) {
      pick.push(...clusters[Math.floor(rnd() * clusters.length)]);
    }
    const v = statFn(pick);
    if (v !== null && Number.isFinite(v)) out.push(v);
  }
  if (out.length < 20) return null;
  out.sort((a, b) => a - b);
  return [
    +out[Math.floor(out.length * 0.025)].toFixed(3),
    +out[Math.floor(out.length * 0.975)].toFixed(3),
  ];
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
