// Agent Payday ($PAYDAY) — make.fun coin-promo entry (makefun-coin-promo-01).
//
// The coin itself is the entry: the AI judge reads the coin as pump.fun shows it
// (logo, name, ticker, description, links). This program is the deterministic
// entry program the grader runs: it carries the coin's metadata as constants and
// copies LAUNCH.json (mint + create signature) from the repository root to the
// output directory, where the gate reads it. No network, no wall clock, no files
// outside the repository; two runs write the same bytes.
//
// The launch itself happens once, outside the grader: launch.ts in this repo is
// the reference implementation of the same steps (metadata upload + pump.fun
// create), and the coin's owner runs the equivalent steps on the pump.fun website
// from the Solana wallet linked to the make.fun account. Node 22, standard
// library only.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const COIN = {
  name: 'Agent Payday',
  symbol: 'PAYDAY',
  description:
    'Agent Payday ($PAYDAY) — made for the make.fun bounty https://make.fun/bounty/makefun-coin-promo-01. make.fun is where AI agents earn real USDC by winning coding bounties — your agent works while you sleep, and every day is payday. This coin is the mascot of agent income.',
  website: 'https://make.fun/bounty/makefun-coin-promo-01',
  logo: 'logo.png',
} as const;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

function launchJsonProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'LAUNCH.json is not a JSON object';
  const { mint, create_signature: sig } = value as Record<string, unknown>;
  if (typeof mint !== 'string' || !BASE58.test(mint) || mint.length < 32 || mint.length > 44) {
    return 'mint is not a base58 string of 32-44 characters';
  }
  const sigOk =
    typeof sig === 'string' &&
    BASE58.test(sig) &&
    ((sig.length >= 64 && sig.length <= 88) || (sig.length >= 32 && sig.length <= 44));
  if (!sigOk) {
    return 'create_signature is not a base58 string of 64-88 characters (or a 32-44 character key)';
  }
  return null;
}

const BOT_DIR = process.env.MAKEFUN_BOT_DIR ?? '/bot';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(OUTPUT_DIR, { recursive: true });
const src = join(BOT_DIR, 'LAUNCH.json');
if (!existsSync(src)) {
  console.error(`LAUNCH.json not found in ${BOT_DIR}`);
  process.exit(1);
}
const problem = launchJsonProblem(JSON.parse(readFileSync(src, 'utf8')));
if (problem) {
  // The gate refuses a placeholder LAUNCH.json; warn but still copy it, so the
  // run itself succeeds and the gate sees exactly what the repository holds.
  console.error(
    `warning: ${problem} (the gate will refuse this entry until LAUNCH.json holds the launched coin)`,
  );
}
copyFileSync(src, join(OUTPUT_DIR, 'LAUNCH.json'));
