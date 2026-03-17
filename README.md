# A2A Protocol — Proof of Concept

R&D project to evaluate [Google's Agent-to-Agent (A2A) protocol](https://github.com/a2aproject/a2a-js) for multi-agent pipeline orchestration.

## Context

Our RockerOS pipeline uses a Supabase-backed state machine with self-patching agents. It works, but has flaky edge cases:
- Agents stuck in `running` without status update
- `waiting_user` transitions missed by watcher
- No standardized completion events

A2A provides a protocol-level solution with well-defined task states: `submitted → working → input-required → completed/failed`.

## Goal

Test if A2A can replace our custom state management for agent lifecycle:
1. **Agent Server**: Express server exposing an A2A-compatible agent
2. **Client/Orchestrator**: Sends tasks, polls status, handles `input-required`
3. **Supabase integration**: Sync A2A task states with our DB
4. **Multi-agent**: Fan-out to multiple agents, fan-in results

## Stack

- TypeScript + Express
- `@a2a-js/sdk` (official A2A TypeScript SDK)
- Supabase (temporary test DB)

## Quick Start

```bash
npm install
npx tsx src/server.ts    # Start agent server on :4000
npx tsx src/client.ts    # Send a task to the agent
```

## Status

🚧 Work in progress — this is a throwaway POC.
