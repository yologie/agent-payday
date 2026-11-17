// Agent Payday ($PAYDAY) — pump.fun launch program.
//
// This is the reference implementation of the coin's launch: it uploads the
// coin's metadata (logo + name + symbol + description + website) to pump.fun's
// IPFS endpoint, then builds and sends the pump.fun `create` transaction (with
// an optional initial `buy` in the same transaction), and writes LAUNCH.json at
// the repository root with the coin's mint and the create transaction's base58
// signature. Run it ONCE, from this repository, before the bounty deadline.
//
//   LAUNCH_KEYPAIR=/path/to/keypair.json node launch.ts
//   BUY_SOL=0.01 SOLANA_RPC=https://api.mainnet-beta.solana.com node launch.ts
//   LAUNCH_KEYPAIR=/path/to/keypair.json node launch.ts --dry-run
//
// The signing keypair comes from LAUNCH_KEYPAIR (a solana-keygen JSON file, the
// wallet linked to the make.fun account). It is read, never printed, never
// written anywhere, and never committed. The launch is a real on-chain
// transaction on Solana mainnet: it costs the create fee and rent plus the
// optional initial buy. --dry-run builds the transaction and prints the mint
// and sizes without sending anything (fully offline).
//
// The coin's owner may instead perform the exact same steps on the pump.fun
// website from the linked wallet (upload logo.png, paste the metadata from
// README.md, create the coin) and then fill LAUNCH.json by hand with the mint
// and the create transaction's signature.
//
// Requires: npm install (see package.json). Node 22.
//
// Implementation notes (verified against the pump.fun program IDL published
// with the pumpdotfun-sdk, program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P):
// - `create` discriminator is sha256("global:create")[0..8]; `buy` is
//   sha256("global:buy")[0..8]. Anchor strings are u32-LE length + UTF-8.
// - create accounts, in IDL order: mint (signer), mint-authority PDA,
//   bonding-curve PDA, associated bonding curve, global PDA, Metaplex metadata
//   program, metadata PDA, user, system program, token program, associated
//   token program, rent, event-authority PDA, program.
// - buy accounts, in IDL order: global, fee recipient, mint, bonding curve,
//   associated bonding curve, associated user, user, system program, token
//   program, rent, event-authority PDA, program.
// - The initial buy price comes from the global account's bonding-curve
//   reserves (getInitialBuyPrice), exactly as the SDK computes it.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const LAMPORTS_PER_SOL = 1_000_000_000n;

const COIN = {
  name: 'Agent Payday',
  symbol: 'PAYDAY',
  description:
    'Agent Payday ($PAYDAY) — made for the make.fun bounty https://make.fun/bounty/makefun-coin-promo-01. make.fun is where AI agents earn real USDC by winning coding bounties — your agent works while you sleep, and every day is payday. This coin is the mascot of agent income.',
  website: 'https://make.fun/bounty/makefun-coin-promo-01',
};

function discriminator(label: string): Buffer {
  return createHash('sha256').update(`global:${label}`).digest().subarray(0, 8);
}

function anchorString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function loadKeypair(path: string): Keypair {
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
  return Keypair.fromSecretKey(secret);
}

/** Parse the pump.fun global account: fee recipient + initial bonding-curve reserves. */
function parseGlobalAccount(data: Buffer): {
  feeRecipient: PublicKey;
  initialVirtualTokenReserves: bigint;
  initialVirtualSolReserves: bigint;
  initialRealTokenReserves: bigint;
} {
  // Layout: discriminator u64 (0), initialized bool (8), authority pubkey (9),
  // feeRecipient pubkey (41), initialVirtualTokenReserves u64 (73),
  // initialVirtualSolReserves u64 (81), initialRealTokenReserves u64 (89).
  return {
    feeRecipient: new PublicKey(data.subarray(41, 73)),
    initialVirtualTokenReserves: data.readBigUInt64LE(73),
    initialVirtualSolReserves: data.readBigUInt64LE(81),
    initialRealTokenReserves: data.readBigUInt64LE(89),
  };
}

/** Token amount a fresh bonding curve pays for `solLamports` of SOL (SDK formula). */
function getInitialBuyPrice(
  solLamports: bigint,
  virtSol: bigint,
  virtToken: bigint,
  realToken: bigint,
): bigint {
  if (solLamports <= 0n) return 0n;
  const n = virtSol * virtToken;
  const i = virtSol + solLamports;
  const r = n / i + 1n;
  const s = virtToken - r;
  return s < realToken ? s : realToken;
}

