# Examples

Runnable demos. Each one labels its output: a local demo policy with no
account needed, or a real Guardian (set the Guardian environment variables) or
real published keys.

```bash
npm install && npm run build   # from the repository root
cd examples
```

Commands below run from `examples/`.

## Smoke test published releases

Use a clean directory outside the checkout so npm cannot resolve the SDK to
workspace packages. With Node 24.16+ (24.x, for current OpenClaw) and Python 3:

```bash
smoke_dir=$(mktemp -d)
cp -R examples "$smoke_dir/"   # from the repository root
cd "$smoke_dir"
npm install @odingard/guardian-{sdk,steel,hook,mcp,openclaw,ap2,x402} \
  @modelcontextprotocol/sdk openclaw @x402/core@~2.30.0 \
  @x402/evm@~2.30.0 @x402/fetch@~2.30.0 viem
python3 -m venv .venv
.venv/bin/python -m pip install odingard-guardian
PYTHON="$PWD/.venv/bin/python" node examples/smoke.mjs
```

The smoke command runs the published, no-account demos and reports each exit
status. Child processes receive only runtime environment settings, not
Guardian, Stripe or other provider credentials. The x402 pins match
the peers declared by published `@odingard/guardian-x402@0.1.1`; the checkout
uses x402 2.31 instead. Review those pins when the adapter releases.

The repository CI jobs build and test the checkout, not the published
artifacts. The Node example job does not run the Codex/DSH hooks, remote MCP,
OpenClaw, AP2 or x402 simulations; the Python job does not run the Hermes demo.
A scheduled published smoke run would cover those gaps. Live recipes still
require a test Guardian agent with provisioned connections, any provider
credentials, and a person to approve held requests.

## Start here (no account needed)

| Example                                                  | What it shows                                                               | Run                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------- |
| [`verify-receipt.mjs`](verify-receipt.mjs)               | No account: verify a real signed decision record offline, then tamper       | `node verify-receipt.mjs`        |
| [`demo-classes.mjs`](demo-classes.mjs)                   | the 7 demo classes                                                          | `node demo-classes.mjs`          |
| [`shopping-agent.mjs`](shopping-agent.mjs)               | purchase → ASK, human approves, signed record                               | `node shopping-agent.mjs`        |
| [`prompt-injection-deny.mjs`](prompt-injection-deny.mjs) | injected "export contacts" → DENY                                           | `node prompt-injection-deny.mjs` |
| [`coding-agent-ask.mjs`](coding-agent-ask.mjs)           | consequential command → ASK                                                 | `node coding-agent-ask.mjs`      |
| [`demo-guardian.mjs`](demo-guardian.mjs)                 | the local demo policy the demos above use; it is not Guardian               | (imported by the demos)          |

## Agents: [`agents/`](agents/)

| Example                                                             | What it shows                                                                            | Run                                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [`agents/agent-hooks.mjs`](agents/agent-hooks.mjs)                  | Codex CLI hook: shell, apply_patch, MCP → ALLOW / ASK / DENY (guardian-hook codex)       | `node agents/agent-hooks.mjs codex`                        |
| [`agents/agent-hooks.mjs`](agents/agent-hooks.mjs)                  | DeepSeek Harness hook via its Claude Code bridge (guardian-hook dsh)                     | `node agents/agent-hooks.mjs dsh`                          |
| [`agents/claude-agent-sdk.mjs`](agents/claude-agent-sdk.mjs)        | A Claude agent governed by Guardian (Claude Agent SDK + guardian-hook)                   | `npm run claude-agent-sdk`                                 |
| [`agents/mastra-agent.mjs`](agents/mastra-agent.mjs)                | A Mastra agent (scripted model): ALLOW, ASK with suspend and resume, DENY (guardian-mastra) | `node agents/mastra-agent.mjs`                             |
| [`agents/codex/`](agents/codex/README.md)                           | OpenAI Codex CLI, governed by Guardian                                                   | see README                                                 |
| [`agents/deepseek-harness/`](agents/deepseek-harness/README.md)     | DeepSeek Harness (dsh), governed by Guardian                                             | see README                                                 |
| [`agents/hosted-claude-code/`](agents/hosted-claude-code/README.md) | Claude Code in a hosted agent VM, governed by Guardian                                   | see README                                                 |
| [`agents/hermes/`](agents/hermes/README.md)                         | Hermes Agent's pre_tool_call hook: ALLOW / ASK / DENY (local demo policy unless env set) | `python agents/hermes/hermes_hook_demo.py`                 |
| [`agents/openclaw/`](agents/openclaw/README.md)                     | OpenClaw plugin in OpenClaw's real hook runtime (stand-in Guardian)                      | `(cd agents/openclaw && npm install && npm run simulated)` |
| [`agents/nemoclaw/`](agents/nemoclaw/README.md)                     | Guardian with NVIDIA NemoClaw (guide)                                                    | see README                                                 |
| [`agents/zeroclaw/`](agents/zeroclaw/README.md)                     | ZeroClaw, governed by Guardian (recipe)                                                  | see README                                                 |

