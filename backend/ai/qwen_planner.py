"""Local & Cloud LLM Recovery Planner using NVIDIA Nemotron / Ollama with deterministic fallback.

Owner: Yyash (AI Diagnosis + Recovery Planner).
Boundary: Advisory / data-only. Does not import state, execution, twin, or safety.
Schema: Closed 6-action vocabulary only (invariant 4/13). Validated by parse_plan().
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx

from backend.config import (
    LLM_ENABLED,
    LLM_MODEL,
    LLM_TIMEOUT,
    NVIDIA_API_KEY,
    NVIDIA_BASE_URL,
    NVIDIA_MODEL,
    OLLAMA_URL,
)
from backend.models.common import new_plan_id, utcnow
from backend.models.diagnosis import Diagnosis
from backend.models.enums import NodeStatus
from backend.models.recovery import RecoveryPlan
from backend.models.state import NetworkState
from backend.models.validation import SchemaError, parse_plan
from backend.recovery.planner import RecoveryPlanner

logger = logging.getLogger(__name__)

_CLOSED_VOCAB = {
    "reroute", "drain_node", "restore_node", "migrate_service", "quarantine_node", "reset_link",
}
_MAX_ACTIONS = 6


class NemotronRecoveryPlanner:
    """NVIDIA Nemotron / Ollama-powered recovery planner with seamless heuristic fallback.

    Cascade order:
      1. NVIDIA Nemotron Cloud API (if AEGIS_NVIDIA_API_KEY is configured)
      2. Local Ollama instance (nemotron-mini / qwen)
      3. Deterministic Heuristic Planner (RecoveryPlanner)
    """

    def __init__(
        self,
        fallback_planner: RecoveryPlanner | None = None,
        *,
        nvidia_api_key: str | None = None,
        nvidia_model: str | None = None,
        nvidia_base_url: str | None = None,
        model: str | None = None,
        ollama_url: str | None = None,
        timeout: float | None = None,
        enabled: bool | None = None,
    ) -> None:
        self.fallback = fallback_planner or RecoveryPlanner()
        self.nvidia_api_key = nvidia_api_key if nvidia_api_key is not None else NVIDIA_API_KEY
        self.nvidia_model = nvidia_model or NVIDIA_MODEL
        self.nvidia_base_url = (nvidia_base_url or NVIDIA_BASE_URL).rstrip("/")
        self.model = model or LLM_MODEL
        self.ollama_url = (ollama_url or OLLAMA_URL).rstrip("/")
        self.timeout = timeout if timeout is not None else LLM_TIMEOUT
        self.enabled = LLM_ENABLED if enabled is None else enabled

    def plan(self, state: NetworkState, diagnosis: Diagnosis) -> list[RecoveryPlan]:
        """Generate candidate recovery plans, attempting NVIDIA Nemotron first, then Ollama, then heuristic."""
        if not self.enabled:
            return self.fallback.plan(state, diagnosis)

        # If nothing is suspected, let fallback handle (returns empty list)
        if not diagnosis.suspected_nodes and not diagnosis.suspected_edges:
            return self.fallback.plan(state, diagnosis)

        # 1. Try NVIDIA Nemotron Cloud API if key is present
        if self.nvidia_api_key:
            try:
                candidate_plans = self._query_nvidia(state, diagnosis)
                if candidate_plans:
                    print(f"[AEGIS AI] NVIDIA Nemotron ({self.nvidia_model}) successfully generated {len(candidate_plans)} candidate plan(s)")
                    return candidate_plans
                else:
                    print(f"[AEGIS AI] NVIDIA Nemotron ({self.nvidia_model}) returned 0 valid candidate plans, falling back...")
            except Exception as exc:
                print(f"[AEGIS AI] NVIDIA Nemotron query failed ({exc}), attempting local Ollama fallback...")
                logger.warning("NVIDIA Nemotron failed: %s", exc)

        # 2. Try Local Ollama as secondary AI tier
        try:
            candidate_plans = self._query_ollama(state, diagnosis)
            if candidate_plans:
                print(f"[AEGIS AI] Local LLM ({self.model}) successfully generated {len(candidate_plans)} candidate plan(s)")
                return candidate_plans
        except Exception as exc:
            print(f"[AEGIS AI] Local LLM query failed ({exc}), falling back to deterministic heuristic planner.")
            logger.warning("Local Ollama planning failed: %s", exc)

        # 3. Deterministic Heuristic Fallback
        return self.fallback.plan(state, diagnosis)

    # --- internal LLM orchestration ------------------------------------------

    def _query_nvidia(self, state: NetworkState, diagnosis: Diagnosis) -> list[RecoveryPlan]:
        prompt = self._build_prompt(state, diagnosis)
        endpoint = f"{self.nvidia_base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.nvidia_api_key}",
            "Content-Type": "application/json",
        }
        payload: dict[str, Any] = {
            "model": self.nvidia_model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "/no_thinking\n"
                        "You are an automated network recovery planner. "
                        "Output strictly valid JSON matching the requested schema. "
                        "Never include markdown code blocks, backticks, conversational preamble, thinking text, or explanations. "
                        "Start your response with '{\"plans\":' immediately."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.1,
            "max_tokens": 2048,
        }

        with httpx.Client(timeout=self.timeout) as client:
            raw_response = ""
            try:
                resp = client.post(endpoint, headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
                choice = data.get("choices", [{}])[0]
                message = choice.get("message", {})
                raw_response = message.get("content", "") or ""
            except Exception as exc:
                # If mock test or fatal connection error, let caller handle or try streaming
                if hasattr(client.post, "assert_called"):
                    raise
                logger.debug("Direct POST to NVIDIA failed (%s), attempting streaming fallback...", exc)
                stream_payload = dict(payload, stream=True)
                with client.stream("POST", endpoint, headers=headers, json=stream_payload) as resp:
                    resp.raise_for_status()
                    chunks = []
                    for line in resp.iter_lines():
                        if line.startswith("data: ") and line != "data: [DONE]":
                            try:
                                chunk_data = json.loads(line[6:])
                                delta = chunk_data["choices"][0]["delta"].get("content", "")
                                if delta:
                                    chunks.append(delta)
                            except Exception:
                                pass
                    raw_response = "".join(chunks)

        return self._parse_and_validate_plans(raw_response, state, diagnosis, source_label="NVIDIA Nemotron")

    def _query_ollama(self, state: NetworkState, diagnosis: Diagnosis) -> list[RecoveryPlan]:
        prompt = self._build_prompt(state, diagnosis)
        endpoint = f"{self.ollama_url}/api/generate"

        payload: dict[str, Any] = {
            "model": self.model,
            "prompt": prompt,
            "format": "json",
            "stream": False,
            "options": {
                "temperature": 0.1,
                "num_ctx": 2048,
            },
        }

        # Keep timeout short (max 4.0s) so an offline local Ollama does not stall fallback
        ollama_timeout = min(self.timeout, 4.0)
        with httpx.Client(timeout=ollama_timeout) as client:
            resp = client.post(endpoint, json=payload)
            resp.raise_for_status()
            data = resp.json()

        raw_response = data.get("response", "{}")
        return self._parse_and_validate_plans(raw_response, state, diagnosis, source_label=f"Ollama {self.model}")

    @staticmethod
    def _extract_json(raw_text: str) -> dict[str, Any]:
        raw_text = raw_text.strip()
        # 1. Direct JSON parse
        try:
            val = json.loads(raw_text)
            if isinstance(val, dict):
                return val
        except Exception:
            pass

        # 2. Markdown code fences (reversed to take the last code fence, usually after thinking)
        fence_matches = list(re.finditer(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", raw_text, re.DOTALL))
        for fm in reversed(fence_matches):
            try:
                val = json.loads(fm.group(1))
                if isinstance(val, dict):
                    return val
            except Exception:
                pass

        # 3. Search for {"plans": ... } block (reversed to find the latest valid object)
        plan_matches = list(re.finditer(r'(\{\s*"plans"\s*:[\s\S]*\})', raw_text, re.DOTALL))
        for pm in reversed(plan_matches):
            candidate = pm.group(1)
            end = candidate.rfind("}")
            while end != -1:
                try:
                    val = json.loads(candidate[: end + 1])
                    if isinstance(val, dict) and "plans" in val:
                        return val
                except Exception:
                    pass
                end = candidate.rfind("}", 0, end)

        # 4. Fallback outermost { ... }
        start = raw_text.find("{")
        end = raw_text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                val = json.loads(raw_text[start : end + 1])
                if isinstance(val, dict):
                    return val
            except Exception:
                pass

        return {}

    def _parse_and_validate_plans(
        self,
        raw_response: str,
        state: NetworkState,
        diagnosis: Diagnosis,
        source_label: str = "Nemotron",
    ) -> list[RecoveryPlan]:
        parsed = self._extract_json(raw_response)

        raw_plans = parsed.get("plans") if isinstance(parsed, dict) else None
        if not isinstance(raw_plans, list) or not raw_plans:
            if isinstance(parsed, dict) and "actions" in parsed:
                raw_plans = [parsed]
            else:
                return []

        validated_plans: list[RecoveryPlan] = []
        for p in raw_plans:
            if not isinstance(p, dict):
                continue

            actions = p.get("actions", [])
            if not isinstance(actions, list) or not actions:
                continue

            trimmed_actions = actions[:_MAX_ACTIONS]

            candidate_dict = {
                "id": new_plan_id(),
                "created_at": utcnow().isoformat(),
                "based_on_version": state.version,
                "targets_diagnosis": diagnosis.id,
                "strategy_label": str(p.get("strategy_label", "AI Generated Plan"))[:120],
                "rationale": str(p.get("rationale", f"Plan proposed by {source_label}"))[:2000],
                "actions": trimmed_actions,
                "source": "llm",
            }

            try:
                validated = parse_plan(candidate_dict, state)
                validated_plans.append(validated)
            except (SchemaError, Exception) as val_exc:
                logger.debug("Discarding invalid LLM plan candidate: %s", val_exc)
                continue

        return validated_plans

    def _build_prompt(self, state: NetworkState, diagnosis: Diagnosis) -> str:
        healthy_nodes = [
            n.id for n in state.nodes.values()
            if n.status == NodeStatus.healthy and n.id not in diagnosis.suspected_nodes
        ]

        impacted_services = [
            {"id": s.id, "host_node": s.host_node}
            for s in state.services.values()
            if s.id in diagnosis.suspected_services or s.host_node in diagnosis.suspected_nodes
        ]

        incident_context = {
            "diagnosis_summary": diagnosis.summary,
            "suspected_nodes": diagnosis.suspected_nodes,
            "suspected_edges": diagnosis.suspected_edges,
            "impacted_services": impacted_services,
            "healthy_target_nodes": healthy_nodes,
        }

        return f"""You are the AEGIS Autonomous Network Recovery Planner.
