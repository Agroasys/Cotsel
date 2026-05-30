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

    @Index_()
    @StringColumn_({nullable: false})
    proposalId!: string

    @Index_()
    @ManyToOne_(() => Trade, {nullable: true})
    trade!: Relation_<Trade>

    @Index_()
    @Column_("varchar", {length: 7, nullable: false})
    disputeStatus!: DisputeStatus

    @IntColumn_({nullable: false})
    approvalCount!: number

    @Index_()
    @BooleanColumn_({nullable: false})
    executed!: boolean

    @Index_()
    @DateTimeColumn_({nullable: false})
    createdAt!: Date

    @Index_()
    @StringColumn_({nullable: false})
    proposer!: string

    @DateTimeColumn_({nullable: true})
    expiresAt!: Date | undefined | null

    @Index_()
    @BooleanColumn_({nullable: false})
    cancelled!: boolean

    @OneToMany_(() => DisputeEvent, e => e.dispute)
    events!: Relation_<DisputeEvent[]>
}
