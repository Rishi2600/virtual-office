import { Schema, type, MapSchema } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") userId = "";
  @type("string") name = "";
  @type("string") picture = "";
  /** Avatar look ("skin.hairStyle.hairColor.top.bottom.extra"), validated by
   *  the server; drawn by the client from code. See shared/src/avatar.ts. */
  @type("string") avatar = "";

  @type("number") x = 0;
  @type("number") y = 0;

  /** Last input seq the server has simulated. The owning client replays every
   *  input newer than this during reconciliation. */
  @type("number") lastSeq = 0;

  /** "available" | "focus" — focus suppresses proximity calls entirely. */
  @type("string") status = "available";

  @type("boolean") micOn = true;
  /** Video is OFF until the user explicitly turns it on — proximity connects
   *  audio only, so walking past someone never opens your camera. */
  @type("boolean") camOn = false;
  @type("boolean") sharing = false;

  /**
   * Non-empty when this player is in a locked ("private discussion") huddle.
   * Everyone in the same locked huddle shares the same id. Proximity refuses to
   * pair anyone whose lock group differs, which is what keeps a third person
   * from walking into a private conversation.
   */
  @type("string") lockGroup = "";

  /** False while the player is inside the reconnect grace window. */
  @type("boolean") connected = true;
}

export class OfficeState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type("string") mapKey = "office";
}
