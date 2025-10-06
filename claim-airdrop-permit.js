import fs from 'fs';
import { createPublicClient, createWalletClient, http, getAddress, encodeFunctionData, parseAbiItem, hexToBigInt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import 'dotenv/config';
import chalk from 'chalk';

// --- CONFIGURATION ---
const AIRDROP_CONTRACT_ADDRESS = getAddress(process.env.AIRDROP_CONTRACT_ADDRESS);
const TOKEN_ADDRESS = getAddress(process.env.TOKEN_ADDRESS);
const PERMIT_CONTRACT_ADDRESS = getAddress(process.env.PERMIT_CONTRACT_ADDRESS);
const RELAYER_PK = process.env.SECURE;
const RPC_URLS = process.env.RPC_HTTP_URLS.split(',').map(url => url.trim());
const CLAIM_FUNCTION_HEX = process.env.CLAIM_FUNCTION_HEX;
const GAS_MULTIPLIER = parseFloat(process.env.GAS_MULTIPLIER || '1.2');
const GAS_PRIORITY_MULTIPLIER = parseFloat(process.env.GAS_PRIORITY_MULTIPLIER || '1.5');
const INFURA_RPC_URL = process.env.INFURA_RPC_URL;

if (!CLAIM_FUNCTION_HEX || !TOKEN_ADDRESS || !PERMIT_CONTRACT_ADDRESS || RPC_URLS.length === 0 || !INFURA_RPC_URL) {
    throw new Error('Critical environment variables are missing. Make sure to define RPC_HTTP_URLS and INFURA_RPC_URL.');
}

const relayerAccount = privateKeyToAccount(RELAYER_PK);
const RELAYER_ADDRESS = relayerAccount.address;

let currentRpcIndex = 0;
let publicClient;
let infuraClient;
let chain;

function rotateRpc() {
    currentRpcIndex = (currentRpcIndex + 1) % RPC_URLS.length;
    const newRpcUrl = RPC_URLS[currentRpcIndex];
    publicClient = createPublicClient({ chain, transport: http(newRpcUrl) });
    console.log(chalk.bgYellow.black(`\n[RPC] Rotating to write RPC: ${newRpcUrl}\n`));
}

// --- ABIs ---
const AIRDROP_ABI = [{ name: 'calculateAllocation', type: 'function', stateMutability: 'view', inputs: [{ name: '_account', type: 'address' }], outputs: [{ name: 'tokenAllocation', type: 'uint256' }] }];
const TOKEN_ABI = [ { name: 'nonces', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }, { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] }];
const PERMIT_HELPER_ABI = [{ name: 'rescueWithPermit', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'tokenContract', type: 'address' }, { name: 'compromisedWallet', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }] }];

async function estimateLineaGasFees(tx, fallbackGasLimit) {
    try {
        const response = await infuraClient.request({ method: 'linea_estimateGas', params: [tx] });
        const baseFee = hexToBigInt(response.baseFeePerGas);
        const priorityFee = hexToBigInt(response.priorityFeePerGas);
        const gasLimit = hexToBigInt(response.gasLimit);
        const competitivePriorityFee = BigInt(Math.floor(Number(priorityFee) * GAS_PRIORITY_MULTIPLIER));
        const competitiveMaxFee = BigInt(Math.floor(Number(baseFee) * GAS_MULTIPLIER)) + competitivePriorityFee;
        return { gas: gasLimit, maxFeePerGas: competitiveMaxFee, maxPriorityFeePerGas: competitivePriorityFee };
    } catch (error) {
        console.warn(chalk.yellow(`   - ⚠️ linea_estimateGas failed, using standard method. Reason: ${error.details || error.message.split('\n')[0]}`));
        const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
        return { gas: fallbackGasLimit, maxFeePerGas, maxPriorityFeePerGas };
    }
}

