// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

// NOTE(issue-150):
// Pull-over-push claim migration is currently release-gated in Hardhat tests.
// Foundry parity requires `forge` availability in CI/local env before this suite
// can be promoted as a blocking gate for claim-flow semantics.

import "forge-std/Test.sol";
import {AgroasysEscrow} from "../src/AgroasysEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

abstract contract AgroasysEscrowFuzzBase is Test {
    AgroasysEscrow public escrow;
    MockUSDC public usdc;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant CREATE_TRADE_AUTHORIZATION_TYPEHASH = keccak256(
        "CreateTradeAuthorization(address buyer,address supplier,uint256 totalAmount,uint256 logisticsAmount,uint256 platformFeesAmount,uint256 supplierFirstTranche,uint256 supplierSecondTranche,bytes32 ricardianHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant USER_ACTION_AUTHORIZATION_TYPEHASH =
        keccak256("UserActionAuthorization(address user,uint8 action,uint256 tradeId,uint256 nonce,uint256 deadline)");
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
    function _create_trade(uint256 logistics, uint256 fees, uint256 tranche1, uint256 tranche2, bytes32 ricardianHash)
        internal
        returns (uint256)
    {
        uint256 total = logistics + fees + tranche1 + tranche2;
        uint256 nonce = escrow.authorizationNonces(buyer);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 escrowDomainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("AgroasysEscrow")),
                keccak256(bytes("1")),
                block.chainid,
                address(escrow)
            )
        );
        bytes32 createStructHash = keccak256(
            abi.encode(
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
            )
        );
        bytes32 createDigest = keccak256(abi.encodePacked("\x19\x01", escrowDomainSeparator, createStructHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, createDigest);
        bytes memory signature = abi.encodePacked(r, s, v);

        bytes32 usdcNonce = keccak256(abi.encodePacked("foundry-usdc", buyer, nonce, ricardianHash));
        bytes32 usdcDomainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Mock USDC")),
                keccak256(bytes("2")),
                block.chainid,
                address(usdc)
            )
        );
        bytes32 usdcStructHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH, buyer, address(escrow), total, uint256(0), deadline, usdcNonce
            )
        );
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
                validAfter: 0, validBefore: deadline, nonce: usdcNonce, v: usdcV, r: usdcR, s: usdcS
            })
        );

        return createdTradeId;
    }

    function _launch_schedule(uint96 goodsAmount)
        internal
        pure
        returns (uint96 fees, uint96 tranche1, uint96 tranche2)
    {
        uint256 supplierFee = uint256(goodsAmount) * 50 / 10_000;
        uint256 firstGross = uint256(goodsAmount) * 6_000 / 10_000;

        fees = uint96(uint256(goodsAmount) / 100 + supplierFee + 4e6);
        tranche1 = uint96(firstGross - supplierFee);
        tranche2 = uint96(uint256(goodsAmount) - firstGross);
    }

    function _authorize_user_action(uint8 action, uint256 tradeId)
        internal
        returns (uint256 nonce, uint256 deadline, bytes memory signature)
    {
        nonce = escrow.authorizationNonces(buyer);
        deadline = block.timestamp + 1 hours;
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("AgroasysEscrow")),
                keccak256(bytes("1")),
                block.chainid,
                address(escrow)
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(USER_ACTION_AUTHORIZATION_TYPEHASH, buyer, action, tradeId, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        signature = abi.encodePacked(r, s, v);
    }
}
