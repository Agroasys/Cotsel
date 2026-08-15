// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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
 * - Inspection availability starts the order's 48h or 72h buyer notice window
 * - Buyer can freeze during window; admins resolve with 4-eyes approval
 * - Treasury ONLY receives explicit fees (logistics + platform fees); buyer principal never routes to treasury
 * - Signature uses buyer-scoped nonce (no global tradeId pre-query race) + deadline + domain separation
 *
 * Business rule enforced:
 * - All buyer funds remain protected until Stage 1; platformFeesAmount includes buyer and supplier platform fees plus the fixed settlement fee
 * - Stage 1 release pays supplierFirstTranche (principal) directly and accrues logistics/platform fees for treasury sweep
 * - Stage 2 finalization pays supplierSecondTranche (principal) directly to supplier
 * - Buyer refunds are transferred directly during the refund transaction; buyers never need to claim
 */
contract AgroasysEscrow is ReentrancyGuard, Pausable {
    error EscrowAlreadyAdmin();
    error EscrowAlreadyApproved();
    error EscrowAlreadyCancelled();
    error EscrowAlreadyExecuted();
    error EscrowAlreadyPaused();
    error EscrowActiveProposalExists();
    error EscrowArrivalNotSet();
    error EscrowAuthorizationExpired();
    error EscrowBadAdmin();
    error EscrowBadAuthorization();
    error EscrowBadAuthorizationNonce();
    error EscrowBreakdownMismatch();
    error EscrowClaimsAlreadyPaused();
    error EscrowClaimsNotPaused();
    error EscrowClaimsPaused();
    error EscrowDuplicateAdmin();
    error EscrowInTransitTimeoutNotElapsed();
    error EscrowInTransitTimestampNotSet();
    error EscrowInspectionNotAvailable();
    error EscrowInsufficientAdmins();
    error EscrowInvalidAdmin();
    error EscrowInvalidAdminChange();
    error EscrowInvalidIncidentReference();
    error EscrowInvalidDisputeStatus();
    error EscrowInvalidLaunchSettlementSchedule();
    error EscrowInvalidOracle();
    error EscrowInvalidRelayer();
    error EscrowInvalidRoleSeparation();
    error EscrowInvalidThreshold();
    error EscrowInvalidToken();
    error EscrowInvalidTreasury();
    error EscrowInvalidTreasuryPayoutReceiver();
    error EscrowInvalidUser();
    error EscrowLockTimeoutNotElapsed();
    error EscrowMustBeARRIVALCONFIRMED();
    error EscrowNoActiveProposal();
    error EscrowNotEnoughAdmins();
    error EscrowNotEnoughApprovals();
    error EscrowMaximumAdminsReached();
    error EscrowNotPaused();
    error EscrowNothingTreasuryClaimable();
    error EscrowOnlyAdmin();
    error EscrowOnlyOracle();
    error EscrowOnlyOracleOrAdmin();
    error EscrowOnlyRelayerOrAdmin();
    error EscrowOnlyTreasuryOrAdmin();
    error EscrowOracleDisabled();
    error EscrowPaused();
    error EscrowProposalCancelled();
    error EscrowProposalExpired();
    error EscrowProposalNotExpired();
    error EscrowProposalNotFound();
    error EscrowProposalNotInitialized();
    error EscrowRequiredApprovalsMustBeAtLeast2();
    error EscrowRicardianHashRequired();
    error EscrowSameOracle();
    error EscrowSameRelayer();
    error EscrowSameTreasuryPayoutReceiver();
    error EscrowStatusMustBeINTRANSIT();
    error EscrowStatusMustBeLOCKED();
    error EscrowSupplierCannotBeEscrow();
    error EscrowSupplierRequired();
    error EscrowStaleGovernanceProposal();
    error EscrowTimelockNotElapsed();
    error EscrowTradeAlreadyPaused();
    error EscrowTradeMustBeFROZEN();
    error EscrowTradeNotFound();
    error EscrowTradeNotFrozen();
    error EscrowTradeNotPaused();
    error EscrowTradePaused();
    error EscrowTranchesMustBeGreaterThan0();
    error EscrowUnsupportedAction();
    error EscrowUnsupportedInspectionWindow();
    error EscrowWindowClosed();
    error EscrowWindowNotElapsed();

    using SafeERC20 for IERC20;

    // -----------------------------
    // Constants
    // -----------------------------
    /// @notice Standard inspection notice window for ordinary agricultural deliveries.
    uint256 public constant STANDARD_INSPECTION_WINDOW = 72 hours;
    /// @notice Inspection notice window for explicitly classified packaged local deliveries.
    uint256 public constant PACKAGED_LOCAL_INSPECTION_WINDOW = 48 hours;
    uint256 private constant BUYER_PLATFORM_FEE_BPS = 100;
    uint256 private constant SUPPLIER_PLATFORM_FEE_BPS = 50;
    uint256 private constant FIRST_SUPPLIER_TRANCHE_BPS = 6_000;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant SETTLEMENT_SUPPORT_FEE = 4_000_000;
    /// @notice Maximum time a trade can remain LOCKED before buyer can cancel for refundable principal.
    uint256 public constant LOCK_TIMEOUT = 7 days;
    /// @notice Maximum time a trade can remain IN_TRANSIT without arrival confirmation before buyer principal refund.
    uint256 public constant IN_TRANSIT_TIMEOUT = 14 days;
    /// @notice Time-to-live for dispute proposals before they must be replaced or cancelled.
    uint256 public constant DISPUTE_PROPOSAL_TTL = 7 days;
    /// @notice Time-to-live for governance proposals (oracle/admin updates).
    uint256 public constant GOVERNANCE_PROPOSAL_TTL = 7 days;
    uint256 public constant MAX_ADMINS = 10;

    bytes32 private constant ACTION_CREATE_TRADE = keccak256("CREATE_TRADE");
    bytes32 private constant ACTION_OPEN_DISPUTE = keccak256("OPEN_DISPUTE");
    bytes32 private constant ACTION_CANCEL_LOCKED_TIMEOUT = keccak256("CANCEL_LOCKED_TIMEOUT");
    bytes32 private constant ACTION_REFUND_IN_TRANSIT_TIMEOUT = keccak256("REFUND_IN_TRANSIT_TIMEOUT");
    bytes32 private constant ACTION_FINALIZE_AFTER_DISPUTE_WINDOW = keccak256("FINALIZE_AFTER_DISPUTE_WINDOW");
    bytes32 private constant ACTION_FINALIZE_AFTER_INSPECTION_ACCEPTANCE =
        keccak256("FINALIZE_AFTER_INSPECTION_ACCEPTANCE");

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant CREATE_TRADE_AUTHORIZATION_TYPEHASH = keccak256(
        "CreateTradeAuthorization(address buyer,address supplier,uint256 totalAmount,uint256 logisticsAmount,uint256 platformFeesAmount,uint256 supplierFirstTranche,uint256 supplierSecondTranche,bytes32 ricardianHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant USER_ACTION_AUTHORIZATION_TYPEHASH =
        keccak256("UserActionAuthorization(address user,uint8 action,uint256 tradeId,uint256 nonce,uint256 deadline)");
    bytes32 private immutable DOMAIN_SEPARATOR;

    // -----------------------------
    // Enums / Structs
    // -----------------------------
    enum TradeStatus {
        LOCKED, // initial deposit
        IN_TRANSIT, // stage1 released (supplier first tranche + logistics fee + platform fee paid)
        ARRIVAL_CONFIRMED, // oracle confirms goods are available for inspection; notice window starts
        FROZEN, // buyer opened dispute within window
        CLOSED // finalized or resolved
    }

    enum DisputeStatus {
        REFUND, // admin resolution: refund buyer remaining escrowed principal (typically supplierSecondTranche)
        RESOLVE // admin resolution: release remaining escrowed principal to supplier (typically supplierSecondTranche)
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
        FINALIZE_AFTER_DISPUTE_WINDOW,
        FINALIZE_AFTER_INSPECTION_ACCEPTANCE
    }

    enum PauseScope {
        GLOBAL,
        CLAIMS,
        TRADE
    }

    enum AdminChangeKind {
        ADD,
        REMOVE,
        REPLACE,
        THRESHOLD,
        RELAYER_ADD,
        RELAYER_REMOVE
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

        uint256 logisticsAmount; // protected until stage1; paid to treasury after custody and document verification
        uint256 platformFeesAmount; // protected until stage1; includes buyer/supplier fees and fixed settlement fee

        uint256 supplierFirstTranche; // 60% gross goods tranche less the supplier fee, released at stage1
        uint256 supplierSecondTranche; // remaining 40% goods tranche, released at stage2/finalization

        uint256 createdAt;
        uint256 arrivalTimestamp; // inspection-availability timestamp retained under the legacy field name
    }

    struct DisputeProposal {
        uint256 tradeId;
        DisputeStatus disputeStatus;
        uint256 approvalCount;
        bool executed;
        uint256 createdAt;
        address proposer;
        uint256 epoch;
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
        uint256 epoch;
    }

    struct AdminChangeProposal {
        AdminChangeKind kind;
        address currentAdmin;
        address newAdmin;
        uint256 newThreshold;
        uint256 approvalCount;
        bool executed;
        uint256 createdAt;
        uint256 eta; // execute-after timestamp (timelock)
        address proposer;
        uint256 epoch;
    }

    struct TreasuryPayoutAddressUpdateProposal {
        address newPayoutReceiver;
        uint256 approvalCount;
        bool executed;
        uint256 createdAt;
        uint256 eta; // execute-after timestamp (timelock)
        address proposer;
        uint256 epoch;
    }

    struct UnpauseProposal {
        PauseScope scope;
        uint256 tradeId;
        bytes32 incidentRef;
        uint256 approvalCount;
        bool executed;
        uint256 createdAt;
        address proposer;
        uint256 epoch;
    }

    // -----------------------------
    // Storage
    // -----------------------------
    mapping(uint256 => Trade) public trades;
    uint256 public tradeCounter;

    /// @notice Per-trade emergency switch. When true, lifecycle transitions for that
    /// trade are blocked, mirroring the global pause but scoped to a single tradeId.
    mapping(uint256 => bool) public tradePaused;

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
    /// @notice Contract-defined inspection notice window for each trade.
    mapping(uint256 => uint256) public inspectionWindowSeconds;

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
    uint256 public governanceEpoch;
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

    mapping(uint256 => AdminChangeProposal) public adminChangeProposals;
    mapping(uint256 => mapping(address => bool)) private adminChangeHasApproved;
    mapping(uint256 => uint256) private adminChangeProposalExpiresAt;
    mapping(uint256 => bool) private adminChangeProposalCancelled;
    uint256 public adminChangeCounter;

    mapping(uint256 => TreasuryPayoutAddressUpdateProposal) public treasuryPayoutAddressUpdateProposals;
    mapping(uint256 => mapping(address => bool)) public treasuryPayoutAddressUpdateHasApproved;
    /// @notice Expiration timestamp for each treasury-payout-address proposal id.
    mapping(uint256 => uint256) public treasuryPayoutAddressUpdateProposalExpiresAt;
    /// @notice True when a treasury-payout-address proposal has been cancelled after expiry.
    mapping(uint256 => bool) public treasuryPayoutAddressUpdateProposalCancelled;
    uint256 public treasuryPayoutAddressUpdateCounter;

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
        address indexed user, bytes32 indexed action, uint256 nonce, address indexed relayer, uint256 deadline
    );

    event RelayedActionExecuted(address indexed relayer, address indexed user, bytes32 indexed action, uint256 tradeId);
    event RelayerUpdated(address indexed relayer, bool allowed, address indexed updatedBy);

    event GaslessTradeFunded(
        uint256 indexed tradeId, address indexed buyer, bytes32 indexed usdcAuthorizationNonce, uint256 amount
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

    event InspectionAvailable(
        uint256 indexed tradeId, uint256 inspectionAvailableAt, uint256 inspectionWindowSeconds, uint256 noticeDeadline
    );
    event InspectionAcceptedForFinalRelease(uint256 indexed tradeId, uint256 acceptedAt);

    // Stage 2 pays supplierSecondTranche ONLY (no treasury payment).
    // Explicit final tranche event for Stage 2/finalization
    event FinalTrancheReleased(uint256 indexed tradeId, address indexed supplier, uint256 supplierSecondTranche);

    event DisputeOpenedByBuyer(uint256 indexed tradeId);

    event DisputeSolutionProposed(
        uint256 indexed proposalId, uint256 indexed tradeId, DisputeStatus disputeStatus, address indexed proposer
    );

    event DisputeApproved(
        uint256 indexed proposalId, address indexed approver, uint256 approvalCount, uint256 requiredApprovals
    );

    event DisputeFinalized(uint256 indexed proposalId, uint256 indexed tradeId, DisputeStatus disputeStatus);

    // ---- Unpause multi-sig events ----
    event UnpauseProposed(
        address indexed proposer, PauseScope indexed scope, uint256 indexed tradeId, bytes32 incidentRef, uint256 epoch
    );
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
        uint256 indexed proposalId, address indexed approver, uint256 approvalCount, uint256 requiredApprovals
    );

    event OracleUpdated(address indexed oldOracle, address indexed newOracle);

    event AdminChangeProposed(
        uint256 indexed proposalId,
        address indexed proposer,
        AdminChangeKind kind,
        address currentAdmin,
        address newAdmin,
        uint256 newThreshold,
        uint256 eta,
        uint256 epoch
    );

    event AdminChangeApproved(
        uint256 indexed proposalId, address indexed approver, uint256 approvalCount, uint256 requiredApprovals
    );

    event AdminAdded(address indexed newAdmin);
    event AdminRemoved(address indexed oldAdmin);
    event AdminReplaced(address indexed oldAdmin, address indexed newAdmin);
    event RequiredApprovalsUpdated(uint256 oldThreshold, uint256 newThreshold);
    event GovernanceEpochAdvanced(uint256 indexed newEpoch);
    event TreasuryPayoutAddressUpdateProposed(
        uint256 indexed proposalId, address indexed proposer, address indexed newPayoutReceiver, uint256 eta
    );
    event TreasuryPayoutAddressUpdateApproved(
        uint256 indexed proposalId, address indexed approver, uint256 approvalCount, uint256 requiredApprovals
    );
    event TreasuryPayoutAddressUpdated(address indexed oldPayoutReceiver, address indexed newPayoutReceiver);
    event TreasuryPayoutAddressUpdateProposalExpiredCancelled(uint256 indexed proposalId, address indexed cancelledBy);
    event TreasuryClaimed(
        address indexed treasuryIdentity, address indexed payoutReceiver, uint256 amount, address triggeredBy
    );

    event OracleDisabledEmergency(address indexed by, address indexed previousOracle);
    event TradeCancelledAfterLockTimeout(uint256 indexed tradeId, address indexed buyer, uint256 refundedAmount);
    event InTransitTimeoutRefunded(uint256 indexed tradeId, address indexed buyer, uint256 refundedAmount);
    event DisputeProposalExpiredCancelled(
        uint256 indexed proposalId, uint256 indexed tradeId, address indexed cancelledBy
    );
    event DisputePayout(
        uint256 indexed tradeId,
        uint256 indexed proposalId,
        address indexed recipient,
        uint256 amount,
        DisputeStatus payoutType
    );
    event ClaimableAccrued(uint256 indexed tradeId, address indexed recipient, uint256 amount, ClaimType claimType);
    event SupplierPayoutTransferred(
        uint256 indexed tradeId,
        address indexed supplier,
        uint256 amount,
        ClaimType claimType,
        address indexed triggeredBy
    );
    event BuyerRefundTransferred(
        uint256 indexed tradeId, address indexed buyer, uint256 amount, ClaimType claimType, address indexed triggeredBy
    );
    event ClaimsPaused(address indexed triggeredBy);
    event ClaimsUnpaused(address indexed triggeredBy);
    event TradePaused(uint256 indexed tradeId, address indexed triggeredBy);
    event TradeUnpaused(uint256 indexed tradeId, address indexed triggeredBy);
    event OracleUpdateProposalExpiredCancelled(uint256 indexed proposalId, address indexed cancelledBy);
    event AdminChangeProposalCancelled(uint256 indexed proposalId, address indexed cancelledBy);

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
        if (!(_usdcToken != address(0))) revert EscrowInvalidToken();
        if (!(_oracleAddress != address(0))) revert EscrowInvalidOracle();
        if (!(_treasuryAddress != address(0))) revert EscrowInvalidTreasury();
        if (!(_relayerAddress != address(0))) revert EscrowInvalidRelayer();
        if (
            _oracleAddress == _treasuryAddress || _oracleAddress == _relayerAddress
                || _treasuryAddress == _relayerAddress
        ) revert EscrowInvalidRoleSeparation();
        if (!(_requiredApprovals >= 2)) revert EscrowRequiredApprovalsMustBeAtLeast2();
        // Strictly greater, not equal: the admin set must keep at least one spare signer beyond
        // the approval threshold. At parity (admins == requiredApprovals) the loss of a single
        // key permanently disables dispute resolution, unpause, and all governance rotation,
        // and this contract has no admin-removal or threshold-change path to recover.
        if (!(_admins.length > _requiredApprovals)) revert EscrowNotEnoughAdmins();
        if (_admins.length > MAX_ADMINS) revert EscrowMaximumAdminsReached();

        usdcToken = IERC20(_usdcToken);
        oracleAddress = _oracleAddress;
        treasuryAddress = _treasuryAddress;
        treasuryPayoutAddress = _treasuryAddress;
        isRelayer[_relayerAddress] = true;
        requiredApprovals = _requiredApprovals;

        for (uint256 i = 0; i < _admins.length; i++) {
            address admin = _admins[i];
            if (!(admin != address(0))) revert EscrowBadAdmin();
            if (!(!isAdmin[admin])) revert EscrowDuplicateAdmin();
            if (admin == _oracleAddress || admin == _treasuryAddress || admin == _relayerAddress) {
                revert EscrowInvalidRoleSeparation();
            }
            admins.push(admin);
            isAdmin[admin] = true;
        }

        // Timelock for sensitive governance operations (oracle/admin updates).
        // Can be changed in future versions if needed; keeping minimal for now.
        governanceTimelock = 24 hours;
        governanceEpoch = 1;
        oracleActive = true;
        DOMAIN_SEPARATOR = _buildDomainSeparator();
        emit RelayerUpdated(_relayerAddress, true, msg.sender);
    }

    modifier onlyAdmin() {
        if (!(isAdmin[msg.sender])) revert EscrowOnlyAdmin();
        _;
    }

    modifier onlyTreasuryOrAdmin() {
        if (!(msg.sender == treasuryAddress || isAdmin[msg.sender])) revert EscrowOnlyTreasuryOrAdmin();
        _;
    }

    modifier onlyRelayerOrAdmin() {
        if (!(isAdmin[msg.sender] || isRelayer[msg.sender])) revert EscrowOnlyRelayerOrAdmin();
        _;
    }

    modifier onlyOracle() {
        if (!(msg.sender == oracleAddress)) revert EscrowOnlyOracle();
        _;
    }

    modifier whenClaimsNotPaused() {
        if (!(!claimsPaused)) revert EscrowClaimsPaused();
        _;
    }
    modifier whenTradeNotPaused(uint256 _tradeId) {
        _requireTradeNotPaused(_tradeId);
        _;
    }

    /// @dev Shared per-trade pause guard; kept as an internal function (not inlined per
    /// call site) so the check exists once in bytecode. Mirrors `_requireNotPaused`.
    function _requireTradeNotPaused(uint256 _tradeId) internal view {
        if (!(!tradePaused[_tradeId])) revert EscrowTradePaused();
    }
    modifier onlyOracleActive() {
        if (!(oracleActive)) revert EscrowOracleDisabled();
        _;
    }

    modifier onlyOracleOrAdmin() {
        bool callerIsOracle = msg.sender == oracleAddress;
        if (!(callerIsOracle || isAdmin[msg.sender])) revert EscrowOnlyOracleOrAdmin();
        if (callerIsOracle) {
            if (!(oracleActive)) revert EscrowOracleDisabled();
        }
        _;
    }

    /// @dev Keep backwards-compatible revert messages for existing consumers/tests.
    function _requireNotPaused() internal view override {
        if (!(!paused())) revert EscrowPaused();
    }

    /// @dev Keep backwards-compatible revert messages for existing consumers/tests.
    function _requirePaused() internal view override {
        if (!(paused())) revert EscrowNotPaused();
    }

    /**
     * @notice Pauses normal protocol operations for emergency containment.
     */
    function pause() external onlyAdmin {
        if (!(!paused())) revert EscrowAlreadyPaused();
        _pause();
    }

    /**
     * @notice Pauses claim withdrawals while keeping global pause policy independent.
     */
    function pauseClaims() external onlyAdmin {
        if (!(!claimsPaused)) revert EscrowClaimsAlreadyPaused();
        claimsPaused = true;
        emit ClaimsPaused(msg.sender);
    }

    /**
     * @notice Pauses lifecycle transitions for a single trade (per-trade emergency switch).
     * @dev Same intent as the global pause but scoped to one tradeId; leaves every other
     * trade unaffected. Does not move funds or change trade status.
     */
    function pauseTrade(uint256 _tradeId) external onlyAdmin {
        if (!(_tradeId < tradeCounter)) revert EscrowTradeNotFound();
        if (!(!tradePaused[_tradeId])) revert EscrowTradeAlreadyPaused();
        tradePaused[_tradeId] = true;
        emit TradePaused(_tradeId, msg.sender);
    }

    /**
     * @notice Propose recovery for one paused scope. Pause remains immediate; recovery requires quorum.
     */
    function proposeUnpause(PauseScope scope, uint256 tradeId, bytes32 incidentRef) external onlyAdmin returns (bool) {
        if (incidentRef == bytes32(0)) revert EscrowInvalidIncidentReference();
        _validatePausedScope(scope, tradeId);

        if (hasActiveUnpauseProposal) {
            bool staleOrExpired = unpauseProposal.epoch != governanceEpoch
                || block.timestamp > unpauseProposal.createdAt + GOVERNANCE_PROPOSAL_TTL;
            if (!staleOrExpired) revert EscrowActiveProposalExists();
            _cancelUnpauseProposal();
        }

        unpauseProposal = UnpauseProposal({
            scope: scope,
            tradeId: tradeId,
            incidentRef: incidentRef,
            approvalCount: 1,
            executed: false,
            createdAt: block.timestamp,
            proposer: msg.sender,
            epoch: governanceEpoch
        });

        unpauseHasApproved[msg.sender] = true;
        hasActiveUnpauseProposal = true;

        emit UnpauseProposed(msg.sender, scope, tradeId, incidentRef, governanceEpoch);
        emit UnpauseApproved(msg.sender, 1, governanceApprovals());

        return true;
    }

    /**
     * @notice Approve the unpause proposal.
     */
    function approveUnpause() external onlyAdmin {
        if (!(hasActiveUnpauseProposal)) revert EscrowNoActiveProposal();
        if (!(!unpauseProposal.executed)) revert EscrowAlreadyExecuted();
        if (unpauseProposal.epoch != governanceEpoch) revert EscrowStaleGovernanceProposal();
        _validatePausedScope(unpauseProposal.scope, unpauseProposal.tradeId);
        if (!(!unpauseHasApproved[msg.sender])) revert EscrowAlreadyApproved();

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
        if (!(hasActiveUnpauseProposal)) revert EscrowNoActiveProposal();
        if (!(!unpauseProposal.executed)) revert EscrowAlreadyExecuted();
        bool staleOrExpired = unpauseProposal.epoch != governanceEpoch
            || block.timestamp > unpauseProposal.createdAt + GOVERNANCE_PROPOSAL_TTL;
        if (msg.sender != unpauseProposal.proposer && !staleOrExpired) revert EscrowActiveProposalExists();

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
        if (!(!unpauseProposal.executed)) revert EscrowAlreadyExecuted();
        if (unpauseProposal.epoch != governanceEpoch) revert EscrowStaleGovernanceProposal();
        if (!(unpauseProposal.approvalCount >= governanceApprovals())) revert EscrowNotEnoughApprovals();

        unpauseProposal.executed = true;
        hasActiveUnpauseProposal = false;
        if (unpauseProposal.scope == PauseScope.GLOBAL) {
            _unpause();
        } else if (unpauseProposal.scope == PauseScope.CLAIMS) {
            claimsPaused = false;
            emit ClaimsUnpaused(msg.sender);
        } else {
            tradePaused[unpauseProposal.tradeId] = false;
            emit TradeUnpaused(unpauseProposal.tradeId, msg.sender);
        }

        // Clear approvals
        address[] memory adminList = admins;
        for (uint256 i = 0; i < adminList.length; i++) {
            unpauseHasApproved[adminList[i]] = false;
        }
    }

    function _validatePausedScope(PauseScope scope, uint256 tradeId) internal view {
        if (scope == PauseScope.GLOBAL) {
            if (!(paused())) revert EscrowNotPaused();
            if (!(oracleActive)) revert EscrowOracleDisabled();
        } else if (scope == PauseScope.CLAIMS) {
            if (!(claimsPaused)) revert EscrowClaimsNotPaused();
        } else {
            if (!(tradeId < tradeCounter)) revert EscrowTradeNotFound();
            if (!(tradePaused[tradeId])) revert EscrowTradeNotPaused();
        }
    }

    /**
     * @notice Emergency kill switch to disable oracle-triggered transitions and pause protocol.
     */
    function disableOracleEmergency() external onlyAdmin {
        if (!(oracleActive)) revert EscrowOracleDisabled();
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
        if (action == SponsoredAction.FINALIZE_AFTER_INSPECTION_ACCEPTANCE) {
            return ACTION_FINALIZE_AFTER_INSPECTION_ACCEPTANCE;
        }
        revert EscrowUnsupportedAction();
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
        if (!(user != address(0))) revert EscrowInvalidUser();
        if (!(block.timestamp <= deadline)) revert EscrowAuthorizationExpired();
        if (!(nonce == authorizationNonces[user])) revert EscrowBadAuthorizationNonce();
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
        if (!(signer == buyer)) revert EscrowBadAuthorization();
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

        bytes32 structHash =
            keccak256(abi.encode(USER_ACTION_AUTHORIZATION_TYPEHASH, user, uint8(action), tradeId, nonce, deadline));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (!(signer == user)) revert EscrowBadAuthorization();
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
        if (!(ricardianHash != bytes32(0))) revert EscrowRicardianHashRequired();
        if (!(supplier != address(0))) revert EscrowSupplierRequired();
        if (!(supplier != address(this))) revert EscrowSupplierCannotBeEscrow();

        uint256 totalExpected = logisticsAmount + platformFeesAmount + supplierFirstTranche + supplierSecondTranche;

        if (!(totalAmount == totalExpected)) revert EscrowBreakdownMismatch();
        if (!(supplierFirstTranche > 0 && supplierSecondTranche > 0)) revert EscrowTranchesMustBeGreaterThan0();
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
        return _createTradeWithAuthorization(
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
            _authorizationSignature,
            _usdcAuthorization
        );
    }

    function _createTradeWithAuthorization(
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
    ) internal returns (uint256) {
        _validateTradeAmounts(
            _supplier,
            _totalAmount,
            _logisticsAmount,
            _platformFeesAmount,
            _supplierFirstTranche,
            _supplierSecondTranche,
            _ricardianHash
        );
        _validateLaunchSettlementSchedule(_platformFeesAmount, _supplierFirstTranche, _supplierSecondTranche);

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

        IUSDCReceiveWithAuthorization(address(usdcToken))
            .receiveWithAuthorization(
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

    function _validateLaunchSettlementSchedule(
        uint256 platformFeesAmount,
        uint256 supplierFirstTranche,
        uint256 supplierSecondTranche
    ) internal pure {
        uint256 netSupplierPayout = supplierFirstTranche + supplierSecondTranche;
        uint256 maximumGoodsCandidate =
            Math.mulDiv(netSupplierPayout, BPS_DENOMINATOR, BPS_DENOMINATOR - SUPPLIER_PLATFORM_FEE_BPS);

        bool valid = _matchesLaunchSettlementSchedule(
            maximumGoodsCandidate, platformFeesAmount, supplierFirstTranche, supplierSecondTranche
        );
        if (!valid && maximumGoodsCandidate > 0) {
            valid = _matchesLaunchSettlementSchedule(
                maximumGoodsCandidate - 1, platformFeesAmount, supplierFirstTranche, supplierSecondTranche
            );
        }

        if (!(valid)) revert EscrowInvalidLaunchSettlementSchedule();
    }

    function _matchesLaunchSettlementSchedule(
        uint256 goodsAmount,
        uint256 platformFeesAmount,
        uint256 supplierFirstTranche,
        uint256 supplierSecondTranche
    ) internal pure returns (bool) {
        uint256 buyerFee = Math.mulDiv(goodsAmount, BUYER_PLATFORM_FEE_BPS, BPS_DENOMINATOR);
        uint256 supplierFee = Math.mulDiv(goodsAmount, SUPPLIER_PLATFORM_FEE_BPS, BPS_DENOMINATOR);
        uint256 firstTrancheGross = Math.mulDiv(goodsAmount, FIRST_SUPPLIER_TRANCHE_BPS, BPS_DENOMINATOR);

        return firstTrancheGross >= supplierFee && supplierFirstTranche == firstTrancheGross - supplierFee
            && supplierSecondTranche == goodsAmount - firstTrancheGross
            && platformFeesAmount == buyerFee + supplierFee + SETTLEMENT_SUPPORT_FEE;
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
        if (trade.status == TradeStatus.LOCKED) {
            return 0;
        }
        return trade.logisticsAmount + trade.platformFeesAmount;
    }

    function _buyerRefundablePrincipalAmount(Trade storage trade) internal view returns (uint256) {
        if (trade.status == TradeStatus.LOCKED) {
            return trade.totalAmountLocked;
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

    function _transferSupplierPayout(uint256 _tradeId, address _supplier, uint256 _amount, ClaimType _claimType)
        internal
    {
        if (_amount == 0) {
            return;
        }

        usdcToken.safeTransfer(_supplier, _amount);
        emit SupplierPayoutTransferred(_tradeId, _supplier, _amount, _claimType, msg.sender);
    }

    function _transferBuyerRefund(uint256 _tradeId, address _buyer, uint256 _amount, ClaimType _claimType) internal {
        if (_amount == 0) {
            return;
        }

        usdcToken.safeTransfer(_buyer, _amount);
        emit BuyerRefundTransferred(_tradeId, _buyer, _amount, _claimType, msg.sender);
    }

    function nonRefundableFeeAmount(uint256 _tradeId) public view returns (uint256) {
        if (!(_tradeId < tradeCounter)) revert EscrowTradeNotFound();
        Trade storage trade = trades[_tradeId];
        return _nonRefundableFeeAmount(trade);
    }

    function buyerRefundableAmount(uint256 _tradeId) public view returns (uint256) {
        if (!(_tradeId < tradeCounter)) revert EscrowTradeNotFound();
        Trade storage trade = trades[_tradeId];
        return _buyerRefundablePrincipalAmount(trade);
    }

    /**
     * @notice Treasury sweep that is destination-locked to treasuryPayoutAddress.
     * @dev Uses treasuryAddress as immutable accounting identity; only treasury/admin callers can trigger it.
     */
    function claimTreasury() external onlyTreasuryOrAdmin whenClaimsNotPaused nonReentrant {
        uint256 amount = claimableUsdc[treasuryAddress];
        if (!(amount > 0)) revert EscrowNothingTreasuryClaimable();

        address payoutReceiver = treasuryPayoutAddress;
        if (!(payoutReceiver != address(0))) revert EscrowInvalidTreasuryPayoutReceiver();

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
    function releaseFundsStage1(uint256 _tradeId)
        external
        onlyOracle
        onlyOracleActive
        whenNotPaused
        whenTradeNotPaused(_tradeId)
        nonReentrant
    {
        if (!(_tradeId < tradeCounter)) revert EscrowTradeNotFound();
        Trade storage trade = trades[_tradeId];

        if (!(trade.status == TradeStatus.LOCKED)) revert EscrowStatusMustBeLOCKED();

        trade.status = TradeStatus.IN_TRANSIT;
        inTransitSince[_tradeId] = block.timestamp;

        _transferSupplierPayout(_tradeId, trade.supplierAddress, trade.supplierFirstTranche, ClaimType.STAGE1_SUPPLIER);
        _accrueClaimable(_tradeId, treasuryAddress, trade.logisticsAmount, ClaimType.STAGE1_LOGISTICS_FEE);
        _accrueClaimable(_tradeId, treasuryAddress, trade.platformFeesAmount, ClaimType.STAGE1_PLATFORM_FEE);

        emit FundsReleasedStage1(
            _tradeId, trade.supplierAddress, trade.supplierFirstTranche, treasuryAddress, trade.logisticsAmount
        );

        (uint256 platformFeeNetAmount, uint256 settlementSupportFeeAmount) =
            _splitPlatformFeeComponents(trade.platformFeesAmount);
        emit PlatformFeesPaidStage1(
            _tradeId, treasuryAddress, trade.platformFeesAmount, platformFeeNetAmount, settlementSupportFeeAmount
        );
    }

    /**
     * Single entry point for confirming inspection availability. The caller supplies
     * the order's inspection window policy (standard 72h or packaged-local 48h).
     */
    function confirmInspectionAvailable(uint256 _tradeId, uint256 _windowSeconds)
        external
        onlyOracle
        onlyOracleActive
        whenNotPaused
        whenTradeNotPaused(_tradeId)
        nonReentrant
    {
        _confirmInspectionAvailable(_tradeId, _windowSeconds);
    }

    function _confirmInspectionAvailable(uint256 _tradeId, uint256 _windowSeconds) internal {
        if (!(_tradeId < tradeCounter)) revert EscrowTradeNotFound();
        Trade storage trade = trades[_tradeId];

        if (!(trade.status == TradeStatus.IN_TRANSIT)) revert EscrowStatusMustBeINTRANSIT();
        if (!(_windowSeconds == STANDARD_INSPECTION_WINDOW || _windowSeconds == PACKAGED_LOCAL_INSPECTION_WINDOW)) {
            revert EscrowUnsupportedInspectionWindow();
        }

        trade.status = TradeStatus.ARRIVAL_CONFIRMED;
        trade.arrivalTimestamp = block.timestamp;
        inspectionWindowSeconds[_tradeId] = _windowSeconds;
        inTransitSince[_tradeId] = 0;

        emit InspectionAvailable(
            _tradeId, trade.arrivalTimestamp, _windowSeconds, trade.arrivalTimestamp + _windowSeconds
        );
    }

    function inspectionDeadline(uint256 _tradeId) public view returns (uint256) {
        if (!(_tradeId < tradeCounter)) revert EscrowTradeNotFound();
        Trade storage trade = trades[_tradeId];
        if (!(trade.arrivalTimestamp > 0)) revert EscrowInspectionNotAvailable();
        return trade.arrivalTimestamp + _inspectionWindow(_tradeId);
    }

    function _inspectionWindow(uint256 _tradeId) internal view returns (uint256) {
        uint256 configuredWindow = inspectionWindowSeconds[_tradeId];
        return configuredWindow == 0 ? STANDARD_INSPECTION_WINDOW : configuredWindow;
    }

    /**
     * Buyer can open a dispute through a relayed authorization during the inspection notice window.
     * This freezes remaining funds until admin resolution.
     */
    function openDisputeWithAuthorization(
        uint256 _tradeId,
        uint256 _authorizationNonce,
        uint256 _authorizationDeadline,
        bytes memory _authorizationSignature
    ) external onlyRelayerOrAdmin whenNotPaused whenTradeNotPaused(_tradeId) nonReentrant {
        if (!(_tradeId < tradeCounter)) revert EscrowTradeNotFound();
        Trade storage trade = trades[_tradeId];

        _verifyUserActionAuthorization(
            trade.buyerAddress,
            SponsoredAction.OPEN_DISPUTE,
            _tradeId,
            _authorizationNonce,
            _authorizationDeadline,
            _authorizationSignature
        );

        if (!(trade.status == TradeStatus.ARRIVAL_CONFIRMED)) revert EscrowMustBeARRIVALCONFIRMED();
        if (!(trade.arrivalTimestamp > 0)) revert EscrowArrivalNotSet();
        if (!(block.timestamp <= inspectionDeadline(_tradeId))) revert EscrowWindowClosed();

        trade.status = TradeStatus.FROZEN;

        emit DisputeOpenedByBuyer(_tradeId);
        emit RelayedActionExecuted(msg.sender, trade.buyerAddress, ACTION_OPEN_DISPUTE, _tradeId);
    }

    /**
     * Final settlement after dispute window if no dispute was opened.
     * Direct execution is available to the active oracle for automatic expiry and to admins
     * for governed recovery; suppliers use finalizeAfterDisputeWindowWithAuthorization.
     *
     * Business rule: Stage 2 pays ONLY remaining supplier principal (supplierSecondTranche).
     * Treasury fees were already collected at Stage 1.
     */
    function finalizeAfterDisputeWindow(uint256 _tradeId)
        external
        onlyOracleOrAdmin
        whenNotPaused
        whenTradeNotPaused(_tradeId)
        nonReentrant
    {
        _finalizeAfterDisputeWindow(_tradeId);
    }

    function finalizeAfterDisputeWindowWithAuthorization(
        uint256 _tradeId,
        uint256 _authorizationNonce,
        uint256 _authorizationDeadline,
        bytes memory _authorizationSignature
    ) external onlyRelayerOrAdmin whenNotPaused whenTradeNotPaused(_tradeId) nonReentrant {
        if (!(_tradeId < tradeCounter)) revert EscrowTradeNotFound();
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

    /**
     * Releases the final tranche immediately after Agroasys records the buyer's explicit
     * acceptance that the inspected goods meet the agreed terms.
     */
    function finalizeAfterInspectionAcceptanceWithAuthorization(
        uint256 _tradeId,
        uint256 _authorizationNonce,
        uint256 _authorizationDeadline,
        bytes memory _authorizationSignature
    ) external onlyRelayerOrAdmin whenNotPaused whenTradeNotPaused(_tradeId) nonReentrant {
        if (!(_tradeId < tradeCounter)) revert EscrowTradeNotFound();
        Trade storage trade = trades[_tradeId];
        if (!(trade.status == TradeStatus.ARRIVAL_CONFIRMED)) revert EscrowMustBeARRIVALCONFIRMED();

        _verifyUserActionAuthorization(
            trade.buyerAddress,
            SponsoredAction.FINALIZE_AFTER_INSPECTION_ACCEPTANCE,
            _tradeId,
            _authorizationNonce,
            _authorizationDeadline,
            _authorizationSignature
        );

        _releaseFinalTranche(_tradeId, trade);
        emit InspectionAcceptedForFinalRelease(_tradeId, block.timestamp);
        emit RelayedActionExecuted(
            msg.sender, trade.buyerAddress, ACTION_FINALIZE_AFTER_INSPECTION_ACCEPTANCE, _tradeId
        );
    }

    function _finalizeAfterDisputeWindow(uint256 _tradeId) internal {
        if (!(_tradeId < tradeCounter)) revert EscrowTradeNotFound();
        Trade storage trade = trades[_tradeId];

        if (!(trade.status == TradeStatus.ARRIVAL_CONFIRMED)) revert EscrowMustBeARRIVALCONFIRMED();
        if (!(trade.arrivalTimestamp > 0)) revert EscrowArrivalNotSet();
        if (!(block.timestamp > inspectionDeadline(_tradeId))) revert EscrowWindowNotElapsed();

        _releaseFinalTranche(_tradeId, trade);
    }

    function _releaseFinalTranche(uint256 _tradeId, Trade storage trade) internal {
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
    ) external onlyRelayerOrAdmin whenNotPaused whenTradeNotPaused(_tradeId) nonReentrant {
        if (!(_tradeId < tradeCounter)) revert EscrowTradeNotFound();
        Trade storage trade = trades[_tradeId];

        _verifyUserActionAuthorization(
            trade.buyerAddress,
            SponsoredAction.CANCEL_LOCKED_TIMEOUT,
            _tradeId,
            _authorizationNonce,
            _authorizationDeadline,
            _authorizationSignature
        );

        if (!(trade.status == TradeStatus.LOCKED)) revert EscrowStatusMustBeLOCKED();
        if (!(block.timestamp > trade.createdAt + LOCK_TIMEOUT)) revert EscrowLockTimeoutNotElapsed();

        uint256 buyerRefundAmount = trade.totalAmountLocked;
        trade.status = TradeStatus.CLOSED;

        _transferBuyerRefund(_tradeId, trade.buyerAddress, buyerRefundAmount, ClaimType.LOCK_TIMEOUT_BUYER_REFUND);

        emit TradeCancelledAfterLockTimeout(_tradeId, trade.buyerAddress, buyerRefundAmount);
        emit RelayedActionExecuted(msg.sender, trade.buyerAddress, ACTION_CANCEL_LOCKED_TIMEOUT, _tradeId);
    }

    function refundInTransitAfterTimeoutWithAuthorization(
        uint256 _tradeId,
        uint256 _authorizationNonce,
        uint256 _authorizationDeadline,
        bytes memory _authorizationSignature
    ) external onlyRelayerOrAdmin whenNotPaused whenTradeNotPaused(_tradeId) nonReentrant {
        if (!(_tradeId < tradeCounter)) revert EscrowTradeNotFound();
        Trade storage trade = trades[_tradeId];

        _verifyUserActionAuthorization(
            trade.buyerAddress,
            SponsoredAction.REFUND_IN_TRANSIT_TIMEOUT,
            _tradeId,
            _authorizationNonce,
            _authorizationDeadline,
            _authorizationSignature
        );

        if (!(trade.status == TradeStatus.IN_TRANSIT)) revert EscrowStatusMustBeINTRANSIT();

        uint256 transitStart = inTransitSince[_tradeId];
        if (!(transitStart > 0)) revert EscrowInTransitTimestampNotSet();
        if (!(block.timestamp > transitStart + IN_TRANSIT_TIMEOUT)) revert EscrowInTransitTimeoutNotElapsed();

        trade.status = TradeStatus.CLOSED;
        inTransitSince[_tradeId] = 0;

        _transferBuyerRefund(
            _tradeId, trade.buyerAddress, trade.supplierSecondTranche, ClaimType.IN_TRANSIT_TIMEOUT_BUYER_REFUND
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
        whenTradeNotPaused(_tradeId)
        returns (uint256)
    {
        if (!(_tradeId < tradeCounter)) revert EscrowTradeNotFound();
        Trade storage trade = trades[_tradeId];

        if (!(trade.status == TradeStatus.FROZEN)) revert EscrowTradeNotFrozen();

        if (tradeHasActiveDisputeProposal[_tradeId]) {
            uint256 activeProposalId = tradeActiveDisputeProposalId[_tradeId];
            bool activeExpired = block.timestamp > disputeProposalExpiresAt[activeProposalId]
                || disputeProposals[activeProposalId].epoch != governanceEpoch;

            if (activeExpired && !disputeProposalCancelled[activeProposalId]) {
                disputeProposalCancelled[activeProposalId] = true;
                tradeHasActiveDisputeProposal[_tradeId] = false;
                tradeActiveDisputeProposalId[_tradeId] = 0;
                emit DisputeProposalExpiredCancelled(activeProposalId, _tradeId, msg.sender);
            } else {
                revert EscrowActiveProposalExists();
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
            proposer: msg.sender,
            epoch: governanceEpoch
        });

        disputeHasApproved[proposalId][msg.sender] = true;
        tradeHasActiveDisputeProposal[_tradeId] = true;
        tradeActiveDisputeProposalId[_tradeId] = proposalId;
        disputeProposalExpiresAt[proposalId] = block.timestamp + DISPUTE_PROPOSAL_TTL;

        emit DisputeSolutionProposed(proposalId, _tradeId, _disputeStatus, msg.sender);

        return proposalId;
    }

    function approveDisputeSolution(uint256 _proposalId) external onlyAdmin whenNotPaused nonReentrant {
        if (!(_proposalId < disputeCounter)) revert EscrowProposalNotFound();

        DisputeProposal storage proposal = disputeProposals[_proposalId];
        if (!(proposal.createdAt > 0)) revert EscrowProposalNotInitialized();
        if (!(!proposal.executed)) revert EscrowAlreadyExecuted();
        if (!(!disputeProposalCancelled[_proposalId])) revert EscrowProposalCancelled();
        if (!(block.timestamp <= disputeProposalExpiresAt[_proposalId])) revert EscrowProposalExpired();
        if (proposal.epoch != governanceEpoch) revert EscrowStaleGovernanceProposal();

        Trade storage trade = trades[proposal.tradeId];
        _requireTradeNotPaused(proposal.tradeId);
        if (!(trade.status == TradeStatus.FROZEN)) revert EscrowTradeNotFrozen();

        if (!(!disputeHasApproved[_proposalId][msg.sender])) revert EscrowAlreadyApproved();

        disputeHasApproved[_proposalId][msg.sender] = true;
        proposal.approvalCount++;

        emit DisputeApproved(_proposalId, msg.sender, proposal.approvalCount, requiredApprovals);

        if (proposal.approvalCount >= requiredApprovals) {
            _executeDispute(_proposalId);
        }
    }

    function _executeDispute(uint256 _proposalId) internal {
        DisputeProposal storage proposal = disputeProposals[_proposalId];

        if (!(!proposal.executed)) revert EscrowAlreadyExecuted();
        if (!(!disputeProposalCancelled[_proposalId])) revert EscrowProposalCancelled();
        if (!(block.timestamp <= disputeProposalExpiresAt[_proposalId])) revert EscrowProposalExpired();
        if (proposal.epoch != governanceEpoch) revert EscrowStaleGovernanceProposal();
        if (!(proposal.approvalCount >= requiredApprovals)) revert EscrowNotEnoughApprovals();

        Trade storage trade = trades[proposal.tradeId];
        if (!(trade.status == TradeStatus.FROZEN)) revert EscrowTradeMustBeFROZEN();

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
            revert EscrowInvalidDisputeStatus();
        }

        emit DisputePayout(proposal.tradeId, _proposalId, recipient, payoutAmount, proposal.disputeStatus);
        emit DisputeFinalized(_proposalId, proposal.tradeId, proposal.disputeStatus);
    }

    /**
     * @notice Cancels an expired dispute proposal to unblock replacement proposals.
     */
    function cancelExpiredDisputeProposal(uint256 _proposalId) external onlyAdmin whenNotPaused {
        if (!(_proposalId < disputeCounter)) revert EscrowProposalNotFound();

        DisputeProposal storage proposal = disputeProposals[_proposalId];
        if (!(proposal.createdAt > 0)) revert EscrowProposalNotInitialized();
        if (!(!proposal.executed)) revert EscrowAlreadyExecuted();
        if (!(!disputeProposalCancelled[_proposalId])) revert EscrowAlreadyCancelled();
        if (!(block.timestamp > disputeProposalExpiresAt[_proposalId])) revert EscrowProposalNotExpired();
        _requireTradeNotPaused(proposal.tradeId);

        disputeProposalCancelled[_proposalId] = true;
        if (
            tradeHasActiveDisputeProposal[proposal.tradeId]
                && tradeActiveDisputeProposalId[proposal.tradeId] == _proposalId
        ) {
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
        if (!(_newOracle != address(0))) revert EscrowInvalidOracle();
        if (!(_newOracle != oracleAddress)) revert EscrowSameOracle();
        _requireServiceRoleAvailable(_newOracle);
        if (!(admins.length >= governanceApprovals())) revert EscrowInsufficientAdmins();

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
            emergencyFastTrack: emergencyFastTrack,
            epoch: governanceEpoch
        });

        oracleUpdateHasApproved[proposalId][msg.sender] = true;
        oracleUpdateProposalExpiresAt[proposalId] = block.timestamp + GOVERNANCE_PROPOSAL_TTL;

        emit OracleUpdateProposed(proposalId, msg.sender, _newOracle, eta, emergencyFastTrack);
        emit OracleUpdateApproved(proposalId, msg.sender, 1, governanceApprovals());

        return proposalId;
    }

    function approveOracleUpdate(uint256 _proposalId) external onlyAdmin {
        if (!(_proposalId < oracleUpdateCounter)) revert EscrowProposalNotFound();

        OracleUpdateProposal storage proposal = oracleUpdateProposals[_proposalId];
        if (!(proposal.createdAt > 0)) revert EscrowProposalNotInitialized();
        if (!(!proposal.executed)) revert EscrowAlreadyExecuted();
        if (!(!oracleUpdateProposalCancelled[_proposalId])) revert EscrowProposalCancelled();
        if (!(block.timestamp <= oracleUpdateProposalExpiresAt[_proposalId])) revert EscrowProposalExpired();
        if (proposal.epoch != governanceEpoch) revert EscrowStaleGovernanceProposal();
        if (!(!oracleUpdateHasApproved[_proposalId][msg.sender])) revert EscrowAlreadyApproved();

        oracleUpdateHasApproved[_proposalId][msg.sender] = true;
        proposal.approvalCount++;

        emit OracleUpdateApproved(_proposalId, msg.sender, proposal.approvalCount, governanceApprovals());
    }

    function executeOracleUpdate(uint256 _proposalId) external onlyAdmin {
        if (!(_proposalId < oracleUpdateCounter)) revert EscrowProposalNotFound();

        OracleUpdateProposal storage proposal = oracleUpdateProposals[_proposalId];
        if (!(proposal.createdAt > 0)) revert EscrowProposalNotInitialized();
        if (!(!proposal.executed)) revert EscrowAlreadyExecuted();
        if (!(!oracleUpdateProposalCancelled[_proposalId])) revert EscrowProposalCancelled();
        if (!(block.timestamp <= oracleUpdateProposalExpiresAt[_proposalId])) revert EscrowProposalExpired();
        if (proposal.epoch != governanceEpoch) revert EscrowStaleGovernanceProposal();
        if (!(proposal.approvalCount >= governanceApprovals())) revert EscrowNotEnoughApprovals();
        if (!(block.timestamp >= proposal.eta)) revert EscrowTimelockNotElapsed();

        proposal.executed = true;

        address oldOracle = oracleAddress;
        oracleAddress = proposal.newOracle;
        oracleActive = true;
        _advanceGovernanceEpoch();

        emit OracleUpdated(oldOracle, proposal.newOracle);
    }

    /**
     * @notice Cancels an expired oracle update proposal.
     */
    function cancelExpiredOracleUpdateProposal(uint256 _proposalId) external onlyAdmin {
        if (!(_proposalId < oracleUpdateCounter)) revert EscrowProposalNotFound();

        OracleUpdateProposal storage proposal = oracleUpdateProposals[_proposalId];
        if (!(proposal.createdAt > 0)) revert EscrowProposalNotInitialized();
        if (!(!proposal.executed)) revert EscrowAlreadyExecuted();
        if (!(!oracleUpdateProposalCancelled[_proposalId])) revert EscrowAlreadyCancelled();
        if (!(block.timestamp > oracleUpdateProposalExpiresAt[_proposalId])) revert EscrowProposalNotExpired();

        oracleUpdateProposalCancelled[_proposalId] = true;

        emit OracleUpdateProposalExpiredCancelled(_proposalId, msg.sender);
    }

    function proposeAdminChange(AdminChangeKind kind, address currentAdmin, address newAdmin, uint256 newThreshold)
        external
        onlyAdmin
        returns (uint256)
    {
        _validateAdminChange(kind, currentAdmin, newAdmin, newThreshold);

        uint256 proposalId = adminChangeCounter++;
        uint256 eta = block.timestamp + governanceTimelock;
        adminChangeProposals[proposalId] = AdminChangeProposal({
            kind: kind,
            currentAdmin: currentAdmin,
            newAdmin: newAdmin,
            newThreshold: newThreshold,
            approvalCount: 1,
            executed: false,
            createdAt: block.timestamp,
            eta: eta,
            proposer: msg.sender,
            epoch: governanceEpoch
        });
        adminChangeHasApproved[proposalId][msg.sender] = true;
        adminChangeProposalExpiresAt[proposalId] = block.timestamp + GOVERNANCE_PROPOSAL_TTL;

        emit AdminChangeProposed(
            proposalId, msg.sender, kind, currentAdmin, newAdmin, newThreshold, eta, governanceEpoch
        );
        emit AdminChangeApproved(proposalId, msg.sender, 1, governanceApprovals());
        return proposalId;
    }

    function approveAdminChange(uint256 proposalId) external onlyAdmin {
        AdminChangeProposal storage proposal = _activeAdminChange(proposalId);
        if (adminChangeHasApproved[proposalId][msg.sender]) revert EscrowAlreadyApproved();
        adminChangeHasApproved[proposalId][msg.sender] = true;
        proposal.approvalCount++;
        emit AdminChangeApproved(proposalId, msg.sender, proposal.approvalCount, governanceApprovals());
    }

    function executeAdminChange(uint256 proposalId) external onlyAdmin {
        AdminChangeProposal storage proposal = _activeAdminChange(proposalId);
        if (proposal.approvalCount < governanceApprovals()) revert EscrowNotEnoughApprovals();
        if (block.timestamp < proposal.eta) revert EscrowTimelockNotElapsed();
        _validateAdminChange(proposal.kind, proposal.currentAdmin, proposal.newAdmin, proposal.newThreshold);
        proposal.executed = true;

        if (proposal.kind == AdminChangeKind.ADD) {
            admins.push(proposal.newAdmin);
            isAdmin[proposal.newAdmin] = true;
            emit AdminAdded(proposal.newAdmin);
        } else if (proposal.kind == AdminChangeKind.REMOVE) {
            _removeAdmin(proposal.currentAdmin);
            emit AdminRemoved(proposal.currentAdmin);
        } else if (proposal.kind == AdminChangeKind.REPLACE) {
            _replaceAdmin(proposal.currentAdmin, proposal.newAdmin);
            emit AdminReplaced(proposal.currentAdmin, proposal.newAdmin);
        } else if (proposal.kind == AdminChangeKind.THRESHOLD) {
            uint256 oldThreshold = requiredApprovals;
            requiredApprovals = proposal.newThreshold;
            emit RequiredApprovalsUpdated(oldThreshold, proposal.newThreshold);
        } else {
            bool allowed = proposal.kind == AdminChangeKind.RELAYER_ADD;
            address relayer = allowed ? proposal.newAdmin : proposal.currentAdmin;
            isRelayer[relayer] = allowed;
            emit RelayerUpdated(relayer, allowed, msg.sender);
        }
        _advanceGovernanceEpoch();
    }

    function cancelAdminChangeProposal(uint256 proposalId) external onlyAdmin {
        AdminChangeProposal storage proposal = adminChangeProposals[proposalId];
        if (proposal.createdAt == 0) revert EscrowProposalNotInitialized();
        if (proposal.executed) revert EscrowAlreadyExecuted();
        if (adminChangeProposalCancelled[proposalId]) revert EscrowAlreadyCancelled();
        if (block.timestamp <= adminChangeProposalExpiresAt[proposalId]) revert EscrowProposalNotExpired();
        adminChangeProposalCancelled[proposalId] = true;
        emit AdminChangeProposalCancelled(proposalId, msg.sender);
    }

    function _activeAdminChange(uint256 proposalId) internal view returns (AdminChangeProposal storage proposal) {
        if (proposalId >= adminChangeCounter) revert EscrowProposalNotFound();
        proposal = adminChangeProposals[proposalId];
        if (proposal.createdAt == 0) revert EscrowProposalNotInitialized();
        if (proposal.executed) revert EscrowAlreadyExecuted();
        if (adminChangeProposalCancelled[proposalId]) revert EscrowProposalCancelled();
        if (block.timestamp > adminChangeProposalExpiresAt[proposalId]) revert EscrowProposalExpired();
        if (proposal.epoch != governanceEpoch) revert EscrowStaleGovernanceProposal();
    }

    function _validateAdminChange(AdminChangeKind kind, address currentAdmin, address newAdmin, uint256 newThreshold)
        internal
        view
    {
        if (kind == AdminChangeKind.ADD || kind == AdminChangeKind.REPLACE) {
            if (newAdmin == address(0)) revert EscrowInvalidAdmin();
            if (isAdmin[newAdmin]) revert EscrowAlreadyAdmin();
            _requireServiceRoleAvailable(newAdmin);
        }
        if (kind == AdminChangeKind.ADD && admins.length >= MAX_ADMINS) revert EscrowMaximumAdminsReached();
        if (kind == AdminChangeKind.REMOVE || kind == AdminChangeKind.REPLACE) {
            if (!isAdmin[currentAdmin]) revert EscrowInvalidAdmin();
        }
        if (kind == AdminChangeKind.REMOVE && admins.length - 1 <= requiredApprovals) {
            revert EscrowNotEnoughAdmins();
        }
        if (kind == AdminChangeKind.THRESHOLD) {
            if (newThreshold < 2 || newThreshold >= admins.length || newThreshold == requiredApprovals) {
                revert EscrowInvalidThreshold();
            }
        } else if (newThreshold != 0) {
            revert EscrowInvalidAdminChange();
        }
        if (kind == AdminChangeKind.RELAYER_ADD) {
            if (newAdmin == address(0)) revert EscrowInvalidRelayer();
            if (isRelayer[newAdmin]) revert EscrowSameRelayer();
            _requireServiceRoleAvailable(newAdmin);
        } else if (kind == AdminChangeKind.RELAYER_REMOVE) {
            if (!isRelayer[currentAdmin]) revert EscrowInvalidRelayer();
        }
    }

    function _removeAdmin(address oldAdmin) internal {
        isAdmin[oldAdmin] = false;
        unpauseHasApproved[oldAdmin] = false;
        uint256 length = admins.length;
        for (uint256 i = 0; i < length; i++) {
            if (admins[i] == oldAdmin) {
                admins[i] = admins[length - 1];
                admins.pop();
                return;
            }
        }
        revert EscrowInvalidAdmin();
    }

    function _replaceAdmin(address oldAdmin, address newAdmin) internal {
        uint256 length = admins.length;
        for (uint256 i = 0; i < length; i++) {
            if (admins[i] == oldAdmin) {
                admins[i] = newAdmin;
                isAdmin[oldAdmin] = false;
                isAdmin[newAdmin] = true;
                unpauseHasApproved[oldAdmin] = false;
                unpauseHasApproved[newAdmin] = false;
                return;
            }
        }
        revert EscrowInvalidAdmin();
    }

    function _requireServiceRoleAvailable(address account) internal view {
        if (
            account == oracleAddress || account == treasuryAddress || account == treasuryPayoutAddress
                || isAdmin[account] || isRelayer[account]
        ) revert EscrowInvalidRoleSeparation();
    }

    function _advanceGovernanceEpoch() internal {
        governanceEpoch++;
        emit GovernanceEpochAdvanced(governanceEpoch);
    }

    function proposeTreasuryPayoutAddressUpdate(address _newPayoutReceiver) external onlyAdmin returns (uint256) {
        if (!(_newPayoutReceiver != address(0))) revert EscrowInvalidTreasuryPayoutReceiver();
        if (!(_newPayoutReceiver != treasuryPayoutAddress)) revert EscrowSameTreasuryPayoutReceiver();
        _requireServiceRoleAvailable(_newPayoutReceiver);
        if (!(admins.length >= governanceApprovals())) revert EscrowInsufficientAdmins();

        uint256 proposalId = treasuryPayoutAddressUpdateCounter;
        treasuryPayoutAddressUpdateCounter++;

        treasuryPayoutAddressUpdateProposals[proposalId] = TreasuryPayoutAddressUpdateProposal({
            newPayoutReceiver: _newPayoutReceiver,
            approvalCount: 1,
            executed: false,
            createdAt: block.timestamp,
            eta: block.timestamp + governanceTimelock,
            proposer: msg.sender,
            epoch: governanceEpoch
        });

        treasuryPayoutAddressUpdateHasApproved[proposalId][msg.sender] = true;
        treasuryPayoutAddressUpdateProposalExpiresAt[proposalId] = block.timestamp + GOVERNANCE_PROPOSAL_TTL;

        emit TreasuryPayoutAddressUpdateProposed(
            proposalId, msg.sender, _newPayoutReceiver, block.timestamp + governanceTimelock
        );
        emit TreasuryPayoutAddressUpdateApproved(proposalId, msg.sender, 1, governanceApprovals());

        return proposalId;
    }

    function approveTreasuryPayoutAddressUpdate(uint256 _proposalId) external onlyAdmin {
        if (!(_proposalId < treasuryPayoutAddressUpdateCounter)) revert EscrowProposalNotFound();

        TreasuryPayoutAddressUpdateProposal storage proposal = treasuryPayoutAddressUpdateProposals[_proposalId];
        if (!(proposal.createdAt > 0)) revert EscrowProposalNotInitialized();
        if (!(!proposal.executed)) revert EscrowAlreadyExecuted();
        if (!(!treasuryPayoutAddressUpdateProposalCancelled[_proposalId])) revert EscrowProposalCancelled();
        if (!(block.timestamp <= treasuryPayoutAddressUpdateProposalExpiresAt[_proposalId])) {
            revert EscrowProposalExpired();
        }
        if (proposal.epoch != governanceEpoch) revert EscrowStaleGovernanceProposal();
        if (!(!treasuryPayoutAddressUpdateHasApproved[_proposalId][msg.sender])) revert EscrowAlreadyApproved();

        treasuryPayoutAddressUpdateHasApproved[_proposalId][msg.sender] = true;
        proposal.approvalCount++;

        emit TreasuryPayoutAddressUpdateApproved(_proposalId, msg.sender, proposal.approvalCount, governanceApprovals());
    }

    function executeTreasuryPayoutAddressUpdate(uint256 _proposalId) external onlyAdmin {
        if (!(_proposalId < treasuryPayoutAddressUpdateCounter)) revert EscrowProposalNotFound();

        TreasuryPayoutAddressUpdateProposal storage proposal = treasuryPayoutAddressUpdateProposals[_proposalId];
        if (!(proposal.createdAt > 0)) revert EscrowProposalNotInitialized();
        if (!(!proposal.executed)) revert EscrowAlreadyExecuted();
        if (!(!treasuryPayoutAddressUpdateProposalCancelled[_proposalId])) revert EscrowProposalCancelled();
        if (!(block.timestamp <= treasuryPayoutAddressUpdateProposalExpiresAt[_proposalId])) {
            revert EscrowProposalExpired();
        }
        if (proposal.epoch != governanceEpoch) revert EscrowStaleGovernanceProposal();
        if (!(proposal.approvalCount >= governanceApprovals())) revert EscrowNotEnoughApprovals();
        if (!(block.timestamp >= proposal.eta)) revert EscrowTimelockNotElapsed();
        if (!(proposal.newPayoutReceiver != address(0))) revert EscrowInvalidTreasuryPayoutReceiver();

        proposal.executed = true;

        address oldPayoutReceiver = treasuryPayoutAddress;
        treasuryPayoutAddress = proposal.newPayoutReceiver;
        _advanceGovernanceEpoch();

        emit TreasuryPayoutAddressUpdated(oldPayoutReceiver, proposal.newPayoutReceiver);
    }

    /**
     * @notice Cancels an expired treasury-payout-address update proposal.
     */
    function cancelExpiredTreasuryPayoutAddressUpdateProposal(uint256 _proposalId) external onlyAdmin {
        if (!(_proposalId < treasuryPayoutAddressUpdateCounter)) revert EscrowProposalNotFound();

        TreasuryPayoutAddressUpdateProposal storage proposal = treasuryPayoutAddressUpdateProposals[_proposalId];
        if (!(proposal.createdAt > 0)) revert EscrowProposalNotInitialized();
        if (!(!proposal.executed)) revert EscrowAlreadyExecuted();
        if (!(!treasuryPayoutAddressUpdateProposalCancelled[_proposalId])) revert EscrowAlreadyCancelled();
        if (!(block.timestamp > treasuryPayoutAddressUpdateProposalExpiresAt[_proposalId])) {
            revert EscrowProposalNotExpired();
        }

        treasuryPayoutAddressUpdateProposalCancelled[_proposalId] = true;

        emit TreasuryPayoutAddressUpdateProposalExpiredCancelled(_proposalId, msg.sender);
    }

    // -----------------------------
    // View helpers
    // -----------------------------
    function getNextTradeId() external view returns (uint256) {
        return tradeCounter;
    }
}
