import fs from 'fs';
import { createPublicClient, createWalletClient, http, getAddress, encodeFunctionData, parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import 'dotenv/config';
import chalk from 'chalk';

// --- CONFIGURATION ---
const AIRDROP_CONTRACT_ADDRESS = getAddress(process.env.AIRDROP_CONTRACT_ADDRESS);
const RELAYER_PK = process.env.SECURE; // Your secure wallet's private key
const RPC_URLS = process.env.RPC_HTTP_URLS.split(',').map(url => url.trim());
const CLAIM_FUNCTION_HEX = process.env.CLAIM_FUNCTION_HEX; // The function signature for the claim
const GAS_MULTIPLIER = parseFloat(process.env.GAS_MULTIPLIER || '1.2');
const GAS_PRIORITY_MULTIPLIER = parseFloat(process.env.GAS_PRIORITY_MULTIPLIER || '1.5');
const MIN_FUNDING_THRESHOLD = parseGwei(process.env.MIN_FUNDING_THRESHOLD_GWEI || '0.1'); // Minimum ETH balance on airdrop contract to trigger rescues

if (!CLAIM_FUNCTION_HEX || !AIRDROP_CONTRACT_ADDRESS || RPC_URLS.length === 0 || !RELAYER_PK) {
    throw new Error('Critical environment variables are missing. Please check your .env file.');
}

const relayerAccount = privateKeyToAccount(RELAYER_PK);
const RELAYER_ADDRESS = relayerAccount.address;

let currentRpcIndex = 0;
let publicClient;
let chain;

function rotateRpc() {
    currentRpcIndex = (currentRpcIndex + 1) % RPC_URLS.length;
    const newRpcUrl = RPC_URLS[currentRpcIndex];
    publicClient = createPublicClient({ chain, transport: http(newRpcUrl) });
    console.log(chalk.bgYellow.black(`\n[RPC] Rotating to write RPC: ${newRpcUrl}\n`));
}

// --- ABIs ---
// We only need the ABI to check the allocation. No token or permit ABIs are needed.
const AIRDROP_ABI = [{ name: 'calculateAllocation', type: 'function', stateMutability: 'view', inputs: [{ name: '_account', type: 'address' }], outputs: [{ name: 'nativeTokenAllocation', type: 'uint256' }] }];

// This function remains the same, as competitive gas estimation is still crucial.
async function estimateCompetitiveGas(tx, fallbackGasLimit) {
    try {
        const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
        const gas = await publicClient.estimateGas({ ...tx, account: relayerAccount });
        const competitivePriorityFee = BigInt(Math.floor(Number(maxPriorityFeePerGas) * GAS_PRIORITY_MULTIPLIER));
        const competitiveMaxFee = BigInt(Math.floor(Number(maxFeePerGas) * GAS_MULTIPLIER)) + competitivePriorityFee;
        return { gas, maxFeePerGas: competitiveMaxFee, maxPriorityFeePerGas: competitivePriorityFee };
    } catch (error) {
        console.warn(chalk.yellow(`   - ⚠️ Gas estimation failed, using fallback. Reason: ${error.details || error.message.split('\n')[0]}`));
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

    console.log(chalk.yellow(`\n🚀 Starting native token rescue for: ${COMPROMISED_ADDRESS} | Amount: ${amountToClaim.toString()}`));

    try {
        console.log(chalk.blue('   - [Step 1/3] Verifying allocation...'));
        const currentAllocation = await publicClient.readContract({ address: AIRDROP_CONTRACT_ADDRESS, abi: AIRDROP_ABI, functionName: 'calculateAllocation', args: [COMPROMISED_ADDRESS] });
        if (currentAllocation < amountToClaim) {
            console.log(chalk.red.bold(`   - ABORTED: Insufficient allocation.`));
            return;
        }

        console.log('   - [Step 2/3] Fetching nonces and estimating gas for the burst...');
        const [relayerNonce, compromisedNonce] = await Promise.all([
            publicClient.getTransactionCount({ address: RELAYER_ADDRESS, blockTag: 'pending' }),
            publicClient.getTransactionCount({ address: COMPROMISED_ADDRESS, blockTag: 'pending' }),
        ]);

        // Estimate gas for the two transactions that will be sent from the compromised wallet
        const claimTxTemplate = { from: COMPROMISED_ADDRESS, to: AIRDROP_CONTRACT_ADDRESS, data: CLAIM_FUNCTION_HEX };
        const claimGas = await estimateCompetitiveGas(claimTxTemplate, 120000n);

        const extractTxTemplate = { from: COMPROMISED_ADDRESS, to: RELAYER_ADDRESS, value: amountToClaim };
        const extractGas = await estimateCompetitiveGas(extractTxTemplate, 21000n);

        // Calculate the total gas cost needed on the compromised wallet
        const claimGasCost = claimGas.gas * claimGas.maxFeePerGas;
        const extractGasCost = extractGas.gas * extractGas.maxFeePerGas;
        const totalGasToSend = claimGasCost + extractGasCost;

        // The final extraction amount will be the full claim amount minus the gas for the extraction transaction itself.
        const amountToExtract = amountToClaim - extractGasCost;
        if (amountToExtract <= 0n) {
            console.log(chalk.red.bold(`   - ABORTED: Claim amount is too small to cover extraction gas.`));
            return;
        }

        // Prepare the 3 atomic transactions
        const gasTxRequest = { to: COMPROMISED_ADDRESS, value: totalGasToSend, nonce: relayerNonce, ...(await estimateCompetitiveGas({ from: RELAYER_ADDRESS, to: COMPROMISED_ADDRESS, value: totalGasToSend }, 21000n)) };
        const claimTxRequest = { to: AIRDROP_CONTRACT_ADDRESS, data: CLAIM_FUNCTION_HEX, nonce: compromisedNonce, ...claimGas };
        const extractTxRequest = { to: RELAYER_ADDRESS, value: amountToExtract, nonce: compromisedNonce + 1, ...extractGas };

        console.log(chalk.red('   - [Step 3/3] Sending atomic burst of 3 transactions!'));
        const [gasTxHash, claimTxHash, extractTxHash] = await Promise.all([
            relayerWalletClient.sendTransaction(gasTxRequest),
            compromisedWalletClient.sendTransaction(claimTxRequest),
            relayerWalletClient.sendTransaction(extractTxRequest) // Note: The extraction is also sent by the relayer, but it's signed by the compromised wallet client.
        ]);

        console.log(chalk.magenta('   - Transactions sent. Awaiting results...'));
        const [claimRes, extractRes] = await Promise.allSettled([
            publicClient.waitForTransactionReceipt({ hash: claimTxHash, timeout: 90_000 }),
            publicClient.waitForTransactionReceipt({ hash: extractTxHash, timeout: 90_000 })
        ]);

        console.log(chalk.bold.underline(`\n--- Final Report for ${COMPROMISED_ADDRESS} ---`));
        console.log(`1. Claim: ${claimRes.status === 'fulfilled' && claimRes.value.status === 'success' ? chalk.greenBright('SUCCESS') : chalk.red('FAILURE')}`);
        console.log(`2. Extraction: ${extractRes.status === 'fulfilled' && extractRes.value.status === 'success' ? chalk.greenBright('SUCCESS') : chalk.red('FAILURE')}`);

    } catch (error) {
        console.error(chalk.red(`💥 Critical error for ${COMPROMISED_ADDRESS}: ${error.message}`));
        if (error.message.includes('RPC') || error.message.includes('rate limit')) rotateRpc();
    }
}

async function main() {
    console.log(chalk.bold.cyan('--- Initializing Native Token Rescue Bot ---'));

    const initialRpc = RPC_URLS[0];
    const tempPublicClient = createPublicClient({ transport: http(initialRpc) });
    chain = { id: await tempPublicClient.getChainId() };

    publicClient = createPublicClient({ chain, transport: http(initialRpc) });

    console.log(chalk.blue(`Network detected with Chain ID: ${chain.id}`));
    console.log(chalk.blue(`Main Write RPC: ${initialRpc}`));

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
        console.log(chalk.yellow('No wallets in pk.txt with allocations found.'));
    } else {
        console.log(chalk.blue(`Will process ${walletsToProcess.length} wallets once funding is detected.`));
    }

    console.log(chalk.magenta.bold(`\n[LISTENER MODE] Waiting for Airdrop contract to be funded with at least ${MIN_FUNDING_THRESHOLD.toString()} ETH...`));

    let rescueTriggered = false;
    setInterval(async () => {
        if (rescueTriggered) return;

        try {
            const contractBalance = await publicClient.getBalance({ address: AIRDROP_CONTRACT_ADDRESS });
            if (contractBalance >= MIN_FUNDING_THRESHOLD) {
                rescueTriggered = true; // Prevents multiple triggers
                console.log(chalk.bgGreen.black.bold(`\n!! EVENT DETECTED: Airdrop contract has been funded with ${contractBalance.toString()} ETH !!\n`));

                for (const wallet of walletsToProcess) {
                    await executeAtomicRescue(wallet);
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Short delay between wallets
                }
                console.log(chalk.magenta('\n--- Rescue cycle completed. The script will now exit. ---'));
                process.exit(0);
            }
        } catch (error) {
            console.error(chalk.red('[BALANCE CHECK ERROR]', error.message));
            rotateRpc();
        }
    }, 10000); // Check every 10 seconds
}

main();
