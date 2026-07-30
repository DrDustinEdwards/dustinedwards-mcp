/**
 * The MCP server and its era routing.
 *
 * The PRIMARY handler is `legacy: "reject"`: stateless-native 2026-07-28, the
 * design-center era, with no compatibility thinking inside it. Prior-era traffic
 * is detected and diverted by ONE call into src/legacy-era.ts, which carries its
 * own removal condition. Delete that file and its two lines here and this becomes
 * a modern-only server, with nothing left behind.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

import { TOOLS } from "./tools";
import { createLegacyEraHandler, isLegacyRequest } from "./legacy-era";
import type { ApiEnv } from "./api-client";

export const MCP_ROUTE = "/mcp";

const SERVER_INFO = {
  name: "dustinedwards-mcp",
  title: "dustinedwards.info operator",
  version: "0.1.0",
} as const;

const INSTRUCTIONS =
  "Publishing tools for dustinedwards.info. Every call here becomes an " +
  "authenticated request to the site's operator API, which owns all the rules; " +
  "this server enforces none of its own. " +
  "One policy governs the surface and it is worth reading before you write: an " +
  "operator may create, edit, unpublish and republish posts, but may NOT perform " +
  "a post's first publication. Check operatorMayPublish via get_post before " +
  "setting draft:false, and treat a 403 naming " +
  "'first-publish-requires-admin' as policy working correctly rather than as an " +
  "error. When you cannot publish, stage the post as a draft and say so.";

/**
 * The server factory. Called per request, which is what stateless means: no
 * instance outlives the call that made it and none carries conversational state.
 */
function buildServer(env: Partial<ApiEnv>) {
  return () => {
    const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
    for (const tool of TOOLS) {
      server.registerTool(tool.name, tool.config, (args: Record<string, unknown>) =>
        tool.handler(env, args ?? {}),
      );
    }
    return server;
  };
}

/**
 * Routes one request to the era that can answer it.
 *
 * Both handlers are constructed per call. They are cheap, stateless objects over
 * the same factory, and building them here rather than at module scope keeps the
 * env closure correct without a mutable global.
 */
export async function handleMcp(
  request: Request,
  env: Partial<ApiEnv>,
  ctx: ExecutionContext,
): Promise<Response> {
  const factory = buildServer(env);

  // --- the one legacy call site, deletable with src/legacy-era.ts -----------
  // The predicate inspects the body, so the request is cloned for it. A Request
  // body is a single-use stream and the handler downstream needs to read it too.
  if (await isLegacyRequest(request.clone())) {
    return createLegacyEraHandler(factory, MCP_ROUTE)(request, env, ctx);
  }
  // -------------------------------------------------------------------------

  // Everything the predicate calls false goes here, including malformed
  // envelopes and header/body mismatches: the library's documentation is
  // explicit that the modern path owns those error answers, so false traffic
  // must never be sent to the legacy handler.
  return createMcpHandler(factory, { route: MCP_ROUTE, legacy: "reject" })(request, env, ctx);
}
