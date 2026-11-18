# @odingard/guardian

`guardian init` sets Guardian up for the agent project in the current folder, in one command.

```sh
npx @odingard/guardian init --tools send_reply,refund_order
```

1. **Finds the framework.** It reads `package.json`, `pyproject.toml` or `requirements.txt` (LangChain, Vercel AI SDK, OpenAI Agents SDK, other Node.js code, Python). It changes no file in your project.
2. **Opens the Guardian console** to sign in. The page shows a code; check that the terminal shows the same one. Press **Create agent and connection**: the console creates the agent and a tool server with your tools as "My own code (record-only)".
3. **Hands the agent credential to the terminal.** The console sends it to this command on `127.0.0.1`. If the browser cannot reach it, the page shows the credential once and the command asks you to paste it (the input is hidden).
4. **Saves it** to `~/.config/guardian/env` (mode 600) after you say yes: `GUARDIAN_AGENT_CREDENTIAL`, `GUARDIAN_CONNECTION_ID` and `GUARDIAN_BASE_URL`. Load it with `. ~/.config/guardian/env` in the shell that starts your agent. The command never prints the credential.
5. **Shows the install line** for your framework (pinned versions) and how to wrap a tool.
6. **Sends one test action.** On the console page, turn on the suggested rules for your tools (nothing is allowed until you do), then press Enter. The test tool `guardian_setup_test` goes through Guardian: allowed and recorded, or held until you approve it in the console.

## Options

| Option              | Meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| `--tools <a,b>`     | Tool names your agent runs through Guardian                |
| `--name <name>`     | Agent name (default: the project name)                     |
| `--server <name>`   | Tool server name (default: `<agent name> tools`)           |
| `--env-file <path>` | Where to save the credential                               |
| `--console <url>`   | Guardian console (default `https://guardian.odingard.com`) |
| `--api <url>`       | Guardian API (default `https://guardian-api.odingard.com`) |
| `--no-browser`      | Print the link instead of opening the browser              |
| `--no-test`         | Skip the test action                                       |
| `--yes`             | Answer yes to every question                               |

## What it can and cannot do

- The agent credential can propose actions. It cannot approve them or change rules: that needs your sign-in in the console.
- The command listens on `127.0.0.1` and takes the credential once, from the console's own address, with this run's code. Anything else is refused.
- An agent started from a shell that loaded the env file can read the credential from its environment.

Node.js 22 or later.

## License

Apache-2.0
