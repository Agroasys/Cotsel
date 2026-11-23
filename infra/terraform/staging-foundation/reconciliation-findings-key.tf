# Reconciliation evidence signing (Cotsel#951).
#
# One ECDSA P-256 key seals each completed reconciliation run's manifest. It is
# not an automated chain signer: it signs evidence digests and cannot move
# funds, so it is deliberately outside approved_automated_signer_roles. Only the
# reconciliation task role may sign with it, and only SHA-256 digests. Retired
# runs stay verifiable from the public key, so the key is never destroyed.
data "aws_iam_policy_document" "reconciliation_findings_key" {
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
      values   = [aws_iam_role.runtime_task["reconciliation"].arn]
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

resource "aws_kms_key" "reconciliation_findings" {
  description                        = "Cotsel ${var.environment} reconciliation evidence signer"
  customer_master_key_spec           = "ECC_NIST_P256"
  key_usage                          = "SIGN_VERIFY"
  deletion_window_in_days            = 30
  bypass_policy_lockout_safety_check = false
  policy                             = data.aws_iam_policy_document.reconciliation_findings_key.json

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Custody     = "aws-kms"
    Exportable  = "false"
    Purpose     = "reconciliation-evidence"
    WorkPackage = "Cotsel-951"
  }
}

resource "aws_kms_alias" "reconciliation_findings" {
  name          = "alias/${local.name_prefix}-reconciliation-findings"
  target_key_id = aws_kms_key.reconciliation_findings.key_id
}

data "aws_iam_policy_document" "reconciliation_findings_signing" {
  statement {
    sid       = "SignReconciliationManifestDigests"
    effect    = "Allow"
    actions   = ["kms:Sign"]
    resources = [aws_kms_key.reconciliation_findings.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:MessageType"
      values   = ["DIGEST"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:SigningAlgorithm"
      values   = ["ECDSA_SHA_256"]
    }
  }
}

resource "aws_iam_role_policy" "reconciliation_findings_signing" {
  name   = "${local.name_prefix}-reconciliation-findings-signing"
  role   = aws_iam_role.runtime_task["reconciliation"].name
  policy = data.aws_iam_policy_document.reconciliation_findings_signing.json
}

data "aws_kms_public_key" "reconciliation_findings" {
  key_id = aws_kms_key.reconciliation_findings.arn
}
