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
  description = "ACM certificate in ap-south-1 for the private CloudFront-to-ALB origin hostname."
  type        = string

  validation {
    condition = can(regex(
      "^arn:(aws|aws-us-gov|aws-cn):acm:ap-south-1:[0-9]{12}:certificate/[0-9a-f-]+$",
      var.origin_certificate_arn,
    ))
    error_message = "origin_certificate_arn must identify an ap-south-1 ACM certificate."
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
