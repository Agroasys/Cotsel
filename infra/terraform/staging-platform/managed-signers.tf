locals {
  human_governance_signer_roles = toset([
    "admin-1",
    "admin-2",
    "admin-3",
  ])

  approved_automated_signer_roles = toset([
    "oracle",
    "relayer",
  ])

  managed_signer_roles = toset([
    "oracle",
    "relayer",
  ])
}

check "only_approved_automated_signers_are_kms_managed" {
  assert {
    condition     = setequals(local.managed_signer_roles, local.approved_automated_signer_roles)
    error_message = "Only the Oracle and gasless relayer have approved automated signing needs and may be provisioned as AWS KMS keys."
  }
}

check "admin_prefixed_signers_are_not_kms_managed" {
  assert {
    condition     = alltrue([for role in local.managed_signer_roles : !startswith(role, "admin-")])
    error_message = "Human administrator signers must use independent hardware wallets and must not be provisioned as AWS KMS keys."
  }
}

data "aws_iam_policy_document" "managed_signer_key" {
  for_each = local.managed_signer_roles

  statement {
    sid    = "AccountAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${var.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }
}

resource "aws_kms_key" "managed_signer" {
  for_each = local.managed_signer_roles

  description                        = "Cotsel ${var.environment} ${each.key} EVM signer"
  customer_master_key_spec           = "ECC_SECG_P256K1"
  key_usage                          = "SIGN_VERIFY"
  deletion_window_in_days            = 30
  bypass_policy_lockout_safety_check = false
  policy                             = data.aws_iam_policy_document.managed_signer_key[each.key].json

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Custody     = "aws-kms"
    SignerRole  = each.key
    Exportable  = "false"
    WorkPackage = "WP-1-WP-2"
  }
}

resource "aws_kms_alias" "managed_signer" {
  for_each = local.managed_signer_roles

  name          = "alias/${local.name_prefix}-${each.key}-signer"
  target_key_id = aws_kms_key.managed_signer[each.key].key_id
}
