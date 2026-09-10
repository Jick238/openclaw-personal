import { describe, expect, it } from "vitest";
import { normalizeTelegramBotInfo } from "./bot-info.js";

describe("normalizeTelegramBotInfo", () => {
  it("retains the Telegram Guest Mode capability reported by getMe", () => {
    expect(
      normalizeTelegramBotInfo({
        id: 123,
        is_bot: true,
        first_name: "Hicks",
        username: "hickss_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_guest_queries: true,
        supports_inline_queries: false,
        can_manage_bots: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
      }),
    ).toMatchObject({ supports_guest_queries: true });
  });
});
