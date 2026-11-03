// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Pure launch economics, independent of custody, signatures and release state.
library LaunchSettlementSchedule {
    uint256 internal constant USDC_BASE_UNITS_PER_CENT = 10_000;
    uint256 internal constant BUYER_PLATFORM_FEE_BPS = 50;
    uint256 internal constant SUPPLIER_PLATFORM_FEE_BPS = 50;
    uint256 internal constant FIRST_SUPPLIER_TRANCHE_BPS = 6_000;
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant SETTLEMENT_SUPPORT_FEE = 4_000_000;

    function isValid(uint256 platformFeesAmount, uint256 supplierFirstTranche, uint256 supplierSecondTranche)
        internal
        pure
        returns (bool)
    {
        // One cent is 10,000 USDC base units; unsupported fractional cents cannot be quoted.
        if (
            platformFeesAmount % USDC_BASE_UNITS_PER_CENT != 0 || supplierFirstTranche % USDC_BASE_UNITS_PER_CENT != 0
                || supplierSecondTranche % USDC_BASE_UNITS_PER_CENT != 0
        ) return false;
        uint256 netSupplierCents = (supplierFirstTranche + supplierSecondTranche) / USDC_BASE_UNITS_PER_CENT;
        // Half-up supplier fees place the true principal at this candidate or the next cent.
        uint256 goodsCandidate =
            Math.mulDiv(netSupplierCents, BPS_DENOMINATOR, BPS_DENOMINATOR - SUPPLIER_PLATFORM_FEE_BPS);
        return matches(goodsCandidate, platformFeesAmount, supplierFirstTranche, supplierSecondTranche)
            || matches(goodsCandidate + 1, platformFeesAmount, supplierFirstTranche, supplierSecondTranche);
    }

    function matches(
        uint256 goodsCents,
        uint256 platformFeesAmount,
        uint256 supplierFirstTranche,
        uint256 supplierSecondTranche
    ) private pure returns (bool) {
        uint256 buyerFee = ((goodsCents * BUYER_PLATFORM_FEE_BPS + 5_000) / BPS_DENOMINATOR) * USDC_BASE_UNITS_PER_CENT;
        uint256 supplierFee =
            ((goodsCents * SUPPLIER_PLATFORM_FEE_BPS + 5_000) / BPS_DENOMINATOR) * USDC_BASE_UNITS_PER_CENT;
        uint256 firstTrancheGross =
            ((goodsCents * FIRST_SUPPLIER_TRANCHE_BPS + 5_000) / BPS_DENOMINATOR) * USDC_BASE_UNITS_PER_CENT;
        uint256 goodsAmount = goodsCents * USDC_BASE_UNITS_PER_CENT;

        return firstTrancheGross >= supplierFee && supplierFirstTranche == firstTrancheGross - supplierFee
            && supplierSecondTranche == goodsAmount - firstTrancheGross
            && platformFeesAmount == buyerFee + supplierFee + SETTLEMENT_SUPPORT_FEE;
    }
}
