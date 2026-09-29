variable "resource_group_name" {
  description = "Resource group to create."
  type        = string
  default     = "anyroute-seal"
}

variable "location" {
  description = "An Azure region that offers NCC H100 v5. Check availability first."
  type        = string
  default     = "eastus2"
}

variable "name" {
  description = "VM name and resource prefix."
  type        = string
  default     = "anyroute-seal"
}

variable "vm_size" {
  description = "NCC H100 v5 size."
  type        = string
  default     = "Standard_NCC40ads_H100_v5"
}

variable "admin_username" {
  description = "Admin user."
  type        = string
  default     = "seal"
}

variable "admin_ssh_public_key" {
  description = "SSH public key for the admin user."
  type        = string
}

variable "os_disk_size_gb" {
  description = "OS disk size; the weights usually live here too."
  type        = number
  default     = 512
}

variable "allowed_cidrs" {
  description = "Who may reach the sidecar port."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "ssh_cidrs" {
  description = "Who may reach SSH."
  type        = list(string)
}

variable "sidecar_port" {
  description = "The sidecar's TLS port."
  type        = number
  default     = 8443
}

variable "seal_region" {
  description = "Region code written to seal.yaml, e.g. us-east."
  type        = string
}

variable "seal_flags" {
  description = "More install.sh options, e.g. --hf-repo org/model --weights-sha256 sha256:... --price-in 0.2 --price-out 0.9. Do not pass --lanes or --cc-mode: this module fixes them."
  type        = string
  default     = ""
  validation {
    condition     = !can(regex("--(lanes|cc-mode|tee)", var.seal_flags))
    error_message = "SEV-SNP hosts are CPU-attested only: --lanes, --cc-mode and --tee are fixed by this module."
  }
}
