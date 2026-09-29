variable "project" {
  description = "GCP project id."
  type        = string
}

variable "zone" {
  description = "A zone that offers A3 High confidential VMs. Check availability first."
  type        = string
  default     = "us-central1-a"
}

variable "name" {
  description = "Instance name."
  type        = string
  default     = "anyroute-seal"
}

variable "machine_type" {
  description = "A3 High machine type with H100 GPUs (a3-highgpu-1g has one)."
  type        = string
  default     = "a3-highgpu-1g"
}

variable "provisioning_model" {
  description = "SPOT or STANDARD. Confidential A3 capacity has been offered as Spot or flex-start; check what your project can get."
  type        = string
  default     = "SPOT"
  validation {
    condition     = contains(["SPOT", "STANDARD"], var.provisioning_model)
    error_message = "provisioning_model must be SPOT or STANDARD."
  }
}

variable "boot_image" {
  description = "A boot image that supports Intel TDX and the NVIDIA confidential-computing driver."
  type        = string
  default     = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64"
}

variable "boot_disk_size_gb" {
  description = "Boot disk size; the weights usually live here too."
  type        = number
  default     = 500
}

variable "boot_disk_type" {
  description = "Boot disk type."
  type        = string
  default     = "pd-balanced"
}

variable "network" {
  description = "VPC network."
  type        = string
  default     = "default"
}

variable "public_ip" {
  description = "Give the VM an external address."
  type        = bool
  default     = true
}

variable "allowed_cidrs" {
  description = "Who may reach the sidecar port."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "sidecar_port" {
  description = "The sidecar's TLS port."
  type        = number
  default     = 8443
}

variable "seal_region" {
  description = "Region code written to seal.yaml, e.g. us-central."
  type        = string
}

variable "seal_flags" {
  description = "More install.sh options, e.g. --hf-repo org/model --weights-sha256 sha256:... --price-in 0.2 --price-out 0.9."
  type        = string
  default     = ""
}
