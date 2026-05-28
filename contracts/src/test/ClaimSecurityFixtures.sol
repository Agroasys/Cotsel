// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ITokenTransferHook {
    function onTokenTransferHook() external;
}

interface ITreasuryClaimEscrow {
    function claimTreasury() external;
}

contract HookedMockUSDC is ERC20 {
    mapping(address => bool) public hookEnabled;
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