async function uploadMetadata(
  logoPath: string,
): Promise<string> {
  const logo = readFileSync(logoPath);
  const form = new FormData();
  form.append('file', new Blob([logo], { type: 'image/png' }), 'logo.png');
  form.append('name', COIN.name);
  form.append('symbol', COIN.symbol);
  form.append('description', COIN.description);
  form.append('twitter', '');
  form.append('telegram', '');
  form.append('website', COIN.website);
  form.append('showName', 'true');

  const res = await fetch('https://pump.fun/api/ipfs', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`metadata upload failed: HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { metadataUri?: string };
  if (!json.metadataUri) {
    throw new Error(`metadata upload returned no metadataUri: ${JSON.stringify(json)}`);
  }
  return json.metadataUri;
}

function buildCreateInstruction(
  creator: PublicKey,
  mint: PublicKey,
  metadataUri: string,
): TransactionInstruction {
  const mintAuthority = pda([Buffer.from('mint-authority')], PUMP_PROGRAM_ID);
  const bondingCurve = pda([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM_ID);
  const global = pda([Buffer.from('global')], PUMP_PROGRAM_ID);
  const eventAuthority = pda([Buffer.from('__event_authority')], PUMP_PROGRAM_ID);
  const metadata = pda(
    [Buffer.from('metadata'), MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA_PROGRAM_ID,
  );
  const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);

  const data = Buffer.concat([
    discriminator('create'),
    anchorString(COIN.name),
    anchorString(COIN.symbol),
    anchorString(metadataUri),
    creator.toBuffer(),
  ]);

  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: true, isWritable: true },
      { pubkey: mintAuthority, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: MPL_TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: creator, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function buildBuyInstruction(
  connection: Connection,
  buyer: PublicKey,
  mint: PublicKey,
  buySolLamports: bigint,
  slippageBps: bigint,
): Promise<TransactionInstruction> {
  const global = pda([Buffer.from('global')], PUMP_PROGRAM_ID);
  const globalInfo = await connection.getAccountInfo(global);
  if (!globalInfo) throw new Error('pump.fun global account not found');
  const { feeRecipient, initialVirtualTokenReserves, initialVirtualSolReserves, initialRealTokenReserves } =
    parseGlobalAccount(globalInfo.data);
  const amount = getInitialBuyPrice(
    buySolLamports,
    initialVirtualSolReserves,
    initialVirtualTokenReserves,
    initialRealTokenReserves,
  );
  const maxSolCost = buySolLamports + (buySolLamports * slippageBps) / 10_000n;

  const bondingCurve = pda([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM_ID);
  const eventAuthority = pda([Buffer.from('__event_authority')], PUMP_PROGRAM_ID);
  const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
  const associatedUser = getAssociatedTokenAddressSync(mint, buyer, false);

  const data = Buffer.concat([discriminator('buy'), u64(amount), u64(maxSolCost)]);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedUser, isSigner: false, isWritable: true },
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// getAssociatedTokenAddress is async in @solana/spl-token; wrap the sync PDA math
// directly so the dry-run path needs no RPC.
function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve: boolean,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const keypairPath = process.env.LAUNCH_KEYPAIR;
  if (!keypairPath) {
    console.error('LAUNCH_KEYPAIR is required: path to the solana-keygen JSON keypair of the linked wallet.');
    process.exit(1);
  }
  const creator = loadKeypair(keypairPath);
  const repoDir = dirname(fileURLToPath(import.meta.url));
  const logoPath = join(repoDir, 'logo.png');
  const buySol = Number(process.env.BUY_SOL ?? '0');
  const slippageBps = BigInt(process.env.SLIPPAGE_BPS ?? '500');
  const rpc = process.env.SOLANA_RPC ?? DEFAULT_RPC;

  const mint = Keypair.generate();
  const mintPubkey = mint.publicKey.toBase58();

  const metadataUri = dryRun ? 'ipfs://dry-run-placeholder' : await uploadMetadata(logoPath);
  console.log(`mint: ${mintPubkey}`);
  console.log(`metadata: ${metadataUri}`);

  const tx = new Transaction();
  tx.add(buildCreateInstruction(creator.publicKey, mint.publicKey, metadataUri));

  if (buySol > 0) {
    if (dryRun) {
      console.log('dry-run: initial buy skipped (BUY_SOL set, not built offline)');
    } else {
      const connection = new Connection(rpc, 'confirmed');
      const buyLamports = BigInt(Math.round(buySol * 1_000_000_000));
      tx.add(
        await buildBuyInstruction(connection, creator.publicKey, mint.publicKey, buyLamports, slippageBps),
      );
      console.log(`initial buy: ${buySol} SOL`);
    }
  }

  if (dryRun) {
    tx.feePayer = creator.publicKey;
    tx.recentBlockhash = '11111111111111111111111111111111';
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    console.log(`dry-run: ${tx.instructions.length} instruction(s), ${serialized.length} bytes serialized, nothing sent`);
    console.log('dry-run: LAUNCH.json not written');
    return;
  }

  const connection = new Connection(rpc, 'confirmed');
  const signature = await connection.sendTransaction(tx, [creator, mint], {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(signature, 'confirmed');
  console.log(`create signature: ${signature}`);

  const launch = { mint: mintPubkey, create_signature: signature };
  const base58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
  if (!base58.test(launch.mint) || launch.mint.length < 32 || launch.mint.length > 44) {
    throw new Error(`mint failed validation: ${launch.mint}`);
  }
  if (!base58.test(launch.create_signature) || launch.create_signature.length < 64 || launch.create_signature.length > 88) {
    throw new Error(`create signature failed validation: ${launch.create_signature}`);
  }
  writeFileSync(join(repoDir, 'LAUNCH.json'), `${JSON.stringify(launch, null, 2)}\n`);
  console.log('LAUNCH.json written');
}

main().catch((err) => {
  console.error(`launch failed: ${(err as Error).message}`);
  process.exit(1);
});
