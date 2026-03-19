import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, IntColumn as IntColumn_, BooleanColumn as BooleanColumn_, DateTimeColumn as DateTimeColumn_, BigIntColumn as BigIntColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {AdminEvent} from "./adminEvent.model"

@Entity_()
export class AdminAddProposal {
    constructor(props?: Partial<AdminAddProposal>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @StringColumn_({nullable: false})
    proposalId!: string

    @Index_()
    @StringColumn_({nullable: false})
    newAdmin!: string

    @IntColumn_({nullable: false})
    approvalCount!: number

    @Index_()
    @BooleanColumn_({nullable: false})
    executed!: boolean

    @Index_()
    @DateTimeColumn_({nullable: false})
    createdAt!: Date

    @BigIntColumn_({nullable: false})
    eta!: bigint

    @Index_()
    @StringColumn_({nullable: false})
    proposer!: string

    @DateTimeColumn_({nullable: true})
    expiresAt!: Date | undefined | null

    @Index_()
    @BooleanColumn_({nullable: false})
    cancelled!: boolean

    @OneToMany_(() => AdminEvent, e => e.adminAddProposal)
    events!: AdminEvent[]
}
