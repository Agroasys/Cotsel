# WP-8 alarm routing. Lists stay empty until the Operations Lead names the on-call
# destinations (#672); alarms still evaluate and appear on the settlement dashboard.
variable "critical_alarm_topic_arns" {
  description = "SNS topics in the workload region paged for CRITICAL settlement alarms (Platform On-Call and Incident Commander)."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for arn in var.critical_alarm_topic_arns :
      can(regex("^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,256}$", arn)) && split(":", arn)[3] == var.region
    ])
    error_message = "critical_alarm_topic_arns must be SNS topic ARNs in the workload region."
  }
}

variable "high_alarm_topic_arns" {
  description = "SNS topics in the workload region notified for HIGH settlement alarms (Ops/Engineering On-Call)."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for arn in var.high_alarm_topic_arns :
      can(regex("^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,256}$", arn)) && split(":", arn)[3] == var.region
    ])
    error_message = "high_alarm_topic_arns must be SNS topic ARNs in the workload region."
  }
}

variable "edge_alarm_topic_arns" {
  description = "SNS topics in us-east-1 notified by the external readiness probe alarm, because Route 53 health-check metrics exist only in us-east-1."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for arn in var.edge_alarm_topic_arns :
      can(regex("^arn:aws:sns:us-east-1:[0-9]{12}:[A-Za-z0-9_-]{1,256}$", arn))
    ])
    error_message = "edge_alarm_topic_arns must be SNS topic ARNs in us-east-1."
  }
}

variable "gateway_availability_slo_percent" {
  description = "Approved monthly gateway availability objective (decision #199) used for burn-rate alarms."
  type        = number
  default     = 99.9

  validation {
    condition     = var.gateway_availability_slo_percent >= 99 && var.gateway_availability_slo_percent < 100
    error_message = "gateway_availability_slo_percent must be at least 99 and below 100."
  }
}

variable "gateway_latency_p99_seconds" {
  description = "Gateway p99 target response time objective in seconds."
  type        = number
  default     = 2

  validation {
    condition     = var.gateway_latency_p99_seconds > 0 && var.gateway_latency_p99_seconds <= 30
    error_message = "gateway_latency_p99_seconds must be greater than 0 and at most 30."
  }
}
