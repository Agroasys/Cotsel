import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, BigIntColumn as BigIntColumn_, DateTimeColumn as DateTimeColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {TradeStatus} from "./_tradeStatus"
import {TradeEvent} from "./tradeEvent.model"
import {DisputeProposal} from "./disputeProposal.model"

@Entity_()
export class Trade {
    constructor(props?: Partial<Trade>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @StringColumn_({nullable: false})
    tradeId!: string

    @Index_()
    @StringColumn_({nullable: false})
    buyer!: string

    @Index_()
    @StringColumn_({nullable: false})
    supplier!: string

    @Index_()
    @Column_("varchar", {length: 17, nullable: false})
    status!: TradeStatus

    @BigIntColumn_({nullable: false})
    totalAmountLocked!: bigint

    @BigIntColumn_({nullable: false})
    logisticsAmount!: bigint

    @BigIntColumn_({nullable: false})
    platformFeesAmount!: bigint

    @BigIntColumn_({nullable: false})
    platformFeeNetAmount!: bigint

    @BigIntColumn_({nullable: false})
    settlementSupportFeeAmount!: bigint

    @BigIntColumn_({nullable: false})
    supplierFirstTranche!: bigint

    @BigIntColumn_({nullable: false})
    supplierSecondTranche!: bigint

    @StringColumn_({nullable: false})
    ricardianHash!: string

    @Index_()
    @DateTimeColumn_({nullable: false})
    createdAt!: Date

    @DateTimeColumn_({nullable: true})
    arrivalTimestamp!: Date | undefined | null

    @OneToMany_(() => TradeEvent, e => e.trade)
    events!: TradeEvent[]

    @OneToMany_(() => DisputeProposal, e => e.trade)
    disputes!: DisputeProposal[]
}
