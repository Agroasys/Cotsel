variable "dashboard_session_routes_enabled" {
  description = "Expose only the three bearer-authenticated dashboard session lifecycle routes through the protected HTTPS edge."
  type        = bool
  default     = false

  validation {
    condition     = !var.dashboard_session_routes_enabled || var.dashboard_origin == "https://cotsel.agroasys.com"
    error_message = "Dashboard session routes require dashboard_origin=https://cotsel.agroasys.com."
  }
}

variable "dashboard_origin" {
  description = "Exact HTTPS Cotsel dashboard origin allowed by auth and gateway CORS. Empty keeps the dashboard origin disabled."
  type        = string
  default     = ""

  validation {
    condition     = var.dashboard_origin == "" || var.dashboard_origin == "https://cotsel.agroasys.com"
    error_message = "dashboard_origin must be empty or https://cotsel.agroasys.com."
  }
}

variable "backend_api_task_security_group_id" {
  description = "Dedicated backend API task security group allowed to reach Cotsel auth for private session exchange."
  type        = string
  default     = ""

  validation {
    condition = (
      var.backend_api_task_security_group_id == "" ||
      can(regex("^sg-([0-9a-f]{8}|[0-9a-f]{17})$", var.backend_api_task_security_group_id))
    )
    error_message = "backend_api_task_security_group_id must be empty or an EC2 security group ID."
  }

  validation {
    condition = (
      !(var.trusted_session_exchange_enabled || var.admin_control_enabled) ||
      var.backend_api_task_security_group_id != ""
    )
    error_message = "Trusted exchange or admin control requires the dedicated backend API task security group ID."
  }
}

variable "trusted_session_exchange_enabled" {
  description = "Enable Cotsel trusted backend session exchange. Requires separately provisioned exchange credentials and reviewed key policies."
  type        = bool
  default     = false
}

variable "trusted_session_exchange_key_policies_json" {
  description = "Non-secret JSON policy mapping for trusted session-exchange key IDs."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.trusted_session_exchange_enabled ||
      (
        var.trusted_session_exchange_key_policies_json != "" &&
        can(jsondecode(var.trusted_session_exchange_key_policies_json)) &&
        try(
          length(keys(jsondecode(var.trusted_session_exchange_key_policies_json))) > 0 &&
          alltrue([
            for policy in values(jsondecode(var.trusted_session_exchange_key_policies_json)) :
            length(policy.roles) > 0 &&
            length(distinct(policy.roles)) == length(policy.roles) &&
            alltrue([for role in policy.roles : contains(["buyer", "supplier", "admin"], role)]) &&
            alltrue([for field in keys(policy) : contains(["roles", "orgId"], field)])
          ]),
          false,
        )
      )
    )
    error_message = "Trusted session exchange requires a non-empty JSON map with distinct supported roles and known policy fields."
  }
}

variable "admin_control_enabled" {
  description = "Enable Cotsel admin control. Requires externally provisioned credentials for two distinct verified human principals."
  type        = bool
  default     = false
}

variable "admin_control_allowed_api_key_ids" {
  description = "Comma-separated non-secret IDs of the two approved Cotsel admin-control credentials."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.admin_control_enabled ||
      length([
        for id in split(",", var.admin_control_allowed_api_key_ids) : trimspace(id)
        if trimspace(id) != ""
      ]) >= 2 &&
      length(toset([
        for id in split(",", var.admin_control_allowed_api_key_ids) : trimspace(id)
        if trimspace(id) != ""
      ])) >= 2
    )
    error_message = "Admin control requires at least two distinct approved API key IDs."
  }
}

variable "gateway_enable_mutations" {
  description = "Enable gateway mutations. Remains false unless separately reviewed and approved."
  type        = bool
  default     = false

  validation {
    condition = !var.gateway_enable_mutations || (
      var.trusted_session_exchange_enabled &&
      try(anytrue([
        for policy in values(jsondecode(var.trusted_session_exchange_key_policies_json)) :
        contains(policy.roles, "admin")
      ]), false)
    )
    error_message = "Gateway mutations require explicitly enabled trusted exchange with an administrator policy."
  }
}

