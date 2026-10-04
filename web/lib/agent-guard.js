// V98: only offered for application when status.agent_guard.enabled is true.
export const GUARD_LIMIT = "Rules apply to actions your agent checks first. Wired into your code before the order function, the model can't skip the check; it doesn't stop whoever holds the brokerage or wallet keys. Amounts traded count what your agent reports.";
export const GUARD_STARTERS = [
  {
    "id": "guard-trading",
    "name": "Trading: market hours, $500 per order",
    "policy": {
      "version": 1,
      "models": {},
      "caps": {},
      "windows": [
        {
          "days": [
            1,
            2,
            3,
            4,
            5
          ],
          "start": "13:30",
          "end": "20:00"
        }
      ],
      "actions": {
        "allow": [
          "trade.order",
          "trade.cancel"
        ],
        "targets": {
          "allow": [
            "NVDA",
            "TSLA",
            "AAPL",
            "MSFT",
            "SPY",
            "QQQ"
          ]
        },
        "per_action_usd": 500,
        "per_day_usd": 2000,
        "approval_above_usd": 250,
        "max_per_hour": 20
      },
      "on_breach": "deny"
    }
  },
  {
    "id": "guard-onchain",
    "name": "On-chain: swaps yes, sending funds out never",
    "policy": {
      "version": 1,
      "models": {},
      "caps": {},
      "actions": {
        "allow": [
          "swap",
          "token.approve"
        ],
        "deny": [
          "transfer.*",
          "bridge.*"
        ],
        "per_action_usd": 200,
        "per_day_usd": 1000,
        "approval_above_usd": 50,
        "max_per_hour": 10
      },
      "on_breach": "kill"
    }
  },
  {
    "id": "guard-payments",
    "name": "Payments: ask above $25",
    "policy": {
      "version": 1,
      "models": {},
      "caps": {},
      "actions": {
        "allow": [
          "payment.send",
          "invoice.pay",
          "tool.buy"
        ],
        "per_action_usd": 100,
        "per_day_usd": 500,
        "approval_above_usd": 25,
        "max_per_hour": 30
      },
      "on_breach": "deny"
    }
  }
];
export function guardIntentSummary(intent, formatUsd, picoUsd) {
  return `Action: ${intent.action} · Target: ${intent.target ?? 'None'} · Amount: ${formatUsd(picoUsd(intent.amount_pico))}${intent.details_sha256 ? ` · Order hash: ${intent.details_sha256}` : ''}`;
}