async function executeAtomicRescue(wallet) {
    const { pk, address: COMPROMISED_ADDRESS, amount: amountToClaim } = wallet;
    const compromisedAccount = privateKeyToAccount(pk);
    
    const currentWriterRpc = RPC_URLS[currentRpcIndex];
    const relayerWalletClient = createWalletClient({ account: relayerAccount, chain, transport: http(currentWriterRpc) });
    const compromisedWalletClient = createWalletClient({ account: compromisedAccount, chain, transport: http(currentWriterRpc) });

    console.log(chalk.yellow(`\n🚀 Starting flow for: ${COMPROMISED_ADDRESS} | Amount: ${amountToClaim.toString()}`));

    try {
        console.log(chalk.blue('   - [Step 1/4] Verifying allocation...'));
        const currentAllocation = await publicClient.readContract({ address: AIRDROP_CONTRACT_ADDRESS, abi: AIRDROP_ABI, functionName: 'calculateAllocation', args: [COMPROMISED_ADDRESS] });
        if (currentAllocation < amountToClaim) {
            console.log(chalk.red.bold(`   - ABORTED: Insufficient allocation.`));
            return;
        }

        console.log('   - [Step 2/4] Fetching nonces and preparing signatures...');
        const [relayerNonce, compromisedNonce, tokenName, permitNonce] = await Promise.all([
            publicClient.getTransactionCount({ address: RELAYER_ADDRESS, blockTag: 'pending' }),
            publicClient.getTransactionCount({ address: COMPROMISED_ADDRESS, blockTag: 'pending' }),
            publicClient.readContract({ address: TOKEN_ADDRESS, abi: TOKEN_ABI, functionName: 'name' }),
            publicClient.readContract({ address: TOKEN_ADDRESS, abi: TOKEN_ABI, functionName: 'nonces', args: [COMPROMISED_ADDRESS] }),
        ]);

        // --- FIX: Move the deadline declaration and signature BEFORE gas estimation ---
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const signatureRaw = await compromisedAccount.signTypedData({
            domain: { name: tokenName, version: '1', chainId: chain.id, verifyingContract: TOKEN_ADDRESS },
            types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
            primaryType: 'Permit',
            message: { owner: COMPROMISED_ADDRESS, spender: PERMIT_CONTRACT_ADDRESS, value: amountToClaim, nonce: permitNonce, deadline },
        });
        const signature = { r: signatureRaw.slice(0, 66), s: `0x${signatureRaw.slice(66, 130)}`, v: parseInt(`0x${signatureRaw.slice(130, 132)}`) };

        console.log('   - [Step 3/4] Estimating precise gas for the burst...');
        
        const extractTxTemplate = { from: RELAYER_ADDRESS, to: PERMIT_CONTRACT_ADDRESS, data: encodeFunctionData({ abi: PERMIT_HELPER_ABI, functionName: 'rescueWithPermit', args: [TOKEN_ADDRESS, COMPROMISED_ADDRESS, amountToClaim, deadline, signature.v, signature.r, signature.s] }) };
        const extractGas = await estimateLineaGasFees(extractTxTemplate, 150000n);

        const claimGasLimit = 120000n;
        const claimGasFees = { maxFeePerGas: extractGas.maxFeePerGas, maxPriorityFeePerGas: extractGas.maxPriorityFeePerGas };
        
        const gasToSend = claimGasLimit * claimGasFees.maxFeePerGas;
        const gasTxGas = await estimateLineaGasFees({ from: RELAYER_ADDRESS, to: COMPROMISED_ADDRESS, value: gasToSend }, 21000n);

        const gasTxRequest = { to: COMPROMISED_ADDRESS, value: gasToSend, nonce: relayerNonce, ...gasTxGas };
        const claimTxRequest = { to: AIRDROP_CONTRACT_ADDRESS, data: CLAIM_FUNCTION_HEX, nonce: compromisedNonce, gas: claimGasLimit, ...claimGasFees };
        const extractTxRequest = { to: PERMIT_CONTRACT_ADDRESS, data: extractTxTemplate.data, nonce: relayerNonce + 1, ...extractGas };
        
        console.log(chalk.red('   - [Step 4/4] Sending atomic burst of 3 transactions!'));
        const [gasTxHash, claimTxHash, extractTxHash] = await Promise.all([
            relayerWalletClient.sendTransaction(gasTxRequest),
            compromisedWalletClient.sendTransaction(claimTxRequest),
            relayerWalletClient.sendTransaction(extractTxRequest)
        ]);
        
        console.log(chalk.magenta('   - Transactions sent. Awaiting results...'));
        const [claimRes, extractRes] = await Promise.allSettled([
            publicClient.waitForTransactionReceipt({ hash: claimTxHash, timeout: 90_000 }),
            publicClient.waitForTransactionReceipt({ hash: extractTxHash, timeout: 90_000 })
        ]);
        
        console.log(chalk.bold.underline(`\n--- Final Report for ${COMPROMISED_ADDRESS} ---`));
        console.log(`2. Claim: ${claimRes.status === 'fulfilled' && claimRes.value.status === 'success' ? chalk.greenBright('SUCCESS') : chalk.red('FAILURE')}`);
        console.log(`3. Extraction: ${extractRes.status === 'fulfilled' && extractRes.value.status === 'success' ? chalk.greenBright('SUCCESS') : chalk.red('FAILURE')}`);
        
    } catch (error) {
        console.error(chalk.red(`💥 Critical error for ${COMPROMISED_ADDRESS}: ${error.message}`));
        if (error.message.includes('RPC') || error.message.includes('rate limit')) rotateRpc();
    }
}

