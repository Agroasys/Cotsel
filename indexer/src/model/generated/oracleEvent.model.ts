import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, Relation as Relation_, StringColumn as StringColumn_, IntColumn as IntColumn_, DateTimeColumn as DateTimeColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"
import {OracleUpdateProposal} from "./oracleUpdateProposal.model"

@Entity_()
export class OracleEvent {
    constructor(props?: Partial<OracleEvent>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_("idx_oracle_event_oracle_update_acb2c06d")
    @ManyToOne_(() => OracleUpdateProposal, {nullable: true})
    oracleUpdate!: Relation_<OracleUpdateProposal> | undefined | null

    @Index_("idx_oracle_event_event_name_66cd5669")
    @StringColumn_({nullable: false})
    eventName!: string

    @Index_("idx_oracle_event_block_number_4bdd2c01")
    @IntColumn_({nullable: false})
    blockNumber!: number

    @Index_("idx_oracle_event_timestamp_7eebae27")
    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @Index_("idx_oracle_event_tx_hash_170d28bd")
    @StringColumn_({nullable: false})
    txHash!: string

    @Index_("idx_oracle_event_log_index_5a7e5b92")
    @IntColumn_({nullable: false})
    logIndex!: number

    @Index_("idx_oracle_event_transaction_index_74b17c2d")
    @IntColumn_({nullable: false})
    transactionIndex!: number

    @StringColumn_({nullable: true})
    proposedOracle!: string | undefined | null

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
    oldOracle!: string | undefined | null

    @StringColumn_({nullable: true})
    newOracle!: string | undefined | null

    @StringColumn_({nullable: true})
    cancelledBy!: string | undefined | null

    @StringColumn_({nullable: true})
    disabledBy!: string | undefined | null

    @StringColumn_({nullable: true})
    previousOracle!: string | undefined | null
}
