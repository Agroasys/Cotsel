// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {AgroasysEscrowFuzzBase} from "./AgroasysEscrowFuzzBase.sol";
import {AgroasysEscrow} from "../src/AgroasysEscrow.sol";

abstract contract AgroasysEscrowFlowFuzzTests is AgroasysEscrowFuzzBase {
    function test_Setup() public view {
        assertEq(escrow.oracleAddress(), oracle);
        assertEq(usdc.balanceOf(buyer), 10_000_000e6);
        assertEq(escrow.tradeCounter(), 0, "initial trade counter should be 0");
        assertEq(escrow.requiredApprovals(), 2, "required approvals should be 2");
    }

    function testFuzz_completeUserFlowWithoutDispute(
        uint96 logistics,
        uint96 fees,
        uint96 tranche1,
        uint96 tranche2,
        bytes32 ricardianHash
    ) public {
        // check fuzzed inputs
        vm.assume(ricardianHash != bytes32(0));
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        uint96 goodsAmount = uint96(bound(fees, 20_000e6, 200_000e6));
        (fees, tranche1, tranche2) = _launch_schedule(goodsAmount);

        uint256 total = logistics + fees + tranche1 + tranche2;

        uint256 buyerBeforeTradeCreationBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeTradeCreationBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeTradeCreationBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeTradeCreationBalance = usdc.balanceOf(address(escrow));

        // ######################## 1) CREATE TRADE #########################################
        uint256 tradeId = _create_trade(logistics, fees, tranche1, tranche2, ricardianHash);

        (,, AgroasysEscrow.TradeStatus _status,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status), uint8(AgroasysEscrow.TradeStatus.LOCKED), "status should be LOCKED");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeTradeCreationBalance - total, "buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier), supplierBeforeTradeCreationBalance, "supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury), treasuryBeforeTradeCreationBalance, "treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)), escrowBeforeTradeCreationBalance + total, "escrow balance mismatch");

        // ######################## 2) RELEASE FUNDS STAGE 1 #########################################
        uint256 buyerBeforeReleaseFundsStage1Balance = usdc.balanceOf(buyer);
        uint256 supplierBeforeReleaseFundsStage1Balance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeReleaseFundsStage1Balance = usdc.balanceOf(treasury);
        uint256 escrowBeforeReleaseFundsStage1Balance = usdc.balanceOf(address(escrow));
        uint256 treasuryBeforeReleaseFundsStage1Claimable = escrow.claimableUsdc(treasury);

        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);

        (,, AgroasysEscrow.TradeStatus _status2,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status2), uint8(AgroasysEscrow.TradeStatus.IN_TRANSIT), "status should be IN_TRANSIT");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeReleaseFundsStage1Balance, "buyer balance mismatch");
        assertEq(
            usdc.balanceOf(supplier), supplierBeforeReleaseFundsStage1Balance + tranche1, "supplier balance mismatch"
        );
        assertEq(usdc.balanceOf(treasury), treasuryBeforeReleaseFundsStage1Balance, "treasury balance mismatch");
        assertEq(
            usdc.balanceOf(address(escrow)), escrowBeforeReleaseFundsStage1Balance - tranche1, "escrow balance mismatch"
        );
        assertEq(escrow.claimableUsdc(supplier), 0, "supplier claimableUsdc mismatch");
        assertEq(
            escrow.claimableUsdc(treasury),
            treasuryBeforeReleaseFundsStage1Claimable + fees + logistics,
            "treasury claimableUsdc mismatch"
        );

        // ######################## 3) CONFIRM ARRIVAL #########################################
        uint256 buyerBeforeArrivalConfirmationBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeArrivalConfirmationBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeArrivalConfirmationBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeArrivalConfirmationBalance = usdc.balanceOf(address(escrow));

        vm.prank(oracle);
        escrow.confirmInspectionAvailable(tradeId, 72 hours);

        (,, AgroasysEscrow.TradeStatus _status3,,,,,,,,, uint256 _arrivalTimestamp) = escrow.trades(tradeId);

        assertEq(_arrivalTimestamp, block.timestamp, "arrival timestamp should be set");
        assertEq(
            uint8(_status3), uint8(AgroasysEscrow.TradeStatus.ARRIVAL_CONFIRMED), "status should be ARRIVAL_CONFIRMED"
        );
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeArrivalConfirmationBalance, "buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier), supplierBeforeArrivalConfirmationBalance, "supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury), treasuryBeforeArrivalConfirmationBalance, "treasury balance mismatch 3)");
        assertEq(usdc.balanceOf(address(escrow)), escrowBeforeArrivalConfirmationBalance, "escrow balance mismatch");

        // ######################## 4) RELEASE FUNDS STAGE 2 #########################################
        uint256 buyerBeforeReleaseFundsStage2Balance = usdc.balanceOf(buyer);
        uint256 supplierBeforeReleaseFundsStage2Balance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeReleaseFundsStage2Balance = usdc.balanceOf(treasury);
        uint256 escrowBeforeReleaseFundsStage2Balance = usdc.balanceOf(address(escrow));

        // increase time beyond the standard 72-hour inspection notice window
        vm.warp(block.timestamp + 72 hours + 1);

        vm.prank(admin1);
        escrow.finalizeAfterDisputeWindow(tradeId);

        (,, AgroasysEscrow.TradeStatus _status4,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status4), uint8(AgroasysEscrow.TradeStatus.CLOSED), "status should be CLOSED");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeReleaseFundsStage2Balance, "buyer balance mismatch");
        assertEq(
            usdc.balanceOf(supplier), supplierBeforeReleaseFundsStage2Balance + tranche2, "supplier balance mismatch"
        );
        assertEq(usdc.balanceOf(treasury), treasuryBeforeReleaseFundsStage2Balance, "treasury balance mismatch");
        assertEq(
            usdc.balanceOf(address(escrow)), escrowBeforeReleaseFundsStage2Balance - tranche2, "escrow balance mismatch"
        );
        assertEq(escrow.claimableUsdc(supplier), 0, "supplier claimableUsdc mismatch");
    }

    function testFuzz_completeUserFlowWithDisputeResolve(
        uint96 logistics,
        uint96 fees,
        uint96 tranche1,
        uint96 tranche2,
        bytes32 ricardianHash
    ) public {
        // check fuzzed inputs
        vm.assume(ricardianHash != bytes32(0));
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        uint96 goodsAmount = uint96(bound(fees, 20_000e6, 200_000e6));
        (fees, tranche1, tranche2) = _launch_schedule(goodsAmount);

        uint256 total = logistics + fees + tranche1 + tranche2;

        uint256 buyerBeforeTradeCreationBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeTradeCreationBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeTradeCreationBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeTradeCreationBalance = usdc.balanceOf(address(escrow));

        // ######################## 1) CREATE TRADE #########################################
        uint256 tradeId = _create_trade(logistics, fees, tranche1, tranche2, ricardianHash);

        (,, AgroasysEscrow.TradeStatus _status,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status), uint8(AgroasysEscrow.TradeStatus.LOCKED), "status should be LOCKED");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeTradeCreationBalance - total, "buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier), supplierBeforeTradeCreationBalance, "supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury), treasuryBeforeTradeCreationBalance, "treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)), escrowBeforeTradeCreationBalance + total, "escrow balance mismatch");

        // ######################## 2) RELEASE FUNDS STAGE 1 #########################################
        uint256 buyerBeforeReleaseFundsStage1Balance = usdc.balanceOf(buyer);
        uint256 supplierBeforeReleaseFundsStage1Balance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeReleaseFundsStage1Balance = usdc.balanceOf(treasury);
        uint256 escrowBeforeReleaseFundsStage1Balance = usdc.balanceOf(address(escrow));
        uint256 treasuryBeforeReleaseFundsStage1Claimable = escrow.claimableUsdc(treasury);

        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);

        (,, AgroasysEscrow.TradeStatus _status2,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status2), uint8(AgroasysEscrow.TradeStatus.IN_TRANSIT), "status should be IN_TRANSIT");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeReleaseFundsStage1Balance, "buyer balance mismatch");
        assertEq(
            usdc.balanceOf(supplier), supplierBeforeReleaseFundsStage1Balance + tranche1, "supplier balance mismatch"
        );
        assertEq(usdc.balanceOf(treasury), treasuryBeforeReleaseFundsStage1Balance, "treasury balance mismatch");
        assertEq(
            usdc.balanceOf(address(escrow)), escrowBeforeReleaseFundsStage1Balance - tranche1, "escrow balance mismatch"
        );
        assertEq(escrow.claimableUsdc(supplier), 0, "supplier claimableUsdc mismatch");
        assertEq(
            escrow.claimableUsdc(treasury),
            treasuryBeforeReleaseFundsStage1Claimable + logistics + fees,
            "treasury claimableUsdc mismatch"
        );

        // ######################## 3) CONFIRM ARRIVAL #########################################
        uint256 buyerBeforeArrivalConfirmationBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeArrivalConfirmationBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeArrivalConfirmationBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeArrivalConfirmationBalance = usdc.balanceOf(address(escrow));

        vm.prank(oracle);
        escrow.confirmInspectionAvailable(tradeId, 72 hours);

        (,, AgroasysEscrow.TradeStatus _status3,,,,,,,,, uint256 _arrivalTimestamp) = escrow.trades(tradeId);

        assertEq(_arrivalTimestamp, block.timestamp, "arrival timestamp should be set");
        assertEq(
            uint8(_status3), uint8(AgroasysEscrow.TradeStatus.ARRIVAL_CONFIRMED), "status should be ARRIVAL_CONFIRMED"
        );
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeArrivalConfirmationBalance, "buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier), supplierBeforeArrivalConfirmationBalance, "supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury), treasuryBeforeArrivalConfirmationBalance, "treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)), escrowBeforeArrivalConfirmationBalance, "escrow balance mismatch");

        // ######################## 4) BUYER OPEN DISPUTE #########################################
        uint256 buyerBeforeOpenDisputeBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeOpenDisputeBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeOpenDisputeBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeOpenDisputeBalance = usdc.balanceOf(address(escrow));

        vm.warp(block.timestamp + 1 hours);

        (uint256 actionNonce, uint256 actionDeadline, bytes memory actionSignature) = _authorize_user_action(1, tradeId);
        vm.prank(admin1);
        escrow.openDisputeWithAuthorization(tradeId, actionNonce, actionDeadline, actionSignature);

        (,, AgroasysEscrow.TradeStatus _status4,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status4), uint8(AgroasysEscrow.TradeStatus.FROZEN), "status should be FROZEN");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeOpenDisputeBalance, "buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier), supplierBeforeOpenDisputeBalance, "supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury), treasuryBeforeOpenDisputeBalance, "treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)), escrowBeforeOpenDisputeBalance, "escrow balance mismatch");

        // ######################## 5) ADMIN PROPOSE SOLUTION #########################################
        uint256 buyerBeforeProposeSolutionBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeProposeSolutionBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeProposeSolutionBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeProposeSolutionBalance = usdc.balanceOf(address(escrow));

        vm.prank(admin1);
        uint256 proposalId = escrow.proposeDisputeSolution(tradeId, AgroasysEscrow.DisputeStatus.RESOLVE);

        (,, AgroasysEscrow.TradeStatus _status5,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status5), uint8(AgroasysEscrow.TradeStatus.FROZEN), "status should be FROZEN");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeProposeSolutionBalance, "buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier), supplierBeforeProposeSolutionBalance, "supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury), treasuryBeforeProposeSolutionBalance, "treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)), escrowBeforeProposeSolutionBalance, "escrow balance mismatch");

        // ######################## 6) ADMIN APPROVES #################################################
        uint256 buyerBeforeApproveSolutionBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeApproveSolutionBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeApproveSolutionBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeApproveSolutionBalance = usdc.balanceOf(address(escrow));

        vm.prank(admin2);
        escrow.approveDisputeSolution(proposalId);

        (,, AgroasysEscrow.TradeStatus _status6,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status6), uint8(AgroasysEscrow.TradeStatus.CLOSED), "status should be CLOSED");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeApproveSolutionBalance, "buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier), supplierBeforeApproveSolutionBalance + tranche2, "supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury), treasuryBeforeApproveSolutionBalance, "treasury balance mismatch");
        assertEq(
            usdc.balanceOf(address(escrow)), escrowBeforeApproveSolutionBalance - tranche2, "escrow balance mismatch"
        );
        assertEq(escrow.claimableUsdc(supplier), 0, "supplier claimableUsdc mismatch");
    }

    function testFuzz_completeUserFlowWithDisputeRefund(
        uint96 logistics,
        uint96 fees,
        uint96 tranche1,
        uint96 tranche2,
        bytes32 ricardianHash
    ) public {
        // check fuzzed inputs
        vm.assume(ricardianHash != bytes32(0));
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        uint96 goodsAmount = uint96(bound(fees, 20_000e6, 200_000e6));
        (fees, tranche1, tranche2) = _launch_schedule(goodsAmount);

        uint256 total = logistics + fees + tranche1 + tranche2;

        uint256 buyerBeforeTradeCreationBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeTradeCreationBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeTradeCreationBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeTradeCreationBalance = usdc.balanceOf(address(escrow));

        // ######################## 1) CREATE TRADE #########################################
        uint256 tradeId = _create_trade(logistics, fees, tranche1, tranche2, ricardianHash);

        (
            uint256 _tradeId,,
            AgroasysEscrow.TradeStatus _status,
            address _buyer,
            address _supplier,
            uint256 _total,
            uint256 _logistics,
            uint256 _fees,
            uint256 _tranche1,
            uint256 _tranche2,,
        ) = escrow.trades(tradeId);

        // check that trades values are stored correctly
        assertEq(_tradeId, tradeId, "trade id mismatch");
        assertEq(_buyer, buyer, "buyer mismatch");
        assertEq(_supplier, supplier, "supplier mismatch");
        assertEq(uint8(_status), uint8(AgroasysEscrow.TradeStatus.LOCKED), "status should be LOCKED");
        assertEq(_total, total, "total mismatch");
        assertEq(_logistics, logistics, "logistics mismatch");
        assertEq(_fees, fees, "fees mismatch");
        assertEq(_tranche1, tranche1, "tranche1 mismatch");
        assertEq(_tranche2, tranche2, "tranche2 mismatch");
        assertEq(_total, _logistics + _fees + _tranche1 + _tranche2, "total mismatch sum of logistic+fees+tranche1&2");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeTradeCreationBalance - total, "buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier), supplierBeforeTradeCreationBalance, "supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury), treasuryBeforeTradeCreationBalance, "treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)), escrowBeforeTradeCreationBalance + total, "escrow balance mismatch");

        // ######################## 2) RELEASE FUNDS STAGE 1 #########################################
        uint256 buyerBeforeReleaseFundsStage1Balance = usdc.balanceOf(buyer);
        uint256 supplierBeforeReleaseFundsStage1Balance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeReleaseFundsStage1Balance = usdc.balanceOf(treasury);
        uint256 escrowBeforeReleaseFundsStage1Balance = usdc.balanceOf(address(escrow));
        uint256 treasuryBeforeReleaseFundsStage1Claimable = escrow.claimableUsdc(treasury);

        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);

        (,, AgroasysEscrow.TradeStatus _status2,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status2), uint8(AgroasysEscrow.TradeStatus.IN_TRANSIT), "status should be IN_TRANSIT");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeReleaseFundsStage1Balance, "buyer balance mismatch");
        assertEq(
            usdc.balanceOf(supplier), supplierBeforeReleaseFundsStage1Balance + tranche1, "supplier balance mismatch"
        );
        assertEq(usdc.balanceOf(treasury), treasuryBeforeReleaseFundsStage1Balance, "treasury balance mismatch");
        assertEq(
            usdc.balanceOf(address(escrow)), escrowBeforeReleaseFundsStage1Balance - tranche1, "escrow balance mismatch"
        );
        assertEq(escrow.claimableUsdc(supplier), 0, "supplier claimableUsdc mismatch");
        assertEq(
            escrow.claimableUsdc(treasury),
            treasuryBeforeReleaseFundsStage1Claimable + logistics + fees,
            "treasury claimableUsdc mismatch"
        );

        // ######################## 3) CONFIRM ARRIVAL #########################################
        uint256 buyerBeforeArrivalConfirmationBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeArrivalConfirmationBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeArrivalConfirmationBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeArrivalConfirmationBalance = usdc.balanceOf(address(escrow));

        vm.prank(oracle);
        escrow.confirmInspectionAvailable(tradeId, 72 hours);

        (,, AgroasysEscrow.TradeStatus _status3,,,,,,,,, uint256 _arrivalTimestamp) = escrow.trades(tradeId);

        assertEq(_arrivalTimestamp, block.timestamp, "arrival timestamp should be set");

        assertEq(
            uint8(_status3), uint8(AgroasysEscrow.TradeStatus.ARRIVAL_CONFIRMED), "status should be ARRIVAL_CONFIRMED"
        );
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeArrivalConfirmationBalance, "buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier), supplierBeforeArrivalConfirmationBalance, "supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury), treasuryBeforeArrivalConfirmationBalance, "treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)), escrowBeforeArrivalConfirmationBalance, "escrow balance mismatch");

        // ######################## 4) BUYER OPEN DISPUTE #########################################
        uint256 buyerBeforeOpenDisputeBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeOpenDisputeBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeOpenDisputeBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeOpenDisputeBalance = usdc.balanceOf(address(escrow));

        vm.warp(block.timestamp + 1 hours);

        (uint256 actionNonce, uint256 actionDeadline, bytes memory actionSignature) = _authorize_user_action(1, tradeId);
        vm.prank(admin1);
        escrow.openDisputeWithAuthorization(tradeId, actionNonce, actionDeadline, actionSignature);

        (,, AgroasysEscrow.TradeStatus _status4,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status4), uint8(AgroasysEscrow.TradeStatus.FROZEN), "status should be FROZEN");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeOpenDisputeBalance, "buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier), supplierBeforeOpenDisputeBalance, "supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury), treasuryBeforeOpenDisputeBalance, "treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)), escrowBeforeOpenDisputeBalance, "escrow balance mismatch");

        // ######################## 5) ADMIN PROPOSE SOLUTION #########################################
        uint256 buyerBeforeProposeSolutionBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeProposeSolutionBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeProposeSolutionBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeProposeSolutionBalance = usdc.balanceOf(address(escrow));

        vm.prank(admin1);
        uint256 proposalId = escrow.proposeDisputeSolution(tradeId, AgroasysEscrow.DisputeStatus.REFUND);

        (,, AgroasysEscrow.TradeStatus _status5,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status5), uint8(AgroasysEscrow.TradeStatus.FROZEN), "status should be FROZEN");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeProposeSolutionBalance, "buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier), supplierBeforeProposeSolutionBalance, "supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury), treasuryBeforeProposeSolutionBalance, "treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)), escrowBeforeProposeSolutionBalance, "escrow balance mismatch");

        // ######################## 6) ADMIN APPROVES #################################################
        uint256 buyerBeforeApproveSolutionBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeApproveSolutionBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeApproveSolutionBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeApproveSolutionBalance = usdc.balanceOf(address(escrow));

        vm.prank(admin2);
        escrow.approveDisputeSolution(proposalId);

        (,, AgroasysEscrow.TradeStatus _status6,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status6), uint8(AgroasysEscrow.TradeStatus.CLOSED), "status should be CLOSED");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer), buyerBeforeApproveSolutionBalance + tranche2, "buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier), supplierBeforeApproveSolutionBalance, "supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury), treasuryBeforeApproveSolutionBalance, "treasury balance mismatch");
        assertEq(
            usdc.balanceOf(address(escrow)), escrowBeforeApproveSolutionBalance - tranche2, "escrow balance mismatch"
        );
        assertEq(escrow.claimableUsdc(buyer), 0, "buyer claimableUsdc mismatch");
    }
}