async function main() {
    console.log(chalk.bold.cyan('--- Initializing Final Rescue Bot (Dual RPC Architecture) ---'));
    
    const initialRpc = RPC_URLS[0];
    const tempPublicClient = createPublicClient({ transport: http(initialRpc) });
    chain = { id: await tempPublicClient.getChainId() };
    
    publicClient = createPublicClient({ chain, transport: http(initialRpc) });
    infuraClient = createPublicClient({ chain, transport: http(INFURA_RPC_URL) });

    console.log(chalk.blue(`Network detected with Chain ID: ${chain.id}`));
    console.log(chalk.blue(`Main Write RPC: ${initialRpc}`));
    console.log(chalk.blue(`Estimation RPC (Infura): ${INFURA_RPC_URL}`));

    const allocations = JSON.parse(fs.readFileSync('allocations.json', 'utf-8'));
    const privateKeys = fs.readFileSync('pk.txt', 'utf-8').split('\n').map(k => k.trim()).filter(Boolean);
    const walletsToProcess = [];
    for (const pk of privateKeys) {
        const address = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`).address;
        if (allocations[address] && BigInt(allocations[address]) > 0n) {
            walletsToProcess.push({ pk: pk.startsWith('0x') ? pk : `0x${pk}`, address, amount: BigInt(allocations[address]) });
        }
    }
    
    if (walletsToProcess.length === 0) {
        console.log(chalk.yellow('No wallets in pk.txt with allocations found. Waiting for contract funding...'));
    } else {
        console.log(chalk.blue(`Will process ${walletsToProcess.length} wallets once funding is detected.`));
    }

    console.log(chalk.magenta.bold('\n[LISTENER MODE] Waiting for funds transfer to the Airdrop contract...'));
    publicClient.watchContractEvent({
        address: TOKEN_ADDRESS,
        event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
        args: { to: AIRDROP_CONTRACT_ADDRESS },
        onLogs: async (logs) => {
            console.log(chalk.bgGreen.black.bold(`\n!! EVENT DETECTED: Airdrop contract has been funded !!\n`));
            
            for (const wallet of walletsToProcess) {
                await executeAtomicRescue(wallet);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            console.log(chalk.magenta('\n--- Rescue cycle completed. Returning to listener mode. ---'));
        },
        onError: (error) => {
            console.error(chalk.red('[LISTENER ERROR]', error.message));
            rotateRpc();
        }
    });
}

main();
