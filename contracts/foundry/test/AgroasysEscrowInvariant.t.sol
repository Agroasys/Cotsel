// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

// NOTE(issue-150):
// Pull-over-push claim migration is currently release-gated in Hardhat tests.
// Foundry parity requires `forge` availability in CI/local env before this suite
// can be promoted as a blocking gate for claim-flow semantics.

import "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {AgroasysEscrow} from "../src/AgroasysEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";


contract Handler is Test {
    AgroasysEscrow public escrow;
    MockUSDC public usdc;

    address public treasury;
    address public oracle;
    address public admin1;
    address public admin2;


    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public tradesCreated;
    uint256 public releaseStage1Triggered;
    uint256 public releaseStage2Triggered;
    uint256 public disputedRaised;
    uint256 public disputeSolved;


    constructor(AgroasysEscrow _escrow, MockUSDC _usdc, address _treasury, address _oracle, address _admin1, address _admin2){
        escrow = _escrow;
        usdc = _usdc;
        treasury = _treasury;
        oracle = _oracle;
        admin1 = _admin1;
        admin2 = _admin2;
    }

    function createTrade(
        uint96 logistics,
        uint96 fees,
        uint96 tranche1,
        uint96 tranche2,
        bytes32 ricardianHash,
        address supplier,
        uint16 privateKey
    ) public {
        logistics = uint96(bound(logistics, 1000e6, 10_000e6));
        fees = uint96(bound(fees, 500e6, 5_000e6));
        tranche1 = uint96(bound(tranche1, 10_000e6, 100_000e6));
        tranche2 = uint96(bound(tranche2, 10_000e6, 100_000e6));

        uint256 total = logistics + fees + tranche1 + tranche2;

        uint256 buyerPk = uint256(bound(privateKey,1,1000));
        address buyer = vm.addr(buyerPk);
        usdc.mint(buyer, total);

        uint256 nonce = escrow.getBuyerNonce(buyer);

        uint256 deadline = block.timestamp + 1 hours;

        bytes32 messageHashRecreated = keccak256(abi.encode(
            block.chainid,
            address(escrow),
            buyer,
            supplier, 
            treasury,
            total,
            logistics,
            fees,
            tranche1,
            tranche2,
            ricardianHash,
            nonce,
            deadline
        ));

        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHashRecreated));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, ethSignedMessageHash);
        bytes memory signature = abi.encodePacked(r, s, v);


        vm.startPrank(buyer);
        usdc.approve(address(escrow), total);
        escrow.createTrade(
            supplier,
            total,
            logistics,
            fees,
            tranche1,
            tranche2,
            ricardianHash,
            nonce,
            deadline,
            signature
        );
        totalDeposited += total;
        tradesCreated++;

        vm.stopPrank();
    }


    function releaseFundsStage1(uint96 random_tradeId) public {
        uint256 tradeCount = escrow.tradeCounter();
        if (tradeCount==0){
            return;
        }

        uint256 tradeId = random_tradeId % tradeCount;

        vm.prank(oracle);
        escrow.releaseFundsStage1(tradeId);
        (,,,,,, uint256 logistics,uint256 fees, uint256 tranche1,,,) = escrow.trades(tradeId);
        totalWithdrawn += logistics + tranche1 + fees;
        releaseStage1Triggered++;
    }

    function confirmArrival(uint96 random_tradeId) public {
        uint256 tradeCount = escrow.tradeCounter();
        if (tradeCount==0){
            return;
        }

        uint256 tradeId = random_tradeId % tradeCount;


        vm.prank(oracle);
        escrow.confirmArrival(tradeId);
    }

    function finalizeAfterDisputeWindow(uint96 random_tradeId) public {
        uint256 tradeCount = escrow.tradeCounter();
        if (tradeCount==0){
            return;
        }

        uint256 tradeId = random_tradeId % tradeCount;

        (,,,,,,,,,,,uint256 arrivalTimestamp) = escrow.trades(tradeId);

        vm.warp(arrivalTimestamp + 24 hours + 1);

        vm.prank(oracle);
        escrow.finalizeAfterDisputeWindow(tradeId);
        (,,,,,,,,,uint256 tranche2,,) = escrow.trades(tradeId);
        totalWithdrawn += tranche2;
        releaseStage2Triggered++;
    }

    function openDisputeByBuyer(uint96 random_tradeId) public {
        uint256 tradeCount = escrow.tradeCounter();
        if (tradeCount == 0) {
            return;
        }
        uint256 tradeId = random_tradeId % tradeCount;
        (,,,address buyer,,,,,,,,) = escrow.trades(tradeId);
        

        vm.prank(buyer);
        escrow.openDispute(tradeId);
        disputedRaised++;
    }

    function proposeDisputeSolution(uint96 random_tradeId, uint8 _disputeStatus) public {
        uint256 tradeCount = escrow.tradeCounter();
        if (tradeCount == 0) {
            return;
        }
        uint256 tradeId = random_tradeId % tradeCount;

        _disputeStatus = _disputeStatus % 2;
        
        vm.prank(admin1);
        escrow.proposeDisputeSolution(tradeId, AgroasysEscrow.DisputeStatus(_disputeStatus));
    }

    function approveDisputeSolution(uint96 random_proposalId) public {
        uint256 disputeCount = escrow.disputeCounter();
        if (disputeCount == 0) {
            return;
        }
        uint256 proposalId = random_proposalId % disputeCount;
        
        (uint256 tradeId,,,bool executed,,) = escrow.disputeProposals(proposalId);
        
        (,,,,,,, ,, uint256 tranche2,,) = escrow.trades(tradeId);
        

        vm.prank(admin2);
        escrow.approveDisputeSolution(proposalId);
        
        (,,, bool executedNow,,) = escrow.disputeProposals(proposalId);
        
        if (executedNow && !executed) {
            disputeSolved++;
            totalWithdrawn += tranche2;
        }
    }
}



