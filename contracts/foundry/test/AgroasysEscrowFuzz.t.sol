// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {AgroasysEscrowFlowFuzzTests} from "./AgroasysEscrowFlowFuzz.sol";
import {AgroasysEscrowValidationFuzzTests} from "./AgroasysEscrowValidationFuzz.sol";
import {AgroasysEscrowTimeoutFuzzTests} from "./AgroasysEscrowTimeoutFuzz.sol";

contract FuzzTest is AgroasysEscrowFlowFuzzTests, AgroasysEscrowValidationFuzzTests, AgroasysEscrowTimeoutFuzzTests {}
