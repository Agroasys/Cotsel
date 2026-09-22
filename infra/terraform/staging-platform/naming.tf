locals {
  name_prefix = "cotsel-${var.environment}"

  services = toset([
    "auth",
    "gateway",
    "indexer-graphql",
    "indexer-pipeline",
    "oracle",
    "reconciliation",
    "relayer",
    "ricardian",
    "treasury",
  ])

  database_owners = toset([
    "auth",
    "gateway",
    "indexer",
    "oracle",
    "reconciliation",
    "ricardian",
    "treasury",
  ])

  database_reader_owners = toset([
    # Reader identities are foundation prerequisites because migration and
    # isolated runtimes both depend on them.
  ])

  database_secret_names = toset(concat(
    flatten([
      for owner in local.database_owners : [
        "database/${owner}/migration",
        "database/${owner}/runtime",
      ]
    ]),
    [for owner in local.database_reader_owners : "database/${owner}/reader"],
  ))

  integration_secret_names = toset([
    "auth-upstream-exchange",
    "gateway-settlement-callback",
    "gateway-settlement-ingress",
    "gateway-to-oracle-auth",
    "gateway-to-ricardian-auth",
    "gateway-to-treasury-auth",
    "gateway-managed-signer",
    "oracle-managed-signer",
    "rpc-base-sepolia-fallback",
    "rpc-base-sepolia-primary",
    "treasury-provider-callback",
  ])

  secret_names = setunion(local.database_secret_names, local.integration_secret_names)

  foundation_secret_arns = data.terraform_remote_state.foundation.outputs.runtime_prerequisite_secret_arns
}
