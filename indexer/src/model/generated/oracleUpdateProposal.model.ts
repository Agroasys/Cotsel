import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, IntColumn as IntColumn_, BooleanColumn as BooleanColumn_, DateTimeColumn as DateTimeColumn_, BigIntColumn as BigIntColumn_, OneToMany as OneToMany_, Relation as Relation_} from "@subsquid/typeorm-store"
import {OracleEvent} from "./oracleEvent.model"

@Entity_()
export class OracleUpdateProposal {
    constructor(props?: Partial<OracleUpdateProposal>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_("idx_oracle_update_proposal_proposal_id_a4c5a58d")
    @StringColumn_({nullable: false})
    proposalId!: string

    @Index_("idx_oracle_update_proposal_new_oracle_7daad2be")
    @StringColumn_({nullable: false})
    newOracle!: string

    @IntColumn_({nullable: false})
    approvalCount!: number

    @Index_("idx_oracle_update_proposal_executed_e995a1e1")
    @BooleanColumn_({nullable: false})
    executed!: boolean

    @Index_("idx_oracle_update_proposal_created_at_ef34e33a")
    @DateTimeColumn_({nullable: false})
    createdAt!: Date

    @BigIntColumn_({nullable: false})
    eta!: bigint

    @Index_("idx_oracle_update_proposal_proposer_e1021ce1")
    @StringColumn_({nullable: false})
    proposer!: string

    @BooleanColumn_({nullable: true})
    emergencyFastTrack!: boolean | undefined | null

    @DateTimeColumn_({nullable: true})
    expiresAt!: Date | undefined | null

    @Index_("idx_oracle_update_proposal_cancelled_b141d19d")
    @BooleanColumn_({nullable: false})
    cancelled!: boolean

    @OneToMany_(() => OracleEvent, e => e.oracleUpdate)
    events!: Relation_<OracleEvent[]>
}
