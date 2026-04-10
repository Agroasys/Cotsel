/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

export default buildModule('MockUSDCModule', (m) => {
  const mockUSDC = m.contract('MockUSDC');

  return { mockUSDC };
});
