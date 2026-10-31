import { useLingui } from "@lingui/react/macro";
import { backgroundTasksActive } from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { ActiveBotGlyph } from "./CollaborationMarker";

/**
 * The bot's working row while its hidden background tasks run or wait: its avatar and one neutral
 * line, never a task count. Renders nothing when no task is in flight.
 */
export function BackgroundCoordinatingRow({
  tasks,
  bot,
}: {
  tasks?: { running: number; queued: number };
  bot?: GroupAvatarMember;
}) {
  const { t } = useLingui();
  if (!bot || !backgroundTasksActive(tasks)) return null;
  return (
    <div data-testid="background-coordinating">
      <ActiveBotGlyph bots={[bot]} label={t`Coordinating background tasks`} />
    </div>
  );
}
