output "state_bucket_name" {
  value = module.backend.state_bucket_name
}

output "lock_table_name" {
  value = module.backend.lock_table_name
}

# Use these values in your environment's backend config (backend.dev.hcl, etc.)
