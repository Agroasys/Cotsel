/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { ethers } from 'hardhat';

async function main() {
  const USDC_ADDRESS = '0xEea5766E43D0c7032463134Afc121e63C9f9C260';
  const RECIPIENT = '0xc7fFC27f58117f13BEE926dF9821C7da5826ce23';
  const AMOUNT = ethers.parseUnits('10000000', 6);

  console.log('Connecting to MockUSDC at:', USDC_ADDRESS);

  const [signer] = await ethers.getSigners();
  console.log('Using account:', signer.address);

  const MockUSDC = await ethers.getContractAt('MockUSDC', USDC_ADDRESS);

  console.log(`Minting ${ethers.formatUnits(AMOUNT, 6)} USDC to ${RECIPIENT}...`);

  const tx = await MockUSDC.mint(RECIPIENT, AMOUNT);
  console.log('Transaction hash:', tx.hash);

  const receipt = await tx.wait();
  console.log('Transaction confirmed in block:', receipt?.blockNumber);

  const balance = await MockUSDC.balanceOf(RECIPIENT);
  console.log(`New balance: ${ethers.formatUnits(balance, 6)} USDC`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
