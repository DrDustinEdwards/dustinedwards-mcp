/**
 * The seven tools.
 *
 * FEW tools, exact names, one job each, mirroring the operator API exactly. No
 * convenience composites: composition is the agent's job, and a composite here
 * would be a place for policy to accumulate.
 *
 * DESCRIPTIONS ARE LOAD-BEARING DOCUMENTATION. An MCP client reads them to
 * decide when to call a tool and how to interpret what comes back, so each one
 * states what the tool does, its constraints, and THE POLICY THE API WILL
 * ENFORCE. The first-publish rule appears in save_post's description for exactly
 * this reason: an agent that has been told the rule reads a 403 as policy and
 * adapts, while an agent that has not reads it as a malfunction and retries.
 *
 * ANNOTATIONS ARE SET HONESTLY. Clients build confirmation UX from
 * readOnlyHint and destructiveHint, so a wrong annotation is a lie told to the
 * human who is deciding whether to approve an action.
 */

import { z } from "zod";

import { callOperator, ApiLegError, type ApiEnv } from "./api-client";

/**
 * A post slug. Constrained here so a malformed call fails at the schema before
 * any HTTP round trip. This is INPUT VALIDATION, not policy: it rejects calls
 * that could not possibly be valid, and it decides nothing about what is
 * allowed. The API remains the only thing that can say yes.
 */
const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "A slug is lowercase letters, digits and single hyphens, e.g. where-should-a-blog-store-its-words",
  )
  .describe("The post's slug, which is also its filename under content/posts/.");

const headShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, "A git sha is 7 to 40 lowercase hex characters.")
  .optional()
  .describe(
    "Optional. The head sha from get_post, for the editor's conflict semantics. " +
      "Omit for an unconditional save. Supplying it means the save is refused with " +
      "409 if main moved since you read the post.",
  );

const DELETE_MENTION_POLICY =
  "POLICY, enforced by the API and not by this wrapper: an operator may approve " +
  "and reject a mention, which are reversible. It may NOT delete one. A mention " +
  "row came from a stranger's POST, there is no repository behind it and no " +
  "derivation that could produce it again, so deleting is reserved to the human " +
  "admin and is refused with HTTP 403 and policy name " +
  "'mention-delete-requires-admin'. That refusal is the system working " +
  "correctly, not an error to retry. Reject instead: it removes the mention " +
  "from the post and can be undone.";

const FIRST_PUBLISH_POLICY =
  "POLICY, enforced by the API and not by this wrapper: an operator may create, " +
  "edit, unpublish and republish a post. It may NOT perform a post's FIRST " +
  "transition to draft:false. That first publication is reserved to the human " +
  "admin and is refused with HTTP 403 and policy name " +
  "'first-publish-requires-admin'. That refusal is the system working correctly, " +
  "not an error to retry or work around. Use get_post and read " +
  "operatorMayPublish to know in advance: when it is false, leave draft:true and " +
  "tell the human the post is staged and ready for them to publish.";

/** The MCP content shape a tool returns. */
type ToolOutput = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

/**
 * Runs one tool against the API and shapes the result for MCP.
 *
 * The failure path is the important one. The API's refusal prose is passed
 * through VERBATIM as the text content, and its structured detail (policy name,
 * field, line, conflict flag) is preserved so an agent can branch on the policy
 * name instead of string-matching English.
 *
 * An API-leg failure is reported as a TOOL error (isError), never as a protocol
 * error, because the tool call itself was well formed and the agent needs to see
 * why the operation was refused.
 */
