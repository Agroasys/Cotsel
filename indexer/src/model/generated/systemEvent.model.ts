import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, IntColumn as IntColumn_, DateTimeColumn as DateTimeColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"

@Entity_()
export class SystemEvent {
    constructor(props?: Partial<SystemEvent>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_("idx_system_event_event_name_2279751f")
    @StringColumn_({nullable: false})
    eventName!: string

    @Index_("idx_system_event_block_number_188d5335")
    @IntColumn_({nullable: false})
    blockNumber!: number

    @Index_("idx_system_event_timestamp_acaabd37")
    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @Index_("idx_system_event_tx_hash_e97457d4")
    @StringColumn_({nullable: false})
    txHash!: string

    @Index_("idx_system_event_log_index_2dcc5631")
    @IntColumn_({nullable: false})
    logIndex!: number

    @Index_("idx_system_event_transaction_index_742ef925")
    @IntColumn_({nullable: false})
    transactionIndex!: number

    @StringColumn_({nullable: true})
    triggeredBy!: string | undefined | null

    @BigIntColumn_({nullable: true})
    claimAmount!: bigint | undefined | null

    @StringColumn_({nullable: true})
    authorizationUser!: string | undefined | null

    @StringColumn_({nullable: true})
    authorizationAction!: string | undefined | null

    @BigIntColumn_({nullable: true})
    authorizationNonce!: bigint | undefined | null

    @StringColumn_({nullable: true})
    authorizationRelayer!: string | undefined | null

    @BigIntColumn_({nullable: true})
    authorizationDeadline!: bigint | undefined | null

    @Index_("idx_system_event_proposal_id_dc20fed9")
    @StringColumn_({nullable: true})
    proposalId!: string | undefined | null

    @StringColumn_({nullable: true})
    treasuryIdentity!: string | undefined | null

    @Index_("idx_system_event_payout_receiver_ba4b2c17")
    @StringColumn_({nullable: true})
    payoutReceiver!: string | undefined | null

    @StringColumn_({nullable: true})
    oldPayoutReceiver!: string | undefined | null

    @StringColumn_({nullable: true})
    newPayoutReceiver!: string | undefined | null

    @IntColumn_({nullable: true})
    approvalCount!: number | undefined | null

    @IntColumn_({nullable: true})
    requiredApprovals!: number | undefined | null

    @BigIntColumn_({nullable: true})
    eta!: bigint | undefined | null

    @IntColumn_({nullable: true})
    pauseScope!: number | undefined | null

    @BigIntColumn_({nullable: true})
    pauseTradeId!: bigint | undefined | null

    @StringColumn_({nullable: true})
    incidentRef!: string | undefined | null

    @BigIntColumn_({nullable: true})
    governanceEpoch!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    oldThreshold!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    newThreshold!: bigint | undefined | null
}
