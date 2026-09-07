"""Central tunables — the only place hackathon knobs live (docs/TRD.md R5).

Threshold values here are SCAFFOLD DEFAULTS pending team agreement
(BACKEND_SCHEMA.md §10 / IMPLEMENTATION_PLAN.md TEAM DECISION D2, D5, D6).
"""

import os
from pathlib import Path

from dotenv import load_dotenv

from backend.models.safety import PolicyConfig

# Load .env from project root if present
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=_env_path)

# --- recovery / LLM ---------------------------------------------------------

LLM_ENABLED = os.getenv("AEGIS_LLM_ENABLED", "false").lower() in ("true", "1", "yes")
NVIDIA_API_KEY = os.getenv("AEGIS_NVIDIA_API_KEY", os.getenv("NVIDIA_API_KEY", ""))
NVIDIA_MODEL = os.getenv("AEGIS_NVIDIA_MODEL", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning")
NVIDIA_BASE_URL = os.getenv("AEGIS_NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")
LLM_MODEL = os.getenv("AEGIS_LLM_MODEL", "nemotron-mini")
OLLAMA_URL = os.getenv("AEGIS_OLLAMA_URL", "http://localhost:11434")
LLM_TIMEOUT = float(os.getenv("AEGIS_LLM_TIMEOUT", "60.0"))
RECOVERY_RUN_AUTO_APPLY_DEFAULT = True   # D6

# --- background simulation / drift ------------------------------------------
DRIFT_ENABLED = os.getenv("AEGIS_DRIFT_ENABLED", "true").lower() in ("true", "1", "yes")
DRIFT_INTERVAL = float(os.getenv("AEGIS_DRIFT_INTERVAL", "2.5"))

# --- safety policy (D2 — values are TEAM DECISION REQUIRED) --------------

DEFAULT_POLICY = PolicyConfig(
    policy_version="p0-scaffold",
    availability_floor=0.99,
    max_latency_increase_ratio=0.20,
    max_node_load_ratio=0.90,
    warnings_block=False,
)
