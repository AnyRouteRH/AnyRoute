// CONTRIBUTING: When shipping a user-visible change, add an entry with a stable id,
// its commit's UTC committer day, plain title and 1–2 honest sentences, site links,
// full public commit URLs and allowed tags. Combine related commits; use the newest
// committer day. Confirm it is switched on before listing it, then run pnpm test.
// Keep old ids and dates stable so bookmarks and feed readers keep working.
export default [
  {
    "id": "rulebook-words",
    "date": "2026-10-06",
    "title": "Rulebooks in plain English",
    "summary": "Wherever a rulebook appears, on Agents, starter setups, playbooks and approvals, it now reads as short sentences that list only what restricts the agent, such as \"Up to $1 in any 24 hours\" and \"Payments up to $20 each; asks you above $5\".",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#rulebook-words"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/5ab63d258741e0f1c5d47071ec82e924d88a7c47"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "stop-for-a-while",
    "date": "2026-10-06",
    "title": "Stop an agent for a while",
    "summary": "Stop now offers \"for 1 hour\", \"until tomorrow 9:00\" or \"until I resume\". A stopped agent shows when it starts again, and its first request after that time resumes it.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#stop-until"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/aa5828f202b1aca68d67a12a9e91381503b4d01a"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "balance-runway",
    "date": "2026-10-06",
    "title": "See how long your balance lasts",
    "summary": "Your balance now shows how long it lasts at your last 7 days' pace, and you can ask for a ping in your inbox and Telegram when it drops below an amount you choose.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#balance-runway"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/fd6791c7b4b50ea7bef826b59de48748a3e20b75"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "similar-model",
    "date": "2026-10-06",
    "title": "Model down? Try a similar one",
    "summary": "When no provider can serve a model right now, the error lists up to three working models with the same abilities and the closest price, and Chat offers each one as a button. Nothing switches on its own.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#errors"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/ce6f4c640812afc7ad5ec991e974daac113ae489"
      }
    ],
    "tags": [
      "chat",
      "build"
    ]
  },
  {
    "id": "deposit-countdown",
    "date": "2026-10-06",
    "title": "A countdown for deposits",
    "summary": "A deposit waiting for Robinhood Chain finality shows about how many minutes are left, and you get an inbox notice, plus a Telegram message if you linked it, when it is credited.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#deposit-countdown"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/4efba3c67e71f578969fa24ae6898ce1fef17547"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "weekly-summary",
    "date": "2026-10-06",
    "title": "A weekly summary in Telegram",
    "summary": "Turn on \"Weekly summary on Mondays\" on the Telegram card in Agents to get last week's spend per agent, approvals, stops and top model in one message.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#weekly-summary"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/f96ef30d5cb1ae6d44c1be12ee0015cbb4dc4cb1"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "site-links",
    "date": "2026-10-06",
    "title": "Links that open anyroute.tech",
    "summary": "Links people open from receipts, Telegram messages and status feeds now point to anyroute.tech. Signed receipts are unchanged.",
    "links": [
      {
        "label": "Open page",
        "href": "/verify/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/50ad5fc2235133aa746484c8d05c9c246399957f"
      }
    ],
    "tags": [
      "fix",
      "verify"
    ]
  },
  {
    "id": "proof-pack-browser",
    "date": "2026-10-06",
    "title": "Check a proof pack in your browser",
    "summary": "Drop a proof pack on /verify to check its signature, every receipt, the statements and the lane report on your own device. The file is never uploaded.",
    "links": [
      {
        "label": "Open page",
        "href": "/verify/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/b0615dd922e6d3359399a2778c9733cf0b73e806"
      }
    ],
    "tags": [
      "verify"
    ]
  },
  {
    "id": "unused-keys",
    "date": "2026-10-06",
    "title": "Clean up unused keys",
    "summary": "The Keys tab shows each key's last call and lists keys that haven't made a call in 30 days, so you can switch them off with one confirm.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#unused-keys"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/f787a5b9ecb9370b33bef4b6ca9e609427bf460d"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "approve-and-allow",
    "date": "2026-10-06",
    "title": "Approve and allow next time",
    "summary": "On an approval, \"Approve and allow next time\" shows the new ask-first amount first, then approves this request and raises only that agent's ask-first amount. Caps never change.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#approve-and-allow"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/d078097eae841c377041a160ae146b9424a1b955"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "team-playbooks",
    "date": "2026-10-05",
    "title": "One playbook for many agents",
    "summary": "Write a rulebook once as a playbook and have any number of agent keys follow it. Change the playbook and every key that follows it picks up the new rules.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#playbooks"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/e61e71f0f4b7bfc87eb84e12f1c75406a098ecf9"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "decision-tags",
    "date": "2026-10-05",
    "title": "Link a trade to the model call behind it",
    "summary": "An agent can stamp a model call with the SHA-256 of the order it is about to place. The signed receipt carries that hash, so /verify can show the order matches the call that informed it.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#decision-tags"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/455af02fe3ddbdf3ece61b18e883821f6507bfc6"
      }
    ],
    "tags": [
      "agents",
      "verify"
    ]
  },
  {
    "id": "auto-topup",
    "date": "2026-10-05",
    "title": "Key budgets that top themselves up",
    "summary": "A key's spending budget can refill from your account credits when it runs low, by an amount you choose and within a weekly limit. Each top-up is listed in Activity.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#auto-topup"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/fe28d8c48b8329cbd3d4f429691940b19b7766ed"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "lane-report",
    "date": "2026-10-05",
    "title": "See where your calls ran",
    "summary": "Statements now show your calls lane by lane, the share that ran on hardware with a verified attestation, and each provider's evidence links.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#statements"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/aea0a17c12b3783d3350be34baebccd47c4b7cf6"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/9ea3043f6384073ce02f06a4a242dbb6c52b008f"
      }
    ],
    "tags": [
      "verify"
    ]
  },
  {
    "id": "replay-rules",
    "date": "2026-10-05",
    "title": "Replay a rulebook before you save it",
    "summary": "Run a draft rulebook against your agent's decisions from the last 7 days and see what it would have allowed, asked about or denied, and how many decisions would change. Replay only reads; nothing changes until you save.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#replay-rules"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/d2933d856701b6f6ff87b197903f2f9034645093"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "agent-pay",
    "date": "2026-10-05",
    "title": "Pay another agent from your own wallet",
    "summary": "Your agent can pay another agent in USDG straight from your wallet. Your rulebook decides first, the router checks the transfer on chain and the payment gets a signed receipt. Anyroute never holds the money.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#agent-pay"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/ddcda0d1de6cf4dc7e04d263230241be96eca162"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "account-on-every-page",
    "date": "2026-10-05",
    "title": "Your account, on every page",
    "summary": "When you are signed in, the header shows your balance and a bell for approvals, alerts and deposits in progress. Approve, deny or check a deposit without leaving the page.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/509f8dcda3139f1b4d72492d5532041661afbc25"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/e51c3061b8890b1550ff709f72efa67a52196ca9"
      }
    ],
    "tags": [
      "build",
      "agents"
    ]
  },
  {
    "id": "cmdk-actions",
    "date": "2026-10-05",
    "title": "Do anything from Cmd-K",
    "summary": "The site search now runs actions as well as links: add funds, new API key, set a spending limit, stop or resume an agent, open a receipt, switch the chat model and set a default route. Changes keep the same confirm step as their page.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/ecb547c516f88295a20ab026d9b65cdc6ec49f63"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/bf7e05d2c66d08b61e0ca30f359f9cab6b9da257"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "one-ui-pass",
    "date": "2026-10-05",
    "title": "Chat, Labs and one account layout",
    "summary": "Harness is now called Chat, account tabs are grouped into five, Stop replaces kill in the interface, and a new Labs page lists what is switched off, read live from status.",
    "links": [
      {
        "label": "Open page",
        "href": "/labs/"
      },
      {
        "label": "Open page",
        "href": "/harness/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/571b4dcebc0f89dbfffe08e2f64205725737ba08"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/4827b09df111322a00cba873cc1245ec0104afac"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/b024bd7cc1c4508289d348cb7f70ad95c351e2ed"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/73c18a813ee93cd301f5dd362d98c08e90e98dd9"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/df64b28fdb83f69fbffc737ead338d3bff8c72c5"
      }
    ],
    "tags": [
      "build",
      "chat"
    ]
  },
  {
    "id": "starter-setups",
    "date": "2026-10-05",
    "title": "Start your limits from a setup",
    "summary": "Pick a setup (careful chatbot, trading agent, batch jobs, or proven hardware by default) and it fills the spending limits editor for you to review and save.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#starter-setups"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/09e68c58320b19ae997d9cddf610f0b045daf4b8"
      }
    ],
    "tags": [
      "agents",
      "build"
    ]
  },
  {
    "id": "one-spending-limits-editor",
    "date": "2026-10-04",
    "title": "One spending limits editor for chat, agents and API keys",
    "summary": "Budgets, ask-first amounts and the stop switch use the same editor in the chat, on /agents and for API keys, over the existing rulebook.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#spending-limits"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/fc1dc5f5923434eaf7254bce8d0828d822dbacd6"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "default-privacy-route",
    "date": "2026-10-05",
    "title": "Each key can choose its default privacy route",
    "summary": "A key or agent can send requests that name no route to standard, proven hardware first, or proven hardware only. The x-anyroute-default-route header shows when it applied.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#default-route"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/a53cda264c397a2fa8bdf616142ae6ca5b623d0a"
      }
    ],
    "tags": [
      "privacy",
      "build"
    ]
  },
  {
    "id": "proof-pack",
    "date": "2026-10-05",
    "title": "Download a proof pack",
    "summary": "One download of your calls, signed receipts, refunds and statements for a date range, with a script that checks it offline.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#proof-pack"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/8253073bfa6d41cba60e4176605e948c0841d718"
      }
    ],
    "tags": [
      "verify"
    ]
  },
  {
    "id": "route-cards",
    "date": "2026-10-04",
    "title": "Route cards where you pick a model",
    "summary": "The chat model picker and /models show price, routes, health and hardware proof for each model before you choose.",
    "links": [
      {
        "label": "Open page",
        "href": "/models/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/9419ee319023de42c26f7c58ffb0874e451b8601"
      }
    ],
    "tags": [
      "chat"
    ]
  },
  {
    "id": "request-limits",
    "date": "2026-10-05",
    "title": "Clear request limits",
    "summary": "Request bodies are capped (256 KB on /mcp, up to 20 messages per MCP batch) and traffic without a key is limited per client, with clear 413 and 429 answers. Limits for keys are unchanged.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#limits"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/46f7993ae35d7f4b37c86d426cc188de1671c2dc"
      }
    ],
    "tags": [
      "build",
      "fix"
    ]
  },
  {
    "id": "agent-guard",
    "date": "2026-10-04",
    "title": "Agent Guard: agents ask before acting with money",
    "summary": "Before a payment, trade or other action, an agent asks its rulebook and gets allow, deny or ask the owner; the owner approves on /agents or Telegram and can stop it. Rules apply to actions the agent checks first.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#agent-guard"
      },
      {
        "label": "Open page",
        "href": "/agents/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/1fc8d32579d105cdd75536ba5b057bdca06b5bf8"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "fast-escrow-credit",
    "date": "2026-10-04",
    "title": "$ANYR and stock-token deposits credit in seconds",
    "summary": "Escrow deposits are credited from the amount seen on chain within seconds, up to $25 per account, and settle when the chain finalizes.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#payments"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/4359a95eed6d46e8b8233610a41700644fa97493"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "add-funds-plain-words",
    "date": "2026-10-04",
    "title": "Add funds says what you will get",
    "summary": "The add-funds card shows the credit rate in plain words, an estimate for the amount you type and the per-deposit limit.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#payments"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/ffa3b73eeb9efa02aee264cd1939afe038cd8b43"
      }
    ],
    "tags": [
      "fix"
    ]
  },
  {
    "id": "models-temporarily-unavailable",
    "date": "2026-10-04",
    "title": "Models show when their provider is out of credit",
    "summary": "When an upstream provider account runs out of credit, its models are marked temporarily unavailable instead of failing when you send, and requests use another provider where one exists.",
    "links": [
      {
        "label": "Open page",
        "href": "/models/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/808eb9003d67324067ebaa35352580621226c0ba"
      }
    ],
    "tags": [
      "chat",
      "fix"
    ]
  },
  {
    "id": "pay-with-zkapi",
    "date": "2026-10-04",
    "title": "Pay with zkAPI on Sepolia (pilot)",
    "summary": "A Sepolia pilot: fund an ETH note with testnet ETH, prove the payment in your browser, make one capped call and withdraw. Your funding wallet is kept apart from your AI calls; calls within a lease are linked. Unaudited.",
    "links": [
      {
        "label": "Open page",
        "href": "/zkapi/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/7e652dd074cda57a109b936c0d248c22576ca9a3"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/2e96827dfe9d6b15aecbfbaaa8c0529b1b09f228"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/7b208f2e81d3a2d091c05dd880edfe36d309d18a"
      }
    ],
    "tags": [
      "build",
      "privacy"
    ]
  },
  {
    "id": "docs-match-status",
    "date": "2026-10-03",
    "title": "Status reports agreements, and the docs follow status",
    "summary": "GET /api/v1/status now reports agreements: the contracts, the start block and whether the isolated jury worker is posting rulings. A docs check compares the README, whitepaper, /docs and this changelog with status on every change and fails when they call a switched-off feature live; x402 now reads as built and switching on when configured.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#agreements"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/3ff57a887d610e9bd0d46888cbb8963e2f6adb74"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/66275f3cf59fcac0d78fc811b04b48698a88e911"
      }
    ],
    "tags": [
      "agents",
      "verify",
      "fix"
    ]
  },
  {
    "id": "trading-agents",
    "date": "2026-10-03",
    "title": "Run trading agents under rulebooks, with decision receipts",
    "summary": "Works with any OpenAI-compatible agent, including agents you run on Robinhood. Three trading starter rulebooks: fixed models, a daily model budget, and ask first after 60 calls an hour. Decision tags that sign an order intent's hash into each receipt, and per-call Stock Token prices and multiplier status, are built and stay off until a router switches them on.",
    "links": [
      {
        "label": "Read the docs",
        "href": "/docs/#trading-agents"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/50bd07c77ad4d60f9b42e9cea80df348de18db91"
      }
    ],
    "tags": [
      "agents",
      "verify"
    ]
  },
  {
    "id": "x402-facilitator",
    "date": "2026-10-03",
    "title": "Settle x402 payments for your own API on Robinhood Chain",
    "summary": "A hosted x402 facilitator for USDG on Robinhood Chain: supported, verify and settle for x402 v1 and v2, signed seller listings and a discovery index. USDG goes from the payer straight to the seller; the router only pays gas. Built, but off until an operator sets FACILITATOR_ENABLED; anyroute.tech has not, and /api/v1/status says so.",
    "links": [
      {
        "label": "Open page",
        "href": "/facilitator/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/150899151169e48fe2bb4920d82ff3647e7f3c64"
      }
    ],
    "tags": [
      "build",
      "verify"
    ]
  },
  {
    "id": "make-good-refunds",
    "date": "2026-10-03",
    "title": "Get a refund by rule when a call fails you",
    "summary": "Built, and off until an operator switches it on (not yet at anyroute.tech). When a paid call gets no answer, a failover costs more, a stream is cut off, repaired JSON still does not parse or an attested call lacks a fresh attestation, the router refunds by fixed rules with a signed refund receipt. Per-call payers are refunded on-chain.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#make-good-refunds"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/be5903d14390594b13e4a663c689c70257b3b527"
      }
    ],
    "tags": [
      "build",
      "verify"
    ]
  },
  {
    "id": "paid-tools",
    "date": "2026-10-03",
    "title": "Pay x402 tools from your Anyroute balance",
    "summary": "Built, and not switched on at anyroute.tech yet: with TOOLS_MARKET_ENABLED a key can pay any x402 tool priced in USDG on Robinhood Chain. The router pays the seller, charges the price plus its take with a signed tool.call receipt, applies your rulebook's tool limits and probes listed tools daily.",
    "links": [
      {
        "label": "Open page",
        "href": "/tools/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/d7d9d6cdb4b0bde2905d156e560c1410b45d4d8d"
      }
    ],
    "tags": [
      "agents",
      "build",
      "verify"
    ]
  },
  {
    "id": "receipt-backed-reputation",
    "date": "2026-10-03",
    "title": "Agent reputation only from people who paid",
    "summary": "Agents can link an ERC-8004 identity on Robinhood Chain, take feedback only from reviewers who paid them through Anyroute, weighted by the amount and fading over time, show a signed daily liveness check, and publish a signed track record with a Merkle proof over their receipts. Built and off by default; not switched on at anyroute.tech yet.",
    "links": [
      {
        "label": "Read the docs",
        "href": "/docs/#agent-identity"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/4a573a612a5642110d61038ef7906328e98eccbd"
      }
    ],
    "tags": [
      "agents",
      "verify"
    ]
  },
  {
    "id": "commerce-ledger",
    "date": "2026-10-03",
    "title": "Read an honest commerce ledger",
    "summary": "The commerce page counts paid settlements only once their receipts are anchored on Robinhood Chain, removes self-dealing (same owner, round trips within 24 hours, funding links) and shows every filtered figure beside the gross one. A published Dune query recomputes the on-chain part. It is built but not switched on at anyroute.tech yet.",
    "links": [
      {
        "label": "Open page",
        "href": "/commerce/"
      },
      {
        "label": "Read the methodology",
        "href": "/docs/#commerce-stats"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/636176d3921b5ed92a8fb944351971d12c2ce24e"
      }
    ],
    "tags": [
      "agents",
      "verify"
    ]
  },
  {
    "id": "x402-payment-recovery",
    "date": "2026-10-03",
    "title": "Recover a lost x402 answer without paying twice",
    "summary": "If a paid answer is lost to a timeout or a 502, 503 or 504, send the same request and payment with a PAYMENT-RECOVERY signature: the router sends the kept answer again, byte for byte, with no second charge. Answers stay sealed outside the database for 24 hours. Built, but off until an operator sets X402_PAY_TO; anyroute.tech has not.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#x402-recovery"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/140de14e5e0396efdb296e667286f149f74e4ee0"
      }
    ],
    "tags": [
      "agents",
      "build",
      "privacy"
    ]
  },
  {
    "id": "x402-v2-headers",
    "date": "2026-10-03",
    "title": "Pay per call with x402 v1 or v2 headers",
    "summary": "Where x402 is switched on, the router reads a v2 PAYMENT-SIGNATURE as well as X-PAYMENT, sends PAYMENT-REQUIRED beside the 402 body and the settlement in PAYMENT-RESPONSE too. Built, but off until an operator sets X402_PAY_TO; anyroute.tech has not.",
    "links": [
      {
        "label": "Read docs",
        "href": "/docs/#x402"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/a5a0ebdf37152c95934647c0c4e0d51c9a66f64a"
      }
    ],
    "tags": [
      "agents",
      "build"
    ]
  },
  {
    "id": "signed-webhooks",
    "date": "2026-10-02",
    "title": "See every webhook signed",
    "summary": "Webhook destinations get a signing secret shown once, and each delivery carries an HMAC signature and event id. Subscribe to approvals, deposits, agreement events, host status and alerts, with a delivery log and a sample event you can send.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/webhooks/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/1f012618d72ae4437fc82d59aac5713b84afc73c"
      }
    ],
    "tags": [
      "agents",
      "build",
      "verify"
    ]
  },
  {
    "id": "spend-insights",
    "date": "2026-10-02",
    "title": "See where your money goes",
    "summary": "Insights shows spend by day or week, model, key or agent and lane, plus live models with the same capability tags at a lower price for your mix. It compares prices, not quality.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#insights"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/01cb510a7efc2ff5ed6d9dd6ebd6b4c6c826f6e1"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "monthly-statements",
    "date": "2026-10-02",
    "title": "Download signed monthly statements and export your data",
    "summary": "Monthly statements reconcile balances, deposits, refunds, usage and fees, are signed with the router's receipt key and can be checked on /verify. Export your data downloads what your account can read as one JSON bundle.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#statements"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/eeff7310fb89e3a94a5e6855d486c6800bccf93a"
      }
    ],
    "tags": [
      "build",
      "verify"
    ]
  },
  {
    "id": "json-check",
    "date": "2026-10-02",
    "title": "Ask the router to check JSON answers",
    "summary": "Opt in with anyroute.json_check to validate a structured answer against its schema, or to repair it once with the same model. Both calls of a repair are billed and receipted, and a repair can still fail.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#structured-output"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/7ac9fdf50221277ddf1b08aebc6de1e717199c46"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "why-this-route",
    "date": "2026-10-02",
    "title": "See why each reply went to its provider",
    "summary": "Replies explain the routing choice: the reason, how many providers were eligible and why others were skipped, as a header, a signed receipt field and a note under each Harness reply.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#why-this-route"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/70aaece54f78db64682a92c8298d0a4abc282ed2"
      }
    ],
    "tags": [
      "chat",
      "verify"
    ]
  },
  {
    "id": "prompt-library",
    "date": "2026-10-02",
    "title": "Save and reuse prompts",
    "summary": "Keep named prompts in the Harness with {{variables}}, tags and an optional model, run them on several models, and import or export the library. Prompts stay in this browser.",
    "links": [
      {
        "label": "Open page",
        "href": "/harness/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/7c60e2333a1c5d2c5c6b6c5bc631f1be30480070"
      }
    ],
    "tags": [
      "chat"
    ]
  },
  {
    "id": "cost-estimator",
    "date": "2026-10-02",
    "title": "Estimate what a request will cost",
    "summary": "Price a request on every live model before signing in, with per-request and 30-day totals, capability filters and links into the chat. Prompts never leave the browser.",
    "links": [
      {
        "label": "Open page",
        "href": "/cost/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/beee72fcdeb57d68a605c12ed3523625edd13d5c"
      }
    ],
    "tags": [
      "build",
      "chat"
    ]
  },
  {
    "id": "live-previews",
    "date": "2026-10-02",
    "title": "Preview code in chat replies",
    "summary": "Code blocks in Harness replies get copy and download, and HTML, SVG and Markdown blocks open in a sandboxed preview with no network access. Scripts stay off unless you switch them on.",
    "links": [
      {
        "label": "Open page",
        "href": "/harness/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/332d0d78cba6c8c50116dae6a90a602e7694202e"
      }
    ],
    "tags": [
      "chat"
    ]
  },
  {
    "id": "starter-rulebooks",
    "date": "2026-10-02",
    "title": "Start an agent from a rulebook template",
    "summary": "Six starter rulebooks show every cap, lane, tool and working hour before you apply them, and Try a request asks the router whether a request would be allowed without spending.",
    "links": [
      {
        "label": "Open page",
        "href": "/agents/#rulebook-templates"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/dcaa1d7be2c4e11c5257cecfeb92aa6805cf0ef9"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "account-activity",
    "date": "2026-10-02",
    "title": "Follow account activity in one list",
    "summary": "Review calls, receipts, approvals, alerts, deposits and agreement events in one account activity feed. Filter the list and export it as CSV or JSON.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#activity"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/60e3d7a62eb953ff9af62ce09be804b57a101b1f"
      }
    ],
    "tags": [
      "build",
      "agents"
    ]
  },
  {
    "id": "account-home",
    "date": "2026-10-02",
    "title": "Manage your account in one place",
    "summary": "Dashboard and Agents share one account menu and sign-in. Account Home shows balances, spending, keys, agents, pending approvals and recent calls.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/3be8aae3dea93b6d6d402cdbfabd08f8819388ef"
      }
    ],
    "tags": [
      "build",
      "agents"
    ]
  },
  {
    "id": "account-inbox",
    "date": "2026-10-02",
    "title": "Check one inbox",
    "summary": "Review pending agent approvals, alerts, deposits, agreement events and host updates in one place. You can approve or deny agent requests there.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#inbox"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/a43aa69ab609af699ee353c45303d32ea9ca751e"
      }
    ],
    "tags": [
      "agents",
      "build"
    ]
  },
  {
    "id": "chat-limits",
    "date": "2026-10-02",
    "title": "Set a chat budget",
    "summary": "Turn on Limits in the Harness to set a spending cap, ask before replies above an amount you choose, and stop the chat session. The router enforces these rules for requests through Anyroute.",
    "links": [
      {
        "label": "Open page",
        "href": "/harness/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/75c52bc598f7b01c4ddaa11b44d41846cdb9b33c"
      }
    ],
    "tags": [
      "chat",
      "agents"
    ]
  },
  {
    "id": "chat-shortcuts",
    "date": "2026-10-02",
    "title": "Chat shortcuts work smoothly",
    "summary": "The Harness shortcut hint now matches its keys, and the model picker opens without a page-loading error.",
    "links": [
      {
        "label": "Open page",
        "href": "/harness/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/4889e203f0afa9e06b4950bcd66bd050053474c3"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/161e7bbe219721da1f3652a245e56c9bc1b5acf4"
      }
    ],
    "tags": [
      "chat",
      "fix"
    ]
  },
  {
    "id": "host-card-counts",
    "date": "2026-10-02",
    "title": "Read clearer host and model counts",
    "summary": "Host cards show probation once and use the correct wording for model counts. Chat counts include chat models rather than unrelated model types.",
    "links": [
      {
        "label": "Open page",
        "href": "/hosts/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/548193f28dd79c5fc4849d3ee448998a1c1b01dd"
      }
    ],
    "tags": [
      "network",
      "chat",
      "fix"
    ]
  },
  {
    "id": "model-catalog",
    "date": "2026-10-02",
    "title": "Find models by what they can do",
    "summary": "The model catalog and Harness picker share capability tags and filters. Find models that read or make images, use tools, or run on admitted network hosts.",
    "links": [
      {
        "label": "Open page",
        "href": "/models/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/2d56fd543f377ba0515e0c8ef55ea73065a61e1e"
      }
    ],
    "tags": [
      "chat",
      "build"
    ]
  },
  {
    "id": "proof-badges",
    "date": "2026-10-02",
    "title": "Read the same proof badges everywhere",
    "summary": "Chat replies, models, hosts and account receipts now use the same proof badges. Each badge explains what the evidence supports and links to its checks and limits.",
    "links": [
      {
        "label": "Open page",
        "href": "/verify/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/fa2765047de492d653e45770125640187b0fc312"
      }
    ],
    "tags": [
      "verify"
    ]
  },
  {
    "id": "tool-map",
    "date": "2026-10-02",
    "title": "Find tools across the site",
    "summary": "The header, homepage, footer and site search use one tool map. Search by what you want to do, including tools inside account sections.",
    "links": [
      {
        "label": "Open page",
        "href": "/#about"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/5fe3c094c78f7d8966f0f1e7ad42dd151d1447f1"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "agent-agreements",
    "date": "2026-10-01",
    "title": "Make agreements between agents",
    "summary": "Use USDG milestone escrow for agreements between agents. Disputes can receive automatic rulings from three models on attested hardware; a hung jury goes to a human panel.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#agreements"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/dab5afb85370c81f948d21464fc7c4632eebcd08"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/0529dffb17bff75ed6099dc357170f9433a6f651"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "agent-alert-feed",
    "date": "2026-10-01",
    "title": "Follow agent alerts",
    "summary": "Review agent alerts in the account feed and use spending webhooks or linked Telegram notifications. These channels help owners follow budget and rule events.",
    "links": [
      {
        "label": "Open page",
        "href": "/agents/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/6b5d42a339c9dbe4de6a004f010e2972b86d358c"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "agent-directory",
    "date": "2026-10-01",
    "title": "Publish an agent profile",
    "summary": "Opt in to a public profile with an owner-chosen rulebook summary and latest valid track-record certificate. Browse these profiles in the agent directory.",
    "links": [
      {
        "label": "Open page",
        "href": "/agents/directory/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/a538dfac5d999b1ac4df12bb60c6e9d0db4d48db"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "chat-history",
    "date": "2026-10-01",
    "title": "Organise your conversations",
    "summary": "Search, pin and rename Harness chats, or export and import them. These conversation tools work in your browser.",
    "links": [
      {
        "label": "Open page",
        "href": "/harness/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/84fd3802a0273eaa9e5020db72832cfa18d87918"
      }
    ],
    "tags": [
      "chat"
    ]
  },
  {
    "id": "chat-images",
    "date": "2026-10-01",
    "title": "Ask about pictures and make images",
    "summary": "Attach pictures to a chat with a model that reads images, or choose an image-output model to make an image. Attached pictures are re-encoded in the browser with metadata stripped.",
    "links": [
      {
        "label": "Open page",
        "href": "/harness/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/d53d7233d17f1ff6396202baea60fd0e104b0008"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/fdf3645cca9477a727cefd2c500cbb2d38e0069c"
      }
    ],
    "tags": [
      "chat"
    ]
  },
  {
    "id": "consistent-site-navigation",
    "date": "2026-10-01",
    "title": "Use the same header across the site",
    "summary": "Every page uses the black top bar, and the Arena follows the site’s light page design. Navigation stays consistent as you move between tools.",
    "links": [
      {
        "label": "Open page",
        "href": "/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/539ad2f9dcac8e39e7f7f004953a8a218048c230"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "harness-chat",
    "date": "2026-10-01",
    "title": "Chat with models in the Harness",
    "summary": "Choose a model and chat in a single conversation column, with the model picker and tools available on demand. Composer notes appear when they apply to the current request.",
    "links": [
      {
        "label": "Open page",
        "href": "/harness/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/4b7770f00d01ba78ca1cd072d90536dca9f3c8a5"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/4d7d7783512621686e1e8106effacae0e8c697a7"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/3edb1be5f599f884c1ccd9ba90215622147d3514"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/55a30cb3b093e6c1ab6a8b3cb8fdfe755709a88f"
      }
    ],
    "tags": [
      "chat"
    ]
  },
  {
    "id": "install-app",
    "date": "2026-10-01",
    "title": "Install the Harness from your browser",
    "summary": "Install the Harness on a phone or desktop using your browser. It is a browser app, not an App Store app.",
    "links": [
      {
        "label": "Open page",
        "href": "/harness/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/96e02484e7f955ca3b8d841f73fcf2eab5d446f8"
      }
    ],
    "tags": [
      "chat"
    ]
  },
  {
    "id": "network-stats",
    "date": "2026-10-01",
    "title": "Inspect live network stats",
    "summary": "See host status counts, available models, bonds and policy version on the network page. Token totals use coarse ranges.",
    "links": [
      {
        "label": "Open page",
        "href": "/network/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/6117f98e0b0c1f60f1c856a28ac3e3cab68ffd91"
      }
    ],
    "tags": [
      "network",
      "verify"
    ]
  },
  {
    "id": "public-whitepaper",
    "date": "2026-10-01",
    "title": "Read the Anyroute whitepaper",
    "summary": "The whitepaper explains the architecture, payment design and routing model. Read it from the site alongside the developer reference.",
    "links": [
      {
        "label": "Open page",
        "href": "/whitepaper/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/6db59379809d59cccc1a396e364eb4011200bc10"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "sealed-agents",
    "date": "2026-10-01",
    "title": "Host an agent on attested hardware",
    "summary": "Use the sealed agent hosting recipe to build and publish an agent sidecar image. The router checks its registered TDX quote; no sealed agent is registered on this site yet.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#sealed-agents"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/fad4d8d6c6f30de042bda08fa487cd52308a702c"
      }
    ],
    "tags": [
      "agents",
      "verify"
    ]
  },
  {
    "id": "telegram-approvals",
    "date": "2026-10-01",
    "title": "Approve agent requests in Telegram",
    "summary": "Link Telegram from Agents to approve or deny agent requests and receive alerts. Approval details pass through Telegram.",
    "links": [
      {
        "label": "Open Agents",
        "href": "/agents/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/02ad3268dbb6cca6c80b6f009a04e8a03925c6b2"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "voice-chat",
    "date": "2026-10-01",
    "title": "Speak in the Harness",
    "summary": "Use browser speech to talk with a model and hear replies. Local voices are preferred; remote speech is used only if you opt in.",
    "links": [
      {
        "label": "Open page",
        "href": "/harness/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/12ec939b3df1c0f9aac41f61dcc79476d505862f"
      }
    ],
    "tags": [
      "chat",
      "privacy"
    ]
  },
  {
    "id": "agent-circuit-breakers",
    "date": "2026-09-30",
    "title": "Stop an agent when limits are crossed",
    "summary": "Agent circuit breakers stop subsequent requests when the configured conditions are crossed. Owners can review the stop and resume the agent; these controls apply to requests through Anyroute.",
    "links": [
      {
        "label": "Open page",
        "href": "/agents/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/60051caacc87cf5cc389bd7f52e7d1ee13493535"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "agent-controls",
    "date": "2026-09-30",
    "title": "Set rules and approvals for agents",
    "summary": "Set model, lane, tool, time and spending rules for an agent, and stop its next request with the kill switch. Requests above your chosen approval amount require a single-use approval that expires after 15 minutes; rules apply to requests through Anyroute.",
    "links": [
      {
        "label": "Open Agents",
        "href": "/agents/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/0eea9eadcfa9e177545df72257d21504c65154a5"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/fa978544d429c9a01d135df49184e64840eb50de"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/b669108545fa283e95da908f395c64dae7a28b0d"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "agent-progressive-caps",
    "date": "2026-09-30",
    "title": "Adjust agent budgets from their track record",
    "summary": "Progressive autonomy adjusts an agent’s spending caps within configured limits as its record changes. The router enforces the resulting caps for requests through Anyroute.",
    "links": [
      {
        "label": "Open page",
        "href": "/agents/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/1372b15efe5893444b650fde94b13da21bd27267"
      }
    ],
    "tags": [
      "agents"
    ]
  },
  {
    "id": "agent-records",
    "date": "2026-09-30",
    "title": "Review agent receipts and track records",
    "summary": "Inspect an agent ledger with signed receipts and CSV or JSON exports. Share router-signed track-record certificates that use a fresh pseudonym and last seven days.",
    "links": [
      {
        "label": "Open Agents",
        "href": "/agents/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/d88d370411880a3dbbebcd49cdc090ccfae16e2f"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/76359ef87ece561715eca364349c416a3f679697"
      }
    ],
    "tags": [
      "agents",
      "verify"
    ]
  },
  {
    "id": "agent-rule-tools",
    "date": "2026-09-30",
    "title": "Let an agent check its rules first",
    "summary": "Agents can read their own rulebook and check a proposed action through MCP tools. The router still enforces those rules when a request is sent through Anyroute.",
    "links": [
      {
        "label": "Open page",
        "href": "/agents/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/099ebb26b28198a8275f1fa79cb56127bb54ae50"
      }
    ],
    "tags": [
      "agents",
      "build"
    ]
  },
  {
    "id": "answer-privacy-labels",
    "date": "2026-09-30",
    "title": "Read what a receipt says about privacy",
    "summary": "Receipt labels explain prompt readers, network and payment links, storage and hardware evidence. The verify page and Telegram show these labels, including reply-cache retention and address-based rate-limit limits.",
    "links": [
      {
        "label": "Open page",
        "href": "/verify/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/de35a769db6ae2bbafb8f27d2640b400e69c390f"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/307b30458bfd0fb8b283468e90dfd5d076e87880"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/44c3a4fb7b8ee21c1314196da99eada17ef5b829"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/641513a938191d75f91f674544f23e7f690a10f9"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/1a3a53d0b2ebd205c7a724e30702fda7f50a141b"
      }
    ],
    "tags": [
      "privacy",
      "verify",
      "fix"
    ]
  },
  {
    "id": "ask-your-files",
    "date": "2026-09-30",
    "title": "Ask questions about text and PDF files",
    "summary": "Read text and PDF files in the browser, then ask questions with cited passages on Ask your files. The router processes submitted text in memory; the page does not upload a file to a server-side document store.",
    "links": [
      {
        "label": "Open page",
        "href": "/ask/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/272e9d36fc5760e4564158dfb7217e8ece639662"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/1bb6a47953a9fa71e691597eba371be1170c9b3c"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/5d477d62c067af2456c017f566d2287489d448d6"
      }
    ],
    "tags": [
      "chat",
      "privacy"
    ]
  },
  {
    "id": "character-cards",
    "date": "2026-09-30",
    "title": "Import and use character cards",
    "summary": "Import character cards, choose their visibility and call them with @character. Character memory uses a client-sealed ledger, with the card’s controls in the dashboard.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#characters"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/7558ff92b964de93b1a3973f7b52482bb54ee012"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/d393b2020492ed50f82ac2ecc80d160573aa2fb8"
      }
    ],
    "tags": [
      "chat",
      "build",
      "privacy"
    ]
  },
  {
    "id": "data-storage-inventory",
    "date": "2026-09-30",
    "title": "Inspect what Anyroute keeps",
    "summary": "What we keep lists database columns, temporary stores, logs and places request text or addresses are read. The page publishes the inventory hash and the available transparency-log evidence.",
    "links": [
      {
        "label": "Open page",
        "href": "/keep/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/72b65ad109a0121118545486bb4c6aecd3e54672"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/2e55558027703f93752cfa3982c5d131400e924b"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/26ce4649e5023654e9d45f8115253fe7ca6e1f99"
      }
    ],
    "tags": [
      "privacy",
      "verify"
    ]
  },
  {
    "id": "encrypted-chat",
    "date": "2026-09-30",
    "title": "Use encrypted chat through the attested gateway",
    "summary": "Encrypt chat on your device for the attested gateway; the router forwards ciphertext on this path. Ordinary chat paths still let the router read request text in memory.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#e2ee-phala"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/4e0a2cc9c175de23045b6d521f1fe66c43a4cdd0"
      }
    ],
    "tags": [
      "chat",
      "privacy"
    ]
  },
  {
    "id": "harness-private-mode",
    "date": "2026-09-30",
    "title": "Choose the attested lane in one switch",
    "summary": "Private mode in the Harness selects attested models and shows privacy labels. Its browser history is encrypted on the device; ordinary chat requests remain readable by the router.",
    "links": [
      {
        "label": "Open page",
        "href": "/harness/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/c5507b89b6e6ba0225533db8fefc30608c2da9be"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/462c91e8d93365c100dc1365e0407724a1a7288f"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/1d55f20afabcac80b565029ce2bd620ddff7bec4"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/d62a47d3ebe9c18b5b362db9cbd370fd2fb0210b"
      }
    ],
    "tags": [
      "chat",
      "privacy"
    ]
  },
  {
    "id": "join-network",
    "date": "2026-09-30",
    "title": "Join the network with an approved host",
    "summary": "Register an early host with one command using the approved Intel TDX build in a supported confidential VM. Admission checks hardware evidence, the signed host policy and operator addresses; new hosts start on probation.",
    "links": [
      {
        "label": "Open page",
        "href": "/network/#join"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/66b45a16c36bca828800331028a6141316097f55"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/b29b20a6165d45bd4ddd7927655c38eddaaf97fa"
      }
    ],
    "tags": [
      "network"
    ]
  },
  {
    "id": "lane-status-page",
    "date": "2026-09-30",
    "title": "Check service status by lane",
    "summary": "The public status page shows lane availability, service-level observations and incidents. Inspect current health alongside recent proof-time checks.",
    "links": [
      {
        "label": "Open page",
        "href": "/status/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/795da879040f4dd0a05ba13205475e68ac10a290"
      }
    ],
    "tags": [
      "verify",
      "network"
    ]
  },
  {
    "id": "network-hardware-readiness",
    "date": "2026-09-30",
    "title": "Check hardware before joining the network",
    "summary": "Use the network hardware checker to inspect readiness and register interest. The network page explains the requirements for the approved host build.",
    "links": [
      {
        "label": "Open page",
        "href": "/network/#readiness"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/53921796f9e9e3cbe2642472cc83f3ca7db6264b"
      }
    ],
    "tags": [
      "network"
    ]
  },
  {
    "id": "network-host-bonds",
    "date": "2026-09-30",
    "title": "Inspect host bonds",
    "summary": "The router indexes USDG host bonds from the HostBond contract and includes them in host records. The network page explains the bond requirements for early hosts.",
    "links": [
      {
        "label": "Open page",
        "href": "/network/#bonds"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/56a465cb5920111fd1a9141c7e0889bfb0cf9af9"
      }
    ],
    "tags": [
      "network",
      "verify"
    ]
  },
  {
    "id": "ollama-compatible-api",
    "date": "2026-09-30",
    "title": "Connect an Ollama-compatible client",
    "summary": "Use Ollama-format chat, generation and embedding requests against the router’s models. Authenticated calls keep the router’s billing, lanes and receipts; no model weights are installed on your device.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/746862e7c35f32d9a09f99e4a59b3579048a2bc1"
      }
    ],
    "tags": [
      "build",
      "chat"
    ]
  },
  {
    "id": "private-token-wallet",
    "date": "2026-09-30",
    "title": "Buy private tokens from your browser",
    "summary": "Buy blind tokens with a wallet payment and save them for the onion path. Blinding separates token spending from purchase, while the payment itself remains visible on chain.",
    "links": [
      {
        "label": "Open page",
        "href": "/tokens/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/b4f984681e047882c66b145219af8ef28c3e9ca1"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/fdbc8ccf42a1647627f3e2692bc408b7927829be"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/9120ba341a270c2d51cd5674af6369bc60fcae56"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/45ea22e106c9ab3dd79a086e4819ed5fd3c91f9b"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/08b3453a3dd704a06435b5044964d9089886a084"
      }
    ],
    "tags": [
      "privacy",
      "build"
    ]
  },
  {
    "id": "provider-build-history",
    "date": "2026-09-30",
    "title": "Keep a record when a host build changes",
    "summary": "Signed measurement bundles bind recorded builds to source, images and model details. A changed compose hash becomes a new measurement while the previous one remains in history.",
    "links": [
      {
        "label": "Open page",
        "href": "/verify/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/770eedf8b58868f80f328cb3ad22404a65951c46"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/bf128feda4fc35af567e70ba17dd566e434d6e43"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/bbe4e5d83d2da7a123070cf8f171059b29d740e3"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/2abe5ef8508494b49737a34f11db9c58544dc3ba"
      }
    ],
    "tags": [
      "verify",
      "network"
    ]
  },
  {
    "id": "public-host-history",
    "date": "2026-09-30",
    "title": "Inspect an attested host’s public record",
    "summary": "Browse host records with hardware evidence, build history and work roots. Host cards show admission status and the recorded routing weight.",
    "links": [
      {
        "label": "Open page",
        "href": "/hosts/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/de03afa75ceedda0384b3d45a694cd1a1f54a343"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/1cd4a2b5f8ea49ab671e63db0b287e30f25afbbb"
      }
    ],
    "tags": [
      "network",
      "verify",
      "fix"
    ]
  },
  {
    "id": "public-key-log",
    "date": "2026-09-30",
    "title": "Inspect published keys in a transparency log",
    "summary": "Published and rotated keys are recorded in a signed transparency log. Checkpoints are anchored in Sigstore Rekor so their public history can be inspected.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#key-log"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/04656c09603a636e5bf7ef640b3fb0a0d54b8993"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/c8cfa759a9a080d12766c1cc86ff58f56b875102"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/3e615af15d603dd353694fc157276e3e95e1b6d1"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/a26221873bce0846d7f8c585f62988e342fff087"
      }
    ],
    "tags": [
      "verify",
      "privacy"
    ]
  },
  {
    "id": "request-tracing",
    "date": "2026-09-30",
    "title": "Send request traces to your collector",
    "summary": "Export request traces in the OpenTelemetry GenAI format to a collector you configure. Use them to inspect request timing and routing from your own tools.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#api-keys"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/d4f7e515f5d9af2b34c11edfa25a59322c557d81"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "rerank-and-routing-options",
    "date": "2026-09-30",
    "title": "Rank passages and choose routing preferences",
    "summary": "Use the rerank endpoint to order passages for a query. The model routing options also support :nitro and :floor variants for provider selection.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/3868e8590f5ac4ebac1d7ae0e0a82b92e7d04568"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "server-request-batches",
    "date": "2026-09-30",
    "title": "Follow a batch on the server",
    "summary": "Submit request batches through the Batch API or dashboard and follow their progress. Download completed results and errors for individual requests.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#batch-studio"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/1c0f6045abe25d078592c72eed596863c5976bc8"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/8df11b1fe7949bc987f7fb9df60348e347c71120"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "signed-host-policy",
    "date": "2026-09-30",
    "title": "Read the signed host admission policy",
    "summary": "Inspect the public, signed policy that defines which host builds can join. Admission screens operator addresses against the public sanctions list.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#network-host-policy"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/1992bc6e0a514be80be96c24183966f0ebbeff43"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/becb10ca578acef7d15d52bebf500ca4b763bce5"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/57b3ae1bc35b762257c36d004435b97d7eb02b1e"
      }
    ],
    "tags": [
      "network",
      "verify"
    ]
  },
  {
    "id": "skill-scan-reports",
    "date": "2026-09-30",
    "title": "Inspect a skill before installing it",
    "summary": "The Skills section lists skill hashes, scan reports and installation details. Read the reported findings before choosing a skill; a scan is not a guarantee about its behaviour.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#skills"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/df0963aef1827a449a3e1439a43a219bca635cd4"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/498b1ba447ed0d1840ad641e5d60d3bd08a0cddd"
      }
    ],
    "tags": [
      "build",
      "agents",
      "verify"
    ]
  },
  {
    "id": "team-account-controls",
    "date": "2026-09-30",
    "title": "Manage a team with passkeys and roles",
    "summary": "Create a team with passkey sign-in, roles, invitations and budgets. Team actions have a hash-chained audit record.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#teams"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/bcbfbc77cbf0cd9629c34ec612f601cb07473086"
      }
    ],
    "tags": [
      "build",
      "agents"
    ]
  },
  {
    "id": "tor-app-proxy",
    "date": "2026-09-30",
    "title": "Connect an existing app through Tor",
    "summary": "Use the single-file proxy to connect an OpenAI-compatible app through the onion service with blind tokens. The router reads the request text after it arrives; this proxy does not encrypt text through the router.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#private"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/386698d803be536d1aa22f7403c25eeb79a250aa"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/664f710353e3b40b3f868dd0850e737f9dcf57b9"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/d93ec41dedb1252bc64795231bd96935d6d09bf9"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/efad5e4211e0e858832a6469cde0e953ba4e5304"
      }
    ],
    "tags": [
      "build",
      "privacy"
    ]
  },
  {
    "id": "unlinkable-tor-lane",
    "date": "2026-09-30",
    "title": "Use blind tokens over the onion service",
    "summary": "Use the unlinkable lane through Tor onion access with blind tokens. This path separates the spent token from its purchase; the router still reads request text in memory.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#unlinkable-tor"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/c5974f71eb38c261e6f01e81eba1ff5891603644"
      }
    ],
    "tags": [
      "privacy",
      "chat"
    ]
  },
  {
    "id": "versioned-presets",
    "date": "2026-09-30",
    "title": "Save and revise prompt settings",
    "summary": "Reuse prompts, models and settings through named presets. Inspect version differences and roll back to an earlier version.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#presets"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/2f262fd89eeff16aaff751720c72a89af051746e"
      }
    ],
    "tags": [
      "build",
      "chat"
    ]
  },
  {
    "id": "agent-sessions",
    "date": "2026-09-29",
    "title": "Give an agent a short-lived key",
    "summary": "Create an agent session with a budget and expiry time. Session management and history stay scoped to the owning account, and pagination keeps sessions from being missed.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#agent-sessions"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/cd950c84c08ca9e33dcf94d6a09ea162253417a3"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/ab6741f4ef20c4979527b52390d767aa9ad96372"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/3921672071fa0a80b73cc61eb5c5f59e3c1f021f"
      }
    ],
    "tags": [
      "agents",
      "build"
    ]
  },
  {
    "id": "anyr-escrow",
    "date": "2026-09-29",
    "title": "Add account credits with $ANYR",
    "summary": "Use the dashboard to send $ANYR to escrow and follow the deposit until it becomes account credit. Deposit status stays visible alongside the account’s other payments.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#payments"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/3da83ce4b164156156e3bb814bfd91c2115a5782"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/cc3f065cc261f4a4c7eb53bfb9825d6591b6ecca"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "attested-provider-checks",
    "date": "2026-09-29",
    "title": "Check hardware evidence before routing a call",
    "summary": "The attested path checks provider hardware evidence and binds the serving connection to it. Gateway answers are accepted only with a verified receipt; this does not hide ordinary request text from the router.",
    "links": [
      {
        "label": "Open page",
        "href": "/verify/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/fea6da996a75eba186954e55e5e4983df7a48862"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/dcfc2deeacd8f3d89ea61d7e7045259e173e8050"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/9f166838d291aa0d8de736d0c698ed6643fd4233"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/172c9ed8f9596dbe40a6815f6e73719828392f81"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/9ebb212dd7b0104c5fe0ab25a93dae19a88db36a"
      }
    ],
    "tags": [
      "verify",
      "privacy"
    ]
  },
  {
    "id": "browser-batches",
    "date": "2026-09-29",
    "title": "Run groups of requests from the browser",
    "summary": "Upload JSONL or CSV requests and run them from the dashboard, including on the attested lane. Batch and evaluation controls show errors and respect retry delays from the router.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#batch-studio"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/5b347ece9c82ef1ccc9c8ee8a50c47ebb4648270"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/fad9d33ab43c5c125dda0cbb8fb3b4ad50f55efc"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/77bec4cc35d51e21ef3266e4fd8b054eb9e92613"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "browser-key-security",
    "date": "2026-09-29",
    "title": "Protect wallet sign-in and browser keys",
    "summary": "Wallet sign-in requires a single-use server challenge, and the website keeps API keys within the browser session. Script execution and external connections are restricted to reduce exposure.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/5e9c11e7e20ec1f8036d648dbf96cd1dbd25b1ca"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/28b53cbcc2586daf90785d0e82f7d429cc1dfa25"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/bcb674fbc1b87c4cffa008f98bd49118481a2cba"
      }
    ],
    "tags": [
      "privacy",
      "fix"
    ]
  },
  {
    "id": "document-question-api",
    "date": "2026-09-29",
    "title": "Ask questions from documents in one request",
    "summary": "Send documents with a question to retrieve relevant passages and get a cited answer. Documents are processed in memory, and each embedding and chat step uses the account’s billing, lane rules and receipts.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#rag"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/cb68d1e51070b01e0932bc956736b88998e07990"
      }
    ],
    "tags": [
      "chat",
      "privacy"
    ]
  },
  {
    "id": "evaluate-models",
    "date": "2026-09-29",
    "title": "Compare answers against your own cases",
    "summary": "Run your own cases across models in the dashboard and compare their answers side by side. Results show usage and cost for the calls you made.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#eval-lab"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/3594db6f68140a6ac8937f976f6bc8afedf4b49e"
      }
    ],
    "tags": [
      "chat",
      "build"
    ]
  },
  {
    "id": "holder-account-details",
    "date": "2026-09-29",
    "title": "Inspect $ANYR account benefits",
    "summary": "The Holders section brings balance, tier and credit details into the dashboard. Inspect the benefits recorded for the connected account.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#holders"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/c2b464bcaba852b872d34c2198a6c33e882aaff9"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/5c0b3d917c16360305d0a02c3f32ce3cea0810be"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/a8a9479be23b841cc57e399c9b051cc72bb5d2c9"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "host-receipt-roots",
    "date": "2026-09-29",
    "title": "Check receipts against a host’s work record",
    "summary": "Receipts signed by an attested host can be checked against that host’s receipt root. Each root records the receipt key and attestation reference; it is marked anchored only after publication on chain.",
    "links": [
      {
        "label": "Open page",
        "href": "/verify/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/4ff890a4c5716b561758aaaeb767ec3c78b733c2"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/4fae16912c98acf0727eed85b85ebffed1d80c75"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/32d6b091dc321ea7cc9eb7753681d21f649e067a"
      }
    ],
    "tags": [
      "verify",
      "network"
    ]
  },
  {
    "id": "key-policy-cache-isolation",
    "date": "2026-09-29",
    "title": "Keep key rules and cached replies separate",
    "summary": "Key policies apply to gateway requests, and cached replies are separated by account and forwarded end user. A requested cache lifetime cannot exceed the operator’s maximum.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/f434b780e280d298687144d277b2bfec72f85c59"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/6b157b6401c8c5d228a3c6c1d44a1c0cfc9f27ab"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/8b2d9f30023e98578bc58e67a1d633f963579113"
      }
    ],
    "tags": [
      "privacy",
      "fix"
    ]
  },
  {
    "id": "messages-api",
    "date": "2026-09-29",
    "title": "Use the Messages API with your models",
    "summary": "Send Messages-format requests and receive Messages-format replies or streams. The adapter uses the router’s chat path with the same key, billing, lanes and receipts.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/782fcdff937c5b280a86a5e5ec0dfb89fe1904f0"
      }
    ],
    "tags": [
      "build",
      "chat"
    ]
  },
  {
    "id": "model-arena",
    "date": "2026-09-29",
    "title": "Compare models in the Arena",
    "summary": "Send one prompt to several models and compare answers, timing and cost. Use model presets, attested-only selection and proof badges, and choose whether to create a share link.",
    "links": [
      {
        "label": "Open page",
        "href": "/arena/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/7fc736940905de5c9ba2e5db6256a449188f9f68"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/889142132f46b0fc08dc3d193dce4c0bb35c1a6f"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/67e2396400c9c0061accb6ec84c09471bc3b98e7"
      }
    ],
    "tags": [
      "chat",
      "verify"
    ]
  },
  {
    "id": "proof-freshness",
    "date": "2026-09-29",
    "title": "Inspect provider health and proof freshness",
    "summary": "Read provider availability, attestation summaries and the history of hardware checks and probes. Proof-time observations show when checks occurred and explain their limits.",
    "links": [
      {
        "label": "Open page",
        "href": "/status/#proof-time"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/0d4a846f71b76f3db4e509a55bec3cd662acb4f1"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/58f0032f49d1693e661663e4797c64caf83de798"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/a8dc7d8d260b4a1ea58a3401a53e649d470598b6"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/8e72a717b9f639015630331b45af2ba61bb0e605"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/112f94a0ec08e47d66f7548cd90dd25987b91876"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/b990da0bc4e8420f90cf2c538dc13e91529cac44"
      }
    ],
    "tags": [
      "verify",
      "network"
    ]
  },
  {
    "id": "provider-approval",
    "date": "2026-09-29",
    "title": "Require review before a provider can route calls",
    "summary": "Provider applications require approval of the reviewed revision before they can serve requests. Provider credentials are protected and outbound destinations are checked.",
    "links": [
      {
        "label": "Open page",
        "href": "/providers/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/e3614db26ec9e0308fc15494131f171c08f1439d"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/cf0cb891cbeee4c5c23b25114b3fa9c78e481af1"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/8e7f91b59e21ec27a13ac1dec0aef4cd23166876"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/95ba03ae895957a61df13dbfd491bead3e394aee"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/5c863102fb7c4d7dfe1edeeafc14fedccd9be77f"
      }
    ],
    "tags": [
      "network",
      "privacy",
      "fix"
    ]
  },
  {
    "id": "public-provider-records",
    "date": "2026-09-29",
    "title": "Browse providers and their model offers",
    "summary": "The router refreshes provider model offers, and the site shows providers with their attestation status and public registry records. An embeddable badge links a provider’s status to its evidence.",
    "links": [
      {
        "label": "Open page",
        "href": "/providers/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/fcc635f8ccf3c828224bf15c4b5bfe2e1e079583"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/c3a0ed459bebd56458935d93eab0a12010feec8d"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/523fa84de1124e641f3d3f04333a0c734a613fda"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/9a920f6596db260f58dc31867a903f538a20f4f7"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/e55950022c930d675a914a38ad2cd5d46cabfd77"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/c65924a26a4d9bcc511c38eeebef52ff5ab0ea26"
      }
    ],
    "tags": [
      "network",
      "verify",
      "build"
    ]
  },
  {
    "id": "public-receipt-verifier",
    "date": "2026-09-29",
    "title": "Verify receipts in your browser",
    "summary": "Use the public verify page to inspect a receipt signature and provider attestation evidence. The page explains what each check establishes and its limits.",
    "links": [
      {
        "label": "Open page",
        "href": "/verify/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/7a37937e7de4eac6ff4fa499aabd1ff4e3177c91"
      }
    ],
    "tags": [
      "verify"
    ]
  },
  {
    "id": "receipt-response-headers",
    "date": "2026-09-29",
    "title": "Read receipt and lane details from API replies",
    "summary": "API replies carry the receipt ID, lane and applicable policy hash in response headers. Adapters pass these details through so a client can connect an answer to its evidence.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/dbcca0fc200263fe30eb847ed5177b58be339253"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/8d1453d1ddfcf678e1bbc67d9f13e0623090e5d5"
      }
    ],
    "tags": [
      "build",
      "verify"
    ]
  },
  {
    "id": "remote-agent-tools",
    "date": "2026-09-29",
    "title": "Connect tools through MCP",
    "summary": "Connect an MCP client to list models and call the router with your key. Tools can select attested models and inspect provider evidence; calls retain the router’s billing and receipts.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#mcp"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/beb49c4445a674ad53ac4a0e1ee85c69084085a8"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/5162e4a5035a1242259c56f0e3c77bc09a6163d6"
      }
    ],
    "tags": [
      "agents",
      "build",
      "verify"
    ]
  },
  {
    "id": "responses-api",
    "date": "2026-09-29",
    "title": "Use the Responses API with your models",
    "summary": "Send Responses-format requests, including function and freeform tool calls, through the chat router. Send the conversation on each request; stored conversations and provider-hosted tools are refused.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#responses"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/5ef449d45b8d0cdfeea533d4a8e4a085358a0ca0"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/66c74003e33fb815722b4815cfb014c40f4e87a2"
      }
    ],
    "tags": [
      "build",
      "chat"
    ]
  },
  {
    "id": "routing-lane-rules",
    "date": "2026-09-29",
    "title": "Keep calls on the requested lane",
    "summary": "Choose a public, attested or unlinkable lane without a silent fallback to weaker routing. Adapter requests preserve lane errors and restrictions across their underlying calls.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#lanes"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/067230e05fd27eddeb7f2e8d30318cb177ae0ac0"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/b5d07ad081a88a7f5962eb1ff5020825aa5626b2"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/0f7844b3a5f7b23e7ddb6c1d9a9a71f5c44f3b45"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/3cb7d6259e8516f471c7e0ad63ee74d6f0cc5804"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/180a2b5cedd00f52af0ac1fef0691ceaf403294b"
      }
    ],
    "tags": [
      "privacy",
      "fix"
    ]
  },
  {
    "id": "saved-routing-policies",
    "date": "2026-09-29",
    "title": "Reuse model routing choices",
    "summary": "Save model choices and fallbacks as a named route, then call it with @route/<slug>. Pin the attested lane or a disclosure ceiling; the dashboard explains when a route cannot be saved.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#saved-routes"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/bcec1a05846fe05434f1aa5edc1453c2fdfa9603"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/e5621531345e94a9d3096049979cb1fa0171dfeb"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/85cefc4f47579166d54f3aaccc56015553084a9e"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/4006e84668ee728f88bd9a270025e5b2da8a8605"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/cb1c6b9669e62199a56663ed51b924def9a3a789"
      }
    ],
    "tags": [
      "build",
      "privacy"
    ]
  },
  {
    "id": "seal-protocol-pages",
    "date": "2026-09-29",
    "title": "Read SEAL and its published specification",
    "summary": "Browse the SEAL overview and specification on the site. Read the protocol’s evidence formats, available paths and implementation limits.",
    "links": [
      {
        "label": "Open page",
        "href": "/seal/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/0364204a433235e141c7bc475c6858b674a89ee7"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/b9006ef2baf443c007f40456f226e83d7f283d8b"
      }
    ],
    "tags": [
      "privacy",
      "verify"
    ]
  },
  {
    "id": "spend-watch",
    "date": "2026-09-29",
    "title": "Watch spending by key and model",
    "summary": "Inspect spending breakdowns and key budgets in Spend Watch. Set spending thresholds and webhook alerts for your account.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#spend-watch"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/28915c71c8babf60de63652f1e233a92f2ed70c3"
      }
    ],
    "tags": [
      "build",
      "agents"
    ]
  },
  {
    "id": "stock-escrow",
    "date": "2026-09-29",
    "title": "Add credits with Stock Tokens and track deposits",
    "summary": "Send supported Stock Tokens to escrow and follow the confirmation wait and deposit status in the dashboard. Only final transfers receive credits, and credits are reversed if a chain reorganisation removes a transfer.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#payments"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/f13d394e8d4a267fa22faa83ccd6431c0cf189fe"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/ee2c99c5d8c7d99ee3250f9dc1f3e041a5da91b3"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/b5829db7ea311df8489e2747cee141d780203d5d"
      }
    ],
    "tags": [
      "build",
      "fix"
    ]
  },
  {
    "id": "telegram-chat",
    "date": "2026-09-29",
    "title": "Chat with Anyroute in Telegram",
    "summary": "Link your key to the Telegram bot and choose a model for chat. Its private mode selects the attested lane; messages still pass through Telegram and the router.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/5f1c03ffb0631ef465ab3898b9e82b1e137f17da"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/f8d62bc9e78ae754e0fa99582b01b3b35378d2e8"
      }
    ],
    "tags": [
      "chat",
      "privacy"
    ]
  },
  {
    "id": "tor-onion-access",
    "date": "2026-09-29",
    "title": "Reach Anyroute through Tor",
    "summary": "Connect to the router’s onion service through Tor. Onion traffic uses rate limits that do not rely on the client’s network address; ordinary request text remains readable by the router.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#unlinkable-tor"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/8246fcf94b93bf8d9d96da4f6b8dbae04521d606"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/b698238a12aaa8137b5f897942310036616061c0"
      }
    ],
    "tags": [
      "privacy"
    ]
  },
  {
    "id": "dashboard-navigation",
    "date": "2026-09-28",
    "title": "Open account sections by link",
    "summary": "Dashboard links keep their selected section when opened directly. Keyboard focus follows navigation so account controls are easier to reach.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/e217905743e8615b26ca47a5d5018b74abb3632b"
      }
    ],
    "tags": [
      "build",
      "fix"
    ]
  },
  {
    "id": "developer-reference",
    "date": "2026-09-28",
    "title": "Read the API reference",
    "summary": "Browse the developer docs and the public OpenAPI reference. Find request formats, payment instructions and endpoint details in one place.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/e353f93323197ca4034925ea492e11c4e670df30"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/3af1dbfdc29c3002a0f2c3022af174f7ca62f27b"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "public-status-details",
    "date": "2026-09-28",
    "title": "Read status without internal diagnostics",
    "summary": "Public status responses omit private RPC credentials and background-job diagnostics. They keep the information needed to inspect service health.",
    "links": [
      {
        "label": "Open page",
        "href": "/status/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/5dda5e278768b45372a5386e15b73833e4bddc13"
      }
    ],
    "tags": [
      "privacy",
      "fix"
    ]
  },
  {
    "id": "receipt-window-checks",
    "date": "2026-09-28",
    "title": "Check receipt roots against chain time",
    "summary": "Receipt roots now use chain time and strict interval boundaries. This prevents an anchor from including a receipt outside its stated window.",
    "links": [
      {
        "label": "Open page",
        "href": "/verify/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/a038f2f9ff1cbca872434e038be1a9e9da1efb5d"
      }
    ],
    "tags": [
      "verify",
      "fix"
    ]
  },
  {
    "id": "account-dashboard",
    "date": "2026-09-24",
    "title": "Manage keys and payments in the dashboard",
    "summary": "Sign in to inspect balances, receipts and keys, and manage deposits and withdrawals. The dashboard brings these account controls together.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/bcfd952593c25a7b127ab56c7728438174f40733"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/330aa65ef6e5c34c1179aa291289f4d4c826e045"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "public-model-pages",
    "date": "2026-09-24",
    "title": "Browse models on the site and through the API",
    "summary": "Browse the model catalog on the website or through the model endpoints. Read model details, provider offers and per-token prices before choosing a model.",
    "links": [
      {
        "label": "Open page",
        "href": "/models/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/124e60b3458f7f8d4973df456e7e975f76f3acb8"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/321faa28c916f0fe86a6718c34deb9672289c969"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/d58fad077b7158f1dad8573f9ee90db171a3184f"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/3ee8b3f262b8edac6d232f5fda4338f865575179"
      }
    ],
    "tags": [
      "chat",
      "build"
    ]
  },
  {
    "id": "signed-receipts",
    "date": "2026-09-10",
    "title": "Inspect calls and check their signed receipts",
    "summary": "Look up call usage, cost and provider details, with signed receipts containing request and reply hashes rather than text. Published signing keys and receipt roots support verification.",
    "links": [
      {
        "label": "Open page",
        "href": "/verify/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/bbf3d3c534e838a2b1c2d6106607aa2e06f7e33d"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/1c26d4c3d6c15367fb8101b88f6435b2c450ebcc"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/ce08f355d7528938ebc5e8cf9e660f3bff1cfcc9"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/b6934fc8951fd670dfc974b699f772b2da8fd433"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/25c00fc39caccda7284c8dc0a00c5dbac3ea2836"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/1633ab1343894f3fb58cb43939403f8b128d848d"
      }
    ],
    "tags": [
      "verify",
      "build"
    ]
  },
  {
    "id": "api-key-controls",
    "date": "2026-09-09",
    "title": "Create keys with their own limits",
    "summary": "Create API keys and set their spending and routing rules. Manage keys within the account that owns them.",
    "links": [
      {
        "label": "Open page",
        "href": "/dashboard/#api-keys"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/8772e4f41495a5dffcb602453073c0c192e7c9ba"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/3657241b067dbb1dbcd12ae8d8c19c825a3bb890"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "streamed-chat-api",
    "date": "2026-09-08",
    "title": "Receive chat replies as they arrive",
    "summary": "Send chat requests through an OpenAI-compatible API and receive replies as a stream. The router selects a provider and records usage for billing.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#quickstart"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/949dfa00a39363b806914bb1d019385cdd1c946f"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/7fb2841bef7edebce434b8dbaf8a86f75161745c"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/1e40f0f52c603aea1bc7c1b50a6a32fa65f21f18"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/289620722337a7377ab17f9630d9690d1f91d598"
      }
    ],
    "tags": [
      "chat",
      "build"
    ]
  },
  {
    "id": "embeddings-api",
    "date": "2026-09-07",
    "title": "Create embeddings through the API",
    "summary": "Send text to the embeddings endpoint using your API key. Calls use the router’s provider selection and billing.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/c1a75cfb834795590cfdd978f1db6c6bb62c4a8b"
      }
    ],
    "tags": [
      "build"
    ]
  },
  {
    "id": "prepaid-credits",
    "date": "2026-08-24",
    "title": "Pay from a prepaid balance",
    "summary": "Deposit USDG as prepaid credits and use the balance for API calls. Credits are accounted for against your key.",
    "links": [
      {
        "label": "Open page",
        "href": "/docs/#payments"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/a61583570f619d6927138df8391932a9b85b0e00"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/14a4c10a031be398ea2c006581f90386ef503a65"
      },
      {
        "label": "View commit",
        "href": "https://github.com/AnyRouteRH/AnyRoute/commit/36cc8b8e37684bdd9b0023995e0f7f5cb3714e39"
      }
    ],
    "tags": [
      "build"
    ]
  }
];
