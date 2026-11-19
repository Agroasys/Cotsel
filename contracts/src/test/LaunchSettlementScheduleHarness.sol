// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {LaunchSettlementSchedule} from "../LaunchSettlementSchedule.sol";

/// @dev Test-only harness exposing the launch schedule check, so off-chain
/// settlement templates can be proven equivalent to the contract.
contract LaunchSettlementScheduleHarness {
    function isValid(uint256 platformFeesAmount, uint256 supplierFirstTranche, uint256 supplierSecondTranche)
        external
        pure
        returns (bool)
    {
        return LaunchSettlementSchedule.isValid(platformFeesAmount, supplierFirstTranche, supplierSecondTranche);
    }
}
