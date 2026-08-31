locals {
  name_prefix = "cotsel-${var.environment}"

  services = toset([
    "auth",
    "gateway",
    "indexer-graphql",
    "indexer-pipeline",
    "oracle",
    "reconciliation",
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

  database_secret_names = setunion(
    toset(flatten([
      for owner in local.database_owners : [
        "database/${owner}/migration",
        "database/${owner}/runtime",
      ]
    ])),
    toset(["database/indexer/reader"]),
  )

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
  ])

  secret_names = setunion(local.database_secret_names, local.integration_secret_names)
}
