import {Entity as Entity_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, IntColumn as IntColumn_, DateTimeColumn as DateTimeColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"

@Entity_()
export class SystemEvent {
    constructor(props?: Partial<SystemEvent>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

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
    triggeredBy!: string | undefined | null

    @BigIntColumn_({nullable: true})
    claimAmount!: bigint | undefined | null

    @Index_()
    @StringColumn_({nullable: true})
    proposalId!: string | undefined | null

    @StringColumn_({nullable: true})
    treasuryIdentity!: string | undefined | null

    @Index_()
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
}
