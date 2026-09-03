terraform {
  required_version = "~> 1.15"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Programme   = "cotsel-production-readiness"
      WorkPackage = "WP-7"
      ManagedBy   = "terraform"
      Root        = "cotsel-staging-platform"
      Environment = var.environment
    }
  }
}

# CloudFront is global, but its WAF web ACL and edge logging control plane are in us-east-1.
# This does not create a second Cotsel workload region.
provider "aws" {
  alias  = "edge"
  region = "us-east-1"

  default_tags {
    tags = {
      Programme   = "cotsel-production-readiness"
      WorkPackage = "WP-7"
      ManagedBy   = "terraform"
      Root        = "cotsel-staging-platform"
      Environment = var.environment
    }
  }
}
