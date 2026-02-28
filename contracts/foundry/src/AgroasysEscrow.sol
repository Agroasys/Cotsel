// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * AgroasysEscrow
 * - Milestone escrow (Stage 1 + Stage 2)
 * - Arrival confirmation starts a 24h buyer dispute window
 * - Buyer can freeze during window; admins resolve with 4-eyes approval
 * - Treasury ONLY receives explicit fees (logistics + platform fees) at Stage 1; buyer principal never routes to treasury
 * - Signature uses buyer-scoped nonce (no global tradeId pre-query race) + deadline + domain separation
 *
 * Business rule enforced:
 * - Stage 1 accrual (40% milestone) includes: supplierFirstTranche (principal) + logisticsAmount (fee) + platformFeesAmount (fee)
 * - Stage 2 accrual (finalization) includes: supplierSecondTranche (principal) ONLY
 */
contract AgroasysEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -----------------------------
    // Constants
    // -----------------------------
    /// @notice Buyer dispute window after arrival confirmation.
    uint256 public constant DISPUTE_WINDOW = 24 hours;
    /// @notice Maximum time a trade can remain LOCKED before buyer can cancel for full refund.
    uint256 public constant LOCK_TIMEOUT = 7 days;
    /// @notice Maximum time a trade can remain IN_TRANSIT without arrival confirmation before buyer principal refund.
    uint256 public constant IN_TRANSIT_TIMEOUT = 14 days;
    /// @notice Time-to-live for dispute proposals before they must be replaced or cancelled.
    uint256 public constant DISPUTE_PROPOSAL_TTL = 7 days;
    /// @notice Time-to-live for governance proposals (oracle/admin updates).
    uint256 public constant GOVERNANCE_PROPOSAL_TTL = 7 days;

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

    struct Trade {
        uint256 tradeId;
        bytes32 ricardianHash;
        TradeStatus status;
        address buyerAddress;
        address supplierAddress;
        uint256 totalAmountLocked;

        uint256 logisticsAmount;     // paid to treasury at stage1
        uint256 platformFeesAmount;  // paid to treasury at stage1

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
    mapping(address => uint256) public nonces;

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
    address public treasuryAddress;
    /// @notice Global pause flag for normal protocol operations.
    bool public paused;
    /// @notice Emergency switch to disable oracle-triggered transitions.
    bool public oracleActive;

    IERC20 public usdcToken;

    address[] public admins;
    mapping(address => bool) public isAdmin;
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
        uint256 platformFeesAmount
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

    event Paused(address indexed by);
    event Unpaused(address indexed by);
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
    event Claimed(address indexed claimant, uint256 amount);
    event OracleUpdateProposalExpiredCancelled(uint256 indexed proposalId, address indexed cancelledBy);
    event AdminAddProposalExpiredCancelled(uint256 indexed proposalId, address indexed cancelledBy);

    // -----------------------------
    // Constructor / Modifiers
    // -----------------------------
    constructor(
        address _usdcToken,
        address _oracleAddress,
        address _treasuryAddress,
        address[] memory _admins,
        uint256 _requiredApprovals
    ) {
        require(_usdcToken != address(0), "invalid token");
        require(_oracleAddress != address(0), "invalid oracle");
        require(_treasuryAddress != address(0), "invalid treasury");
        require(_requiredApprovals > 0, "required approvals must be > 0");
        require(_admins.length >= _requiredApprovals, "not enough admins");

        usdcToken = IERC20(_usdcToken);
        oracleAddress = _oracleAddress;
        treasuryAddress = _treasuryAddress;
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
    }

    modifier onlyAdmin() {
        require(isAdmin[msg.sender], "only admin");
        _;
    }

    modifier onlyOracle() {
        require(msg.sender == oracleAddress, "only oracle");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    modifier onlyOracleActive() {
        require(oracleActive, "oracle disabled");
        _;
    }

    /**
     * @notice Pauses normal protocol operations for emergency containment.
     */
    function pause() external onlyAdmin {
        require(!paused, "already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Propose unpausing the protocol (requires multi-sig approval).
     */
    function proposeUnpause() external onlyAdmin returns (bool) {
        require(paused, "not paused");
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
        emit UnpauseApproved(msg.sender, 1, requiredApprovals);

        return true;
    }

    /**
     * @notice Approve the unpause proposal.
     */
    function approveUnpause() external onlyAdmin {
        require(paused, "not paused");
        require(hasActiveUnpauseProposal, "no active proposal");
        require(!unpauseProposal.executed, "already executed");
        require(!unpauseHasApproved[msg.sender], "already approved");

        unpauseHasApproved[msg.sender] = true;
        unpauseProposal.approvalCount++;

        emit UnpauseApproved(msg.sender, unpauseProposal.approvalCount, requiredApprovals);

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
        paused = false;
        hasActiveUnpauseProposal = false;

        // Clear approvals
        address[] memory adminList = admins;
        for (uint256 i = 0; i < adminList.length; i++) {
            unpauseHasApproved[adminList[i]] = false;
        }

        emit Unpaused(msg.sender);
    }

    /**
     * @notice Emergency kill switch to disable oracle-triggered transitions and pause protocol.
     */
    function disableOracleEmergency() external onlyAdmin {
        require(oracleActive, "oracle disabled");
        oracleActive = false;
        if (!paused) {
            paused = true;
            emit Paused(msg.sender);
        }
        emit OracleDisabledEmergency(msg.sender, oracleAddress);
    }

    // -----------------------------
    // Signature Verification (buyer nonce + deadline)
    // -----------------------------
    function _verifySignature(
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
        require(block.timestamp <= deadline, "signature expired");

        // Domain separation: chain + contract address
        bytes32 messageHash = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                buyer,
                supplier,
                treasuryAddress,
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

        // EIP-191 personal_sign style
        bytes32 ethSignedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );

        return ECDSA.recover(ethSignedHash, signature);
    }

    // -----------------------------
    // Trade Creation
    // -----------------------------
    function createTrade(
        address _supplier,
        uint256 _totalAmount,
        uint256 _logisticsAmount,
        uint256 _platformFeesAmount,
        uint256 _supplierFirstTranche,
        uint256 _supplierSecondTranche,
        bytes32 _ricardianHash,
        uint256 _buyerNonce,
        uint256 _deadline,
        bytes memory _signature
    ) external whenNotPaused nonReentrant returns (uint256) {
        require(_ricardianHash != bytes32(0), "ricardian hash required");
        require(_supplier != address(0), "supplier required");

        uint256 totalExpected = _logisticsAmount
            + _platformFeesAmount
            + _supplierFirstTranche
            + _supplierSecondTranche;

        require(_totalAmount == totalExpected, "breakdown mismatch");
        require(_supplierFirstTranche > 0 && _supplierSecondTranche > 0, "tranches must be > 0");

        // Nonce must match current buyer nonce
        require(_buyerNonce == nonces[msg.sender], "bad nonce");

        // Verify signature binds all critical fields + nonce + deadline + domain separation
        address signer = _verifySignature(
            msg.sender,
            _supplier,
            _totalAmount,
            _logisticsAmount,
            _platformFeesAmount,
            _supplierFirstTranche,
            _supplierSecondTranche,
            _ricardianHash,
            _buyerNonce,
            _deadline,
            _signature
        );
        require(signer == msg.sender, "bad signature");

        // Effects (increment nonce & create trade id) before external calls
        nonces[msg.sender] = _buyerNonce + 1;
        uint256 newTradeId = tradeCounter;
        tradeCounter++;

        trades[newTradeId] = Trade({
            tradeId: newTradeId,
            ricardianHash: _ricardianHash,
            status: TradeStatus.LOCKED,
            buyerAddress: msg.sender,
            supplierAddress: _supplier,
            totalAmountLocked: _totalAmount,
            logisticsAmount: _logisticsAmount,
            platformFeesAmount: _platformFeesAmount,
            supplierFirstTranche: _supplierFirstTranche,
            supplierSecondTranche: _supplierSecondTranche,
            createdAt: block.timestamp,
            arrivalTimestamp: 0
        });

        // Interactions (transfer funds into escrow)
        usdcToken.safeTransferFrom(msg.sender, address(this), _totalAmount);

        emit TradeLocked(
            newTradeId,
            msg.sender,
            _supplier,
            _totalAmount,
            _logisticsAmount,
            _platformFeesAmount,
            _supplierFirstTranche,
            _supplierSecondTranche,
            _ricardianHash
        );

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

    function claim() external whenNotPaused nonReentrant {
        uint256 amount = claimableUsdc[msg.sender];
        require(amount > 0, "nothing claimable");

        claimableUsdc[msg.sender] = 0;
        totalClaimableUsdc -= amount;
        usdcToken.safeTransfer(msg.sender, amount);

        emit Claimed(msg.sender, amount);
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

        _accrueClaimable(_tradeId, trade.supplierAddress, trade.supplierFirstTranche, ClaimType.STAGE1_SUPPLIER);
        _accrueClaimable(_tradeId, treasuryAddress, trade.logisticsAmount, ClaimType.STAGE1_LOGISTICS_FEE);
        _accrueClaimable(_tradeId, treasuryAddress, trade.platformFeesAmount, ClaimType.STAGE1_PLATFORM_FEE);

        emit FundsReleasedStage1(
            _tradeId,
            trade.supplierAddress,
            trade.supplierFirstTranche,
            treasuryAddress,
            trade.logisticsAmount
        );

        emit PlatformFeesPaidStage1(_tradeId, treasuryAddress, trade.platformFeesAmount);
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
     * Buyer can open a dispute within 24h after arrival confirmation.
     * This freezes remaining funds until admin resolution.
     */
    function openDispute(uint256 _tradeId) external whenNotPaused nonReentrant {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];

        require(trade.buyerAddress == msg.sender, "only buyer");
        require(trade.status == TradeStatus.ARRIVAL_CONFIRMED, "must be ARRIVAL_CONFIRMED");
        require(trade.arrivalTimestamp > 0, "arrival not set");
        require(block.timestamp <= trade.arrivalTimestamp + DISPUTE_WINDOW, "window closed");

        trade.status = TradeStatus.FROZEN;

        emit DisputeOpenedByBuyer(_tradeId);
    }

    /**
     * Final settlement after dispute window if no dispute was opened.
     * Permissionless (anyone can call) to avoid funds getting stuck if oracle is down.
     *
     * Business rule: Stage 2 accrues ONLY remaining supplier principal (supplierSecondTranche).
     * Treasury fees were already collected at Stage 1.
     */
    function finalizeAfterDisputeWindow(uint256 _tradeId) external whenNotPaused nonReentrant {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];

        require(trade.status == TradeStatus.ARRIVAL_CONFIRMED, "must be ARRIVAL_CONFIRMED");
        require(trade.arrivalTimestamp > 0, "arrival not set");
        require(block.timestamp > trade.arrivalTimestamp + DISPUTE_WINDOW, "window not elapsed");

        trade.status = TradeStatus.CLOSED;
        inTransitSince[_tradeId] = 0;

        _accrueClaimable(_tradeId, trade.supplierAddress, trade.supplierSecondTranche, ClaimType.STAGE2_SUPPLIER);

        emit FinalTrancheReleased(_tradeId, trade.supplierAddress, trade.supplierSecondTranche);
    }

    /**
     * @notice Buyer escape hatch: cancel a LOCKED trade after timeout and recover full locked amount.
     */
    function cancelLockedTradeAfterTimeout(uint256 _tradeId) external whenNotPaused nonReentrant {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];

        require(trade.buyerAddress == msg.sender, "only buyer");
        require(trade.status == TradeStatus.LOCKED, "status must be LOCKED");
        require(block.timestamp > trade.createdAt + LOCK_TIMEOUT, "lock timeout not elapsed");

        trade.status = TradeStatus.CLOSED;

        _accrueClaimable(_tradeId, trade.buyerAddress, trade.totalAmountLocked, ClaimType.LOCK_TIMEOUT_BUYER_REFUND);

        emit TradeCancelledAfterLockTimeout(_tradeId, trade.buyerAddress, trade.totalAmountLocked);
    }

    /**
     * @notice Buyer escape hatch: refund only remaining escrowed principal when IN_TRANSIT timeout elapses.
     */
    function refundInTransitAfterTimeout(uint256 _tradeId) external whenNotPaused nonReentrant {
        require(_tradeId < tradeCounter, "trade not found");
        Trade storage trade = trades[_tradeId];

        require(trade.buyerAddress == msg.sender, "only buyer");
        require(trade.status == TradeStatus.IN_TRANSIT, "status must be IN_TRANSIT");

        uint256 transitStart = inTransitSince[_tradeId];
        require(transitStart > 0, "in-transit timestamp not set");
        require(block.timestamp > transitStart + IN_TRANSIT_TIMEOUT, "in-transit timeout not elapsed");

        trade.status = TradeStatus.CLOSED;
        inTransitSince[_tradeId] = 0;

        _accrueClaimable(_tradeId, trade.buyerAddress, trade.supplierSecondTranche, ClaimType.IN_TRANSIT_TIMEOUT_BUYER_REFUND);

        emit InTransitTimeoutRefunded(_tradeId, trade.buyerAddress, trade.supplierSecondTranche);
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

        // auto-execute if requiredApprovals == 1 (rare, but supported)
        if (requiredApprovals == 1) {
            _executeDispute(proposalId);
        }

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
            _accrueClaimable(proposal.tradeId, recipient, payoutAmount, ClaimType.DISPUTE_REFUND_BUYER);
        } else if (proposal.disputeStatus == DisputeStatus.RESOLVE) {
            // Release remaining escrowed principal to supplier (supplierSecondTranche)
            recipient = trade.supplierAddress;
            _accrueClaimable(proposal.tradeId, recipient, payoutAmount, ClaimType.DISPUTE_RESOLVE_SUPPLIER);
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

    // Sensitive operations require at least 2 approvals, even if requiredApprovals == 1.
    function governanceApprovals() public view returns (uint256) {
        return requiredApprovals < 2 ? 2 : requiredApprovals;
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

    // -----------------------------
    // View helpers
    // -----------------------------
    function getNextTradeId() external view returns (uint256) {
        return tradeCounter;
    }

    function getBuyerNonce(address buyer) external view returns (uint256) {
        return nonces[buyer];
    }
}