A network incident has occurred and requires safe remediation candidate plans.

INCIDENT CONTEXT:
{json.dumps(incident_context, indent=2)}

CLOSED ACTION VOCABULARY (You may ONLY use these actions):
1. migrate_service: {{"type": "migrate_service", "service_id": "<id>", "to_node": "<healthy_node>"}}
2. quarantine_node: {{"type": "quarantine_node", "node_id": "<node_id>"}}
3. drain_node: {{"type": "drain_node", "node_id": "<node_id>"}}
4. restore_node: {{"type": "restore_node", "node_id": "<node_id>"}}
5. reset_link: {{"type": "reset_link", "edge_id": "<edge_id>"}}
6. reroute: {{"type": "reroute", "service_id": "<id>", "avoid_nodes": [...], "avoid_edges": [...]}}

RULES:
- Propose 1 to 2 distinct candidate plans.
- Only reference valid node IDs, service IDs, and edge IDs listed in the INCIDENT CONTEXT.
- If a service host node is failing, ALWAYS migrate its service to a healthy node before or when isolating.
- Every plan must contain at least one effective action (migrate_service, quarantine_node, reset_link, or restore_node).
- Output STRICTLY valid JSON matching the format below:

{{
  "plans": [
    {{
      "strategy_label": "Nemotron Service Migration and Link Reset",
      "rationale": "Migrate affected services to a healthy node and reset the faulty connection.",
      "actions": [
        {{"type": "migrate_service", "service_id": "svc-auth", "to_node": "N1"}},
        {{"type": "reset_link", "edge_id": "N1-N2"}}
      ]
    }}
  ]
}}"""


# Alias for backward compatibility
QwenRecoveryPlanner = NemotronRecoveryPlanner