contract InvariantTest is Test {
    AgroasysEscrow public escrow;
    MockUSDC public usdc;
    Handler public handler;

    address oracle;
    address admin1;
    address admin2;
    address admin3;
    address treasury;

    function setUp() public {
        treasury = makeAddr("treasury");
        oracle = makeAddr("oracle");
        admin1 = makeAddr("admin1");
        admin2 = makeAddr("admin2");
        admin3 = makeAddr("admin3");

        usdc = new MockUSDC();

        address[] memory admins = new address[](3);
        admins[0] = admin1;
        admins[1] = admin2;
        admins[2] = admin3;

        escrow = new AgroasysEscrow(address(usdc), oracle,treasury ,admins, 2);

        handler = new Handler(escrow,usdc,treasury,oracle,admin1,admin2);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = Handler.createTrade.selector;
        selectors[1] = Handler.releaseFundsStage1.selector;
        selectors[2] = Handler.confirmArrival.selector;
        selectors[3] = Handler.finalizeAfterDisputeWindow.selector;
        selectors[4] = Handler.openDisputeByBuyer.selector;
        selectors[5] = Handler.proposeDisputeSolution.selector;
        selectors[6] = Handler.approveDisputeSolution.selector;
        
                
        targetSelector(
            FuzzSelector({addr: address(handler),selectors: selectors})
        );
    }

    function _Summary() internal view {
        console2.log("Total trades:", uint256(handler.tradesCreated()));
        console2.log("Total locked in the escrow (USDC):", uint256(usdc.balanceOf(address(escrow))/1e6));
        console2.log("Total deposited (USDC):", uint256(handler.totalDeposited()/1e6));
        console2.log("Total withdrawn (USDC):", uint256(handler.totalWithdrawn()/1e6));
        console2.log("Total triger stage 1:", uint256(handler.releaseStage1Triggered()));
        console2.log("Total triger stage 2:", uint256(handler.releaseStage2Triggered()));
        console2.log("Total dispute raised:", uint256(handler.disputedRaised()));
        console2.log("Total dispute solved:", uint256(handler.disputeSolved()));
    }


    function invariant_EscrowBalanceMatchesLockedFunds() public view {
        uint256 totalLocked = 0;
        
        for (uint256 i = 0; i < escrow.tradeCounter(); i++) {
            (,,AgroasysEscrow.TradeStatus status,,,uint256 total,,,,uint256 tranche2,,) = escrow.trades(i);
            
            if (status == AgroasysEscrow.TradeStatus.LOCKED) {
                totalLocked += total;
            } else if (
                status == AgroasysEscrow.TradeStatus.IN_TRANSIT || 
                status == AgroasysEscrow.TradeStatus.ARRIVAL_CONFIRMED || 
                status == AgroasysEscrow.TradeStatus.FROZEN
            ) {
                totalLocked += tranche2;
            }
        }
        assertEq(usdc.balanceOf(address(escrow)), totalLocked, "escrow balance doesn't match logical locked funds");
        _Summary();
    }

    function invariant_EscrowFundsConservation() public view {
        uint256 amountRemaining = handler.totalDeposited() - handler.totalWithdrawn();
        uint256 escrowBalance = usdc.balanceOf(address(escrow));
        assertEq(escrowBalance, amountRemaining, "escrow balance doesn't match 'deposited - withdrawn'");
        _Summary();
    }

    function invariant_TotalWithdrawnNeverExceedsDeposited() public view {
        assertGe(handler.totalDeposited(), handler.totalWithdrawn(), "Withdrawn > deposited");
        _Summary();
    }

    function invariant_TradeCreationNumber() public view {
        assertEq(handler.tradesCreated(), escrow.tradeCounter(), "create trade calls don't match the number of trade created");
        _Summary();
    }

    function invariant_DisputesSolvedMatches() public view {
        uint256 disputedCount = 0;
        for (uint256 i = 0; i < escrow.disputeCounter(); i++) {
            (,,,bool executed,,) = escrow.disputeProposals(i);
            
            if (executed) {
                disputedCount ++;
            }
        }
        assertEq(disputedCount, handler.disputeSolved(), "dispute solved in the contract check failed");
        _Summary();
    }

    function invariant_TriggerStage1GreaterThanTriggerStage2() public view {
        assertGe(handler.releaseStage1Triggered(), handler.releaseStage2Triggered(), "stage 1 should be >= stage 2");
        _Summary();
    }

    function invariant_DisputeRaisedGreaterThanDisputeSolved() public view {
        assertGe(handler.disputedRaised(), handler.disputeSolved(), "dispute raised should be >= dispute solved");
        _Summary();
    }
}
