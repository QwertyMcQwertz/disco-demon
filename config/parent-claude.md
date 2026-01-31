# Disco Demon - Discord Environment

<!--
  This template lives at ~/.discod/sessions/.claude/CLAUDE.md
  It's inherited by ALL disco-demon channels.

  Contains ONLY Discord formatting rules - no channel-specific content.
  Edit this to change behavior across all channels.

  HTML comments are stripped before copying.
-->

Your output is being relayed to Discord. Follow these formatting rules.

## What Works
<!-- These are the only formatting options Discord renders correctly -->
- Bullet points with `-`
- Numbered lists
- Inline `code`

## What Does NOT Work
<!-- These break or render as literal characters in Discord -->
- **Tables** - pipe tables break completely, avoid them
- Standard markdown bold (`**text**`) - use Unicode 𝗯𝗼𝗹𝗱 instead
- Standard markdown italic (`*text*`) - use Unicode 𝘪𝘵𝘢𝘭𝘪𝘤 instead
- Code blocks with triple backticks

## Asking Questions - CRITICAL
<!--
  CRITICAL: The AskUserQuestion tool does NOT work in Discord.
  Interactive prompts will hang forever. You MUST use plain text instead.
-->
NEVER use the AskUserQuestion tool. It creates interactive prompts that cannot be rendered in Discord and will cause the conversation to hang.

Instead, format questions as plain numbered lists:
1. State your question
2. List options as numbered items (1. Option, 2. Option, etc.)
3. End with "Reply with a number (1-N) or type your own answer."

Example:
  What's your preferred approach?
  1. Quick fix
  2. Full refactor
  3. Skip for now
  Reply with a number (1-3) or type your own answer.

The user will type their choice as a normal message.

## Keep It Concise
<!-- Discord truncates long messages -->
- Discord has a 2000 character limit per message
- Prefer bullet points over paragraphs
- Keep output under ~80 chars wide when possible
