import type { WorkboardCard } from "@openclaw/workboard-contract";
import { assertCanMutateClaimedCard, cardBoardId } from "./store-card-helpers.js";
import type { WorkboardDecomposeChildInput } from "./store-inputs.js";
import { normalizeAutomation } from "./store-normalizers.js";
import { WorkboardPromoteStore } from "./store-promote.js";

type FrontRequestGroupInput = {
  parent: WorkboardDecomposeChildInput;
  child: WorkboardDecomposeChildInput;
  tenant: string;
  boardId: string;
  requesterSessionKey: string;
  requestGroupId: string;
};

function isActiveRequestGroup(card: WorkboardCard, input: FrontRequestGroupInput): boolean {
  return (
    card.status !== "done" &&
    card.status !== "blocked" &&
    card.metadata?.automation?.tenant === input.tenant &&
    cardBoardId(card) === input.boardId &&
    card.metadata?.automation?.requesterSessionKey === input.requesterSessionKey &&
    card.metadata?.automation?.requestGroupId === input.requestGroupId &&
    !card.metadata?.automation?.createdByCardId
  );
}

export class WorkboardRequestGroupStore extends WorkboardPromoteStore {
  /** Serialize related Front tool calls into one parent and one child manifest. */
  async reserveFrontRequestGroup(input: FrontRequestGroupInput): Promise<{
    parent: WorkboardCard;
    created: boolean;
    child?: WorkboardCard;
  }> {
    return await this.enqueueMutation(async () =>
      this.withCardCompensation(async () => {
        const existing = (await this.list()).find((card) => isActiveRequestGroup(card, input));
        if (!existing) {
          return {
            parent: await this.createDirect({
              ...input.parent,
              boardId: input.boardId,
              tenant: input.tenant,
              requesterSessionKey: input.requesterSessionKey,
              requestGroupId: input.requestGroupId,
            }),
            created: true,
          };
        }
        if (existing.metadata?.automation?.idempotencyKey === input.child.idempotencyKey) {
          return { parent: existing, created: false };
        }

        // Related admissions are a store-owned manifest mutation. Revalidate
        // the active owner while the mutation queue is held; Front never sees its token.
        const claimOwner = existing.metadata?.claim?.ownerId;
        assertCanMutateClaimedCard(existing, claimOwner ? { ownerId: claimOwner } : undefined);
        const child = await this.createDirect({
          ...input.child,
          boardId: input.boardId,
          tenant: input.tenant,
          requesterSessionKey: input.requesterSessionKey,
          requestGroupId: input.requestGroupId,
          createdByCardId: existing.id,
        });
        const latestParent = (await this.get(existing.id)) ?? existing;
        const createdCardIds = [
          ...(latestParent.metadata?.automation?.createdCardIds ?? []),
          child.id,
        ].filter((cardId, index, ids) => ids.indexOf(cardId) === index);
        const parent = await this.updateCard(
          latestParent.id,
          {
            metadata: {
              ...latestParent.metadata,
              automation: normalizeAutomation(
                { ...latestParent.metadata?.automation, createdCardIds },
                latestParent.metadata?.automation,
              ),
            },
          },
          { expectedUpdatedAt: latestParent.updatedAt },
        );
        return { parent, child, created: false };
      }),
    );
  }
}
