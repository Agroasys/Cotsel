// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

// NOTE(issue-150):
// Pull-over-push claim migration is currently release-gated in Hardhat tests.
// Foundry parity requires `forge` availability in CI/local env before this suite
// can be promoted as a blocking gate for claim-flow semantics.

import "forge-std/Test.sol";
import {AgroasysEscrow} from "../src/AgroasysEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract FuzzTest is Test {
    AgroasysEscrow public escrow;
    MockUSDC public usdc;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant CREATE_TRADE_AUTHORIZATION_TYPEHASH = keccak256(
        "CreateTradeAuthorization(address buyer,address supplier,uint256 totalAmount,uint256 logisticsAmount,uint256 platformFeesAmount,uint256 supplierFirstTranche,uint256 supplierSecondTranche,bytes32 ricardianHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant USER_ACTION_AUTHORIZATION_TYPEHASH = keccak256(
        "UserActionAuthorization(address user,uint8 action,uint256 tradeId,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    
    address buyer;
    uint256 buyerPk;
    address supplier;
    address treasury;
    address oracle;
    address relayer;
    address admin1;
    address admin2;
    address admin3;
    
    function setUp() public {
        (buyer, buyerPk) = makeAddrAndKey("buyer");
        supplier = makeAddr("supplier");
        treasury = makeAddr("treasury");
        oracle = makeAddr("oracle");
        relayer = makeAddr("relayer");
        admin1 = makeAddr("admin1");
        admin2 = makeAddr("admin2");
        admin3 = makeAddr("admin3");
        
        usdc = new MockUSDC();
        usdc.mint(buyer, 10_000_000e6);
        
        address[] memory admins = new address[](3);
        admins[0] = admin1;
        admins[1] = admin2;
        admins[2] = admin3;
        
        escrow = new AgroasysEscrow(address(usdc), oracle, treasury, relayer, admins, 2);
    }

    // helper function
    function _create_trade(
        uint256 logistics,
        uint256 fees,
        uint256 tranche1,
        uint256 tranche2,
        bytes32 ricardianHash
    ) internal returns (uint256) {
        uint256 total = logistics + fees + tranche1 + tranche2;
        uint256 nonce = escrow.authorizationNonces(buyer);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 escrowDomainSeparator = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes("AgroasysEscrow")),
            keccak256(bytes("1")),
            block.chainid,
            address(escrow)
        ));
        bytes32 createStructHash = keccak256(abi.encode(
            CREATE_TRADE_AUTHORIZATION_TYPEHASH,
            buyer,
            supplier, 
            total,
            logistics,
            fees,
            tranche1,
            tranche2,
            ricardianHash,
            nonce,
            deadline
        ));
        bytes32 createDigest = keccak256(abi.encodePacked("\x19\x01", escrowDomainSeparator, createStructHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, createDigest);
        bytes memory signature = abi.encodePacked(r, s, v);

        bytes32 usdcNonce = keccak256(abi.encodePacked("foundry-usdc", buyer, nonce, ricardianHash));
        bytes32 usdcDomainSeparator = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes("Mock USDC")),
            keccak256(bytes("2")),
            block.chainid,
            address(usdc)
        ));
        bytes32 usdcStructHash = keccak256(abi.encode(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
            buyer,
            address(escrow),
            total,
            uint256(0),
            deadline,
            usdcNonce
        ));
        bytes32 usdcDigest = keccak256(abi.encodePacked("\x19\x01", usdcDomainSeparator, usdcStructHash));
        (uint8 usdcV, bytes32 usdcR, bytes32 usdcS) = vm.sign(buyerPk, usdcDigest);

        vm.prank(admin1);
        uint256 createdTradeId = escrow.createTradeWithAuthorization(
            buyer,
            supplier,
            total,
            logistics,
            fees,
            tranche1,
            tranche2,
            ricardianHash,
            nonce,
            deadline,
            signature,
            AgroasysEscrow.UsdcAuthorization({
                validAfter: 0,
                validBefore: deadline,
                nonce: usdcNonce,
                v: usdcV,
                r: usdcR,
                s: usdcS
            })
        );

        return createdTradeId;
    }

    function _authorize_user_action(uint8 action, uint256 tradeId) internal returns (uint256 nonce, uint256 deadline, bytes memory signature) {
        nonce = escrow.authorizationNonces(buyer);
        deadline = block.timestamp + 1 hours;
        bytes32 domainSeparator = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes("AgroasysEscrow")),
            keccak256(bytes("1")),
            block.chainid,
            address(escrow)
        ));
        bytes32 structHash = keccak256(abi.encode(
            USER_ACTION_AUTHORIZATION_TYPEHASH,
            buyer,
            action,
            tradeId,
            nonce,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        signature = abi.encodePacked(r, s, v);
    }
    
    function test_Setup() public view {
        assertEq(escrow.oracleAddress(), oracle);
        assertEq(usdc.balanceOf(buyer), 10_000_000e6);
        assertEq(escrow.tradeCounter(), 0, "initial trade counter should be 0");
        assertEq(escrow.requiredApprovals(), 2, "required approvals should be 2");

    }
    

    function testFuzz_completeUserFlowWithoutDispute(uint96 logistics,uint96 fees,uint96 tranche1,uint96 tranche2, bytes32 ricardianHash) public {
        // check fuzzed inputs
        vm.assume(ricardianHash != bytes32(0));
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        fees = uint96(bound(fees, 500e6, 5_000e6));
        tranche1 = uint96(bound(tranche1, 10_000e6, 100_000e6));
        tranche2 = uint96(bound(tranche2, 10_000e6, 100_000e6));
        
        uint256 total = logistics + fees + tranche1 + tranche2;

        uint256 buyerBeforeTradeCreationBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeTradeCreationBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeTradeCreationBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeTradeCreationBalance = usdc.balanceOf(address(escrow));
        
        // ######################## 1) CREATE TRADE #########################################
        uint256 tradeId = _create_trade(logistics,fees,tranche1,tranche2, ricardianHash);
        
        (uint256 _tradeId,,AgroasysEscrow.TradeStatus _status,address _buyer,address _supplier,uint256 _total,uint256 _logistics,uint256 _fees,uint256 _tranche1,uint256 _tranche2,,) = escrow.trades(tradeId);

        // check that trades values are stored correctly
        assertEq(_tradeId, tradeId, "trade id mismatch");
        assertEq(_buyer,buyer,"buyer mismatch");
        assertEq(_supplier, supplier, "supplier mismatch");
        assertEq(uint8(_status), uint8(AgroasysEscrow.TradeStatus.LOCKED), "status should be LOCKED");
        assertEq(_total, total, "total mismatch");
        assertEq(_logistics, logistics, "logistics mismatch");
        assertEq(_fees, fees, "fees mismatch");
        assertEq(_tranche1, tranche1, "tranche1 mismatch");
        assertEq(_tranche2, tranche2, "tranche2 mismatch");
        assertEq(_total, _logistics + _fees + _tranche1 + _tranche2, "total mismatch sum of logistic+fees+tranche1&2");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeTradeCreationBalance-total,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeTradeCreationBalance,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeTradeCreationBalance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeTradeCreationBalance+total,"escrow balance mismatch");


        // ######################## 2) RELEASE FUNDS STAGE 1 #########################################
        uint256 buyerBeforeReleaseFundsStage1Balance = usdc.balanceOf(buyer);
        uint256 supplierBeforeReleaseFundsStage1Balance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeReleaseFundsStage1Balance = usdc.balanceOf(treasury);
        uint256 escrowBeforeReleaseFundsStage1Balance = usdc.balanceOf(address(escrow));
        uint256 treasuryBeforeReleaseFundsStage1Claimable = escrow.claimableUsdc(treasury);

        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);

        (,,AgroasysEscrow.TradeStatus _status2,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status2), uint8(AgroasysEscrow.TradeStatus.IN_TRANSIT), "status should be IN_TRANSIT");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeReleaseFundsStage1Balance,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeReleaseFundsStage1Balance + tranche1,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeReleaseFundsStage1Balance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeReleaseFundsStage1Balance - tranche1,"escrow balance mismatch");
        assertEq(escrow.claimableUsdc(supplier),0,"supplier claimableUsdc mismatch");
        assertEq(escrow.claimableUsdc(treasury),treasuryBeforeReleaseFundsStage1Claimable + fees + logistics,"treasury claimableUsdc mismatch");


        // ######################## 3) CONFIRM ARRIVAL #########################################
        uint256 buyerBeforeArrivalConfirmationBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeArrivalConfirmationBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeArrivalConfirmationBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeArrivalConfirmationBalance = usdc.balanceOf(address(escrow));

        vm.prank(oracle);
        escrow.confirmArrival(tradeId);

        (,,AgroasysEscrow.TradeStatus _status3,,,,,,,,,uint256 _arrivalTimestamp) = escrow.trades(tradeId);

        assertEq(_arrivalTimestamp, block.timestamp, "arrival timestamp should be set");
        assertEq(uint8(_status3), uint8(AgroasysEscrow.TradeStatus.ARRIVAL_CONFIRMED), "status should be ARRIVAL_CONFIRMED");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeArrivalConfirmationBalance,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeArrivalConfirmationBalance,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeArrivalConfirmationBalance,"treasury balance mismatch 3)");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeArrivalConfirmationBalance,"escrow balance mismatch");


        // ######################## 4) RELEASE FUNDS STAGE 2 #########################################
        uint256 buyerBeforeReleaseFundsStage2Balance = usdc.balanceOf(buyer);
        uint256 supplierBeforeReleaseFundsStage2Balance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeReleaseFundsStage2Balance = usdc.balanceOf(treasury);
        uint256 escrowBeforeReleaseFundsStage2Balance = usdc.balanceOf(address(escrow));

        // increase time by 24 hours
        vm.warp(block.timestamp + 24 hours + 1);

        vm.prank(admin1);
        escrow.finalizeAfterDisputeWindow(tradeId);

        (,,AgroasysEscrow.TradeStatus _status4,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status4), uint8(AgroasysEscrow.TradeStatus.CLOSED), "status should be CLOSED");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeReleaseFundsStage2Balance,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeReleaseFundsStage2Balance + tranche2,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeReleaseFundsStage2Balance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeReleaseFundsStage2Balance - tranche2,"escrow balance mismatch");
        assertEq(escrow.claimableUsdc(supplier),0,"supplier claimableUsdc mismatch");
    }



    function testFuzz_completeUserFlowWithDisputeResolve(uint96 logistics,uint96 fees,uint96 tranche1,uint96 tranche2, bytes32 ricardianHash) public {
        // check fuzzed inputs
        vm.assume(ricardianHash != bytes32(0));
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        fees = uint96(bound(fees, 500e6, 5_000e6));
        tranche1 = uint96(bound(tranche1, 10_000e6, 100_000e6));
        tranche2 = uint96(bound(tranche2, 10_000e6, 100_000e6));
        
        uint256 total = logistics + fees + tranche1 + tranche2;

        uint256 buyerBeforeTradeCreationBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeTradeCreationBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeTradeCreationBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeTradeCreationBalance = usdc.balanceOf(address(escrow));
        
        // ######################## 1) CREATE TRADE #########################################
        uint256 tradeId = _create_trade(logistics,fees,tranche1,tranche2, ricardianHash);
        
        (uint256 _tradeId,,AgroasysEscrow.TradeStatus _status,address _buyer,address _supplier,uint256 _total,uint256 _logistics,uint256 _fees,uint256 _tranche1,uint256 _tranche2,,) = escrow.trades(tradeId);

        // check that trades values are stored correctly
        assertEq(_tradeId, tradeId, "trade id mismatch");
        assertEq(_buyer,buyer,"buyer mismatch");
        assertEq(_supplier, supplier, "supplier mismatch");
        assertEq(uint8(_status), uint8(AgroasysEscrow.TradeStatus.LOCKED), "status should be LOCKED");
        assertEq(_total, total, "total mismatch");
        assertEq(_logistics, logistics, "logistics mismatch");
        assertEq(_fees, fees, "fees mismatch");
        assertEq(_tranche1, tranche1, "tranche1 mismatch");
        assertEq(_tranche2, tranche2, "tranche2 mismatch");
        assertEq(_total, _logistics + _fees + _tranche1 + _tranche2, "total mismatch sum of logistic+fees+tranche1&2");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeTradeCreationBalance-total,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeTradeCreationBalance,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeTradeCreationBalance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeTradeCreationBalance+total,"escrow balance mismatch");


        // ######################## 2) RELEASE FUNDS STAGE 1 #########################################
        uint256 buyerBeforeReleaseFundsStage1Balance = usdc.balanceOf(buyer);
        uint256 supplierBeforeReleaseFundsStage1Balance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeReleaseFundsStage1Balance = usdc.balanceOf(treasury);
        uint256 escrowBeforeReleaseFundsStage1Balance = usdc.balanceOf(address(escrow));
        uint256 treasuryBeforeReleaseFundsStage1Claimable = escrow.claimableUsdc(treasury);

        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);

        (,,AgroasysEscrow.TradeStatus _status2,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status2), uint8(AgroasysEscrow.TradeStatus.IN_TRANSIT), "status should be IN_TRANSIT");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeReleaseFundsStage1Balance,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeReleaseFundsStage1Balance + tranche1,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeReleaseFundsStage1Balance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeReleaseFundsStage1Balance - tranche1,"escrow balance mismatch");
        assertEq(escrow.claimableUsdc(supplier),0,"supplier claimableUsdc mismatch");
        assertEq(escrow.claimableUsdc(treasury),treasuryBeforeReleaseFundsStage1Claimable + logistics + fees,"treasury claimableUsdc mismatch");


        // ######################## 3) CONFIRM ARRIVAL #########################################
        uint256 buyerBeforeArrivalConfirmationBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeArrivalConfirmationBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeArrivalConfirmationBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeArrivalConfirmationBalance = usdc.balanceOf(address(escrow));

        vm.prank(oracle);
        escrow.confirmArrival(tradeId);

        (,,AgroasysEscrow.TradeStatus _status3,,,,,,,,,uint256 _arrivalTimestamp) = escrow.trades(tradeId);

        assertEq(_arrivalTimestamp, block.timestamp, "arrival timestamp should be set");
        assertEq(uint8(_status3), uint8(AgroasysEscrow.TradeStatus.ARRIVAL_CONFIRMED), "status should be ARRIVAL_CONFIRMED");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeArrivalConfirmationBalance,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeArrivalConfirmationBalance,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeArrivalConfirmationBalance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeArrivalConfirmationBalance,"escrow balance mismatch");


        // ######################## 4) BUYER OPEN DISPUTE #########################################
        uint256 buyerBeforeOpenDisputeBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeOpenDisputeBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeOpenDisputeBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeOpenDisputeBalance = usdc.balanceOf(address(escrow));

        vm.warp(block.timestamp + 1 hours);

        (uint256 actionNonce, uint256 actionDeadline, bytes memory actionSignature) = _authorize_user_action(1, tradeId);
        vm.prank(admin1);
        escrow.openDisputeWithAuthorization(tradeId, actionNonce, actionDeadline, actionSignature);

        (,,AgroasysEscrow.TradeStatus _status4,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status4), uint8(AgroasysEscrow.TradeStatus.FROZEN), "status should be FROZEN");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeOpenDisputeBalance,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeOpenDisputeBalance,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeOpenDisputeBalance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeOpenDisputeBalance,"escrow balance mismatch");


        // ######################## 5) ADMIN PROPOSE SOLUTION #########################################
        uint256 buyerBeforeProposeSolutionBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeProposeSolutionBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeProposeSolutionBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeProposeSolutionBalance = usdc.balanceOf(address(escrow));

        vm.prank(admin1);
        uint256 proposalId = escrow.proposeDisputeSolution(tradeId, AgroasysEscrow.DisputeStatus.RESOLVE);

        (,,AgroasysEscrow.TradeStatus _status5,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status5), uint8(AgroasysEscrow.TradeStatus.FROZEN), "status should be FROZEN");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeProposeSolutionBalance,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeProposeSolutionBalance,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeProposeSolutionBalance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeProposeSolutionBalance,"escrow balance mismatch");


        // ######################## 6) ADMIN APPROVES #################################################
        uint256 buyerBeforeApproveSolutionBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeApproveSolutionBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeApproveSolutionBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeApproveSolutionBalance = usdc.balanceOf(address(escrow));

        vm.prank(admin2);
        escrow.approveDisputeSolution(proposalId);

        (,,AgroasysEscrow.TradeStatus _status6,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status6), uint8(AgroasysEscrow.TradeStatus.CLOSED), "status should be CLOSED");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeApproveSolutionBalance,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeApproveSolutionBalance + tranche2,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeApproveSolutionBalance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeApproveSolutionBalance - tranche2,"escrow balance mismatch");
        assertEq(escrow.claimableUsdc(supplier),0,"supplier claimableUsdc mismatch");
    }


    function testFuzz_completeUserFlowWithDisputeRefund(uint96 logistics,uint96 fees,uint96 tranche1,uint96 tranche2, bytes32 ricardianHash) public {
        // check fuzzed inputs
        vm.assume(ricardianHash != bytes32(0));
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        fees = uint96(bound(fees, 500e6, 5_000e6));
        tranche1 = uint96(bound(tranche1, 10_000e6, 100_000e6));
        tranche2 = uint96(bound(tranche2, 10_000e6, 100_000e6));
        
        uint256 total = logistics + fees + tranche1 + tranche2;

        uint256 buyerBeforeTradeCreationBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeTradeCreationBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeTradeCreationBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeTradeCreationBalance = usdc.balanceOf(address(escrow));
        
        // ######################## 1) CREATE TRADE #########################################
        uint256 tradeId = _create_trade(logistics,fees,tranche1,tranche2, ricardianHash);
        
        (uint256 _tradeId,,AgroasysEscrow.TradeStatus _status,address _buyer,address _supplier,uint256 _total,uint256 _logistics,uint256 _fees,uint256 _tranche1,uint256 _tranche2,,) = escrow.trades(tradeId);

        // check that trades values are stored correctly
        assertEq(_tradeId, tradeId, "trade id mismatch");
        assertEq(_buyer,buyer,"buyer mismatch");
        assertEq(_supplier, supplier, "supplier mismatch");
        assertEq(uint8(_status), uint8(AgroasysEscrow.TradeStatus.LOCKED), "status should be LOCKED");
        assertEq(_total, total, "total mismatch");
        assertEq(_logistics, logistics, "logistics mismatch");
        assertEq(_fees, fees, "fees mismatch");
        assertEq(_tranche1, tranche1, "tranche1 mismatch");
        assertEq(_tranche2, tranche2, "tranche2 mismatch");
        assertEq(_total, _logistics + _fees + _tranche1 + _tranche2, "total mismatch sum of logistic+fees+tranche1&2");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeTradeCreationBalance-total,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeTradeCreationBalance,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeTradeCreationBalance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeTradeCreationBalance+total,"escrow balance mismatch");


        // ######################## 2) RELEASE FUNDS STAGE 1 #########################################
        uint256 buyerBeforeReleaseFundsStage1Balance = usdc.balanceOf(buyer);
        uint256 supplierBeforeReleaseFundsStage1Balance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeReleaseFundsStage1Balance = usdc.balanceOf(treasury);
        uint256 escrowBeforeReleaseFundsStage1Balance = usdc.balanceOf(address(escrow));
        uint256 treasuryBeforeReleaseFundsStage1Claimable = escrow.claimableUsdc(treasury);

        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);

        (,,AgroasysEscrow.TradeStatus _status2,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status2), uint8(AgroasysEscrow.TradeStatus.IN_TRANSIT), "status should be IN_TRANSIT");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeReleaseFundsStage1Balance,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeReleaseFundsStage1Balance + tranche1,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeReleaseFundsStage1Balance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeReleaseFundsStage1Balance - tranche1,"escrow balance mismatch");
        assertEq(escrow.claimableUsdc(supplier),0,"supplier claimableUsdc mismatch");
        assertEq(escrow.claimableUsdc(treasury),treasuryBeforeReleaseFundsStage1Claimable + logistics + fees,"treasury claimableUsdc mismatch");


        // ######################## 3) CONFIRM ARRIVAL #########################################
        uint256 buyerBeforeArrivalConfirmationBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeArrivalConfirmationBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeArrivalConfirmationBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeArrivalConfirmationBalance = usdc.balanceOf(address(escrow));

        vm.prank(oracle);
        escrow.confirmArrival(tradeId);

        (,,AgroasysEscrow.TradeStatus _status3,,,,,,,,,uint256 _arrivalTimestamp) = escrow.trades(tradeId);

        assertEq(_arrivalTimestamp, block.timestamp, "arrival timestamp should be set");

        assertEq(uint8(_status3), uint8(AgroasysEscrow.TradeStatus.ARRIVAL_CONFIRMED), "status should be ARRIVAL_CONFIRMED");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeArrivalConfirmationBalance,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeArrivalConfirmationBalance,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeArrivalConfirmationBalance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeArrivalConfirmationBalance,"escrow balance mismatch");


        // ######################## 4) BUYER OPEN DISPUTE #########################################
        uint256 buyerBeforeOpenDisputeBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeOpenDisputeBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeOpenDisputeBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeOpenDisputeBalance = usdc.balanceOf(address(escrow));

        vm.warp(block.timestamp + 1 hours);

        (uint256 actionNonce, uint256 actionDeadline, bytes memory actionSignature) = _authorize_user_action(1, tradeId);
        vm.prank(admin1);
        escrow.openDisputeWithAuthorization(tradeId, actionNonce, actionDeadline, actionSignature);

        (,,AgroasysEscrow.TradeStatus _status4,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status4), uint8(AgroasysEscrow.TradeStatus.FROZEN), "status should be FROZEN");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeOpenDisputeBalance,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeOpenDisputeBalance,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeOpenDisputeBalance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeOpenDisputeBalance,"escrow balance mismatch");


        // ######################## 5) ADMIN PROPOSE SOLUTION #########################################
        uint256 buyerBeforeProposeSolutionBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeProposeSolutionBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeProposeSolutionBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeProposeSolutionBalance = usdc.balanceOf(address(escrow));

        vm.prank(admin1);
        uint256 proposalId = escrow.proposeDisputeSolution(tradeId, AgroasysEscrow.DisputeStatus.REFUND);

        (,,AgroasysEscrow.TradeStatus _status5,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status5), uint8(AgroasysEscrow.TradeStatus.FROZEN), "status should be FROZEN");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeProposeSolutionBalance,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeProposeSolutionBalance,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeProposeSolutionBalance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeProposeSolutionBalance,"escrow balance mismatch");


        // ######################## 6) ADMIN APPROVES #################################################
        uint256 buyerBeforeApproveSolutionBalance = usdc.balanceOf(buyer);
        uint256 supplierBeforeApproveSolutionBalance = usdc.balanceOf(supplier);
        uint256 treasuryBeforeApproveSolutionBalance = usdc.balanceOf(treasury);
        uint256 escrowBeforeApproveSolutionBalance = usdc.balanceOf(address(escrow));

        vm.prank(admin2);
        escrow.approveDisputeSolution(proposalId);

        (,,AgroasysEscrow.TradeStatus _status6,,,,,,,,,) = escrow.trades(tradeId);

        assertEq(uint8(_status6), uint8(AgroasysEscrow.TradeStatus.CLOSED), "status should be CLOSED");
        // check that balances are correct
        assertEq(usdc.balanceOf(buyer),buyerBeforeApproveSolutionBalance + tranche2,"buyer balance mismatch");
        assertEq(usdc.balanceOf(supplier),supplierBeforeApproveSolutionBalance,"supplier balance mismatch");
        assertEq(usdc.balanceOf(treasury),treasuryBeforeApproveSolutionBalance,"treasury balance mismatch");
        assertEq(usdc.balanceOf(address(escrow)),escrowBeforeApproveSolutionBalance - tranche2,"escrow balance mismatch");
        assertEq(escrow.claimableUsdc(buyer),0,"buyer claimableUsdc mismatch");
    }


    function testFuzz_CannotOpenDisputeBeforeArrival(uint96 logistics, uint96 fees, uint96 tranche1, uint96 tranche2, bytes32 ricardianHash) public {
        vm.assume(ricardianHash != bytes32(0));
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        fees = uint96(bound(fees, 500e6, 5_000e6));
        tranche1 = uint96(bound(tranche1, 10_000e6, 100_000e6));
        tranche2 = uint96(bound(tranche2, 10_000e6, 100_000e6));

        
        uint256 tradeId = _create_trade(logistics,fees,tranche1,tranche2, ricardianHash);
        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);
        
        (uint256 actionNonce, uint256 actionDeadline, bytes memory actionSignature) = _authorize_user_action(1, tradeId);
        vm.expectRevert("must be ARRIVAL_CONFIRMED");
        vm.prank(admin1);
        escrow.openDisputeWithAuthorization(tradeId, actionNonce, actionDeadline, actionSignature);
    }

    function testFuzz_CannotOpenDisputeAfter24Hours(uint96 logistics, uint96 fees, uint96 tranche1, uint96 tranche2, bytes32 ricardianHash) public {
        vm.assume(ricardianHash != bytes32(0));
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        fees = uint96(bound(fees, 500e6, 5_000e6));
        tranche1 = uint96(bound(tranche1, 10_000e6, 100_000e6));
        tranche2 = uint96(bound(tranche2, 10_000e6, 100_000e6));

     
        uint256 tradeId = _create_trade(logistics,fees,tranche1,tranche2, ricardianHash);
        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);

        vm.prank(oracle);
        escrow.confirmArrival(tradeId);
        
        vm.warp(block.timestamp + 24 hours + 1 seconds);
        
        (uint256 actionNonce, uint256 actionDeadline, bytes memory actionSignature) = _authorize_user_action(1, tradeId);
        vm.expectRevert("window closed");
        vm.prank(admin1);
        escrow.openDisputeWithAuthorization(tradeId, actionNonce, actionDeadline, actionSignature);
    }


    function testFuzz_CannotReleaseStage2Before24Hours(uint96 logistics, uint96 fees, uint96 tranche1, uint96 tranche2, bytes32 ricardianHash) public {
        vm.assume(ricardianHash != bytes32(0));
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        fees = uint96(bound(fees, 500e6, 5_000e6));
        tranche1 = uint96(bound(tranche1, 10_000e6, 100_000e6));
        tranche2 = uint96(bound(tranche2, 10_000e6, 100_000e6));

     
        uint256 tradeId = _create_trade(logistics,fees,tranche1,tranche2, ricardianHash);
        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);

        vm.prank(oracle);
        escrow.confirmArrival(tradeId);
        
        vm.warp(block.timestamp + 1 hours);
        
        vm.prank(admin1);
        vm.expectRevert("window not elapsed");
        escrow.finalizeAfterDisputeWindow(tradeId);
    }

    function testFuzz_UpdateOracle(address new_oracle) public {
        vm.assume(new_oracle!=address(0));
        vm.assume(new_oracle!=escrow.oracleAddress());

        vm.prank(admin1);
        uint256 proposalId = escrow.proposeOracleUpdate(new_oracle);

        vm.prank(admin2);
        escrow.approveOracleUpdate(proposalId);

        vm.warp(block.timestamp + 24 hours + 1 seconds);

        vm.prank(admin2);
        escrow.executeOracleUpdate(proposalId);


        assertEq(new_oracle,escrow.oracleAddress(),"update failed");
    }


    function testFuzz_UpdateAdmins(address new_admin) public {
        vm.assume(new_admin!=address(0));
        vm.assume(!escrow.isAdmin(new_admin));

        vm.prank(admin1);
        uint256 proposalId = escrow.proposeAddAdmin(new_admin);

        vm.prank(admin2);
        escrow.approveAddAdmin(proposalId);

        vm.warp(block.timestamp + 24 hours + 1 seconds);

        vm.prank(admin2);
        escrow.executeAddAdmin(proposalId);


        assertTrue(escrow.isAdmin(new_admin),"update failed");
    }
    

    function testFuzz_CancelLockedTradeAfterTimeout(uint96 logistics, uint96 fees, uint96 tranche1, uint96 tranche2, bytes32 ricardianHash) public {
        vm.assume(ricardianHash != bytes32(0));
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        fees = uint96(bound(fees, 500e6, 5_000e6));
        tranche1 = uint96(bound(tranche1, 10_000e6, 100_000e6));
        tranche2 = uint96(bound(tranche2, 10_000e6, 100_000e6));
        
        uint256 total = logistics + fees + tranche1 + tranche2;
        uint256 refundablePrincipal = tranche1 + tranche2;

        uint256 tradeId = _create_trade(logistics, fees, tranche1, tranche2, ricardianHash);
        
        (,,AgroasysEscrow.TradeStatus _status,,,uint256 _total,,,,,,) = escrow.trades(tradeId);
        
        assertEq(uint8(_status), uint8(AgroasysEscrow.TradeStatus.LOCKED), "status should be LOCKED");
        assertEq(_total, total, "total mismatch");
        
        uint256 buyerBalanceBefore = usdc.balanceOf(buyer);
        uint256 escrowBalanceBefore = usdc.balanceOf(address(escrow));
        uint256 treasuryClaimableBefore = escrow.claimableUsdc(treasury);
        
        vm.warp(block.timestamp + 7 days + 1);
        
        (uint256 actionNonce, uint256 actionDeadline, bytes memory actionSignature) = _authorize_user_action(2, tradeId);
        vm.prank(admin1);
        escrow.cancelLockedTradeAfterTimeoutWithAuthorization(tradeId, actionNonce, actionDeadline, actionSignature);
        
        (,,AgroasysEscrow.TradeStatus _statusAfter,,,,,,,,,) = escrow.trades(tradeId);
        
        assertEq(uint8(_statusAfter), uint8(AgroasysEscrow.TradeStatus.CLOSED), "status should be CLOSED");
        assertEq(usdc.balanceOf(buyer), buyerBalanceBefore + refundablePrincipal, "buyer should receive refundable principal immediately");
        assertEq(usdc.balanceOf(address(escrow)), escrowBalanceBefore - refundablePrincipal, "escrow balance should retain only non-refundable fees");
        assertEq(escrow.claimableUsdc(buyer), 0, "buyer claimable should remain zero after direct refund");
        assertEq(escrow.claimableUsdc(treasury), treasuryClaimableBefore + logistics + fees, "treasury claimable should retain non-refundable fees");
    }


    function testFuzz_RefundInTransitAfterTimeout(uint96 logistics, uint96 fees, uint96 tranche1, uint96 tranche2, bytes32 ricardianHash) public {
        vm.assume(ricardianHash != bytes32(0));
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        fees = uint96(bound(fees, 500e6, 5_000e6));
        tranche1 = uint96(bound(tranche1, 10_000e6, 100_000e6));
        tranche2 = uint96(bound(tranche2, 10_000e6, 100_000e6));
        
        uint256 tradeId = _create_trade(logistics, fees, tranche1, tranche2, ricardianHash);
        
        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);
        
        (,,AgroasysEscrow.TradeStatus _status,,,,,,,,,) = escrow.trades(tradeId);
        assertEq(uint8(_status), uint8(AgroasysEscrow.TradeStatus.IN_TRANSIT), "status should be IN_TRANSIT");
        
        uint256 buyerBalanceBefore = usdc.balanceOf(buyer);
        uint256 escrowBalanceBefore = usdc.balanceOf(address(escrow));
        
        assertEq(escrowBalanceBefore, logistics + fees + tranche2, "escrow balance should retain only unpaid funds after stage1 payout");
        
        vm.warp(block.timestamp + 14 days + 1);
        
        (uint256 actionNonce, uint256 actionDeadline, bytes memory actionSignature) = _authorize_user_action(3, tradeId);
        vm.prank(admin1);
        escrow.refundInTransitAfterTimeoutWithAuthorization(tradeId, actionNonce, actionDeadline, actionSignature);
        
        (,,AgroasysEscrow.TradeStatus _statusAfter,,,,,,,,,) = escrow.trades(tradeId);
        
        assertEq(uint8(_statusAfter), uint8(AgroasysEscrow.TradeStatus.CLOSED), "status should be CLOSED");
        assertEq(usdc.balanceOf(buyer), buyerBalanceBefore + tranche2, "buyer should receive tranche2 refund immediately");
        assertEq(usdc.balanceOf(address(escrow)), escrowBalanceBefore - tranche2, "escrow balance should retain only treasury fees");
        assertEq(escrow.claimableUsdc(buyer), 0, "buyer claimable should remain zero after direct refund");
    }

    function test_treasuryPayoutRotationRoutesClaimTreasury() public {
        uint256 tradeId = _create_trade(1_000e6, 500e6, 10_000e6, 10_000e6, keccak256("doc"));

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
