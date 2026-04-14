# MCP

## Current status

Full external MCP integration is not implemented yet in the running app.

Milestone 4.1 now ships local capability-tool placeholders for:

- `ListMcpResourcesTool`
- `ReadMcpResourceTool`

Those tools currently operate over the app's local MCP placeholder surface rather than a real external server connection. The bridge still keeps a dedicated integration seam for future MCP:

- tools
- resources
- prompts

## Planned milestone coverage

The intended MCP implementation will include:

- server configuration UI
- connection lifecycle management
- manifest refresh
- discovery and invocation for tools
- listing and reading of resources
- discovery and insertion of prompts
- disconnected and degraded state handling
