/**
 * DataVersion → Minecraft Java release. Only release milestones are listed; values between two
 * entries are snapshots/pre-releases of the next version and are shown approximately.
 * Source: minecraft.wiki "Data version". Extend when new versions ship.
 */
const RELEASES: [number, string][] = [
  [100, '15w32a'],
  [169, '1.9'],
  [184, '1.9.4'],
  [510, '1.10'],
  [512, '1.10.2'],
  [819, '1.11'],
  [922, '1.11.2'],
  [1139, '1.12'],
  [1343, '1.12.2'],
  [1519, '1.13'],
  [1631, '1.13.2'],
  [1952, '1.14'],
  [1976, '1.14.4'],
  [2225, '1.15'],
  [2230, '1.15.2'],
  [2566, '1.16'],
  [2586, '1.16.5'],
  [2724, '1.17'],
  [2730, '1.17.1'],
  [2860, '1.18'],
  [2865, '1.18.1'],
  [2975, '1.18.2'],
  [3105, '1.19'],
  [3120, '1.19.2'],
  [3218, '1.19.3'],
  [3337, '1.19.4'],
  [3463, '1.20'],
  [3465, '1.20.1'],
  [3578, '1.20.2'],
  [3698, '1.20.3'],
  [3700, '1.20.4'],
  [3837, '1.20.5'],
  [3839, '1.20.6'],
  [3953, '1.21'],
  [3955, '1.21.1'],
  [4080, '1.21.2'],
  [4082, '1.21.3'],
  [4189, '1.21.4'],
  [4325, '1.21.5'],
  [4435, '1.21.6'],
  [4438, '1.21.7'],
  [4440, '1.21.8'],
];

export function describeDataVersion(dv: number): string {
  let lo = 0, hi = RELEASES.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (RELEASES[mid][0] <= dv) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return 'pre-1.9';
  const [v, name] = RELEASES[best];
  if (v === dv) return name;
  if (best === RELEASES.length - 1) return `newer than ${name}`;
  return `${name}+ (snapshot)`;
}
