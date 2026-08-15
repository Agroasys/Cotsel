import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, ManyToOne as ManyToOne_, Relation as Relation_, IntColumn as IntColumn_, BooleanColumn as BooleanColumn_, DateTimeColumn as DateTimeColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {Trade} from "./trade.model"
import {DisputeStatus} from "./_disputeStatus"
import {DisputeEvent} from "./disputeEvent.model"

@Entity_()
export class DisputeProposal {
    constructor(props?: Partial<DisputeProposal>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_("idx_dispute_proposal_proposal_id_e74c4594")
    @StringColumn_({nullable: false})
    proposalId!: string

    @Index_("idx_dispute_proposal_trade_16d9e52d")
    @ManyToOne_(() => Trade, {nullable: true})
    trade!: Relation_<Trade>

    @Index_("idx_dispute_proposal_dispute_status_2630e633")
    @Column_("varchar", {length: 7, nullable: false})
    disputeStatus!: DisputeStatus

    @IntColumn_({nullable: false})
    approvalCount!: number

    @Index_("idx_dispute_proposal_executed_8525f83b")
    @BooleanColumn_({nullable: false})
    executed!: boolean

    @Index_("idx_dispute_proposal_created_at_d96446fa")
    @DateTimeColumn_({nullable: false})
    createdAt!: Date

    @Index_("idx_dispute_proposal_proposer_a258daee")
    @StringColumn_({nullable: false})
    proposer!: string

    @DateTimeColumn_({nullable: true})
    expiresAt!: Date | undefined | null

    @Index_("idx_dispute_proposal_cancelled_d99ab56c")
    @BooleanColumn_({nullable: false})
    cancelled!: boolean

    @OneToMany_(() => DisputeEvent, e => e.dispute)
    events!: Relation_<DisputeEvent[]>
}
