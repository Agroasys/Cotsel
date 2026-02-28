import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, StringColumn as StringColumn_, IntColumn as IntColumn_, DateTimeColumn as DateTimeColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"
import {Trade} from "./trade.model"
import {DisputeStatus} from "./_disputeStatus"
import {ClaimType} from "./_claimType"

@Entity_()
export class TradeEvent {
    constructor(props?: Partial<TradeEvent>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => Trade, {nullable: true})
    trade!: Trade

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

    @BigIntColumn_({nullable: true})
    totalAmount!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    logisticsAmount!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    platformFeesAmount!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    supplierFirstTranche!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    supplierSecondTranche!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    releasedFirstTranche!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    releasedLogisticsAmount!: bigint | undefined | null

    @StringColumn_({nullable: true})
    treasuryAddress!: string | undefined | null

    @BigIntColumn_({nullable: true})
    paidPlatformFees!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    arrivalTimestamp!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    finalTranche!: bigint | undefined | null

    @StringColumn_({nullable: true})
    finalRecipient!: string | undefined | null

    @BigIntColumn_({nullable: true})
    refundedAmount!: bigint | undefined | null

    @StringColumn_({nullable: true})
    refundedTo!: string | undefined | null

    @BigIntColumn_({nullable: true})
    refundedBuyerPrincipal!: bigint | undefined | null

    @StringColumn_({nullable: true})
    payoutRecipient!: string | undefined | null

    @BigIntColumn_({nullable: true})
    payoutAmount!: bigint | undefined | null

    @Column_("varchar", {length: 7, nullable: true})
    payoutType!: DisputeStatus | undefined | null

    @StringColumn_({nullable: true})
    relatedProposalId!: string | undefined | null

    @Column_("varchar", {length: 31, nullable: true})
    claimType!: ClaimType | undefined | null

    @StringColumn_({nullable: true})
    claimRecipient!: string | undefined | null

    @BigIntColumn_({nullable: true})
    claimAmount!: bigint | undefined | null
}
