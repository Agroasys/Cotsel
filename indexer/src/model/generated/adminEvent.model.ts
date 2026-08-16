import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, Relation as Relation_, StringColumn as StringColumn_, IntColumn as IntColumn_, DateTimeColumn as DateTimeColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"
import {AdminChangeProposal} from "./adminChangeProposal.model"

@Entity_()
export class AdminEvent {
    constructor(props?: Partial<AdminEvent>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_("idx_admin_event_admin_change_proposal_e3e3697f")
    @ManyToOne_(() => AdminChangeProposal, {nullable: true})
    adminChangeProposal!: Relation_<AdminChangeProposal> | undefined | null

    @Index_("idx_admin_event_event_name_d4832d89")
    @StringColumn_({nullable: false})
    eventName!: string

    @Index_("idx_admin_event_block_number_e0a95fef")
    @IntColumn_({nullable: false})
    blockNumber!: number

    @Index_("idx_admin_event_timestamp_a5192938")
    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @Index_("idx_admin_event_tx_hash_01c4fc8c")
    @StringColumn_({nullable: false})
    txHash!: string

    @Index_("idx_admin_event_log_index_cb53ad37")
    @IntColumn_({nullable: false})
    logIndex!: number

    @Index_("idx_admin_event_transaction_index_d461babc")
    @IntColumn_({nullable: false})
    transactionIndex!: number

    @IntColumn_({nullable: true})
    adminChangeKind!: number | undefined | null

    @StringColumn_({nullable: true})
    currentAdmin!: string | undefined | null

    @StringColumn_({nullable: true})
    newAdmin!: string | undefined | null

    @BigIntColumn_({nullable: true})
    newThreshold!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    governanceEpoch!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    eta!: bigint | undefined | null

    @StringColumn_({nullable: true})
    proposer!: string | undefined | null

    @StringColumn_({nullable: true})
    approver!: string | undefined | null

    @IntColumn_({nullable: true})
    approvalCount!: number | undefined | null

    @IntColumn_({nullable: true})
    requiredApprovals!: number | undefined | null

    @StringColumn_({nullable: true})
    addedAdmin!: string | undefined | null

    @StringColumn_({nullable: true})
    removedAdmin!: string | undefined | null

    @StringColumn_({nullable: true})
    oldAdmin!: string | undefined | null

    @StringColumn_({nullable: true})
    replacementAdmin!: string | undefined | null

    @StringColumn_({nullable: true})
    cancelledBy!: string | undefined | null
}
