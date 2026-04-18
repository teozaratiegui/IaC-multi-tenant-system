# Copiar a backend.hcl y completar bucket + dynamodb_table (outputs del bootstrap)
# Luego: terraform init -backend-config=backend.hcl

key            = "orgs/acme/dev/terraform.tfstate"
bucket         = "tete-terraform-state-dev"
region         = "sa-east-1"
dynamodb_table = "tete-terraform-lock-dev"
encrypt        = true
