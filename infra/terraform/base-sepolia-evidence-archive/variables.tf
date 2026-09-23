variable "account_id" {
  description = "AWS account that owns the Base Sepolia evidence archive."
  type        = string

  validation {
    condition     = var.account_id == "655177116834"
    error_message = "The evidence archive may operate only in AWS account 655177116834."
  }
}

variable "region" {
  description = "Region that owns the evidence archive and its audit trail."
  type        = string
  default     = "eu-north-1"

  validation {
    condition     = var.region == "eu-north-1"
    error_message = "The evidence archive may operate only in eu-north-1."
  }
}

variable "retention_days" {
  description = "Governance-mode Object Lock retention in calendar days."
  type        = number
  default     = 90

  validation {
    condition     = var.retention_days == 90
    error_message = "The approved evidence retention period is exactly 90 days."
  }
}
