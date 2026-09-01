// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {AgroasysEscrowFuzzBase} from "./AgroasysEscrowFuzzBase.sol";
import {AgroasysEscrow} from "../src/AgroasysEscrow.sol";

abstract contract AgroasysEscrowValidationFuzzTests is AgroasysEscrowFuzzBase {
    function testFuzz_CannotOpenDisputeBeforeArrival(
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

        (uint256 actionNonce, uint256 actionDeadline, bytes memory actionSignature) = _authorize_user_action(1, tradeId);
        vm.expectRevert(AgroasysEscrow.EscrowMustBeARRIVALCONFIRMED.selector);
        vm.prank(admin1);
        escrow.openDisputeWithAuthorization(tradeId, actionNonce, actionDeadline, actionSignature);
    }

    function testFuzz_CannotOpenDisputeAfter72Hours(
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

        vm.prank(oracle);
        escrow.confirmInspectionAvailable(tradeId, 72 hours);

        vm.warp(block.timestamp + 72 hours + 1 seconds);

        (uint256 actionNonce, uint256 actionDeadline, bytes memory actionSignature) = _authorize_user_action(1, tradeId);
        vm.expectRevert(AgroasysEscrow.EscrowWindowClosed.selector);
        vm.prank(admin1);
        escrow.openDisputeWithAuthorization(tradeId, actionNonce, actionDeadline, actionSignature);
    }

    function testFuzz_CannotReleaseStage2Before72Hours(
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

        vm.prank(oracle);
        escrow.confirmInspectionAvailable(tradeId, 72 hours);

        vm.warp(block.timestamp + 1 hours);

        vm.prank(admin1);
        vm.expectRevert(AgroasysEscrow.EscrowWindowNotElapsed.selector);
        escrow.finalizeAfterDisputeWindow(tradeId);
    }

    function test_OracleFinalizesAfterStandardInspectionDeadline() public {
        (uint96 fees, uint96 tranche1, uint96 tranche2) = _launch_schedule(100_000e6);
        uint256 tradeId = _create_trade(5_000e6, fees, tranche1, tranche2, keccak256("standard-window"));

        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);
        vm.prank(oracle);
        escrow.confirmInspectionAvailable(tradeId, 72 hours);
        vm.warp(block.timestamp + 72 hours + 1);

        uint256 supplierBefore = usdc.balanceOf(supplier);
        vm.prank(oracle);
        escrow.finalizeAfterDisputeWindow(tradeId);

        (,, AgroasysEscrow.TradeStatus status,,,,,,,,,) = escrow.trades(tradeId);
        assertEq(uint8(status), uint8(AgroasysEscrow.TradeStatus.CLOSED));
        assertEq(usdc.balanceOf(supplier), supplierBefore + tranche2);
    }

    function test_PackagedLocalInspectionUses48HourWindow() public {
        (uint96 fees, uint96 tranche1, uint96 tranche2) = _launch_schedule(100_000e6);
        uint256 tradeId = _create_trade(5_000e6, fees, tranche1, tranche2, keccak256("packaged-window"));

        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);
        vm.prank(oracle);
        escrow.confirmInspectionAvailable(tradeId, 48 hours);

        assertEq(escrow.inspectionDeadline(tradeId), block.timestamp + 48 hours);
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(oracle);
        escrow.finalizeAfterDisputeWindow(tradeId);

        (,, AgroasysEscrow.TradeStatus status,,,,,,,,,) = escrow.trades(tradeId);
        assertEq(uint8(status), uint8(AgroasysEscrow.TradeStatus.CLOSED));
    }

    function test_InspectionAcceptanceReleasesFinalTrancheImmediately() public {
        (uint96 fees, uint96 tranche1, uint96 tranche2) = _launch_schedule(100_000e6);
        uint256 tradeId = _create_trade(5_000e6, fees, tranche1, tranche2, keccak256("buyer-acceptance"));

        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);
        vm.prank(oracle);
        escrow.confirmInspectionAvailable(tradeId, 72 hours);

        uint256 supplierBefore = usdc.balanceOf(supplier);
        (uint256 nonce, uint256 deadline, bytes memory signature) = _authorize_user_action(5, tradeId);
        vm.prank(admin1);
        escrow.finalizeAfterInspectionAcceptanceWithAuthorization(tradeId, nonce, deadline, signature);

        (,, AgroasysEscrow.TradeStatus status,,,,,,,,,) = escrow.trades(tradeId);
        assertEq(uint8(status), uint8(AgroasysEscrow.TradeStatus.CLOSED));
        assertEq(usdc.balanceOf(supplier), supplierBefore + tranche2);
    }

    function testFuzz_UpdateOracle(address new_oracle) public {
        vm.assume(new_oracle != address(0));
        vm.assume(new_oracle != escrow.oracleAddress());

        vm.prank(admin1);
        uint256 proposalId = escrow.proposeOracleUpdate(new_oracle);

        vm.prank(admin2);
        escrow.approveOracleUpdate(proposalId);

        vm.warp(block.timestamp + 24 hours + 1 seconds);

        vm.prank(admin2);
        escrow.executeOracleUpdate(proposalId);

        assertEq(new_oracle, escrow.oracleAddress(), "update failed");
    }

    function testFuzz_UpdateAdmins(address new_admin) public {
        vm.assume(new_admin != address(0));
        vm.assume(!escrow.isAdmin(new_admin));
        vm.assume(new_admin != oracle && new_admin != treasury && new_admin != relayer);

        vm.prank(admin1);
        uint256 proposalId = escrow.proposeAdminChange(AgroasysEscrow.AdminChangeKind.ADD, address(0), new_admin, 0);

        vm.prank(admin2);
        escrow.approveAdminChange(proposalId);

        vm.warp(block.timestamp + 24 hours + 1 seconds);

        vm.prank(admin2);
        escrow.executeAdminChange(proposalId);

        assertTrue(escrow.isAdmin(new_admin), "update failed");
    }
}
