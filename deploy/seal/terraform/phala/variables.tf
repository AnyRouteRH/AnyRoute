variable "name" {
  description = "App name on Phala Cloud."
  type        = string
  default     = "anyroute-seal"
}

variable "gpu" {
  description = "A GPU node (vLLM) rather than a CPU node (llama.cpp)."
  type        = bool
  default     = true
}

variable "node_type" {
  description = "Phala Cloud instance type, as its CLI names it (e.g. tdx.medium for CPU). Empty leaves the CLI's default."
  type        = string
  default     = ""
}

variable "out_dir" {
  description = "Where the sidecar's onboarding CLI writes the Phala files."
  type        = string
  default     = "anyroute-provider"
}

variable "compose_file" {
  description = "The compose file to deploy (written by the onboarding CLI)."
  type        = string
  default     = "anyroute-provider/docker-compose.yml"
}
