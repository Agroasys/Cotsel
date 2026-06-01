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

    address public treasury;
    address public oracle;
    address public admin1;
    address public admin2;


    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public totalClaimableUsdc;
    uint256 public tradesCreated;
    uint256 public releaseStage1Triggered;
    uint256 public releaseStage2Triggered;
    uint256 public disputedRaised;
    uint256 public disputeSolved;
    mapping(uint256 => uint256) public buyerPrivateKeyByTrade;


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

        bytes32 usdcNonce = keccak256(abi.encodePacked("invariant-usdc", buyer, nonce, ricardianHash));
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
        uint256 tradeId = escrow.createTradeWithAuthorization(
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
        buyerPrivateKeyByTrade[tradeId] = buyerPk;
        totalDeposited += total;
        tradesCreated++;
    }

    function _authorizeUserAction(
        address user,
        uint256 userPrivateKey,
        uint8 action,
        uint256 tradeId
    ) internal returns (uint256 nonce, uint256 deadline, bytes memory signature) {
        nonce = escrow.authorizationNonces(user);
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
            user,
            action,
            tradeId,
            nonce,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPrivateKey, digest);
        signature = abi.encodePacked(r, s, v);
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
        totalClaimableUsdc += logistics + fees;
        totalWithdrawn += tranche1;
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

        vm.prank(admin1);
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
        

        uint256 buyerPk = buyerPrivateKeyByTrade[tradeId];
        if (buyerPk == 0) {
            return;
        }
        (uint256 nonce, uint256 deadline, bytes memory signature) = _authorizeUserAction(buyer, buyerPk, 1, tradeId);
        vm.prank(admin1);
        escrow.openDisputeWithAuthorization(tradeId, nonce, deadline, signature);
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
        
        (uint256 tradeId,AgroasysEscrow.DisputeStatus disputeStatus,,bool executed,,) = escrow.disputeProposals(proposalId);
        
        (,,,,,,, ,, uint256 tranche2,,) = escrow.trades(tradeId);
        

        vm.prank(admin2);
        escrow.approveDisputeSolution(proposalId);
        
        (,,, bool executedNow,,) = escrow.disputeProposals(proposalId);
        
        if (executedNow && !executed) {
            disputeSolved++;
            if (disputeStatus == AgroasysEscrow.DisputeStatus.RESOLVE) {
                totalWithdrawn += tranche2;
            } else {
                totalWithdrawn += tranche2;
            }
        }
    }
}



contract InvariantTest is Test {
    AgroasysEscrow public escrow;
    MockUSDC public usdc;
    Handler public handler;

    address oracle;
    address relayer;
    address admin1;
    address admin2;
    address admin3;
    address treasury;

    function setUp() public {
        treasury = makeAddr("treasury");
        oracle = makeAddr("oracle");
        relayer = makeAddr("relayer");
        admin1 = makeAddr("admin1");
        admin2 = makeAddr("admin2");
        admin3 = makeAddr("admin3");

        usdc = new MockUSDC();

        address[] memory admins = new address[](3);
        admins[0] = admin1;
        admins[1] = admin2;
        admins[2] = admin3;

        escrow = new AgroasysEscrow(address(usdc), oracle, treasury, relayer, admins, 2);

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
        console2.log("Total claimable accrued (USDC):", uint256(handler.totalClaimableUsdc()/1e6));
        console2.log("Total trigger stage 1:", uint256(handler.releaseStage1Triggered()));
        console2.log("Total trigger stage 2:", uint256(handler.releaseStage2Triggered()));
        console2.log("Total dispute raised:", uint256(handler.disputedRaised()));
        console2.log("Total dispute solved:", uint256(handler.disputeSolved()));
    }


    function invariant_EscrowBalanceMatchesLockedFunds() public view {
        uint256 totalReserved = 0;
        
        for (uint256 i = 0; i < escrow.tradeCounter(); i++) {
            (,,AgroasysEscrow.TradeStatus status,,,uint256 total,,,,uint256 tranche2,,) = escrow.trades(i);
            
            if (status == AgroasysEscrow.TradeStatus.LOCKED) {
                totalReserved += total;
            } else if (
                status == AgroasysEscrow.TradeStatus.IN_TRANSIT || 
                status == AgroasysEscrow.TradeStatus.ARRIVAL_CONFIRMED || 
                status == AgroasysEscrow.TradeStatus.FROZEN
            ) {
                totalReserved += tranche2;
            }
        }
        uint256 expectedEscrowBalance = totalReserved + escrow.totalClaimableUsdc();
        assertEq(usdc.balanceOf(address(escrow)), expectedEscrowBalance, "escrow balance doesn't match reserved+claimable");
        _Summary();
    }

    function invariant_EscrowFundsConservation() public view {
        uint256 totalDeposited = handler.totalDeposited();
        uint256 totalWithdrawn = handler.totalWithdrawn();
        uint256 escrowBalance = usdc.balanceOf(address(escrow));
        assertEq(totalDeposited, escrowBalance + totalWithdrawn, "escrow funds conservation violated");
        assertEq(escrow.totalClaimableUsdc(), handler.totalClaimableUsdc(), "claimable tracking mismatch");
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
