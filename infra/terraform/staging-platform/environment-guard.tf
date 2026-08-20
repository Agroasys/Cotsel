data "aws_caller_identity" "current" {}

resource "terraform_data" "environment_guard" {
  lifecycle {
    precondition {
      condition     = terraform.workspace == "default"
      error_message = "Use the default workspace. Rebuilds require a separate state key, not a workspace."
    }

    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.account_id
      error_message = "Refusing to operate in an AWS account other than account_id."
    }

    precondition {
      condition     = var.region == "ap-south-1" && var.environment == "staging"
      error_message = "Refusing to operate outside the approved Mumbai staging boundary."
    }
  }
}
