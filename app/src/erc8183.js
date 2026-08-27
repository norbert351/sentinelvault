// SentinelVault ERC-8183 on-chain proof recorder.
// Binds a verdict on-chain by creating a Telegraph job on the Base Sepolia
// Diamond: the verdict digest is committed as the job's parameter and the job
// settles through the protocol (immutable record). Requires a USDC-funded escrow.
//
// Lifecycle: approve(Diamond) once → depositUSDC once → createJob per verdict.
// Escrow has a 4-hour timelock on withdrawals — deposit only what's needed.
import {
  privateKeyToAccount,
} from 'viem/accounts';
import {
  createWalletClient, createPublicClient, http, encodeAbiParameters,
  keccak256, toHex,
} from 'viem';
import { baseSepolia } from 'viem/chains';

const DIAMOND = '0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8';
const USDC = process.env.SENTINEL_USDC || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RPC = process.env.SENTINEL_RPC || 'https://base-sepolia.publicnode.com';
const DEFAULT_INTENT = process.env.SENTINEL_ERC8183_INTENT || 'CHAT_COMPLETION';

let _clients = null;
async function clients() {
  if (_clients) return _clients;
  const pk = process.env.SENTINEL_PK;
  if (!pk) throw new Error('ERC-8183 recorder requires SENTINEL_PK');
  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  _clients = { account, publicClient, wallet };
  return _clients;
}

function intentId(name) {
  return keccak256(toHex(name));
}

const ERC20_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];
const DIAMOND_ABI = [
  'function depositUSDC(uint256)',
  'function escrowBalance(address) view returns (uint256)',
  'function createJob(bytes32,(address[],uint256[],string[],bool[]),address) returns (uint256)',
];
const ONCHAIN_DATA = [{ type: 'address[]' }, { type: 'uint256[]' }, { type: 'string[]' }, { type: 'bool[]' }];
const ZERO = '0x0000000000000000000000000000000000000000';
const MIN_DEPOSIT = BigInt(1_000_000); // $1 USDC

export async function ensureEscrow() {
  const { account, publicClient, wallet } = await clients();
  const bal = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
  if (bal < MIN_DEPOSIT) throw new Error(`escrow needs USDC on ${account.address}; balance ${Number(bal)}`);
  const allowance = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, DIAMOND] });
  if (allowance < MIN_DEPOSIT) {
    const req = await publicClient.simulateContract({ address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [DIAMOND, BigInt(1_000_000_000_000)], account });
    await wallet.writeContract(req.request);
  }
  const escrow = await publicClient.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'escrowBalance', args: [account.address] });
  if (escrow < MIN_DEPOSIT) {
    const req = await publicClient.simulateContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'depositUSDC', args: [MIN_DEPOSIT], account });
    await wallet.writeContract(req.request);
  }
  return { account, publicClient, wallet };
}

export async function createVerdictJob(digest) {
  const { account, publicClient, wallet } = await ensureEscrow();
  const id = intentId(DEFAULT_INTENT);
  const params = [[], [], [digest], []]; // must be 4-array (addresses,integers,strings,bools)
  // simulate to surface errors before signing
  await publicClient.simulateContract({
    address: DIAMOND, abi: DIAMOND_ABI, functionName: 'createJob', args: [id, params, ZERO], account,
  });
  const txHash = await wallet.writeContract({
    address: DIAMOND, abi: DIAMOND_ABI, functionName: 'createJob', args: [id, params, ZERO],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash, status: receipt.status, network: 'eip155:84532' };
}

export function createErc8183Recorder() {
  return async function recordErc8183({ commit, signals }) {
    try {
      const out = await createVerdictJob(commit);
      return {
        mode: 'erc8183',
        commit,
        ref: out.txHash,
        onChain: out.status === 'success',
        txHash: out.txHash,
        detail: `Verdict digest committed via ERC-8183 createJob on Base Sepolia (${out.txHash})`,
      };
    } catch (e) {
      const ownTxs = (signals || []).map((s) => s.txHash).filter(Boolean);
      return {
        mode: 'erc8183-fallback',
        commit,
        ref: ownTxs[0] || commit.slice(0, 18),
        onChain: ownTxs.length > 0,
        detail: `ERC-8183 createJob failed (${e.message}); recorded ${ownTxs.length} on-chain x402 txs instead.`,
      };
    }
  };
}