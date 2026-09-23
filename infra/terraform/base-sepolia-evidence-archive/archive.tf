data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  bucket_name      = "agroasys-cotsel-base-sepolia-evidence-${var.account_id}"
  writer_role_name = "agroasys-cotsel-base-sepolia-evidence-writer"
  writer_role_arn  = "arn:${data.aws_partition.current.partition}:iam::${var.account_id}:role/${local.writer_role_name}"
  trail_name       = "cotsel-base-sepolia-evidence"
}

resource "terraform_data" "environment_guard" {
  lifecycle {
    precondition {
      condition     = terraform.workspace == "default"
      error_message = "Use the default workspace. A different archive requires a different state key."
    }

    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.account_id
      error_message = "Refusing to operate outside the approved AWS account."
    }
  }
}

resource "aws_s3_bucket" "evidence" {
  bucket              = local.bucket_name
  object_lock_enabled = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.evidence]
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "archive_key" {
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
    sid    = "EvidenceWriterEncryption"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [local.writer_role_arn]
    }

    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }
  }

  statement {
    sid    = "CloudTrailEncryption"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    actions   = ["kms:DescribeKey", "kms:GenerateDataKey*"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:cloudtrail:${var.region}:${var.account_id}:trail/${local.trail_name}"]
    }
  }
}

resource "aws_kms_key" "archive" {
  description             = "Base Sepolia staging evidence archive encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.archive_key.json

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "archive" {
  name          = "alias/cotsel-base-sepolia-evidence-archive"
  target_key_id = aws_kms_key.archive.key_id

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.archive.arn
    }

    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "writer_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${var.account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:Agroasys/Cotsel:environment:base-sepolia-evidence"]
    }
  }
}

resource "aws_iam_role" "writer" {
  name               = local.writer_role_name
  description        = "Writes reviewed Base Sepolia staging evidence. It cannot delete evidence or bypass retention."
  assume_role_policy = data.aws_iam_policy_document.writer_trust.json

  lifecycle {
    prevent_destroy = true
  }
}

data "aws_iam_policy_document" "writer" {
  statement {
    sid       = "ListCandidatePrefix"
    effect    = "Allow"
    actions   = ["s3:GetBucketLocation", "s3:ListBucket"]
    resources = [aws_s3_bucket.evidence.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["base-sepolia/staging/candidates/*"]
    }
  }

  statement {
    sid    = "WriteCandidateEvidence"
    effect = "Allow"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.evidence.arn}/base-sepolia/staging/candidates/*"]
  }

  statement {
    sid       = "EncryptCandidateEvidence"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.archive.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }
  }

  statement {
    sid    = "NeverAlterArchiveRetention"
    effect = "Deny"
    actions = [
      "s3:BypassGovernanceRetention",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:PutObjectLegalHold",
      "s3:PutObjectRetention",
    ]
    resources = ["${aws_s3_bucket.evidence.arn}/*"]
  }
}

resource "aws_iam_role_policy" "writer" {
  name   = "base-sepolia-evidence-write-only"
  role   = aws_iam_role.writer.id
  policy = data.aws_iam_policy_document.writer.json
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.evidence.arn, "${aws_s3_bucket.evidence.arn}/*"]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid     = "DenyGovernanceBypass"
    effect  = "Deny"
    actions = ["s3:BypassGovernanceRetention"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = ["${aws_s3_bucket.evidence.arn}/*"]
  }

  statement {
    sid     = "CloudTrailBucketAccess"
    effect  = "Allow"
    actions = ["s3:GetBucketAcl"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    resources = [aws_s3_bucket.evidence.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:cloudtrail:${var.region}:${var.account_id}:trail/${local.trail_name}"]
    }
  }

  statement {
    sid     = "CloudTrailWriteAuditObjects"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    resources = ["${aws_s3_bucket.evidence.arn}/cloudtrail/AWSLogs/${var.account_id}/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:cloudtrail:${var.region}:${var.account_id}:trail/${local.trail_name}"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
}

resource "aws_s3_bucket_policy" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  policy = data.aws_iam_policy_document.bucket.json
}

resource "aws_cloudtrail" "evidence" {
  name                          = local.trail_name
  s3_bucket_name                = aws_s3_bucket.evidence.id
  s3_key_prefix                 = "cloudtrail"
  kms_key_id                    = aws_kms_key.archive.arn
  include_global_service_events = false
  is_multi_region_trail         = false
  enable_log_file_validation    = true

  lifecycle {
    prevent_destroy = true
  }

  advanced_event_selector {
    name = "BaseSepoliaEvidenceObjectDataEvents"

    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }

    field_selector {
      field  = "resources.type"
      equals = ["AWS::S3::Object"]
    }

    field_selector {
      field       = "resources.ARN"
      starts_with = ["${aws_s3_bucket.evidence.arn}/base-sepolia/"]
    }
  }

  depends_on = [aws_s3_bucket_policy.evidence]
}