async function run(
  env: Partial<ApiEnv>,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolOutput> {
  try {
    const result = await callOperator(env, tool, args);

    if (result.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
        structuredContent: result.data as Record<string, unknown>,
      };
    }

    // Verbatim. The status and any policy name travel alongside rather than
    // being folded into the prose, so neither is lost and neither is invented.
    const detail = result.detail as { policy?: string; field?: string | null; line?: number | null } | undefined;
    const parts = [result.error ?? "The operator API refused the request."];
    if (detail?.policy) parts.push(`policy: ${detail.policy}`);
    if (detail?.field) parts.push(`field: ${detail.field}`);
    if (typeof detail?.line === "number") parts.push(`line: ${detail.line}`);

    return {
      isError: true,
      content: [{ type: "text", text: parts.join("\n") }],
      structuredContent: {
        status: result.status,
        error: result.error,
        detail: result.detail ?? null,
      },
    };
  } catch (cause) {
    // A wrapper-side failure. Named as such so it cannot be mistaken for the
    // API having refused something: those two mean very different things and an
    // agent's next move differs between them.
    const message =
      cause instanceof ApiLegError
        ? `The wrapper could not complete its request to the operator API (${cause.kind}): ${cause.message}`
        : `The wrapper failed unexpectedly: ${cause instanceof Error ? cause.message : String(cause)}`;
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

export interface ToolDefinition {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodObject<z.ZodRawShape>;
    annotations: {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
      openWorldHint: boolean;
    };
  };
  handler: (env: Partial<ApiEnv>, args: Record<string, unknown>) => Promise<ToolOutput>;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_posts",
    config: {
      title: "List posts",
      description:
        "Lists every post on dustinedwards.info from the committed content " +
        "artifact, with the current head sha of main. Includes drafts and " +
        "future-dated posts, so it is a view of the repository rather than of the " +
        "public site. Returns slug, title, description, date, publishAt, draft, " +
        "tags, series, part, updated and sourcePath for each post.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler: (env) => run(env, "list_posts", {}),
  },

  {
    name: "get_post",
    config: {
      title: "Get a post",
      description:
        "Reads one post's COMPLETE markdown file, frontmatter included, exactly as " +
        "committed, so it can be edited and handed straight back to save_post. " +
        "Also returns the head sha, the rendered html, the reading time, the " +
        "draft flag, and two fields that matter before any publish attempt: " +
        "firstPublished, and operatorMayPublish. " +
        "Read operatorMayPublish BEFORE trying to set draft:false. " +
        FIRST_PUBLISH_POLICY,
      inputSchema: z.object({ slug: slugSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler: (env, args) => run(env, "get_post", { slug: args.slug }),
  },

  {
    name: "save_post",
    config: {
      title: "Create or update a post",
      description:
        "Creates or updates a post by committing the complete markdown file. One " +
        "save is ONE atomic commit on main carrying both content/posts/<slug>.md " +
        "and the regenerated content artifact, followed by a database sync and an " +
        "AI search index sync. Returns the commit sha.\n\n" +
        "Pass `raw` as the ENTIRE file including frontmatter, not a patch and not " +
        "the body alone. Use get_post first to obtain the current file.\n\n" +
        "The content gates run server side before anything is written. A rejection " +
        "returns the gate's own message naming the offending field and line, and " +
        "that message is passed back to you unchanged so you can fix it. Note the " +
        "house style rule the gate enforces: no wide dashes anywhere in the prose.\n\n" +
        FIRST_PUBLISH_POLICY,
      inputSchema: z.object({
        slug: slugSchema,
        raw: z
          .string()
          .min(1)
          .describe("The complete markdown file including its YAML frontmatter block."),
        expectedHeadSha: headShaSchema,
        isNew: z
          .boolean()
          .optional()
          .describe("Optional. Inferred from whether the file already exists; supply only to be explicit."),
      }),
      annotations: {
        readOnlyHint: false,
        // Not destructive: a save is a new commit on top of history, and version
        // history plus restore exist. Overwriting a post's content is a real
        // change, which openWorldHint and readOnlyHint:false already convey.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    handler: (env, args) =>
      run(env, "save_post", {
        slug: args.slug,
        raw: args.raw,
        ...(args.expectedHeadSha ? { expectedHeadSha: args.expectedHeadSha } : {}),
        ...(args.isNew !== undefined ? { isNew: args.isNew } : {}),
      }),
  },

  {
    name: "delete_post",
    config: {
      title: "Delete a post",
      description:
        "Deletes a post: removes its markdown file, its entry in the content " +
        "artifact, and its database rows, then removes it from the AI search " +
        "index. One atomic commit on main. Returns the commit sha.\n\n" +
        "This removes a live URL. The commit remains in git history, so the " +
        "content is recoverable by a human through the version history surface, " +
        "but the post stops being served immediately. Prefer setting draft:true " +
        "through save_post when the intent is to withdraw a post rather than to " +
        "erase it, because unpublishing is reversible by you and deletion is not.",
      inputSchema: z.object({ slug: slugSchema, expectedHeadSha: headShaSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    handler: (env, args) =>
      run(env, "delete_post", {
        slug: args.slug,
        ...(args.expectedHeadSha ? { expectedHeadSha: args.expectedHeadSha } : {}),
      }),
  },

  {
    name: "sync_status",
    config: {
      title: "Pipeline sync status",
      description:
        "Reports the state of the publishing pipeline's three stores SEPARATELY, " +
        "because they can disagree and the design assumes they fail " +
        "independently: the head sha, the post count in the committed artifact, " +
        "the total and publicly visible counts in the database, the document count " +
        "in the search index, and whether the AI index and GitHub are configured. " +
        "Use this to check a save landed everywhere, or to diagnose a disagreement " +
        "between the repository and the live site.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler: (env) => run(env, "sync_status", {}),
  },
{
    name: "list_mentions",
    config: {
      title: "List webmentions",
      description:
        "Lists webmentions other sites have sent to dustinedwards.info, newest " +
        "decision first. Returns id, source, target slug, status, author, " +
        "excerpt, failureReason and the received, verified and decided " +
        "timestamps for each. " +
        "Statuses: 'unverified' (received, not yet fetched), 'pending' (the " +
        "source really links here and it is awaiting a decision), 'approved' " +
        "(published under the post), 'rejected' (turned down), 'failed' (the " +
        "source could not be fetched or did not link here, with the reason). " +
        "Unfiltered by default, which is what the moderation queue shows: the " +
        "failures matter, because an empty pending list means something " +
        "different from a list of failures. Pass status to narrow it. " +
        "Call this before decide_mention to get the ids.",
      inputSchema: z.object({
        status: z
          .enum(["unverified", "pending", "approved", "rejected", "failed"])
          .optional()
          .describe("Optional. Narrow the list to one status. Omit for the whole queue."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler: (env, args) =>
      run(env, "list_mentions", args.status ? { status: args.status } : {}),
  },

  {
    name: "decide_mention",
    config: {
      title: "Decide a webmention",
      description:
        "Approves, rejects or deletes one received webmention by id. " +
        "Approving publishes it under the target post as escaped text with a " +
        "validated link, and PURGES that post's cached page, so the change " +
        "reaches readers on the next fetch rather than after the ten minute " +
        "shared-cache lifetime. Rejecting removes it from the post the same " +
        "way. Approve and reject are a two-way door: either can be applied to " +
        "a mention that is currently the other. " +
        "Only a mention that has been VERIFIED can be decided. One that is " +
        "still 'unverified', or that 'failed' verification, returns " +
        "changed:false rather than an error, because there is no evidence to " +
        "approve and retrying will not change that. " +
        DELETE_MENTION_POLICY,
      inputSchema: z.object({
        id: z
          .number()
          .int()
          .positive()
          .describe("The mention's id, from list_mentions."),
        decision: z
          .enum(["approve", "reject", "delete"])
          .describe("approve, reject or delete."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler: (env, args) => run(env, "decide_mention", { id: args.id, decision: args.decision }),
  },
];

