# Antigravity turns in Cake

Cake can run a text turn through Google's installed Antigravity CLI from an open desktop Project Session. The model picker lists **Gemini · via Antigravity** separately from the Pi model catalog. Google chooses the concrete Gemini model. **Return to Pi** keeps the existing Pi configuration; the picker starts on Pi when the session is reopened. Draft/new-session setup, Cake Chat and Project Chat, side chats, browser chat, workers, scheduled messages, and automations do not opt in.

## Context and permissions

- Cake sends only the submitted text, plus the current working directory during ACP setup. It does not send the Pi transcript, system prompt, attachments, generated reminders, or Cake tool configuration. To share prior context, paste only the text you intend to send. Antigravity has its own workspace access and CLI permission rules; this is not a filesystem sandbox.
- While supported and advertised, Cake resumes Antigravity's own context via `session/resume`, with no history replay. The Pi transcript, including intervening Pi turns, is not synchronized to Google. If resume is unavailable, fails, or cannot be safely scoped to the current branch, the next Antigravity turn starts fresh. Cake never reads Antigravity's local history.
- The requesting desktop receives the CLI's ACP permission requests. Cake offers only per-call Allow once or Deny. Cancel, disconnect at a permission prompt, expiry, or a request that cannot be safely presented never authorizes it. Existing Antigravity CLI rules may allow or deny actions without asking.
- Each foreground turn has its own subprocess; Stop cancels it without starting Pi. Cake records the prompt, external reply text, and tool activity summaries through Pi's supported append APIs. It uses a Pi custom context message for the external reply (not a fabricated provider message or tool replay). Later Pi turns see the reply as labeled external context. No automatic crash retry is attempted. A crash before settlement can leave the user message and an interrupted-turn notice but no final reply.
- This release does not forward attachment payloads or support ACP steering, ACP slash commands, terminal/filesystem client capabilities, MCP provisioning, direct authentication, or diff replay. Cake's explicit Pi tool-pruned branch and side-chat export operate on native dialogue; they are not ways to transfer Antigravity context.

## Local smoke test with Google's CLI

Use a disposable empty project. From the environment that launches Cake, check `command -v agy` and `agy acp --help`. If not signed in, run `agy` interactively and use Google's sign-in flow yourself. Cake does not install the executable or perform sign-in. Follow [Google's ACP setup](https://antigravity.google/docs/ide/extensions/acp/#other-clients) and the [ACP v1 protocol](https://agentclientprotocol.com/protocol/v1/session-setup) for the wire contract.

1. Start a normal Pi turn with `Reply with the text pi-one and use no tools.`
2. In the same Project Session, open the model picker, choose **Change model → Gemini · via Antigravity**, and send `Reply with the text agy-two and use no tools.` Check the Antigravity status and streamed reply.
3. Choose **Return to Pi** and ask `What exact text did Antigravity reply with? Use no tools.` Verify the answer can use the earlier reply. Close and reopen the session; verify the same history, with no duplicated messages.
4. Re-select Antigravity and ask `What exact text did I ask you to reply with on your last turn? Use no tools.` Check that the status says whether it resumed its own context or started fresh.
5. If you choose to test permissions, use only an empty disposable workspace. Ask Antigravity to run `printf cake-acp` and deny it if the CLI sends a permission request. Existing CLI rules may handle that command without prompting; don't change global rules solely for this smoke test.
