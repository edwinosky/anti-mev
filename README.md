# Anti-MEV Airdrop Rescue Scripts

This repository contains advanced Node.js scripts designed to securely and automatically rescue airdropped tokens from compromised wallets by front-running malicious actors and MEV bots. The scripts execute a coordinated, high-speed burst of transactions the moment an airdrop becomes claimable.

There are two versions available:

- **`claim-airdrop-permit.js`**: For rescuing ERC20 tokens that support the `permit` function (EIP-2612).
- **`claim-airdrop.js`**: For rescuing native chain tokens (e.g., ETH on Linea, BNB on BSC).

---

## 🚀 Problem Solved

When a wallet's private key is compromised, any funds that land in it are at immediate risk. Bots constantly monitor the blockchain and will instantly sweep away any assets. If you're eligible for an airdrop on such a wallet, a manual claim is impossible—a bot will steal the tokens before you can transfer them.

These scripts automate a **defensive front-running strategy** to win this race. They send a precisely calculated sequence of transactions within the same block to:
1. Fund the compromised wallet with gas,
2. Claim the airdrop,
3. Extract the assets to a secure wallet.

---

## ✨ Key Features

- **Atomic Transaction Burst**: Executes a 3-transaction sequence (`Fund → Claim → Extract`) in rapid succession to beat competing bots.
- **Automated Event Listening**: Monitors the blockchain and triggers the rescue the instant the airdrop contract is funded.
- **Advanced Gas Control**: Uses competitive gas settings with multipliers to ensure high transaction priority—critical on congested networks.
- **ERC20 `permit()` Support**: Leverages EIP-2612 permit signatures to approve and extract tokens in a single transaction, saving time and gas.
- **Native Token Support**: Dedicated logic for rescuing airdrops of native currency (e.g., ETH).
- **RPC Redundancy**: Automatically rotates between multiple RPC endpoints to ensure high availability and bypass rate limits.
- **Batch Processing**: Manages and rescues airdrops for multiple compromised wallets in a single execution.

---

## 🔧 How It Works

### 1. For ERC20 Tokens (`claim-rescue-linea.js`)

This script uses the `permit` function (EIP-2612) for gasless approvals via off-chain signatures.

1. **Fund Gas**: The secure Relayer Wallet sends a micro-transaction to the Compromised Wallet with just enough ETH to pay for the claim.
2. **Claim Airdrop**: The Compromised Wallet sends a transaction to claim the airdrop tokens from the Airdrop Contract.
3. **Extract Tokens**: The Relayer Wallet calls a helper **Permit Contract** with a pre-signed `permit` message, authorizing it to pull the tokens and send them directly to the secure wallet.

> All three steps are submitted as a burst to be mined in the same block.

### 2. For Native Tokens (`claim-rescue-native.js`)

Simpler flow—no token approvals needed.

1. **Fund Gas**: Relayer Wallet sends ETH to cover gas for both claim and transfer.
2. **Claim Airdrop**: Compromised Wallet claims the native token airdrop.
3. **Extract Funds**: Compromised Wallet immediately transfers its entire new balance (airdrop amount minus gas) to the Relayer Wallet.

---

## ⚙️ Setup and Configuration

### 1. Prerequisites

- Node.js (v18 or later)
- npm or yarn

### 2. Installation
```
git clone https://github.com/edwinosky/anti-mev.git
cd anti-mev
npm install
```

### 3. Environment Variables

Create a .env file by copying the example:
```
cp .env.example .env

# --- COMMON VARIABLES (for both scripts) ---

# Your secure wallet's private key (must be funded with ETH for gas).
SECURE="0x..."

# Comma-separated RPC URLs (e.g., Linea, Base). At least one required.
RPC_HTTP_URLS="https://rpc.linea.build,https://linea.drpc.org"

# 4-byte hex signature of the airdrop claim function (e.g., "claim()" = 0x4e71d92d).
CLAIM_FUNCTION_HEX="0x..."

# Address of the airdrop contract.
AIRDROP_CONTRACT_ADDRESS="0x..."

# Gas multipliers for competitive transaction priority.
GAS_MULTIPLIER=1.2
GAS_PRIORITY_MULTIPLIER=1.5


# --- SCRIPT-SPECIFIC VARIABLES ---

# == For claim-rescue-linea.js (ERC20) ONLY ==
INFURA_RPC_URL="https://linea-mainnet.infura.io/v3/YOUR_INFURA_KEY"
TOKEN_ADDRESS="0x..."
PERMIT_CONTRACT_ADDRESS="0x..."


# == For claim-rescue-native.js (Native Tokens) ONLY ==
# Minimum contract balance (in Gwei) to trigger rescue (e.g., 0.1 ETH = 100_000_000 Gwei).
MIN_FUNDING_THRESHOLD_GWEI="100000000"
```
### 4. Create allocations.json
This file maps compromised wallets to their expected airdrop amounts (in wei):

```
{
  "0xCOMPROMISED_WALLET_ADDRESS_1": "AMOUNT_IN_WEI_1",
  "0xCOMPROMISED_WALLET_ADDRESS_2": "AMOUNT_IN_WEI_2"
}
```
Place it in the project root.

### 5. Create pk.txt
List the private keys of compromised wallets, one per line:
```
0xPRIVATE_KEY_1
0xPRIVATE_KEY_2
```
