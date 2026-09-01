// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {AgroasysEscrowFuzzBase} from "./AgroasysEscrowFuzzBase.sol";
import {AgroasysEscrow} from "../src/AgroasysEscrow.sol";

abstract contract AgroasysEscrowTimeoutFuzzTests is AgroasysEscrowFuzzBase {
    function testFuzz_CancelLockedTradeAfterTimeout(
        uint96 logistics,
        uint96 fees,
        uint96 tranche1,
        uint96 tranche2,
        bytes32 ricardianHash
    ) public {
        vm.assume(ricardianHash != bytes32(0));
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        uint96 goodsAmount = uint96(bound(fees, 20_000e6, 200_000e6));
        (fees, tranche1, tranche2) = _launch_schedule(goodsAmount);

        uint256 total = logistics + fees + tranche1 + tranche2;
        uint256 refundableProtectedAmount = total;

        uint256 tradeId = _create_trade(logistics, fees, tranche1, tranche2, ricardianHash);

        (,, AgroasysEscrow.TradeStatus _status,,, uint256 _total,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status), uint8(AgroasysEscrow.TradeStatus.LOCKED), "status should be LOCKED");
        assertEq(_total, total, "total mismatch");

        uint256 buyerBalanceBefore = usdc.balanceOf(buyer);
        uint256 escrowBalanceBefore = usdc.balanceOf(address(escrow));
        uint256 treasuryClaimableBefore = escrow.claimableUsdc(treasury);

        vm.warp(block.timestamp + 7 days + 1);

        (uint256 actionNonce, uint256 actionDeadline, bytes memory actionSignature) = _authorize_user_action(2, tradeId);
        vm.prank(admin1);
        escrow.cancelLockedTradeAfterTimeoutWithAuthorization(tradeId, actionNonce, actionDeadline, actionSignature);

        (,, AgroasysEscrow.TradeStatus _statusAfter,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_statusAfter), uint8(AgroasysEscrow.TradeStatus.CLOSED), "status should be CLOSED");
        assertEq(
            usdc.balanceOf(buyer),
            buyerBalanceBefore + refundableProtectedAmount,
            "buyer should receive every protected component immediately"
        );
        assertEq(
            usdc.balanceOf(address(escrow)),
            escrowBalanceBefore - refundableProtectedAmount,
            "escrow balance should release the full protected amount"
        );
        assertEq(escrow.claimableUsdc(buyer), 0, "buyer claimable should remain zero after direct refund");
        assertEq(
            escrow.claimableUsdc(treasury), treasuryClaimableBefore, "treasury should receive no fees before stage one"
        );
    }

    function testFuzz_RefundInTransitAfterTimeout(
        uint96 logistics,
        uint96 fees,
        uint96 tranche1,
        uint96 tranche2,
        bytes32 ricardianHash
    ) public {
        vm.assume(ricardianHash != bytes32(0));
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        uint96 goodsAmount = uint96(bound(fees, 20_000e6, 200_000e6));
        (fees, tranche1, tranche2) = _launch_schedule(goodsAmount);

        uint256 tradeId = _create_trade(logistics, fees, tranche1, tranche2, ricardianHash);

        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);

        (,, AgroasysEscrow.TradeStatus _status,,,,,,,,,) = escrow.trades(tradeId);
        assertEq(uint8(_status), uint8(AgroasysEscrow.TradeStatus.IN_TRANSIT), "status should be IN_TRANSIT");

        uint256 buyerBalanceBefore = usdc.balanceOf(buyer);
        uint256 escrowBalanceBefore = usdc.balanceOf(address(escrow));

        assertEq(
            escrowBalanceBefore,
            logistics + fees + tranche2,
            "escrow balance should retain only unpaid funds after stage1 payout"
        );

        vm.warp(block.timestamp + 14 days + 1);

        (uint256 actionNonce, uint256 actionDeadline, bytes memory actionSignature) = _authorize_user_action(3, tradeId);
        vm.prank(admin1);
        escrow.refundInTransitAfterTimeoutWithAuthorization(tradeId, actionNonce, actionDeadline, actionSignature);

        (,, AgroasysEscrow.TradeStatus _statusAfter,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_statusAfter), uint8(AgroasysEscrow.TradeStatus.CLOSED), "status should be CLOSED");
        assertEq(
            usdc.balanceOf(buyer), buyerBalanceBefore + tranche2, "buyer should receive tranche2 refund immediately"
        );
        assertEq(
            usdc.balanceOf(address(escrow)),
            escrowBalanceBefore - tranche2,
            "escrow balance should retain only treasury fees"
        );
        assertEq(escrow.claimableUsdc(buyer), 0, "buyer claimable should remain zero after direct refund");
    }

    function test_treasuryPayoutRotationRoutesClaimTreasury() public {
        (uint96 fees, uint96 tranche1, uint96 tranche2) = _launch_schedule(20_000e6);
        uint256 tradeId = _create_trade(1_000e6, fees, tranche1, tranche2, keccak256("doc"));

        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);

        // treasury has accrued fees at this point
        uint256 accrued = escrow.claimableUsdc(treasury);
        assertGt(accrued, 0, "treasury should have claimable balance");

        // rotate payout address to a separate receiver
        address newReceiver = makeAddr("newReceiver");
        vm.prank(admin1);
        uint256 proposalId = escrow.proposeTreasuryPayoutAddressUpdate(newReceiver);
        vm.prank(admin2);
        escrow.approveTreasuryPayoutAddressUpdate(proposalId);
        vm.warp(block.timestamp + escrow.governanceTimelock() + 1);
        vm.prank(admin1);
        escrow.executeTreasuryPayoutAddressUpdate(proposalId);
        assertEq(escrow.treasuryPayoutAddress(), newReceiver, "payout address should be rotated");

        // claimTreasury() routes funds to newReceiver, not treasury
        uint256 receiverBefore = usdc.balanceOf(newReceiver);
        vm.prank(treasury);
        escrow.claimTreasury();
        assertEq(usdc.balanceOf(newReceiver), receiverBefore + accrued, "funds should land at rotated receiver");
        assertEq(usdc.balanceOf(treasury), 0, "treasury wallet should receive nothing");
    }
}
