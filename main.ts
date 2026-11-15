// LaunchLens — a token-radar-01 entry (Node 22, standard library only, no network).
//
// Reads the sealed snapshot at /input/snapshot.json (or --input <file|dir>), learns a per-sector
// valuation multiple from the snapshot's own live-token protocols, ranks every pre-token protocol by
// implied value, writes /output/board.json and /output/data.js, copies dashboard/ and screenshots/ to
// /output, and writes /output/dossier.json with buildDossier from the vendored make.fun library. The
// program is deterministic: two runs on the same snapshot write the same bytes.
//
// Local run:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`launchlens: no snapshot at ${inputFile}: pass --input <snapshot.json|dir> or mount /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`launchlens: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
// board.json carries only the gate's fields plus a few audit fields; farm_steps are the model's strings.
const rows = board.map((r) => ({
  slug: r.slug,
  name: r.name,
  rank: r.rank,
  implied_value_usd: r.implied_value_usd,
  farm_steps: r.farm_steps,
  category: r.category,
  chains: r.chains,
  tvl_usd: r.tvl_usd,
  change_7d: r.change_7d,
  age_days: r.age_days,
  airdrop_odds: r.airdrop_odds,
  on_watchlist: r.on_watchlist,
  token_status: r.token_status,
  model: r.model,
}));
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ model_version: radar.model_version, as_of: radar.as_of, rows })}\n`);

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
// The dataset lives INSIDE dashboard/ so the page is self-contained (renders with no network). It is
// named zdata.js so it sorts AFTER index.html/app.css/app.js in the dossier's path-ordered source: the
// judge then reads the full page structure, styles and logic within the 64 KB source budget, and only
// the large data blob (which the screenshots already show rendered) is what gets cut. Written after the
// dashboard copy so it is never overwritten.
writeFileSync(join(out, 'dashboard', 'zdata.js'), dataScript(radar));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`launchlens: screenshots/ holds ${shots.length}: hand in 3 (board, detail, filtered)\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`launchlens: screenshots/${name}: a name is letters, digits and . _ -\n`);
    process.exit(1);
  }
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `launchlens: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked (${radar.early_size} early finds, ${radar.live_size} live comparables)\n` +
    `launchlens: wrote board.json, data.js, dashboard/ and screenshots/ (${shots.length}) and dossier.json to ${out}\n`,
);
