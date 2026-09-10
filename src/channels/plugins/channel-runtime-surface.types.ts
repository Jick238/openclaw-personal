/**
 * Channel runtime context registry types.
 *
 * Defines the public plugin SDK surface for channel runtime context registration and watches.
 */
export type ChannelRuntimeContextKey = {
  channelId: string;
  accountId?: string | null;
  capability: string;
};

export type ChannelRuntimeContextEvent = {
  type: "registered" | "unregistered";
  key: {
    channelId: string;
    accountId?: string;
    capability: string;
  };
  context?: unknown;
};

export type ChannelRuntimeContextRegistry = {
  register: (
    params: ChannelRuntimeContextKey & {
      context: unknown;
      abortSignal?: AbortSignal;
    },
  ) => { dispose: () => void };
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Runtime context values are caller-typed by key.
  get: <T = unknown>(params: ChannelRuntimeContextKey) => T | undefined;
  watch: (params: {
    channelId?: string;
    accountId?: string | null;
    capability?: string;
    onEvent: (event: ChannelRuntimeContextEvent) => void;
  }) => () => void;
};

export type ChannelExternalTurnRequest = {
  channel: string;
  accountId: string;
  agentId?: string;
  sessionKey: string;
  prompt: string;
  senderId: string;
  senderUsername?: string;
  senderIsOwner?: boolean;
  correlationId?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ChannelExternalTurnResult =
  | { kind: "completed"; text: string }
  | { kind: "empty" }
  | { kind: "timeout" }
  | { kind: "error"; code: "failed" | "aborted" };

export type ChannelExternalTurnRunner = (
  request: ChannelExternalTurnRequest,
) => Promise<ChannelExternalTurnResult>;

export type ChannelExternalTaskCommitRequest = {
  channel: string;
  accountId: string;
  agentId: string;
  senderId: string;
  senderUsername?: string;
  sessionKey: string;
  prompt: string;
  correlationId: string;
  signal?: AbortSignal;
};

export type ChannelExternalTaskCommitResult =
  | { kind: "accepted"; taskId: string }
  | {
      kind: "unavailable";
      code: "unsupported" | "unauthorized" | "failed";
      reason?: "gateway_unavailable" | "unauthorized" | "rejected" | "failed";
    };

export type ChannelExternalTaskCommitter = (
  request: ChannelExternalTaskCommitRequest,
) => Promise<ChannelExternalTaskCommitResult>;

/**
 * Minimal channel-runtime surface exported through the public plugin SDK.
 *
 * Gateway startup supplies the full plugin channel runtime, but external callers
 * may still type context-only helpers against this compatibility surface.
 */
export type ChannelRuntimeSurface = {
  runtimeContexts: ChannelRuntimeContextRegistry;
  externalTurns?: {
    runResultOnly: ChannelExternalTurnRunner;
    commitTask?: ChannelExternalTaskCommitter;
  };
  [key: string]: unknown;
};
