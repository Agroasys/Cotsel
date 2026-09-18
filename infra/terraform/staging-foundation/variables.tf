variable "account_id" {
  description = "AWS account that owns the Agroasys staging control plane."
  type        = string

  validation {
    condition     = var.account_id == "655177116834"
    error_message = "The staging foundation may operate only in AWS account 655177116834."
  }
}

variable "region" {
  description = "AWS workload region approved for Cotsel staging."
  type        = string
  default     = "ap-south-1"

  validation {
    condition     = var.region == "ap-south-1"
    error_message = "The staging foundation may operate only in ap-south-1."
  }
}

variable "environment" {
  description = "Deployment environment. This root is intentionally staging-only."
  type        = string
  default     = "staging"

  validation {
    condition     = var.environment == "staging"
    error_message = "The staging foundation may operate only in staging."
  }
}

variable "service_role_permissions_boundary_arn" {
  description = "Permissions boundary required for isolated Cotsel signer task roles."
  type        = string
  default     = "arn:aws:iam::655177116834:policy/agroasys-cotsel-staging-service-role-boundary"

  validation {
    condition = can(regex(
      "^arn:(aws|aws-us-gov|aws-cn):iam::655177116834:policy/agroasys-cotsel-staging-service-role-boundary$",
      var.service_role_permissions_boundary_arn,
    ))
    error_message = "service_role_permissions_boundary_arn must be the Cotsel staging service role boundary policy ARN."
  }
}
