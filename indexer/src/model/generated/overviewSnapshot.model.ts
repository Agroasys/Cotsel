import {Entity as Entity_, PrimaryColumn as PrimaryColumn_, IntColumn as IntColumn_, BigIntColumn as BigIntColumn_, DateTimeColumn as DateTimeColumn_} from "@subsquid/typeorm-store"

@Entity_()
export class OverviewSnapshot {
    constructor(props?: Partial<OverviewSnapshot>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @IntColumn_({nullable: false})
    totalTrades!: number

    @IntColumn_({nullable: false})
    lockedTrades!: number

    @IntColumn_({nullable: false})
    stage1Trades!: number

    @IntColumn_({nullable: false})
    stage2Trades!: number

    @IntColumn_({nullable: false})
    completedTrades!: number

    @IntColumn_({nullable: false})
    disputedTrades!: number

    @IntColumn_({nullable: false})
    cancelledTrades!: number

    @BigIntColumn_({nullable: false})
    lastProcessedBlock!: bigint

    @DateTimeColumn_({nullable: false})
    lastIndexedAt!: Date

    @DateTimeColumn_({nullable: true})
    lastTradeEventAt!: Date | undefined | null
}