## MCP: [`mcp/`](mcp/)

| Example                                    | What it shows                                                                                                               | Run                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| [`mcp/remote-mcp.mjs`](mcp/remote-mcp.mjs) | guardian-mcp in front of a remote (HTTP) MCP server; fails closed with no settings, runs against Guardian with Guardian env | `node mcp/remote-mcp.mjs` |
| [`mcp/byo/`](mcp/byo/README.md)            | Your own container (CrewAI, LangGraph, AutoGen), governed by Guardian (recipe)                                              | see README                |

## Payments: [`payments/`](payments/)

| Example                                                      | What it shows                                                                                              | Run                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| [`payments/invoice-agent.mjs`](payments/invoice-agent.mjs)   | B2B invoices: ALLOW under $5k, ASK above, DENY unknown payee (createGuard)                                 | `node payments/invoice-agent.mjs`           |
| [`payments/opencommerce/batteries.mjs`](payments/opencommerce/batteries.mjs) | Agentcard opencommerce buy tool: the checkout of two packs of AA batteries from Amazon goes through Guardian before Agentcard (guardian-opencommerce; needs Agentcard sandbox credentials and a Guardian connection) | `node payments/opencommerce/batteries.mjs` |
| [`payments/steel-checkout.mjs`](payments/steel-checkout.mjs) | Guardian for Steel, agent side: the order goes to ASK                                                      | `node payments/steel-checkout.mjs`          |
| [`payments/x402/`](payments/x402/README.md)                  | x402 payments: ALLOW, ASK above a cap, DENY, before the wallet signs (stand-in Guardian, no network)       | `node payments/x402/simulated-payments.mjs` |
| [`payments/ap2/`](payments/ap2/README.md)                    | AP2 mandates: delegation, ALLOW, ASK above a cap, DENY, before the agent key signs (stand-ins, no network) | `node payments/ap2/simulated-payments.mjs`  |

## Python: [`python/`](python/)

The invoice and Hermes demos work with PyPI's `odingard-guardian==0.5.0`.
The other Python examples below use adapters or adapter APIs not in that
release. Install from this checkout for those examples (use separate virtual
environments for crewAI and Strands, as CI does). For example, from the root:

```bash
python -m pip install -e "./packages/python[openai-agents]"
python examples/python/openai_agents_agent.py
```

| Example                                              | What it shows                                               | Run                              |
| ---------------------------------------------------- | ----------------------------------------------------------- | -------------------------------- |
| [`python/invoice_agent.py`](python/invoice_agent.py) | the invoice agent in Python (pip install odingard-guardian) | `python python/invoice_agent.py` |
| [`python/crewai_agent.py`](python/crewai_agent.py) | a crewAI agent with governed tools: ALLOW, ASK then approved, DENY (scripted model; checkout extra `crewai`) | `python python/crewai_agent.py` |
| [`python/langchain_agent.py`](python/langchain_agent.py) | LangChain agent: ALLOW, ASK as a LangGraph interrupt, DENY | `python python/langchain_agent.py` |
| [`python/openai_agents_agent.py`](python/openai_agents_agent.py) | an OpenAI Agents SDK agent with governed tools: ALLOW, ASK as a paused run, DENY (scripted model, no API key; checkout extra `openai-agents`) | `python python/openai_agents_agent.py` |
| [`python/google_adk_agent.py`](python/google_adk_agent.py) | a Google ADK agent with Guardian's plugin on ADK's real loop (scripted model, local demo policy; checkout extra `google-adk`) | `python python/google_adk_agent.py` |
| [`python/strands_agent.py`](python/strands_agent.py) | a Strands agent loop: ALLOW, ASK pauses the run, DENY       | `python python/strands_agent.py` |
| [`python/claude_agent_sdk_agent.py`](python/claude_agent_sdk_agent.py) | Claude Agent SDK: the PreToolUse hook and a guarded `@tool`, with a scripted stand-in for the CLI (checkout extra `claude-agent-sdk`) | `python python/claude_agent_sdk_agent.py` |

Recipes that need a real Guardian agent: [ZeroClaw](agents/zeroclaw/README.md) ·
[your own container: CrewAI, LangGraph, AutoGen](mcp/byo/README.md).

To verify your own decision record against the keys its Guardian API publishes at
`/v1/receipts/verification-keys` instead of the bundled copy
(`receipts/verification-keys.json`), pass that API's base URL:

```sh
node verify-receipt.mjs path/to/record.greceipt.json https://<your-guardian-api>
```

Use the bundled keys (no arguments) for the bundled sample. A deployment
that does not publish the receipt's signing key cannot verify that receipt.
