// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IUSDCReceiveWithAuthorization {
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
    ) external;
}

/**
 * AgroasysEscrow
 * - Milestone escrow (Stage 1 + Stage 2)
 * - Arrival confirmation starts a 24h buyer dispute window
 * - Buyer can freeze during window; admins resolve with 4-eyes approval
 * - Treasury ONLY receives explicit fees (logistics + platform fees); buyer principal never routes to treasury
 * - Signature uses buyer-scoped nonce (no global tradeId pre-query race) + deadline + domain separation
 *
 * Business rule enforced:
 * - Logistics/platform fees are non-refundable once a trade is funded; platformFeesAmount includes the fixed settlement fee
 * - Stage 1 release pays supplierFirstTranche (principal) directly and accrues logistics/platform fees for treasury sweep
 * - Stage 2 finalization pays supplierSecondTranche (principal) directly to supplier
 * - Buyer refunds are transferred directly during the refund transaction; buyers never need to claim
 */
contract AgroasysEscrow is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // -----------------------------
    // Constants
    // -----------------------------
    /// @notice Buyer dispute window after arrival confirmation.
    uint256 public constant DISPUTE_WINDOW = 24 hours;
    /// @notice Maximum time a trade can remain LOCKED before buyer can cancel for refundable principal.
    uint256 public constant LOCK_TIMEOUT = 7 days;
    /// @notice Maximum time a trade can remain IN_TRANSIT without arrival confirmation before buyer principal refund.
    uint256 public constant IN_TRANSIT_TIMEOUT = 14 days;
    /// @notice Time-to-live for dispute proposals before they must be replaced or cancelled.
    uint256 public constant DISPUTE_PROPOSAL_TTL = 7 days;
    /// @notice Time-to-live for governance proposals (oracle/admin updates).
    uint256 public constant GOVERNANCE_PROPOSAL_TTL = 7 days;

    bytes32 public constant ACTION_CREATE_TRADE = keccak256("CREATE_TRADE");
    bytes32 public constant ACTION_OPEN_DISPUTE = keccak256("OPEN_DISPUTE");
    bytes32 public constant ACTION_CANCEL_LOCKED_TIMEOUT = keccak256("CANCEL_LOCKED_TIMEOUT");
    bytes32 public constant ACTION_REFUND_IN_TRANSIT_TIMEOUT = keccak256("REFUND_IN_TRANSIT_TIMEOUT");
    bytes32 public constant ACTION_FINALIZE_AFTER_DISPUTE_WINDOW = keccak256("FINALIZE_AFTER_DISPUTE_WINDOW");

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant CREATE_TRADE_AUTHORIZATION_TYPEHASH = keccak256(
        "CreateTradeAuthorization(address buyer,address supplier,uint256 totalAmount,uint256 logisticsAmount,uint256 platformFeesAmount,uint256 supplierFirstTranche,uint256 supplierSecondTranche,bytes32 ricardianHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant USER_ACTION_AUTHORIZATION_TYPEHASH = keccak256(
        "UserActionAuthorization(address user,uint8 action,uint256 tradeId,uint256 nonce,uint256 deadline)"
    );
    bytes32 private immutable DOMAIN_SEPARATOR;

    // -----------------------------
    // Enums / Structs
    // -----------------------------
    enum TradeStatus {
        LOCKED,            // initial deposit
        IN_TRANSIT,        // stage1 released (supplier first tranche + logistics fee + platform fee paid)
        ARRIVAL_CONFIRMED, // oracle confirms arrival; 24h dispute window starts
        FROZEN,            // buyer opened dispute within window
        CLOSED             // finalized or resolved
    }

    enum DisputeStatus {
        REFUND,  // admin resolution: refund buyer remaining escrowed principal (typically supplierSecondTranche)
        RESOLVE  // admin resolution: release remaining escrowed principal to supplier (typically supplierSecondTranche)
    }

    enum ClaimType {
        STAGE1_SUPPLIER,
        STAGE1_LOGISTICS_FEE,
        STAGE1_PLATFORM_FEE,
        STAGE2_SUPPLIER,
        LOCK_TIMEOUT_BUYER_REFUND,
        IN_TRANSIT_TIMEOUT_BUYER_REFUND,
        DISPUTE_REFUND_BUYER,
        DISPUTE_RESOLVE_SUPPLIER
    }

    enum SponsoredAction {
        CREATE_TRADE,
        OPEN_DISPUTE,
        CANCEL_LOCKED_TIMEOUT,
        REFUND_IN_TRANSIT_TIMEOUT,
        FINALIZE_AFTER_DISPUTE_WINDOW
    }

    struct UsdcAuthorization {
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Trade {
        uint256 tradeId;
        bytes32 ricardianHash;
        TradeStatus status;
        address buyerAddress;
        address supplierAddress;
        uint256 totalAmountLocked;

        uint256 logisticsAmount;     // non-refundable; paid to treasury at stage1 or lock timeout cancellation
        uint256 platformFeesAmount;  // non-refundable; includes settlement fee; paid to treasury at stage1 or lock timeout cancellation

        uint256 supplierFirstTranche;  // typically 40% (principal component released at stage1)
        uint256 supplierSecondTranche; // typically 60% (principal component released at stage2/finalization)

        uint256 createdAt;
        uint256 arrivalTimestamp; // set on confirmArrival
    }

    struct DisputeProposal {
        uint256 tradeId;
        DisputeStatus disputeStatus;
        uint256 approvalCount;
        bool executed;
        uint256 createdAt;
        address proposer;
    }

    // ---- Governance (timelocked) ----
    struct OracleUpdateProposal {
        address newOracle;
        uint256 approvalCount;
        bool executed;
        uint256 createdAt;
        uint256 eta; // execute-after timestamp (timelock)
        address proposer;
        bool emergencyFastTrack; // true if oracle was disabled when proposed
    }

    struct AdminAddProposal {
        address newAdmin;
        uint256 approvalCount;
        bool executed;
        uint256 createdAt;
        uint256 eta; // execute-after timestamp (timelock)
        address proposer;
    }

    struct TreasuryPayoutAddressUpdateProposal {
        address newPayoutReceiver;
        uint256 approvalCount;
        bool executed;
        uint256 createdAt;
        uint256 eta; // execute-after timestamp (timelock)
        address proposer;
    }

    struct UnpauseProposal {
        uint256 approvalCount;
        bool executed;
        uint256 createdAt;
        address proposer;
    }

    // -----------------------------
    // Storage
    // -----------------------------
    mapping(uint256 => Trade) public trades;
    uint256 public tradeCounter;

    // buyer-scoped nonce to prevent signature replay and global counter races
    mapping(address => uint256) public authorizationNonces;

    // dispute proposals
    mapping(uint256 => DisputeProposal) public disputeProposals;
    mapping(uint256 => mapping(address => bool)) public disputeHasApproved;
    mapping(uint256 => bool) public tradeHasActiveDisputeProposal;
    /// @notice Active dispute proposal id by trade id.
    mapping(uint256 => uint256) public tradeActiveDisputeProposalId;
    /// @notice Expiration timestamp for each dispute proposal id.
    mapping(uint256 => uint256) public disputeProposalExpiresAt;
    /// @notice True when a dispute proposal has been cancelled after expiry.
    mapping(uint256 => bool) public disputeProposalCancelled;
    uint256 public disputeCounter;

    /// @notice Timestamp when a trade moved to IN_TRANSIT.
    mapping(uint256 => uint256) public inTransitSince;

    // roles
    address public oracleAddress;
    /// @notice Immutable treasury identity used in trade signature preimage and fee accrual accounting.
    address public treasuryAddress;
    /// @notice Rotatable payout receiver for treasury sweeps; initialized to treasuryAddress.
    address public treasuryPayoutAddress;
    /// @notice Dedicated emergency switch for claim withdrawals.
    bool public claimsPaused;
    /// @notice Emergency switch to disable oracle-triggered transitions.
    bool public oracleActive;

    IERC20 public usdcToken;

    address[] public admins;
    mapping(address => bool) public isAdmin;
    mapping(address => bool) public isRelayer;
    uint256 public requiredApprovals;
    mapping(address => uint256) public claimableUsdc;
    uint256 public totalClaimableUsdc;

    // ---- Unpause multi-sig storage ----
    UnpauseProposal public unpauseProposal;
    mapping(address => bool) public unpauseHasApproved;
    bool public hasActiveUnpauseProposal;

    // ---- Governance (timelocked) storage ----
    uint256 public governanceTimelock; // delay between approvals and execution for sensitive ops

    mapping(uint256 => OracleUpdateProposal) public oracleUpdateProposals;
    mapping(uint256 => mapping(address => bool)) public oracleUpdateHasApproved;
    /// @notice Expiration timestamp for each oracle-update proposal id.
    mapping(uint256 => uint256) public oracleUpdateProposalExpiresAt;
    /// @notice True when an oracle-update proposal has been cancelled after expiry.
    mapping(uint256 => bool) public oracleUpdateProposalCancelled;
    uint256 public oracleUpdateCounter;

    mapping(uint256 => AdminAddProposal) public adminAddProposals;
    mapping(uint256 => mapping(address => bool)) public adminAddHasApproved;
    /// @notice Expiration timestamp for each admin-add proposal id.
    mapping(uint256 => uint256) public adminAddProposalExpiresAt;
    /// @notice True when an admin-add proposal has been cancelled after expiry.
    mapping(uint256 => bool) public adminAddProposalCancelled;
    uint256 public adminAddCounter;

    mapping(uint256 => TreasuryPayoutAddressUpdateProposal) public treasuryPayoutAddressUpdateProposals;
    mapping(uint256 => mapping(address => bool)) public treasuryPayoutAddressUpdateHasApproved;
    /// @notice Expiration timestamp for each treasury-payout-address proposal id.
    mapping(uint256 => uint256) public treasuryPayoutAddressUpdateProposalExpiresAt;
    /// @notice True when a treasury-payout-address proposal has been cancelled after expiry.
    mapping(uint256 => bool) public treasuryPayoutAddressUpdateProposalCancelled;
    uint256 public treasuryPayoutAddressUpdateCounter;
    /// @notice True when a treasury-payout-address update proposal is currently pending (not yet executed or cancelled).
    bool public hasPendingTreasuryPayoutAddressUpdateProposal;

    // -----------------------------
    // Events
    // -----------------------------
    event TradeLocked(
        uint256 indexed tradeId,
        address indexed buyer,
        address indexed supplier,
        uint256 totalAmount,
        uint256 logisticsAmount,
        uint256 platformFeesAmount,
        uint256 supplierFirstTranche,
        uint256 supplierSecondTranche,
        bytes32 ricardianHash
    );

    event AuthorizationConsumed(
        address indexed user,
        bytes32 indexed action,
        uint256 nonce,
        address indexed relayer,
        uint256 deadline
    );

    event RelayedActionExecuted(
        address indexed relayer,
        address indexed user,
        bytes32 indexed action,
        uint256 tradeId
    );
    event RelayerUpdated(address indexed relayer, bool allowed, address indexed updatedBy);

    event GaslessTradeFunded(
        uint256 indexed tradeId,
        address indexed buyer,
        bytes32 indexed usdcAuthorizationNonce,
        uint256 amount
    );

    event FundsReleasedStage1(
        uint256 indexed tradeId,
        address indexed supplier,
        uint256 supplierFirstTranche,
        address indexed treasury,
        uint256 logisticsAmount
    );

    // Added: explicit event for platform fee payout in Stage 1 (so indexers/auditors see it)
    event PlatformFeesPaidStage1(
        uint256 indexed tradeId,
        address indexed treasury,
        uint256 platformFeesAmount,
        uint256 platformFeeNetAmount,
        uint256 settlementSupportFeeAmount
    );

    event ArrivalConfirmed(uint256 indexed tradeId, uint256 arrivalTimestamp);

    // NOTE: Stage 2 now pays supplierSecondTranche ONLY (no treasury payment).
    // This event is kept as-is for backward compatibility, but is no longer emitted.
    event FundsReleasedStage2(
        uint256 indexed tradeId,
        address indexed supplier,
        uint256 supplierSecondTranche,
        address indexed treasury,
        uint256 platformFeesAmount
    );

    // Added: explicit final tranche event for Stage 2/finalization
    event FinalTrancheReleased(
        uint256 indexed tradeId,
        address indexed supplier,
        uint256 supplierSecondTranche
    );

    event DisputeOpenedByBuyer(uint256 indexed tradeId);

    event DisputeSolutionProposed(
        uint256 indexed proposalId,
        uint256 indexed tradeId,
        DisputeStatus disputeStatus,
        address indexed proposer
    );

    event DisputeApproved(
        uint256 indexed proposalId,
        address indexed approver,
        uint256 approvalCount,
        uint256 requiredApprovals
    );

    event DisputeFinalized(
        uint256 indexed proposalId,
        uint256 indexed tradeId,
        DisputeStatus disputeStatus
    );

    // ---- Unpause multi-sig events ----
    event UnpauseProposed(address indexed proposer);
    event UnpauseApproved(address indexed approver, uint256 approvalCount, uint256 requiredApprovals);
    event UnpauseProposalCancelled(address indexed cancelledBy);

    // ---- Governance (timelocked) events ----
    event OracleUpdateProposed(
        uint256 indexed proposalId,
        address indexed proposer,
        address indexed newOracle,
        uint256 eta,
        bool emergencyFastTrack
    );

    event OracleUpdateApproved(
        uint256 indexed proposalId,
        address indexed approver,
        uint256 approvalCount,
        uint256 requiredApprovals
    );

    event OracleUpdated(
        address indexed oldOracle,
        address indexed newOracle
    );

    event AdminAddProposed(
        uint256 indexed proposalId,
        address indexed proposer,
        address indexed newAdmin,
        uint256 eta
    );

    event AdminAddApproved(
        uint256 indexed proposalId,
        address indexed approver,
        uint256 approvalCount,
        uint256 requiredApprovals
    );

    event AdminAdded(address indexed newAdmin);
    event TreasuryPayoutAddressUpdateProposed(
        uint256 indexed proposalId,
        address indexed proposer,
        address indexed newPayoutReceiver,
        uint256 eta
    );
    event TreasuryPayoutAddressUpdateApproved(
        uint256 indexed proposalId,
        address indexed approver,
        uint256 approvalCount,
        uint256 requiredApprovals
    );
    event TreasuryPayoutAddressUpdated(
        address indexed oldPayoutReceiver,
        address indexed newPayoutReceiver
    );
    event TreasuryPayoutAddressUpdateProposalExpiredCancelled(uint256 indexed proposalId, address indexed cancelledBy);
    event TreasuryClaimed(
        address indexed treasuryIdentity,
        address indexed payoutReceiver,
        uint256 amount,
        address triggeredBy
    );

    event OracleDisabledEmergency(address indexed by, address indexed previousOracle);
    event TradeCancelledAfterLockTimeout(
        uint256 indexed tradeId,
        address indexed buyer,
        uint256 refundedAmount
    );
    event InTransitTimeoutRefunded(
        uint256 indexed tradeId,
        address indexed buyer,
        uint256 refundedAmount
    );
    event DisputeProposalExpiredCancelled(
        uint256 indexed proposalId,
        uint256 indexed tradeId,
        address indexed cancelledBy
    );
    event DisputePayout(
        uint256 indexed tradeId,
        uint256 indexed proposalId,
        address indexed recipient,
        uint256 amount,
        DisputeStatus payoutType
    );
    event ClaimableAccrued(
        uint256 indexed tradeId,
        address indexed recipient,
        uint256 amount,
        ClaimType claimType
    );
    event SupplierPayoutTransferred(
        uint256 indexed tradeId,
        address indexed supplier,
        uint256 amount,
        ClaimType claimType,
        address indexed triggeredBy
    );
    event BuyerRefundTransferred(
        uint256 indexed tradeId,
        address indexed buyer,
        uint256 amount,
        ClaimType claimType,
        address indexed triggeredBy
    );
    event ClaimsPaused(address indexed triggeredBy);
    event ClaimsUnpaused(address indexed triggeredBy);
    event OracleUpdateProposalExpiredCancelled(uint256 indexed proposalId, address indexed cancelledBy);
    event AdminAddProposalExpiredCancelled(uint256 indexed proposalId, address indexed cancelledBy);

    // -----------------------------
    // Constructor / Modifiers
    // -----------------------------
    constructor(
        address _usdcToken,
        address _oracleAddress,
        address _treasuryAddress,
        address _relayerAddress,
        address[] memory _admins,
        uint256 _requiredApprovals
    ) {
        require(_usdcToken != address(0), "invalid token");
        require(_oracleAddress != address(0), "invalid oracle");
        require(_treasuryAddress != address(0), "invalid treasury");
        require(_relayerAddress != address(0), "invalid relayer");
        require(_requiredApprovals >= 2, "required approvals must be >= 2");
        require(_admins.length >= _requiredApprovals, "not enough admins");

        usdcToken = IERC20(_usdcToken);
        oracleAddress = _oracleAddress;
        treasuryAddress = _treasuryAddress;
        treasuryPayoutAddress = _treasuryAddress;
        isRelayer[_relayerAddress] = true;
        requiredApprovals = _requiredApprovals;

        for (uint256 i = 0; i < _admins.length; i++) {
            address admin = _admins[i];
            require(admin != address(0), "bad admin");
            require(!isAdmin[admin], "duplicate admin");
            admins.push(admin);
            isAdmin[admin] = true;
        }

        // Timelock for sensitive governance operations (oracle/admin updates).
        // Can be changed in future versions if needed; keeping minimal for now.
        governanceTimelock = 24 hours;
        oracleActive = true;
        DOMAIN_SEPARATOR = _buildDomainSeparator();
        emit RelayerUpdated(_relayerAddress, true, msg.sender);
    }

    modifier onlyAdmin() {
        require(isAdmin[msg.sender], "only admin");
        _;
    }

    modifier onlyTreasuryOrAdmin() {
        require(msg.sender == treasuryAddress || isAdmin[msg.sender], "only treasury or admin");
        _;
    }

    modifier onlyRelayerOrAdmin() {
        require(isAdmin[msg.sender] || isRelayer[msg.sender], "only relayer or admin");
        _;
    }

    modifier onlyOracle() {
        require(msg.sender == oracleAddress, "only oracle");
        _;
    }

    modifier whenClaimsNotPaused() {
        require(!claimsPaused, "claims paused");
        _;
    }
    modifier onlyOracleActive() {
        require(oracleActive, "oracle disabled");
        _;
    }

    /// @dev Keep backwards-compatible revert messages for existing consumers/tests.
    function _requireNotPaused() internal view override {
        require(!paused(), "paused");
    }

    /// @dev Keep backwards-compatible revert messages for existing consumers/tests.
    function _requirePaused() internal view override {
        require(paused(), "not paused");
    }

    /**
     * @notice Pauses normal protocol operations for emergency containment.
     */
    function pause() external onlyAdmin {
        require(!paused(), "already paused");
        _pause();
    }

    /**
     * @notice Pauses claim withdrawals while keeping global pause policy independent.
     */
    function pauseClaims() external onlyAdmin {
        require(!claimsPaused, "claims already paused");
        claimsPaused = true;
        emit ClaimsPaused(msg.sender);
    }

    /**
     * @notice Unpauses claim withdrawals.
     */
    function unpauseClaims() external onlyAdmin {
        require(claimsPaused, "claims not paused");
        claimsPaused = false;
        emit ClaimsUnpaused(msg.sender);
    }

    function setRelayer(address relayer, bool allowed) external onlyAdmin {
        require(relayer != address(0), "invalid relayer");
        isRelayer[relayer] = allowed;
        emit RelayerUpdated(relayer, allowed, msg.sender);
    }

    /**
     * @notice Propose unpausing the protocol (requires multi-sig approval).
     */
    function proposeUnpause() external onlyAdmin returns (bool) {
        require(paused(), "not paused");
        require(oracleActive, "oracle disabled");

        // Cancel any existing unpause proposal
        if (hasActiveUnpauseProposal) {
            _cancelUnpauseProposal();
        }

        unpauseProposal = UnpauseProposal({
            approvalCount: 1,
            executed: false,
            createdAt: block.timestamp,
            proposer: msg.sender
        });

        unpauseHasApproved[msg.sender] = true;
        hasActiveUnpauseProposal = true;

        emit UnpauseProposed(msg.sender);
        emit UnpauseApproved(msg.sender, 1, governanceApprovals());

        return true;
    }

    /**
     * @notice Approve the unpause proposal.
     */
    function approveUnpause() external onlyAdmin {
        require(paused(), "not paused");
        require(hasActiveUnpauseProposal, "no active proposal");
        require(!unpauseProposal.executed, "already executed");
        require(!unpauseHasApproved[msg.sender], "already approved");

        unpauseHasApproved[msg.sender] = true;
        unpauseProposal.approvalCount++;

        emit UnpauseApproved(msg.sender, unpauseProposal.approvalCount, governanceApprovals());

        if (unpauseProposal.approvalCount >= governanceApprovals()) {
            _executeUnpause();
        }
    }

    /**
     * @notice Cancel the current unpause proposal.
     */
    function cancelUnpauseProposal() external onlyAdmin {
        require(hasActiveUnpauseProposal, "no active proposal");
        require(!unpauseProposal.executed, "already executed");

        _cancelUnpauseProposal();
    }

    function _cancelUnpauseProposal() internal {
        // Clear approvals
        address[] memory adminList = admins;
        for (uint256 i = 0; i < adminList.length; i++) {
            unpauseHasApproved[adminList[i]] = false;
        }

        hasActiveUnpauseProposal = false;
        delete unpauseProposal;

        emit UnpauseProposalCancelled(msg.sender);
    }

    function _executeUnpause() internal {
        require(!unpauseProposal.executed, "already executed");
        require(unpauseProposal.approvalCount >= governanceApprovals(), "not enough approvals");


        unpauseProposal.executed = true;
        hasActiveUnpauseProposal = false;
        _unpause();

        // Clear approvals
        address[] memory adminList = admins;
        for (uint256 i = 0; i < adminList.length; i++) {
            unpauseHasApproved[adminList[i]] = false;
        }
    }

    /**
     * @notice Emergency kill switch to disable oracle-triggered transitions and pause protocol.
     */
    function disableOracleEmergency() external onlyAdmin {
        require(oracleActive, "oracle disabled");
        oracleActive = false;
        if (!paused()) {
            _pause();
        }
        emit OracleDisabledEmergency(msg.sender, oracleAddress);
    }

    // -----------------------------
    // Authorization Verification
    // -----------------------------
    function getAuthorizationNonce(address user) external view returns (uint256) {
        return authorizationNonces[user];
    }

    function _actionName(SponsoredAction action) internal pure returns (bytes32) {
        if (action == SponsoredAction.CREATE_TRADE) return ACTION_CREATE_TRADE;
        if (action == SponsoredAction.OPEN_DISPUTE) return ACTION_OPEN_DISPUTE;
        if (action == SponsoredAction.CANCEL_LOCKED_TIMEOUT) return ACTION_CANCEL_LOCKED_TIMEOUT;
        if (action == SponsoredAction.REFUND_IN_TRANSIT_TIMEOUT) return ACTION_REFUND_IN_TRANSIT_TIMEOUT;
        if (action == SponsoredAction.FINALIZE_AFTER_DISPUTE_WINDOW) return ACTION_FINALIZE_AFTER_DISPUTE_WINDOW;
        revert("unsupported action");
    }

    function _buildDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("AgroasysEscrow")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function _domainSeparatorV4() internal view returns (bytes32) {
        return DOMAIN_SEPARATOR;
    }

    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparatorV4(), structHash));
    }

    function _requireAuthorization(address user, uint256 nonce, uint256 deadline) internal view {
        require(user != address(0), "invalid user");
        require(block.timestamp <= deadline, "authorization expired");
        require(nonce == authorizationNonces[user], "bad authorization nonce");
    }

    function _consumeAuthorization(address user, SponsoredAction action, uint256 nonce, uint256 deadline) internal {
        authorizationNonces[user] = nonce + 1;
        emit AuthorizationConsumed(user, _actionName(action), nonce, msg.sender, deadline);
    }

    function _recoverCreateTradeAuthorization(
        address buyer,
        address supplier,
        uint256 totalAmount,
        uint256 logisticsAmount,
        uint256 platformFeesAmount,
        uint256 supplierFirstTranche,
        uint256 supplierSecondTranche,
        bytes32 ricardianHash,
        uint256 buyerNonce,
        uint256 deadline,
        bytes memory signature
    ) internal view returns (address) {
        bytes32 structHash = keccak256(
            abi.encode(
                CREATE_TRADE_AUTHORIZATION_TYPEHASH,
                buyer,
                supplier,
                totalAmount,
                logisticsAmount,
                platformFeesAmount,
                supplierFirstTranche,
                supplierSecondTranche,
                ricardianHash,
                buyerNonce,
                deadline
            )
        );

        return ECDSA.recover(_hashTypedDataV4(structHash), signature);
    }

    function _verifyCreateTradeAuthorization(
        address buyer,
        address supplier,
        uint256 totalAmount,
        uint256 logisticsAmount,
        uint256 platformFeesAmount,
        uint256 supplierFirstTranche,
        uint256 supplierSecondTranche,
        bytes32 ricardianHash,
        uint256 nonce,
        uint256 deadline,
        bytes memory signature
    ) internal {
        _requireAuthorization(buyer, nonce, deadline);

        address signer = _recoverCreateTradeAuthorization(
            buyer,
            supplier,
            totalAmount,
            logisticsAmount,
            platformFeesAmount,
            supplierFirstTranche,
            supplierSecondTranche,
            ricardianHash,
            nonce,
            deadline,
            signature
        );
        require(signer == buyer, "bad authorization");
        _consumeAuthorization(buyer, SponsoredAction.CREATE_TRADE, nonce, deadline);
    }

    function _verifyUserActionAuthorization(
        address user,
        SponsoredAction action,
        uint256 tradeId,
        uint256 nonce,
        uint256 deadline,
        bytes memory signature
    ) internal {
        _requireAuthorization(user, nonce, deadline);

        bytes32 structHash = keccak256(
            abi.encode(
                USER_ACTION_AUTHORIZATION_TYPEHASH,
                user,
                uint8(action),
                tradeId,
                nonce,
                deadline
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        require(signer == user, "bad authorization");
        _consumeAuthorization(user, action, nonce, deadline);
    }

    function _validateTradeAmounts(
        address supplier,
        uint256 totalAmount,
        uint256 logisticsAmount,
        uint256 platformFeesAmount,
        uint256 supplierFirstTranche,
        uint256 supplierSecondTranche,
        bytes32 ricardianHash
    ) internal view {
        require(ricardianHash != bytes32(0), "ricardian hash required");
        require(supplier != address(0), "supplier required");
        require(supplier != address(this), "supplier cannot be escrow");

        uint256 totalExpected = logisticsAmount
            + platformFeesAmount
            + supplierFirstTranche
            + supplierSecondTranche;

        require(totalAmount == totalExpected, "breakdown mismatch");
        require(supplierFirstTranche > 0 && supplierSecondTranche > 0, "tranches must be > 0");
    }

    function _storeTrade(
        address buyer,
        address supplier,
        uint256 totalAmount,
        uint256 logisticsAmount,
        uint256 platformFeesAmount,
        uint256 supplierFirstTranche,
        uint256 supplierSecondTranche,
        bytes32 ricardianHash
    ) internal returns (uint256) {
        uint256 newTradeId = tradeCounter;
        tradeCounter++;

        trades[newTradeId] = Trade({
            tradeId: newTradeId,
            ricardianHash: ricardianHash,
            status: TradeStatus.LOCKED,
            buyerAddress: buyer,
            supplierAddress: supplier,
            totalAmountLocked: totalAmount,
            logisticsAmount: logisticsAmount,
            platformFeesAmount: platformFeesAmount,
            supplierFirstTranche: supplierFirstTranche,
            supplierSecondTranche: supplierSecondTranche,
            createdAt: block.timestamp,
            arrivalTimestamp: 0
        });

        emit TradeLocked(
            newTradeId,
            buyer,
            supplier,
            totalAmount,
            logisticsAmount,
            platformFeesAmount,
            supplierFirstTranche,
            supplierSecondTranche,
            ricardianHash
        );

        return newTradeId;
    }

    // -----------------------------
    // Trade Creation
    // -----------------------------
    function createTradeWithAuthorization(
        address _buyer,
        address _supplier,
        uint256 _totalAmount,
        uint256 _logisticsAmount,
        uint256 _platformFeesAmount,
        uint256 _supplierFirstTranche,
        uint256 _supplierSecondTranche,
        bytes32 _ricardianHash,
        uint256 _authorizationNonce,
        uint256 _authorizationDeadline,
        bytes memory _authorizationSignature,
        UsdcAuthorization calldata _usdcAuthorization
    ) external onlyRelayerOrAdmin whenNotPaused nonReentrant returns (uint256) {
        _validateTradeAmounts(
            _supplier,
            _totalAmount,
            _logisticsAmount,
            _platformFeesAmount,
            _supplierFirstTranche,
            _supplierSecondTranche,
            _ricardianHash
        );

        _verifyCreateTradeAuthorization(
            _buyer,
            _supplier,
            _totalAmount,
            _logisticsAmount,
            _platformFeesAmount,
            _supplierFirstTranche,
            _supplierSecondTranche,
            _ricardianHash,
            _authorizationNonce,
            _authorizationDeadline,
            _authorizationSignature
        );

        uint256 newTradeId = _storeTrade(
            _buyer,
            _supplier,
            _totalAmount,
            _logisticsAmount,
            _platformFeesAmount,
            _supplierFirstTranche,
            _supplierSecondTranche,
            _ricardianHash
        );

        IUSDCReceiveWithAuthorization(address(usdcToken)).receiveWithAuthorization(
            _buyer,
            address(this),
            _totalAmount,
            _usdcAuthorization.validAfter,
            _usdcAuthorization.validBefore,
            _usdcAuthorization.nonce,
            _usdcAuthorization.v,
            _usdcAuthorization.r,
            _usdcAuthorization.s
        );

        emit GaslessTradeFunded(newTradeId, _buyer, _usdcAuthorization.nonce, _totalAmount);
        emit RelayedActionExecuted(msg.sender, _buyer, ACTION_CREATE_TRADE, newTradeId);

        return newTradeId;
    }

    function _accrueClaimable(uint256 _tradeId, address _recipient, uint256 _amount, ClaimType _claimType) internal {
        if (_amount == 0) {
            return;
        }
        claimableUsdc[_recipient] += _amount;
        totalClaimableUsdc += _amount;
        emit ClaimableAccrued(_tradeId, _recipient, _amount, _claimType);
    }

    function _nonRefundableFeeAmount(Trade storage trade) internal view returns (uint256) {
        return trade.logisticsAmount + trade.platformFeesAmount;
    }

    function _buyerRefundablePrincipalAmount(Trade storage trade) internal view returns (uint256) {
        if (trade.status == TradeStatus.LOCKED) {
            return trade.supplierFirstTranche + trade.supplierSecondTranche;
        }

        if (
            trade.status == TradeStatus.IN_TRANSIT || trade.status == TradeStatus.ARRIVAL_CONFIRMED
                || trade.status == TradeStatus.FROZEN
        ) {
            return trade.supplierSecondTranche;
        }

        return 0;
    }

    function _splitPlatformFeeComponents(uint256 _platformFeesAmount)
        internal
        pure
        returns (uint256 platformFeeNetAmount, uint256 settlementSupportFeeAmount)
    {
        settlementSupportFeeAmount = _platformFeesAmount < 4_000_000 ? _platformFeesAmount : 4_000_000;
        platformFeeNetAmount = _platformFeesAmount - settlementSupportFeeAmount;
    }

    function _transferSupplierPayout(
        uint256 _tradeId,
        address _supplier,
        uint256 _amount,
        ClaimType _claimType
    ) internal {
        if (_amount == 0) {
            return;
        }

        usdcToken.safeTransfer(_supplier, _amount);
        emit SupplierPayoutTransferred(_tradeId, _supplier, _amount, _claimType, msg.sender);
    }

    function _transferBuyerRefund(
        uint256 _tradeId,
        address _buyer,
        uint256 _amount,
        ClaimType _claimType
    ) internal {
        if (_amount == 0) {
            return;
        }

        usdcToken.safeTransfer(_buyer, _amount);
        emit BuyerRefundTransferred(_tradeId, _buyer, _amount, _claimType, msg.sender);
    }

    function nonRefundableFeeAmount(uint256 _tradeId) public view returns (uint256) {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];
        return _nonRefundableFeeAmount(trade);
    }

    function buyerRefundableAmount(uint256 _tradeId) public view returns (uint256) {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];
        return _buyerRefundablePrincipalAmount(trade);
    }

    /**
     * @notice Treasury sweep that is destination-locked to treasuryPayoutAddress.
     * @dev Uses treasuryAddress as immutable accounting identity; only treasury/admin callers can trigger it.
     */
    function claimTreasury() external onlyTreasuryOrAdmin whenClaimsNotPaused nonReentrant {
        uint256 amount = claimableUsdc[treasuryAddress];
        require(amount > 0, "nothing treasury claimable");

        address payoutReceiver = treasuryPayoutAddress;
        require(payoutReceiver != address(0), "invalid treasury payout receiver");

        claimableUsdc[treasuryAddress] = 0;
        totalClaimableUsdc -= amount;
        usdcToken.safeTransfer(payoutReceiver, amount);

        emit TreasuryClaimed(treasuryAddress, payoutReceiver, amount, msg.sender);
    }

    // -----------------------------
    // Milestones
    // -----------------------------

    /**
     * Stage 1 release:
     * - Only oracle
     * - LOCKED -> IN_TRANSIT
     * - Accrue supplier first tranche (principal)
     * - Accrue logistics fee to treasury
     * - Accrue platform fee to treasury
     */
    function releaseFundsStage1(uint256 _tradeId) external onlyOracle onlyOracleActive whenNotPaused nonReentrant {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];

        require(trade.status == TradeStatus.LOCKED, "status must be LOCKED");

        trade.status = TradeStatus.IN_TRANSIT;
        inTransitSince[_tradeId] = block.timestamp;

        _transferSupplierPayout(_tradeId, trade.supplierAddress, trade.supplierFirstTranche, ClaimType.STAGE1_SUPPLIER);
        _accrueClaimable(_tradeId, treasuryAddress, trade.logisticsAmount, ClaimType.STAGE1_LOGISTICS_FEE);
        _accrueClaimable(_tradeId, treasuryAddress, trade.platformFeesAmount, ClaimType.STAGE1_PLATFORM_FEE);

        emit FundsReleasedStage1(
            _tradeId,
            trade.supplierAddress,
            trade.supplierFirstTranche,
            treasuryAddress,
            trade.logisticsAmount
        );

        (uint256 platformFeeNetAmount, uint256 settlementSupportFeeAmount) =
            _splitPlatformFeeComponents(trade.platformFeesAmount);
        emit PlatformFeesPaidStage1(
            _tradeId,
            treasuryAddress,
            trade.platformFeesAmount,
            platformFeeNetAmount,
            settlementSupportFeeAmount
        );
    }

    /**
     * Arrival confirmation starts dispute window.
     * Only oracle can confirm arrival.
     */
    function confirmArrival(uint256 _tradeId) external onlyOracle onlyOracleActive whenNotPaused nonReentrant {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];

        require(trade.status == TradeStatus.IN_TRANSIT, "status must be IN_TRANSIT");

        trade.status = TradeStatus.ARRIVAL_CONFIRMED;
        trade.arrivalTimestamp = block.timestamp;
        inTransitSince[_tradeId] = 0;

        emit ArrivalConfirmed(_tradeId, trade.arrivalTimestamp);
    }

    /**
     * Buyer can open a dispute through a relayed authorization within 24h after arrival confirmation.
     * This freezes remaining funds until admin resolution.
     */
    function openDisputeWithAuthorization(
        uint256 _tradeId,
        uint256 _authorizationNonce,
        uint256 _authorizationDeadline,
        bytes memory _authorizationSignature
    ) external onlyRelayerOrAdmin whenNotPaused nonReentrant {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];

        _verifyUserActionAuthorization(
            trade.buyerAddress,
            SponsoredAction.OPEN_DISPUTE,
            _tradeId,
            _authorizationNonce,
            _authorizationDeadline,
            _authorizationSignature
        );

        require(trade.status == TradeStatus.ARRIVAL_CONFIRMED, "must be ARRIVAL_CONFIRMED");
        require(trade.arrivalTimestamp > 0, "arrival not set");
        require(block.timestamp <= trade.arrivalTimestamp + DISPUTE_WINDOW, "window closed");

        trade.status = TradeStatus.FROZEN;

        emit DisputeOpenedByBuyer(_tradeId);
        emit RelayedActionExecuted(msg.sender, trade.buyerAddress, ACTION_OPEN_DISPUTE, _tradeId);
    }

    /**
     * Final settlement after dispute window if no dispute was opened.
     * Direct execution is admin-only; suppliers use finalizeAfterDisputeWindowWithAuthorization.
     *
     * Business rule: Stage 2 pays ONLY remaining supplier principal (supplierSecondTranche).
     * Treasury fees were already collected at Stage 1.
     */
    function finalizeAfterDisputeWindow(uint256 _tradeId) external onlyAdmin whenNotPaused nonReentrant {
        _finalizeAfterDisputeWindow(_tradeId);
    }

    function finalizeAfterDisputeWindowWithAuthorization(
        uint256 _tradeId,
        uint256 _authorizationNonce,
        uint256 _authorizationDeadline,
        bytes memory _authorizationSignature
    ) external onlyRelayerOrAdmin whenNotPaused nonReentrant {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];

        _verifyUserActionAuthorization(
            trade.supplierAddress,
            SponsoredAction.FINALIZE_AFTER_DISPUTE_WINDOW,
            _tradeId,
            _authorizationNonce,
            _authorizationDeadline,
            _authorizationSignature
        );

        _finalizeAfterDisputeWindow(_tradeId);
        emit RelayedActionExecuted(msg.sender, trade.supplierAddress, ACTION_FINALIZE_AFTER_DISPUTE_WINDOW, _tradeId);
    }

    function _finalizeAfterDisputeWindow(uint256 _tradeId) internal {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];

        require(trade.status == TradeStatus.ARRIVAL_CONFIRMED, "must be ARRIVAL_CONFIRMED");
        require(trade.arrivalTimestamp > 0, "arrival not set");
        require(block.timestamp > trade.arrivalTimestamp + DISPUTE_WINDOW, "window not elapsed");

        trade.status = TradeStatus.CLOSED;
        inTransitSince[_tradeId] = 0;

        _transferSupplierPayout(_tradeId, trade.supplierAddress, trade.supplierSecondTranche, ClaimType.STAGE2_SUPPLIER);

        emit FinalTrancheReleased(_tradeId, trade.supplierAddress, trade.supplierSecondTranche);
    }

    function cancelLockedTradeAfterTimeoutWithAuthorization(
        uint256 _tradeId,
        uint256 _authorizationNonce,
        uint256 _authorizationDeadline,
        bytes memory _authorizationSignature
    ) external onlyRelayerOrAdmin whenNotPaused nonReentrant {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];

        _verifyUserActionAuthorization(
            trade.buyerAddress,
            SponsoredAction.CANCEL_LOCKED_TIMEOUT,
            _tradeId,
            _authorizationNonce,
            _authorizationDeadline,
            _authorizationSignature
        );

        require(trade.status == TradeStatus.LOCKED, "status must be LOCKED");
        require(block.timestamp > trade.createdAt + LOCK_TIMEOUT, "lock timeout not elapsed");

        uint256 buyerRefundAmount = _buyerRefundablePrincipalAmount(trade);
        trade.status = TradeStatus.CLOSED;

        _accrueClaimable(_tradeId, treasuryAddress, trade.logisticsAmount, ClaimType.STAGE1_LOGISTICS_FEE);
        _accrueClaimable(_tradeId, treasuryAddress, trade.platformFeesAmount, ClaimType.STAGE1_PLATFORM_FEE);
        _transferBuyerRefund(_tradeId, trade.buyerAddress, buyerRefundAmount, ClaimType.LOCK_TIMEOUT_BUYER_REFUND);

        emit TradeCancelledAfterLockTimeout(_tradeId, trade.buyerAddress, buyerRefundAmount);
        emit RelayedActionExecuted(msg.sender, trade.buyerAddress, ACTION_CANCEL_LOCKED_TIMEOUT, _tradeId);
    }

    function refundInTransitAfterTimeoutWithAuthorization(
        uint256 _tradeId,
        uint256 _authorizationNonce,
        uint256 _authorizationDeadline,
        bytes memory _authorizationSignature
    ) external onlyRelayerOrAdmin whenNotPaused nonReentrant {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];

        _verifyUserActionAuthorization(
            trade.buyerAddress,
            SponsoredAction.REFUND_IN_TRANSIT_TIMEOUT,
            _tradeId,
            _authorizationNonce,
            _authorizationDeadline,
            _authorizationSignature
        );

        require(trade.status == TradeStatus.IN_TRANSIT, "status must be IN_TRANSIT");

        uint256 transitStart = inTransitSince[_tradeId];
        require(transitStart > 0, "in-transit timestamp not set");
        require(block.timestamp > transitStart + IN_TRANSIT_TIMEOUT, "in-transit timeout not elapsed");

        trade.status = TradeStatus.CLOSED;
        inTransitSince[_tradeId] = 0;

        _transferBuyerRefund(
            _tradeId,
            trade.buyerAddress,
            trade.supplierSecondTranche,
            ClaimType.IN_TRANSIT_TIMEOUT_BUYER_REFUND
        );

        emit InTransitTimeoutRefunded(_tradeId, trade.buyerAddress, trade.supplierSecondTranche);
        emit RelayedActionExecuted(msg.sender, trade.buyerAddress, ACTION_REFUND_IN_TRANSIT_TIMEOUT, _tradeId);
    }

    // -----------------------------
    // Dispute Resolution (Admins, 4-eyes)
    // -----------------------------
    function proposeDisputeSolution(uint256 _tradeId, DisputeStatus _disputeStatus)
        external
        onlyAdmin
        whenNotPaused
        returns (uint256)
    {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];

        require(trade.status == TradeStatus.FROZEN, "trade not frozen");

        if (tradeHasActiveDisputeProposal[_tradeId]) {
            uint256 activeProposalId = tradeActiveDisputeProposalId[_tradeId];
            bool activeExpired = block.timestamp > disputeProposalExpiresAt[activeProposalId];

            if (activeExpired && !disputeProposalCancelled[activeProposalId]) {
                disputeProposalCancelled[activeProposalId] = true;
                tradeHasActiveDisputeProposal[_tradeId] = false;
                tradeActiveDisputeProposalId[_tradeId] = 0;
                emit DisputeProposalExpiredCancelled(activeProposalId, _tradeId, msg.sender);
            } else {
                revert("active proposal exists");
            }
        }

        uint256 proposalId = disputeCounter;
        disputeCounter++;

        disputeProposals[proposalId] = DisputeProposal({
            tradeId: _tradeId,
            disputeStatus: _disputeStatus,
            approvalCount: 1,
            executed: false,
            createdAt: block.timestamp,
            proposer: msg.sender
        });

        disputeHasApproved[proposalId][msg.sender] = true;
        tradeHasActiveDisputeProposal[_tradeId] = true;
        tradeActiveDisputeProposalId[_tradeId] = proposalId;
        disputeProposalExpiresAt[proposalId] = block.timestamp + DISPUTE_PROPOSAL_TTL;

        emit DisputeSolutionProposed(proposalId, _tradeId, _disputeStatus, msg.sender);

        return proposalId;
    }

    function approveDisputeSolution(uint256 _proposalId) external onlyAdmin whenNotPaused nonReentrant {
        require(_proposalId < disputeCounter, "proposal not found");

        DisputeProposal storage proposal = disputeProposals[_proposalId];
        require(proposal.createdAt > 0, "proposal not initialized");
        require(!proposal.executed, "already executed");
        require(!disputeProposalCancelled[_proposalId], "proposal cancelled");
        require(block.timestamp <= disputeProposalExpiresAt[_proposalId], "proposal expired");

        Trade storage trade = trades[proposal.tradeId];
        require(trade.status == TradeStatus.FROZEN, "trade not frozen");

        require(!disputeHasApproved[_proposalId][msg.sender], "already approved");

        disputeHasApproved[_proposalId][msg.sender] = true;
        proposal.approvalCount++;

        emit DisputeApproved(_proposalId, msg.sender, proposal.approvalCount, requiredApprovals);

        if (proposal.approvalCount >= requiredApprovals) {
            _executeDispute(_proposalId);
        }
    }

    function _executeDispute(uint256 _proposalId) internal {
        DisputeProposal storage proposal = disputeProposals[_proposalId];

        require(!proposal.executed, "already executed");
        require(!disputeProposalCancelled[_proposalId], "proposal cancelled");
        require(block.timestamp <= disputeProposalExpiresAt[_proposalId], "proposal expired");
        require(proposal.approvalCount >= requiredApprovals, "not enough approvals");

        Trade storage trade = trades[proposal.tradeId];
        require(trade.status == TradeStatus.FROZEN, "trade must be FROZEN");

        proposal.executed = true;
        trade.status = TradeStatus.CLOSED;
        tradeHasActiveDisputeProposal[proposal.tradeId] = false;
        tradeActiveDisputeProposalId[proposal.tradeId] = 0;
        inTransitSince[proposal.tradeId] = 0;

        address recipient;
        uint256 payoutAmount = trade.supplierSecondTranche;

        // NOTE: Platform/logistics fees were already paid at Stage 1 and are not refunded via escrow.
        if (proposal.disputeStatus == DisputeStatus.REFUND) {
            // Refund buyer remaining escrowed principal (supplierSecondTranche)
            recipient = trade.buyerAddress;
            _transferBuyerRefund(proposal.tradeId, recipient, payoutAmount, ClaimType.DISPUTE_REFUND_BUYER);
        } else if (proposal.disputeStatus == DisputeStatus.RESOLVE) {
            // Release remaining escrowed principal to supplier (supplierSecondTranche)
            recipient = trade.supplierAddress;
            _transferSupplierPayout(proposal.tradeId, recipient, payoutAmount, ClaimType.DISPUTE_RESOLVE_SUPPLIER);
        } else {
            revert("invalid dispute status");
        }

        emit DisputePayout(proposal.tradeId, _proposalId, recipient, payoutAmount, proposal.disputeStatus);
        emit DisputeFinalized(_proposalId, proposal.tradeId, proposal.disputeStatus);
    }

    /**
     * @notice Cancels an expired dispute proposal to unblock replacement proposals.
     */
    function cancelExpiredDisputeProposal(uint256 _proposalId) external onlyAdmin whenNotPaused {
        require(_proposalId < disputeCounter, "proposal not found");

        DisputeProposal storage proposal = disputeProposals[_proposalId];
        require(proposal.createdAt > 0, "proposal not initialized");
        require(!proposal.executed, "already executed");
        require(!disputeProposalCancelled[_proposalId], "already cancelled");
        require(block.timestamp > disputeProposalExpiresAt[_proposalId], "proposal not expired");

        disputeProposalCancelled[_proposalId] = true;
        if (tradeHasActiveDisputeProposal[proposal.tradeId] && tradeActiveDisputeProposalId[proposal.tradeId] == _proposalId)
        {
            tradeHasActiveDisputeProposal[proposal.tradeId] = false;
            tradeActiveDisputeProposalId[proposal.tradeId] = 0;
        }

        emit DisputeProposalExpiredCancelled(_proposalId, proposal.tradeId, msg.sender);
    }

    // -----------------------------
    // Governance (timelocked) - Admin/Oracle rotation
    // -----------------------------

    function governanceApprovals() public view returns (uint256) {
        return requiredApprovals;
    }

    /**
     * @notice Propose oracle update with fast-track option when oracle is disabled.
     * @param _newOracle The new oracle address.
     * @return proposalId The ID of the created proposal.
     */
    function proposeOracleUpdate(address _newOracle) external onlyAdmin returns (uint256) {
        require(_newOracle != address(0), "invalid oracle");
        require(_newOracle != oracleAddress, "same oracle");
        require(admins.length >= governanceApprovals(), "insufficient admins");

        uint256 proposalId = oracleUpdateCounter;
        oracleUpdateCounter++;

        // Fast-track if oracle is disabled (no timelock)
        bool emergencyFastTrack = !oracleActive;
        uint256 eta = emergencyFastTrack ? block.timestamp : block.timestamp + governanceTimelock;

        oracleUpdateProposals[proposalId] = OracleUpdateProposal({
            newOracle: _newOracle,
            approvalCount: 1,
            executed: false,
            createdAt: block.timestamp,
            eta: eta,
            proposer: msg.sender,
            emergencyFastTrack: emergencyFastTrack
        });

        oracleUpdateHasApproved[proposalId][msg.sender] = true;
        oracleUpdateProposalExpiresAt[proposalId] = block.timestamp + GOVERNANCE_PROPOSAL_TTL;

        emit OracleUpdateProposed(proposalId, msg.sender, _newOracle, eta, emergencyFastTrack);
        emit OracleUpdateApproved(proposalId, msg.sender, 1, governanceApprovals());

        return proposalId;
    }

    function approveOracleUpdate(uint256 _proposalId) external onlyAdmin {
        require(_proposalId < oracleUpdateCounter, "proposal not found");

        OracleUpdateProposal storage proposal = oracleUpdateProposals[_proposalId];
        require(proposal.createdAt > 0, "proposal not initialized");
        require(!proposal.executed, "already executed");
        require(!oracleUpdateProposalCancelled[_proposalId], "proposal cancelled");
        require(block.timestamp <= oracleUpdateProposalExpiresAt[_proposalId], "proposal expired");
        require(!oracleUpdateHasApproved[_proposalId][msg.sender], "already approved");

        oracleUpdateHasApproved[_proposalId][msg.sender] = true;
        proposal.approvalCount++;

        emit OracleUpdateApproved(_proposalId, msg.sender, proposal.approvalCount, governanceApprovals());
    }

    function executeOracleUpdate(uint256 _proposalId) external onlyAdmin {
        require(_proposalId < oracleUpdateCounter, "proposal not found");

        OracleUpdateProposal storage proposal = oracleUpdateProposals[_proposalId];
        require(proposal.createdAt > 0, "proposal not initialized");
        require(!proposal.executed, "already executed");
        require(!oracleUpdateProposalCancelled[_proposalId], "proposal cancelled");
        require(block.timestamp <= oracleUpdateProposalExpiresAt[_proposalId], "proposal expired");
        require(proposal.approvalCount >= governanceApprovals(), "not enough approvals");
        require(block.timestamp >= proposal.eta, "timelock not elapsed");

        proposal.executed = true;

        address oldOracle = oracleAddress;
        oracleAddress = proposal.newOracle;
        oracleActive = true;

        emit OracleUpdated(oldOracle, proposal.newOracle);
    }

    /**
     * @notice Cancels an expired oracle update proposal.
     */
    function cancelExpiredOracleUpdateProposal(uint256 _proposalId) external onlyAdmin {
        require(_proposalId < oracleUpdateCounter, "proposal not found");

        OracleUpdateProposal storage proposal = oracleUpdateProposals[_proposalId];
        require(proposal.createdAt > 0, "proposal not initialized");
        require(!proposal.executed, "already executed");
        require(!oracleUpdateProposalCancelled[_proposalId], "already cancelled");
        require(block.timestamp > oracleUpdateProposalExpiresAt[_proposalId], "proposal not expired");

        oracleUpdateProposalCancelled[_proposalId] = true;

        emit OracleUpdateProposalExpiredCancelled(_proposalId, msg.sender);
    }

    function proposeAddAdmin(address _newAdmin) external onlyAdmin returns (uint256) {
        require(_newAdmin != address(0), "invalid admin");
        require(!isAdmin[_newAdmin], "already admin");
        require(admins.length >= governanceApprovals(), "insufficient admins");

        uint256 proposalId = adminAddCounter;
        adminAddCounter++;

        adminAddProposals[proposalId] = AdminAddProposal({
            newAdmin: _newAdmin,
            approvalCount: 1,
            executed: false,
            createdAt: block.timestamp,
            eta: block.timestamp + governanceTimelock,
            proposer: msg.sender
        });

        adminAddHasApproved[proposalId][msg.sender] = true;
        adminAddProposalExpiresAt[proposalId] = block.timestamp + GOVERNANCE_PROPOSAL_TTL;

        emit AdminAddProposed(proposalId, msg.sender, _newAdmin, adminAddProposals[proposalId].eta);
        emit AdminAddApproved(proposalId, msg.sender, 1, governanceApprovals());

        return proposalId;
    }

    function approveAddAdmin(uint256 _proposalId) external onlyAdmin {
        require(_proposalId < adminAddCounter, "proposal not found");

        AdminAddProposal storage proposal = adminAddProposals[_proposalId];
        require(proposal.createdAt > 0, "proposal not initialized");
        require(!proposal.executed, "already executed");
        require(!adminAddProposalCancelled[_proposalId], "proposal cancelled");
        require(block.timestamp <= adminAddProposalExpiresAt[_proposalId], "proposal expired");
        require(!adminAddHasApproved[_proposalId][msg.sender], "already approved");

        adminAddHasApproved[_proposalId][msg.sender] = true;
        proposal.approvalCount++;

        emit AdminAddApproved(_proposalId, msg.sender, proposal.approvalCount, governanceApprovals());
    }

    function executeAddAdmin(uint256 _proposalId) external onlyAdmin {
        require(_proposalId < adminAddCounter, "proposal not found");

        AdminAddProposal storage proposal = adminAddProposals[_proposalId];
        require(proposal.createdAt > 0, "proposal not initialized");
        require(!proposal.executed, "already executed");
        require(!adminAddProposalCancelled[_proposalId], "proposal cancelled");
        require(block.timestamp <= adminAddProposalExpiresAt[_proposalId], "proposal expired");
        require(proposal.approvalCount >= governanceApprovals(), "not enough approvals");
        require(block.timestamp >= proposal.eta, "timelock not elapsed");

        // Re-check target is still valid at execution time
        require(proposal.newAdmin != address(0), "invalid admin");
        require(!isAdmin[proposal.newAdmin], "already admin");

        proposal.executed = true;

        admins.push(proposal.newAdmin);
        isAdmin[proposal.newAdmin] = true;

        emit AdminAdded(proposal.newAdmin);
    }

    /**
     * @notice Cancels an expired admin-add proposal.
     */
    function cancelExpiredAddAdminProposal(uint256 _proposalId) external onlyAdmin {
        require(_proposalId < adminAddCounter, "proposal not found");

        AdminAddProposal storage proposal = adminAddProposals[_proposalId];
        require(proposal.createdAt > 0, "proposal not initialized");
        require(!proposal.executed, "already executed");
        require(!adminAddProposalCancelled[_proposalId], "already cancelled");
        require(block.timestamp > adminAddProposalExpiresAt[_proposalId], "proposal not expired");

        adminAddProposalCancelled[_proposalId] = true;

        emit AdminAddProposalExpiredCancelled(_proposalId, msg.sender);
    }

    function proposeTreasuryPayoutAddressUpdate(address _newPayoutReceiver) external onlyAdmin returns (uint256) {
        require(_newPayoutReceiver != address(0), "invalid treasury payout receiver");
        require(_newPayoutReceiver != treasuryPayoutAddress, "same treasury payout receiver");
        require(admins.length >= governanceApprovals(), "insufficient admins");
        require(!hasPendingTreasuryPayoutAddressUpdateProposal, "proposal already pending");

        uint256 proposalId = treasuryPayoutAddressUpdateCounter;
        treasuryPayoutAddressUpdateCounter++;

        treasuryPayoutAddressUpdateProposals[proposalId] = TreasuryPayoutAddressUpdateProposal({
            newPayoutReceiver: _newPayoutReceiver,
            approvalCount: 1,
            executed: false,
            createdAt: block.timestamp,
            eta: block.timestamp + governanceTimelock,
            proposer: msg.sender
        });

        treasuryPayoutAddressUpdateHasApproved[proposalId][msg.sender] = true;
        treasuryPayoutAddressUpdateProposalExpiresAt[proposalId] = block.timestamp + GOVERNANCE_PROPOSAL_TTL;
        hasPendingTreasuryPayoutAddressUpdateProposal = true;

        emit TreasuryPayoutAddressUpdateProposed(proposalId, msg.sender, _newPayoutReceiver, block.timestamp + governanceTimelock);
        emit TreasuryPayoutAddressUpdateApproved(proposalId, msg.sender, 1, governanceApprovals());

        return proposalId;
    }

    function approveTreasuryPayoutAddressUpdate(uint256 _proposalId) external onlyAdmin {
        require(_proposalId < treasuryPayoutAddressUpdateCounter, "proposal not found");

        TreasuryPayoutAddressUpdateProposal storage proposal = treasuryPayoutAddressUpdateProposals[_proposalId];
        require(proposal.createdAt > 0, "proposal not initialized");
        require(!proposal.executed, "already executed");
        require(!treasuryPayoutAddressUpdateProposalCancelled[_proposalId], "proposal cancelled");
        require(block.timestamp <= treasuryPayoutAddressUpdateProposalExpiresAt[_proposalId], "proposal expired");
        require(!treasuryPayoutAddressUpdateHasApproved[_proposalId][msg.sender], "already approved");

        treasuryPayoutAddressUpdateHasApproved[_proposalId][msg.sender] = true;
        proposal.approvalCount++;

        emit TreasuryPayoutAddressUpdateApproved(_proposalId, msg.sender, proposal.approvalCount, governanceApprovals());
    }

    function executeTreasuryPayoutAddressUpdate(uint256 _proposalId) external onlyAdmin {
        require(_proposalId < treasuryPayoutAddressUpdateCounter, "proposal not found");

        TreasuryPayoutAddressUpdateProposal storage proposal = treasuryPayoutAddressUpdateProposals[_proposalId];
        require(proposal.createdAt > 0, "proposal not initialized");
        require(!proposal.executed, "already executed");
        require(!treasuryPayoutAddressUpdateProposalCancelled[_proposalId], "proposal cancelled");
        require(block.timestamp <= treasuryPayoutAddressUpdateProposalExpiresAt[_proposalId], "proposal expired");
        require(proposal.approvalCount >= governanceApprovals(), "not enough approvals");
        require(block.timestamp >= proposal.eta, "timelock not elapsed");
        require(proposal.newPayoutReceiver != address(0), "invalid treasury payout receiver");

        proposal.executed = true;
        hasPendingTreasuryPayoutAddressUpdateProposal = false;

        address oldPayoutReceiver = treasuryPayoutAddress;
        treasuryPayoutAddress = proposal.newPayoutReceiver;

        emit TreasuryPayoutAddressUpdated(oldPayoutReceiver, proposal.newPayoutReceiver);
    }

    /**
     * @notice Cancels an expired treasury-payout-address update proposal.
     */
    function cancelExpiredTreasuryPayoutAddressUpdateProposal(uint256 _proposalId) external onlyAdmin {
        require(_proposalId < treasuryPayoutAddressUpdateCounter, "proposal not found");

        TreasuryPayoutAddressUpdateProposal storage proposal = treasuryPayoutAddressUpdateProposals[_proposalId];
        require(proposal.createdAt > 0, "proposal not initialized");
        require(!proposal.executed, "already executed");
        require(!treasuryPayoutAddressUpdateProposalCancelled[_proposalId], "already cancelled");
        require(block.timestamp > treasuryPayoutAddressUpdateProposalExpiresAt[_proposalId], "proposal not expired");

        treasuryPayoutAddressUpdateProposalCancelled[_proposalId] = true;
        hasPendingTreasuryPayoutAddressUpdateProposal = false;

        emit TreasuryPayoutAddressUpdateProposalExpiredCancelled(_proposalId, msg.sender);
    }

    // -----------------------------
    // View helpers
    // -----------------------------
    function getNextTradeId() external view returns (uint256) {
        return tradeCounter;
    }
}
