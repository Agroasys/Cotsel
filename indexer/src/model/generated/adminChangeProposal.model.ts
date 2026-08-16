import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, IntColumn as IntColumn_, BigIntColumn as BigIntColumn_, BooleanColumn as BooleanColumn_, DateTimeColumn as DateTimeColumn_, OneToMany as OneToMany_, Relation as Relation_} from "@subsquid/typeorm-store"
import {AdminEvent} from "./adminEvent.model"

@Entity_()
export class AdminChangeProposal {
    constructor(props?: Partial<AdminChangeProposal>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_("idx_admin_change_proposal_proposal_id_2ff7f6e3")
    @StringColumn_({nullable: false})
    proposalId!: string

    @Index_("idx_admin_change_proposal_kind_c17f9b30")
    @IntColumn_({nullable: false})
    kind!: number

    @StringColumn_({nullable: true})
    currentAdmin!: string | undefined | null

    @StringColumn_({nullable: true})
    newAdmin!: string | undefined | null

    @BigIntColumn_({nullable: false})
    newThreshold!: bigint

    @IntColumn_({nullable: false})
    approvalCount!: number

    @Index_("idx_admin_change_proposal_executed_f6710410")
    @BooleanColumn_({nullable: false})
    executed!: boolean

    @Index_("idx_admin_change_proposal_created_at_cc137277")
    @DateTimeColumn_({nullable: false})
    createdAt!: Date

    @BigIntColumn_({nullable: false})
    eta!: bigint

    @Index_("idx_admin_change_proposal_proposer_04d5efe7")
    @StringColumn_({nullable: false})
    proposer!: string

    @BigIntColumn_({nullable: false})
    epoch!: bigint

    @DateTimeColumn_({nullable: true})
    expiresAt!: Date | undefined | null

    @Index_("idx_admin_change_proposal_cancelled_8bd2b7d8")
    @BooleanColumn_({nullable: false})
    cancelled!: boolean

    @OneToMany_(() => AdminEvent, e => e.adminChangeProposal)
    events!: Relation_<AdminEvent[]>
}
