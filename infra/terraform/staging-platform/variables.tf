variable "account_id" {
  description = "AWS account that owns the Agroasys staging control plane."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "region" {
  description = "AWS workload region approved for Agroasys and Cotsel staging."
  type        = string
  default     = "ap-south-1"

  validation {
    condition     = var.region == "ap-south-1"
    error_message = "Cotsel staging is approved only for ap-south-1."
  }
}

variable "environment" {
  description = "Deployment environment. This root is intentionally staging-only."
  type        = string
  default     = "staging"

  validation {
    condition     = var.environment == "staging"
    error_message = "This Terraform root may only manage staging."
  }
}

variable "state_bucket" {
  description = "Shared Agroasys Terraform state bucket."
  type        = string
  default     = "agroasys-tfstate-655177116834"
}

variable "state_bucket_region" {
  description = "Region of the shared Terraform state bucket."
  type        = string
  default     = "eu-north-1"
}

variable "origin_certificate_arn" {
  description = "ACM certificate in ap-south-1 for the CloudFront-to-ALB origin hostname."
  type        = string

  validation {
    condition = can(regex(
      "^arn:(aws|aws-us-gov|aws-cn):acm:ap-south-1:[0-9]{12}:certificate/[0-9a-f-]+$",
      var.origin_certificate_arn,
    ))
    error_message = "origin_certificate_arn must identify an ap-south-1 ACM certificate."
  }
}

variable "edge_certificate_arn" {
  description = "ACM certificate in us-east-1 for the public CloudFront gateway hostname."
  type        = string

  validation {
    condition = can(regex(
      "^arn:(aws|aws-us-gov|aws-cn):acm:us-east-1:[0-9]{12}:certificate/[0-9a-f-]+$",
      var.edge_certificate_arn,
    ))
    error_message = "edge_certificate_arn must identify a us-east-1 ACM certificate for CloudFront."
  }
}

variable "public_gateway_domain_name" {
  description = "Canonical public staging hostname for the Cotsel gateway edge."
  type        = string
  default     = "cotsel.sys.agroasys.com"

  validation {
    condition     = var.public_gateway_domain_name == "cotsel.sys.agroasys.com"
    error_message = "The Cotsel staging gateway hostname must remain cotsel.sys.agroasys.com."
  }
}

variable "gateway_image_tag" {
  description = "Immutable Git commit SHA image tag shared by the bundled Cotsel runtime containers."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.gateway_image_tag))
    error_message = "gateway_image_tag must be a 40-character lowercase Git commit SHA."
  }
}

variable "base_sepolia_escrow_address" {
  description = "Reviewed Base Sepolia escrow deployment consumed by the staging runtime."
  type        = string

  validation {
    condition = (
      can(regex("^0x[0-9a-fA-F]{40}$", var.base_sepolia_escrow_address)) &&
      lower(var.base_sepolia_escrow_address) != "0x0000000000000000000000000000000000000000"
    )
    error_message = "base_sepolia_escrow_address must be a non-zero EVM address."
  }
}

variable "base_sepolia_contract_start_block" {
  description = "Deployment block from which the Base Sepolia indexer starts."
  type        = number

  validation {
    condition = (
      var.base_sepolia_contract_start_block >= 1 &&
      floor(var.base_sepolia_contract_start_block) == var.base_sepolia_contract_start_block
    )
    error_message = "base_sepolia_contract_start_block must be a positive integer."
  }
}

variable "base_sepolia_usdc_address" {
  description = "Reviewed Base Sepolia USDC address consumed by the staging runtime."
  type        = string

  validation {
    condition = (
      can(regex("^0x[0-9a-fA-F]{40}$", var.base_sepolia_usdc_address)) &&
      lower(var.base_sepolia_usdc_address) != "0x0000000000000000000000000000000000000000"
    )
    error_message = "base_sepolia_usdc_address must be a non-zero EVM address."
  }
}

variable "backend_settlement_callback_url" {
  description = "Canonical Agroasys staging callback endpoint for Cotsel execution events."
  type        = string
  default     = "https://api.staging.agroasys.com/api/v1/settlement-handoffs/cotsel/callbacks/execution-events"

  validation {
    condition = (
      var.backend_settlement_callback_url ==
      "https://api.staging.agroasys.com/api/v1/settlement-handoffs/cotsel/callbacks/execution-events"
    )
    error_message = "backend_settlement_callback_url must remain the canonical direct staging callback URL."
  }
}

variable "oracle_wallet_secret_name" {
  description = "Existing Secrets Manager identity for the controlled Base Sepolia oracle signer."
  type        = string
  default     = "/agroasys/staging/base-sepolia/wallet-oracle"

  validation {
    condition     = var.oracle_wallet_secret_name == "/agroasys/staging/base-sepolia/wallet-oracle"
    error_message = "oracle_wallet_secret_name must identify the controlled staging oracle wallet."
  }
}

variable "gateway_desired_count" {
  description = "Number of Cotsel gateway tasks to run in staging."
  type        = number
  default     = 1

  validation {
    condition     = var.gateway_desired_count >= 1 && var.gateway_desired_count <= 2
    error_message = "gateway_desired_count must be 1 or 2 for the current staging runtime."
  }
}

variable "service_role_permissions_boundary_arn" {
  description = "Permissions boundary required for Cotsel staging ECS task and execution roles."
  type        = string
  default     = "arn:aws:iam::655177116834:policy/agroasys-cotsel-staging-service-role-boundary"

  validation {
    condition = can(regex(
      "^arn:(aws|aws-us-gov|aws-cn):iam::[0-9]{12}:policy/agroasys-cotsel-staging-service-role-boundary$",
      var.service_role_permissions_boundary_arn,
    ))
    error_message = "service_role_permissions_boundary_arn must be the Cotsel staging service role boundary policy ARN."
  }
}

variable "log_retention_days" {
  description = "CloudWatch retention for staging service logs."
  type        = number
  default     = 30

  validation {
    condition     = contains([30, 60, 90, 120, 150, 180, 365], var.log_retention_days)
    error_message = "log_retention_days must be an AWS-supported value of at least 30 days."
  }
}
