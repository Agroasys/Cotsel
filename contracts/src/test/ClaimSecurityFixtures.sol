// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface ITokenTransferHook {
    function onTokenTransferHook() external;
}

interface ITreasuryClaimEscrow {
    function claimTreasury() external;
}

contract HookedMockUSDC is ERC20 {
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address => bool) public hookEnabled;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    bool private _insideHook;

    constructor() ERC20("Hooked Mock USDC", "hUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHookEnabled(address account, bool enabled) external {
        hookEnabled[account] = enabled;
    }

    function _domainSeparatorV4() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Mock USDC")),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparatorV4(), structHash));
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp > validAfter, "authorization not yet valid");
        require(block.timestamp < validBefore, "authorization expired");
        require(!authorizationState[from][nonce], "authorization used");

        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), v, r, s);
        require(signer == from, "invalid authorization");

        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (!_insideHook && hookEnabled[to]) {
            _insideHook = true;
            ITokenTransferHook(to).onTokenTransferHook();
            _insideHook = false;
        }
        return super.transfer(to, amount);
    }
}

contract ClaimHookReceiver is ITokenTransferHook {
    ITreasuryClaimEscrow public immutable escrow;

    bool public attackEnabled;
    bool public forceRevert;
    bool public reentryAttempted;
    bytes public lastError;

    constructor(address escrowAddress) {
        escrow = ITreasuryClaimEscrow(escrowAddress);
    }

    function configure(bool _attackEnabled, bool _forceRevert) external {
        attackEnabled = _attackEnabled;
        forceRevert = _forceRevert;
    }

    function triggerTreasuryClaim() external {
        escrow.claimTreasury();
    }

    function onTokenTransferHook() external {
        if (attackEnabled && !reentryAttempted) {
            reentryAttempted = true;
            try escrow.claimTreasury() {}
            catch (bytes memory reason) {
                lastError = reason;
            }
        }

        if (forceRevert) {
            revert("hook revert");
        }
    }
}
