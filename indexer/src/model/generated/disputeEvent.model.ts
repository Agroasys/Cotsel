import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, Relation as Relation_, StringColumn as StringColumn_, IntColumn as IntColumn_, DateTimeColumn as DateTimeColumn_} from "@subsquid/typeorm-store"
import {DisputeProposal} from "./disputeProposal.model"
import {DisputeStatus} from "./_disputeStatus"

@Entity_()
export class DisputeEvent {
    constructor(props?: Partial<DisputeEvent>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_("idx_dispute_event_dispute_51561e78")
    @ManyToOne_(() => DisputeProposal, {nullable: true})
    dispute!: Relation_<DisputeProposal>

    @Index_("idx_dispute_event_event_name_5647f7a0")
    @StringColumn_({nullable: false})
    eventName!: string

    @Index_("idx_dispute_event_block_number_eafe21bc")
    @IntColumn_({nullable: false})
    blockNumber!: number

    @Index_("idx_dispute_event_timestamp_766954f2")
    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @Index_("idx_dispute_event_tx_hash_435c2a5f")
    @StringColumn_({nullable: false})
    txHash!: string

    @Index_("idx_dispute_event_log_index_0f874e5c")
    @IntColumn_({nullable: false})
    logIndex!: number

    @Index_("idx_dispute_event_transaction_index_167c7794")
    @IntColumn_({nullable: false})
    transactionIndex!: number

    @Column_("varchar", {length: 7, nullable: true})
    proposedDisputeStatus!: DisputeStatus | undefined | null

    @StringColumn_({nullable: true})
    proposer!: string | undefined | null

    @StringColumn_({nullable: true})
    approver!: string | undefined | null

    @IntColumn_({nullable: true})
    approvalCount!: number | undefined | null

    @IntColumn_({nullable: true})
    requiredApprovals!: number | undefined | null

    @Column_("varchar", {length: 7, nullable: true})
    finalDisputeStatus!: DisputeStatus | undefined | null

    @StringColumn_({nullable: true})
    cancelledBy!: string | undefined | null
}
