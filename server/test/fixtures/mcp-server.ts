// Minimal MCP server used by the tests: one read-only tool, one write tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-mail", version: "1.0.0" });
server.registerTool(
  "list_inbox",
  { description: "List inbox", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "text", text: "1 unread: invoice from ACME" }] }),
);
server.registerTool(
  "send_email",
  { description: "Send an email", inputSchema: { to: z.string(), body: z.string() } },
  async ({ to }) => ({ content: [{ type: "text", text: `sent to ${to}` }] }),
);
await server.connect(new StdioServerTransport());
