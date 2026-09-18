terraform {
  backend "s3" {
    bucket       = "agroasys-tfstate-655177116834"
    key          = "cotsel/staging-platform/foundation.tfstate"
    region       = "eu-north-1"
    use_lockfile = true
    encrypt      = true
  }
}
