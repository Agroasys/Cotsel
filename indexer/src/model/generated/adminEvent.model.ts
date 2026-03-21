import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, StringColumn as StringColumn_, IntColumn as IntColumn_, DateTimeColumn as DateTimeColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"
import {AdminAddProposal} from "./adminAddProposal.model"

@Entity_()
export class AdminEvent {
    constructor(props?: Partial<AdminEvent>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => AdminAddProposal, {nullable: true})
    adminAddProposal!: AdminAddProposal | undefined | null

    @Index_()
    @StringColumn_({nullable: false})
    eventName!: string

    @Index_()
    @IntColumn_({nullable: false})
    blockNumber!: number

    @Index_()
    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @Index_()
    @StringColumn_({nullable: true})
    txHash!: string | undefined | null

    @Index_()
    @StringColumn_({nullable: true})
    extrinsicHash!: string | undefined | null

    @IntColumn_({nullable: false})
    extrinsicIndex!: number

    @StringColumn_({nullable: true})
    proposedAdmin!: string | undefined | null

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
    cancelledBy!: string | undefined | null
}
