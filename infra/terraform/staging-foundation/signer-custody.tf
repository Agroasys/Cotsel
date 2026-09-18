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

  managed_signer_roles = local.approved_automated_signer_roles
}

data "aws_partition" "current" {}

check "only_approved_automated_signers_are_kms_managed" {
  assert {
    condition     = local.managed_signer_roles == local.approved_automated_signer_roles
    error_message = "Only the Oracle and gasless relayer have approved automated signing needs and may be provisioned as AWS KMS keys."
  }
}

check "admin_prefixed_signers_are_not_kms_managed" {
  assert {
    condition     = alltrue([for role in local.managed_signer_roles : !startswith(role, "admin-")])
    error_message = "Human administrator signers must use independent hardware wallets and must not be provisioned as AWS KMS keys."
  }
}

data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    sid     = "AllowEcsTasksAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_iam_role" "managed_signer_task" {
  for_each = local.managed_signer_roles

  name                 = "cotsel-${var.environment}-${each.key}-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  permissions_boundary = var.service_role_permissions_boundary_arn

  tags = {
    Custody     = "aws-kms"
    Service     = each.key
    SignerRole  = each.key
    WorkPackage = "WP-1-WP-2"
  }

  lifecycle {
    prevent_destroy = true
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

  statement {
    sid    = "DenyUnapprovedSigningPrincipal"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["kms:Sign"]
    resources = ["*"]

    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.managed_signer_task[each.key].arn]
    }
  }

  statement {
    sid    = "DenyNonDigestSigning"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["kms:Sign"]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "kms:MessageType"
      values   = ["DIGEST"]
    }
  }

  statement {
    sid    = "DenyUnexpectedSigningAlgorithm"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["kms:Sign"]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "kms:SigningAlgorithm"
      values   = ["ECDSA_SHA_256"]
    }
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
    Exportable  = "false"
    SignerRole  = each.key
    WorkPackage = "WP-1-WP-2"
  }
}

resource "aws_kms_alias" "managed_signer" {
  for_each = local.managed_signer_roles

  name          = "alias/cotsel-${var.environment}-${each.key}-signer"
  target_key_id = aws_kms_key.managed_signer[each.key].key_id

  lifecycle {
    prevent_destroy = true
  }
}
