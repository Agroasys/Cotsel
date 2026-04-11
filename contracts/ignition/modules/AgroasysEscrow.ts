/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

export default buildModule('AgroasysEscrowModule', (m) => {
  const usdcAddress = '0xEea5766E43D0c7032463134Afc121e63C9f9C260';
  const oracleAddress = '0x20e7E6fC0905E17De2D28E926Ad56324a6844a1D';
  const treasuryAddress = '0x20e7E6fC0905E17De2D28E926Ad56324a6844a1D';
  const admin1 = '0x20e7E6fC0905E17De2D28E926Ad56324a6844a1D';
  const admin2 = '0x229C75F0cD13D6ab7621403Bd951a9e43ba53b1e';
  const admin3 = '0x4aF052cB4B3eC7b58322548021bF254Cc4c80b2c';
  const admins = [admin1, admin2, admin3];
  const requiredApprovals = 2;

  const agroasysEscrow = m.contract('AgroasysEscrow', [
    usdcAddress,
    oracleAddress,
    treasuryAddress,
    admins,
    requiredApprovals,
  ]);

  return { agroasysEscrow };
});
