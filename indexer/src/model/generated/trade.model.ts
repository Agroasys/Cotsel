import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, BigIntColumn as BigIntColumn_, DateTimeColumn as DateTimeColumn_, BooleanColumn as BooleanColumn_, OneToMany as OneToMany_, Relation as Relation_} from "@subsquid/typeorm-store"
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

    @Index_("idx_trade_trade_id_fa202df3")
    @StringColumn_({nullable: false})
    tradeId!: string

    @Index_("idx_trade_buyer_aae3567b")
    @StringColumn_({nullable: false})
    buyer!: string

    @Index_("idx_trade_supplier_1f1b70c1")
    @StringColumn_({nullable: false})
    supplier!: string

    @Index_("idx_trade_status_f6afdbf4")
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

    @Index_("idx_trade_created_at_6cf33da0")
    @DateTimeColumn_({nullable: false})
    createdAt!: Date

    @DateTimeColumn_({nullable: true})
    arrivalTimestamp!: Date | undefined | null

    @Index_("idx_trade_paused_e9985100")
    @BooleanColumn_({nullable: false})
    paused!: boolean

    @OneToMany_(() => TradeEvent, e => e.trade)
    events!: Relation_<TradeEvent[]>

    @OneToMany_(() => DisputeProposal, e => e.trade)
    disputes!: Relation_<DisputeProposal[]>
}
