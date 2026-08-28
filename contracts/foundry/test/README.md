# Foundry escrow test layout

`AgroasysEscrowFuzz.t.sol` is the aggregate fuzz-test entry point. It preserves
the `FuzzTest` contract name consumed by Forge and CI.

The aggregate inherits three behavior modules over one fixture:

- `AgroasysEscrowFuzzBase.sol` owns deployment, identities, signing, and trade
  creation helpers.
- `AgroasysEscrowFlowFuzz.sol` owns successful and disputed settlement flows.
- `AgroasysEscrowValidationFuzz.sol` owns timing, authorization, inspection, and
  governance validation.
- `AgroasysEscrowTimeoutFuzz.sol` owns timeout refunds and Treasury routing.

The modules are abstract so Forge discovers each test only once through
`FuzzTest`. Preserve the aggregate contract name and test-function names when
moving coverage between modules. Run the complete Foundry gate after every
change; a single-module run does not exercise the separate invariant suite.
